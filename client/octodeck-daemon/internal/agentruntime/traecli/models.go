// Package traecli — model discovery helper.
//
// Per-family model discovery for the Trae CLI family. The discovery
// pipeline follows the CLI-visible model list:
//
//  1. Run `traecli models --json` (parsed via the trae-cli
//     specific schema first, then the generic id/name schema).
//  2. Fallback to ~/.trae/cli/models_cache.json (the CLI maintains this cache
//     after a successful login / model sync).
//  3. Final fallback to a single "default" entry whose display label
//     reads "Default (CLI configured)" — older / enterprise traecli
//     builds may require login or a network call before models --json
//     works, and we still want chat to load.
package traecli

import (
	"context"
	"encoding/json"
	"fmt"
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

// ListModels implements agentruntime.ModelProvider for the Trae CLI family.
//
// It tries `traecli models --json` first, then the local models_cache.json,
// then falls back to a single "default" entry. The returned slice is never
// nil on success.
func (a *Agent) ListModels(ctx context.Context) ([]agentclient.ModelInfo, error) {
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	default:
	}

	binary := strings.TrimSpace(a.Client.Binary)
	if binary == "" {
		binary = "traecli"
	}
	if models, err := tryTraeCliModelsJSON(ctx, binary); err == nil && len(models) > 0 {
		return models, nil
	}
	if models := readTraeCliModelsCache(); len(models) > 0 {
		return models, nil
	}
	// Older/enterprise traecli builds may require login or a network call for
	// `models --json`; still surface a single placeholder entry so the chat
	// page can render and users can type a custom model manually.
	return []agentclient.ModelInfo{{ID: "default", DisplayName: "Default (CLI configured)"}}, nil
}

// traeCliModelCachePaths returns the candidate paths for the trae CLI's
// local models cache. Mirrors the historical agentruntime.TraeCLIModelCachePaths
// helper but lives privately in this sub-package.
func traeCliModelCachePaths(home string) []string {
	return []string{filepath.Join(home, ".trae", "cli", "models_cache.json")}
}

func readTraeCliModelsCache() []agentclient.ModelInfo {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return nil
	}
	for _, path := range traeCliModelCachePaths(home) {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		if models := parseTraeCliModelsCache(data); len(models) > 0 {
			return models
		}
	}
	return nil
}

type traeCliCacheModelEntry struct {
	Slug           string `json:"slug"`
	Name           string `json:"name"`
	RealName       string `json:"real_name"`
	DisplayName    string `json:"display_name"`
	ConfigName     string `json:"config_name"`
	Description    string `json:"description"`
	Visibility     string `json:"visibility"`
	SupportedInAPI *bool  `json:"supported_in_api"`
}

func parseTraeCliModelsCache(data []byte) []agentclient.ModelInfo {
	var wrapper struct {
		Models []traeCliCacheModelEntry `json:"models"`
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
		id := strings.TrimSpace(m.ConfigName)
		if id == "" {
			id = strings.TrimSpace(m.Slug)
		}
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
			display = strings.TrimSpace(m.Slug)
		}
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

func tryTraeCliModelsJSON(ctx context.Context, binary string) ([]agentclient.ModelInfo, error) {
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
	if models, err := parseTraeCliModelsJSON(out); err == nil && len(models) > 0 {
		return models, nil
	}
	if models, err := parseGenericModelsJSON(out); err == nil && len(models) > 0 {
		return models, nil
	}
	return nil, fmt.Errorf("%s models --json: empty or unrecognized payload", binary)
}

type traeCliModelJSONEntry struct {
	Name        string `json:"name"`
	RealName    string `json:"real_name"`
	Description string `json:"description"`
}

// parseTraeCliModelsJSON parses the trae CLI's `models --json` output, which
// uses the {name, real_name, description} schema. Mirrors the historical
// inventory.parseTraeCliModelsJSON exactly.
func parseTraeCliModelsJSON(out []byte) ([]agentclient.ModelInfo, error) {
	var raw []traeCliModelJSONEntry
	if err := json.Unmarshal(out, &raw); err != nil {
		return nil, fmt.Errorf("parse traecli models json failed: %w", err)
	}
	models := make([]agentclient.ModelInfo, 0, len(raw))
	seen := map[string]struct{}{}
	for _, item := range raw {
		id := strings.TrimSpace(item.Name)
		if id == "" {
			id = strings.TrimSpace(item.RealName)
		}
		if id == "" {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		display := strings.TrimSpace(item.RealName)
		if display == "" {
			display = id
		}
		models = append(models, agentclient.ModelInfo{ID: id, DisplayName: display})
	}
	return models, nil
}

type genericModelJSONEntry struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	DisplayName string `json:"display_name"`
	Description string `json:"description"`
}

func parseGenericModelsJSON(out []byte) ([]agentclient.ModelInfo, error) {
	trimmed := strings.TrimSpace(string(out))
	if trimmed == "" {
		return nil, fmt.Errorf("empty payload")
	}
	if strings.HasPrefix(trimmed, "{") {
		var wrapper struct {
			Data   []genericModelJSONEntry `json:"data"`
			Models []genericModelJSONEntry `json:"models"`
		}
		if err := json.Unmarshal([]byte(trimmed), &wrapper); err != nil {
			return nil, err
		}
		raw := wrapper.Data
		if len(raw) == 0 {
			raw = wrapper.Models
		}
		return materializeGenericModels(raw), nil
	}
	var raw []genericModelJSONEntry
	if err := json.Unmarshal([]byte(trimmed), &raw); err != nil {
		return nil, err
	}
	return materializeGenericModels(raw), nil
}

func materializeGenericModels(raw []genericModelJSONEntry) []agentclient.ModelInfo {
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

// Compile-time assertion that *Agent implements agentruntime.ModelProvider.
var _ agentcore.ModelProvider = (*Agent)(nil)
