// Package traex — model discovery helper.
//
// 阶段 C: 把 traex family 自家的模型枚举从 internal/inventory 下沉到本子
// 包。inventory 层未来只剩薄薄的聚合调用（阶段 E2），不再认识 "traex"
// 字面量。
//
// traex 的模型发现策略:
//
//  1. 读 ~/.trae/cli/models_cache.json （CLI 自己持久化的列表）；
//  2. 跑 `<binary> models --json`，兼容 trae-cli/通用两种 JSON shape；
//  3. fallback 到 codex-style 内置默认（gpt-5 / gpt-5-codex）。
//
// 与 inventory.traexModelProfile 对齐：traex 不走 codex app-server jsonrpc
// （UseAppServerModelList=false），保持与历史 daemon 行为一致。如果未来要
// 引入 app-server 模型枚举，应当复制一份 helper 到本包，避免跨 family
// 强耦合 (plan §5.5)。
package traex

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

// ListModels 实现 agentruntime.ModelProvider。优先 CLI cache → `models
// --json` → 内置默认。任意一步成功且非空即返回。
func (a *Agent) ListModels(ctx context.Context) ([]agentclient.ModelInfo, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if models := readCliModelsCache(); len(models) > 0 {
		return models, nil
	}
	binary := strings.TrimSpace(a.Client.Binary)
	if binary != "" {
		if models, err := tryCliModelsJSON(ctx, binary); err == nil && len(models) > 0 {
			return models, nil
		}
	}
	return defaultModels(), nil
}

var _ agentcore.ModelProvider = (*Agent)(nil)

// defaultModels 返回 traex family 的兜底模型清单（与历史 codex-style 默认
// 一致；traex 与 codex 共用同一组上游模型）。
func defaultModels() []agentclient.ModelInfo {
	return []agentclient.ModelInfo{
		{ID: "gpt-5", DisplayName: "GPT-5"},
		{ID: "gpt-5-codex", DisplayName: "GPT-5 Codex"},
	}
}

// readCliModelsCache 读取 ~/.trae/cli/models_cache.json。
func readCliModelsCache() []agentclient.ModelInfo {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return nil
	}
	path := filepath.Join(home, ".trae", "cli", "models_cache.json")
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	return parseCliModelsCache(data)
}

type cliCacheModelEntry struct {
	Slug           string `json:"slug"`
	Name           string `json:"name"`
	RealName       string `json:"real_name"`
	DisplayName    string `json:"display_name"`
	Description    string `json:"description"`
	Visibility     string `json:"visibility"`
	SupportedInAPI *bool  `json:"supported_in_api"`
}

func parseCliModelsCache(data []byte) []agentclient.ModelInfo {
	var wrapper struct {
		Models []cliCacheModelEntry `json:"models"`
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

// tryCliModelsJSON 调 `<binary> models --json` 拿 CLI 实时列表。
func tryCliModelsJSON(ctx context.Context, binary string) ([]agentclient.ModelInfo, error) {
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

func parseGenericModelsJSON(out []byte) ([]agentclient.ModelInfo, error) {
	trimmed := strings.TrimSpace(string(out))
	if trimmed == "" {
		return nil, fmt.Errorf("empty payload")
	}
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
	var raw []genericModelJSON
	if err := json.Unmarshal([]byte(trimmed), &raw); err != nil {
		return nil, err
	}
	return materializeGenericModels(raw), nil
}

func materializeGenericModels(raw []genericModelJSON) []agentclient.ModelInfo {
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

type traeCliModelJSON struct {
	Name        string `json:"name"`
	RealName    string `json:"real_name"`
	Description string `json:"description"`
}

func parseTraeCliModelsJSON(out []byte) ([]agentclient.ModelInfo, error) {
	var raw []traeCliModelJSON
	if err := json.Unmarshal(out, &raw); err != nil {
		return nil, fmt.Errorf("parse trae cli models json failed: %w", err)
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
		displayName := strings.TrimSpace(item.RealName)
		if displayName == "" {
			displayName = id
		}
		models = append(models, agentclient.ModelInfo{ID: id, DisplayName: displayName})
	}
	return models, nil
}
