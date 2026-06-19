// Package codex — model discovery (ModelProvider implementation).
//
// This file owns the Codex family's private model discovery flow:
//
//  1. The request policy already specifies a model → wrap it as a single
//     ModelInfo and return immediately.
//  2. Probe `codex app-server --listen stdio://` over JSON-RPC for the
//     authoritative `model/list` payload (the same data the CLI's `/model`
//     selector uses). This requires the user to be logged in / online.
//  3. Fall back to ~/.codex/models_cache.json (CLI persisted cache).
//  4. Fall back to `codex models --json` (rarely available, but cheap to
//     try).
//  5. Fall back to the static codexStyleDefaultModels list.
//
// All Codex private helpers (app-server JSON-RPC handshake, models cache
// parser, default list) live here so the shared inventory package no
// longer needs to know about the Codex family.
package codex

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	agentclient "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentclient"
	agentcore "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentcore"
	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
)

// PolicyModel returns the trimmed model name from the request policy, or
// the empty string when the request leaves the model unset.
func PolicyModel(req *proto.AgentRunRequestFrame) string {
	if req == nil {
		return ""
	}
	return strings.TrimSpace(req.Policy.Model)
}

// ListModels implements agentruntime.ModelProvider for the Codex family.
//
// Order: app-server jsonrpc → ~/.codex/models_cache.json → `codex models
// --json` → static defaults. Never returns an empty list and never
// surfaces a hard error: callers (and the web model picker) treat
// discovery as best-effort.
func (a *Agent) ListModels(ctx context.Context) ([]agentclient.ModelInfo, error) {
	binary := strings.TrimSpace(a.Client.Binary)

	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	default:
	}

	if binary != "" {
		if models, err := tryCodexAppServerListModels(ctx, binary); err == nil && len(models) > 0 {
			return models, nil
		}
	}

	if models := readCodexModelsCache(); len(models) > 0 {
		return models, nil
	}

	if binary != "" {
		if models, err := tryCodexCliModelsJSON(ctx, binary); err == nil && len(models) > 0 {
			return models, nil
		}
	}

	return append([]agentclient.ModelInfo(nil), codexStyleDefaultModels()...), nil
}

// codexStyleDefaultModels is the static fallback for the Codex family
// (mirrors the historical inventory.codexStyleDefaultModels).
func codexStyleDefaultModels() []agentclient.ModelInfo {
	return []agentclient.ModelInfo{
		{ID: "gpt-5", DisplayName: "GPT-5"},
		{ID: "gpt-5-codex", DisplayName: "GPT-5 Codex"},
	}
}

// codexModelsCachePath is the on-disk location the Codex CLI uses to
// persist its model selector list.
func codexModelsCachePath() string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ""
	}
	return filepath.Join(home, ".codex", "models_cache.json")
}

type codexAppServerModelEntry struct {
	ID          string `json:"id"`
	Model       string `json:"model"`
	DisplayName string `json:"displayName"`
	Description string `json:"description"`
	Hidden      bool   `json:"hidden"`
	IsDefault   bool   `json:"isDefault"`
}

// tryCodexAppServerListModels spawns `codex app-server --listen stdio://`
// and asks for the model catalogue over JSON-RPC.
func tryCodexAppServerListModels(ctx context.Context, binary string) ([]agentclient.ModelInfo, error) {
	cmdCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(cmdCtx, binary, "app-server", "--listen", "stdio://")
	cmd.Env = os.Environ()
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("codex app-server stdin: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("codex app-server stdout: %w", err)
	}
	cmd.Stderr = io.Discard
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("codex app-server start: %w", err)
	}
	defer func() {
		_ = stdin.Close()
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
	}()

	writeFrame := func(payload string) error {
		_, werr := io.WriteString(stdin, payload+"\n")
		return werr
	}
	if err := writeFrame(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"octodeck-daemon","version":"1"}}}`); err != nil {
		return nil, fmt.Errorf("codex initialize write: %w", err)
	}
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	// Wait for the initialize response (id=1) before issuing model/list.
	for scanner.Scan() {
		var msg map[string]any
		if err := json.Unmarshal(scanner.Bytes(), &msg); err != nil {
			continue
		}
		if id, _ := msg["id"].(float64); id == 1 {
			break
		}
	}
	if err := writeFrame(`{"jsonrpc":"2.0","id":2,"method":"model/list","params":{}}`); err != nil {
		return nil, fmt.Errorf("codex model/list write: %w", err)
	}
	for scanner.Scan() {
		var msg struct {
			ID     float64 `json:"id"`
			Result struct {
				Data []codexAppServerModelEntry `json:"data"`
			} `json:"result"`
			Error *struct {
				Code    int    `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &msg); err != nil {
			continue
		}
		if msg.ID != 2 {
			continue
		}
		if msg.Error != nil {
			return nil, fmt.Errorf("codex model/list rpc error: %s", msg.Error.Message)
		}
		out := make([]agentclient.ModelInfo, 0, len(msg.Result.Data))
		seen := map[string]struct{}{}
		for _, m := range msg.Result.Data {
			if m.Hidden {
				continue
			}
			id := strings.TrimSpace(m.ID)
			if id == "" {
				id = strings.TrimSpace(m.Model)
			}
			if id == "" {
				continue
			}
			if _, ok := seen[id]; ok {
				continue
			}
			seen[id] = struct{}{}
			display := strings.TrimSpace(m.DisplayName)
			if display == "" {
				display = id
			}
			out = append(out, agentclient.ModelInfo{ID: id, DisplayName: display})
		}
		if len(out) == 0 {
			return nil, fmt.Errorf("codex model/list returned 0 visible models")
		}
		return out, nil
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("codex app-server scan: %w", err)
	}
	return nil, fmt.Errorf("codex app-server closed without model/list response")
}

type codexCacheModelEntry struct {
	Slug           string `json:"slug"`
	Name           string `json:"name"`
	RealName       string `json:"real_name"`
	DisplayName    string `json:"display_name"`
	Description    string `json:"description"`
	Visibility     string `json:"visibility"`
	SupportedInAPI *bool  `json:"supported_in_api"`
}

// readCodexModelsCache reads ~/.codex/models_cache.json (the Codex CLI's
// persisted model list). Returns nil on any error / empty payload.
func readCodexModelsCache() []agentclient.ModelInfo {
	path := codexModelsCachePath()
	if path == "" {
		return nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var wrapper struct {
		Models []codexCacheModelEntry `json:"models"`
	}
	if err := json.Unmarshal(data, &wrapper); err != nil || len(wrapper.Models) == 0 {
		return nil
	}
	out := make([]agentclient.ModelInfo, 0, len(wrapper.Models))
	seen := map[string]struct{}{}
	for _, m := range wrapper.Models {
		if strings.EqualFold(strings.TrimSpace(m.Visibility), "hide") {
			continue
		}
		if m.SupportedInAPI != nil && !*m.SupportedInAPI {
			continue
		}
		id := strings.TrimSpace(m.Slug)
		if id == "" {
			id = strings.TrimSpace(m.Name)
		}
		if id == "" {
			id = strings.TrimSpace(m.RealName)
		}
		if id == "" {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		display := strings.TrimSpace(m.DisplayName)
		if display == "" {
			display = strings.TrimSpace(m.RealName)
		}
		if display == "" {
			display = id
		}
		out = append(out, agentclient.ModelInfo{ID: id, DisplayName: display})
	}
	return out
}

type codexGenericModelJSON struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	DisplayName string `json:"display_name"`
	Description string `json:"description"`
}

// tryCodexCliModelsJSON probes `codex models --json`. The Codex CLI
// rarely supports this subcommand, but historically the inventory layer
// tried it as a fallback so we keep parity.
func tryCodexCliModelsJSON(ctx context.Context, binary string) ([]agentclient.ModelInfo, error) {
	cmdCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(cmdCtx, binary, "models", "--json")
	out, err := cmd.CombinedOutput()
	if cmdCtx.Err() != nil {
		return nil, cmdCtx.Err()
	}
	if err != nil {
		return nil, fmt.Errorf("%s models --json failed: %w", binary, err)
	}
	if models, err := parseCodexGenericModelsJSON(out); err == nil && len(models) > 0 {
		return models, nil
	}
	return nil, fmt.Errorf("%s models --json: empty or unrecognized payload", binary)
}

func parseCodexGenericModelsJSON(out []byte) ([]agentclient.ModelInfo, error) {
	trimmed := strings.TrimSpace(string(out))
	if trimmed == "" {
		return nil, fmt.Errorf("empty payload")
	}
	if strings.HasPrefix(trimmed, "{") {
		var wrapper struct {
			Data   []codexGenericModelJSON `json:"data"`
			Models []codexGenericModelJSON `json:"models"`
		}
		if err := json.Unmarshal([]byte(trimmed), &wrapper); err != nil {
			return nil, err
		}
		raw := wrapper.Data
		if len(raw) == 0 {
			raw = wrapper.Models
		}
		return materializeCodexGenericModels(raw), nil
	}
	var raw []codexGenericModelJSON
	if err := json.Unmarshal([]byte(trimmed), &raw); err != nil {
		return nil, err
	}
	return materializeCodexGenericModels(raw), nil
}

func materializeCodexGenericModels(raw []codexGenericModelJSON) []agentclient.ModelInfo {
	models := make([]agentclient.ModelInfo, 0, len(raw))
	seen := map[string]struct{}{}
	for _, item := range raw {
		id := strings.TrimSpace(item.ID)
		if id == "" {
			id = strings.TrimSpace(item.Name)
		}
		if id == "" {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		display := strings.TrimSpace(item.DisplayName)
		if display == "" {
			display = strings.TrimSpace(item.Name)
		}
		if display == "" {
			display = id
		}
		models = append(models, agentclient.ModelInfo{ID: id, DisplayName: display})
	}
	return models
}

// Compile-time interface assertion.
var _ agentcore.ModelProvider = (*Agent)(nil)
