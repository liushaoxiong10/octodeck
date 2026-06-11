package main

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
)

type modelDiscoverer struct {
	send func(any) error
}

func newModelDiscoverer(send func(any) error) *modelDiscoverer {
	return &modelDiscoverer{send: send}
}

func (d *modelDiscoverer) handle(ctx context.Context, req *ModelsRequestFrame) {
	go func() {
		started := time.Now()
		models, err := discoverProviderModels(ctx, req.ProviderID)
		var errPtr *string
		if err != nil {
			msg := err.Error()
			errPtr = &msg
		}
		_ = d.send(&ModelsResultFrame{
			Type:       tModelsResult,
			RequestID:  req.RequestID,
			OK:         err == nil,
			Models:     models,
			Error:      errPtr,
			DurationMs: time.Since(started).Milliseconds(),
		})
	}()
}

func discoverProviderModels(ctx context.Context, providerID string) ([]ModelInfo, error) {
	providerID = strings.TrimSpace(providerID)
	if providerID == "" {
		return nil, fmt.Errorf("providerId required")
	}
	clients := discoverAgentClients()
	var foundClient *AgentClientInfo
	for _, client := range clients {
		if client.ID == providerID {
			c := client
			foundClient = &c
			break
		}
	}
	if foundClient == nil {
		return nil, fmt.Errorf("provider not found on device: %s", providerID)
	}

	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	default:
	}

	// codex / codex-acp 优先走 app-server jsonrpc：CLI 自己的 `/model` 选择器
	// 实际上是同一份数据。这条路径要求用户已经登录 + 在线，因此失败会自动
	// 跌到下面的 cache / 内置 fallback。
	if providerID == "codex" || providerID == "codex-acp" {
		if models, err := tryCodexAppServerListModels(ctx, foundClient.Binary); err == nil && len(models) > 0 {
			return models, nil
		}
	}

	// 优先尝试从各 CLI 的本地 models_cache.json / models --json 拿实时列表，
	// CLI 没缓存或解析失败时再 fallback 到内置默认列表。这样官方上线新模型
	// （或用户登录新 provider）后无需 daemon 升级即可在 web 上选到。
	if models := readCliModelsCache(providerID); len(models) > 0 {
		return models, nil
	}
	if models, err := tryCliModelsJSON(ctx, foundClient.Binary); err == nil && len(models) > 0 {
		return models, nil
	}

	switch providerID {
	case "claude-code", "claude-acp":
		return []ModelInfo{
			{ID: "claude-sonnet-4-5", DisplayName: "Claude Sonnet 4.5"},
			{ID: "claude-opus-4-1", DisplayName: "Claude Opus 4.1"},
			{ID: "sonnet", DisplayName: "Sonnet (CLI alias)"},
			{ID: "opus", DisplayName: "Opus (CLI alias)"},
		}, nil
	case "codex", "codex-acp":
		return []ModelInfo{
			{ID: "gpt-5", DisplayName: "GPT-5"},
			{ID: "gpt-5-codex", DisplayName: "GPT-5 Codex"},
		}, nil
	case "traecli", "traecli-acp":
		// traecli 本身就支持 models --json；如果 tryCliModelsJSON 已经返回过这里
		// 不会到达。保留这条以便在 tryCliModelsJSON 因超时之类失败时不至于
		// 退回到 default 占位。
		return discoverTraeCliModels(ctx, foundClient.Binary)
	case "traex", "traex-acp":
		// traex 与 codex 调用约定一致，沿用 codex 的 GPT-5 系列默认模型列表。
		return []ModelInfo{
			{ID: "gpt-5", DisplayName: "GPT-5"},
			{ID: "gpt-5-codex", DisplayName: "GPT-5 Codex"},
		}, nil
	default:
		return []ModelInfo{{ID: "default", DisplayName: "Default"}}, nil
	}
}

// tryCodexAppServerListModels 启动 `codex app-server --listen stdio://` 子进程，
// 通过 jsonrpc 发 `initialize` + `model/list`，拿到与 codex CLI `/model` 选择器
// 完全一致的模型清单。
//
// 协议要点（见 codex_app_server_protocol schema）：
//   - 必须先调 `initialize`（params 至少给 clientInfo），server 返回基础信息后
//     才允许下发其它请求；
//   - `model/list` params 接 ModelListParams：cursor/limit/includeHidden 都可选；
//   - response.result 形如 `{ "data": [{ "id": "...", "displayName": "...",
//     "hidden": bool, "isDefault": bool, ... }], "nextCursor": "..." }`；
//   - 任何错误（OAuth 过期、地理拦截、token refresh 失败、`Not initialized`
//     等）都返回 err，让上层 fallback 到本地 cache / 内置默认列表。
//
// 我们故意不解析 nextCursor（首页通常已包含 `/model` 选择器里全部内容）。
// 如果以后需要分页可以扩展。
func tryCodexAppServerListModels(ctx context.Context, binary string) ([]ModelInfo, error) {
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
		if _, err := io.WriteString(stdin, payload+"\n"); err != nil {
			return err
		}
		return nil
	}
	if err := writeFrame(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"octodeck-daemon","version":"1"}}}`); err != nil {
		return nil, fmt.Errorf("codex initialize write: %w", err)
	}
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	// 读到 id=1 的响应后再发 model/list，确保 server 完成 init。
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
		out := make([]ModelInfo, 0, len(msg.Result.Data))
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
			out = append(out, ModelInfo{ID: id, DisplayName: display})
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

type codexAppServerModelEntry struct {
	ID          string `json:"id"`
	Model       string `json:"model"`
	DisplayName string `json:"displayName"`
	Description string `json:"description"`
	Hidden      bool   `json:"hidden"`
	IsDefault   bool   `json:"isDefault"`
}

// readCliModelsCache 读取各 CLI 在用户家目录下持久化的模型缓存：
//   - codex / codex-acp -> ~/.codex/models_cache.json
//   - traex / traex-acp -> ~/.trae/cli/models_cache.json (traex 与 trae 共用此目录)
//   - traecli / traecli-acp -> ~/.trae/cli/models_cache.json
//   - claude / claude-acp -> 暂无本地缓存，返回 nil 让上层 fallback 到内置列表
//
// 三家 CLI 的 cache 顶层结构基本一致：
//
//	{ "fetched_at": "...", "models": [{ "slug" / "name", "display_name" / "real_name", ... }] }
//
// `visibility=hide` 的条目（如 codex-auto-review）会被过滤掉，不暴露到 web 选择器里。
func readCliModelsCache(providerID string) []ModelInfo {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return nil
	}
	candidates := cliModelsCachePaths(providerID, home)
	for _, path := range candidates {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		if models := parseCliModelsCache(data); len(models) > 0 {
			return models
		}
	}
	return nil
}

func cliModelsCachePaths(providerID, home string) []string {
	switch providerID {
	case "codex", "codex-acp":
		return []string{filepath.Join(home, ".codex", "models_cache.json")}
	case "traex", "traex-acp", "traecli", "traecli-acp":
		// trae 系列 CLI 共享 ~/.trae/cli/ 作为状态目录。
		return []string{filepath.Join(home, ".trae", "cli", "models_cache.json")}
	default:
		return nil
	}
}

// cliCacheModelEntry 兼容 codex / trae cli 两家 cache 的字段：
//   - codex: {slug, display_name, visibility, supported_in_api, ...}
//   - trae:  {slug | name, display_name | real_name, visibility?, ...}
type cliCacheModelEntry struct {
	Slug           string `json:"slug"`
	Name           string `json:"name"`
	RealName       string `json:"real_name"`
	DisplayName    string `json:"display_name"`
	Description    string `json:"description"`
	Visibility     string `json:"visibility"`
	SupportedInAPI *bool  `json:"supported_in_api"`
}

func parseCliModelsCache(data []byte) []ModelInfo {
	var wrapper struct {
		Models []cliCacheModelEntry `json:"models"`
	}
	if err := json.Unmarshal(data, &wrapper); err != nil || len(wrapper.Models) == 0 {
		return nil
	}
	out := make([]ModelInfo, 0, len(wrapper.Models))
	seen := map[string]struct{}{}
	for _, m := range wrapper.Models {
		// hidden / 不支持 API 调用的条目不暴露到 web 选择器，避免误选。
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
		out = append(out, ModelInfo{ID: id, DisplayName: display})
	}
	return out
}

// tryCliModelsJSON 调用 `<binary> models --json` 解析模型列表。
// 不支持该子命令、超时、解析失败、空列表都视为失败，返回 err 让上层走 fallback。
//
// 兼容两种 JSON 形态：
//  1. traecli 风格：[{"name":"...", "real_name":"...", "description":"..."}, ...]
//  2. 通用 OpenAI 风格：{"data":[{"id":"...", "name":"..."}, ...]} 或
//     [{"id":"...", "name":"..."}, ...]
func tryCliModelsJSON(ctx context.Context, binary string) ([]ModelInfo, error) {
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

type genericModelJSON struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	DisplayName string `json:"display_name"`
	Description string `json:"description"`
}

func parseGenericModelsJSON(out []byte) ([]ModelInfo, error) {
	trimmed := strings.TrimSpace(string(out))
	if trimmed == "" {
		return nil, fmt.Errorf("empty payload")
	}
	// 形如 {"data":[...]}
	if strings.HasPrefix(trimmed, "{") {
		var wrapper struct {
			Data   []genericModelJSON `json:"data"`
			Models []genericModelJSON `json:"models"`
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
	// 形如 [{...}, ...]
	var raw []genericModelJSON
	if err := json.Unmarshal([]byte(trimmed), &raw); err != nil {
		return nil, err
	}
	return materializeGenericModels(raw), nil
}

func materializeGenericModels(raw []genericModelJSON) []ModelInfo {
	models := make([]ModelInfo, 0, len(raw))
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
		models = append(models, ModelInfo{ID: id, DisplayName: display})
	}
	return models
}

type traeCliModelJSON struct {
	Name        string `json:"name"`
	RealName    string `json:"real_name"`
	Description string `json:"description"`
}

func discoverTraeCliModels(ctx context.Context, binary string) ([]ModelInfo, error) {
	cmdCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(cmdCtx, binary, "models", "--json")
	out, err := cmd.CombinedOutput()
	if cmdCtx.Err() != nil {
		return nil, cmdCtx.Err()
	}
	if err != nil {
		return nil, fmt.Errorf("traecli models --json failed: %w: %s", err, strings.TrimSpace(string(out)))
	}

	models, err := parseTraeCliModelsJSON(out)
	if err != nil {
		return nil, err
	}
	if len(models) == 0 {
		return nil, fmt.Errorf("traecli models --json returned no models")
	}
	return models, nil
}

func parseTraeCliModelsJSON(out []byte) ([]ModelInfo, error) {
	var raw []traeCliModelJSON
	if err := json.Unmarshal(out, &raw); err != nil {
		return nil, fmt.Errorf("parse traecli models json failed: %w", err)
	}
	models := make([]ModelInfo, 0, len(raw))
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
		displayName := strings.TrimSpace(item.RealName)
		if displayName == "" {
			displayName = id
		}
		models = append(models, ModelInfo{ID: id, DisplayName: displayName})
	}
	return models, nil
}
