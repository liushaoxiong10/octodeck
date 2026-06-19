// Package claudecode — model discovery (ModelProvider implementation).
//
// This file owns the Claude family's model discovery logic end-to-end:
//
//  1. honour an explicit Policy.Model on the bound run request (when set);
//  2. parse ~/.claude/settings.json for ANTHROPIC_*_MODEL entries;
//  3. fall back to a small built-in catalogue.
//
// All helpers below are private to this package. The C-stage migration
// pulled the relevant logic out of internal/inventory/models.go so that
// the daemon main loop can satisfy proto-level model listing through the
// agentruntime.ModelProvider type assertion alone, without reaching back
// into inventory's family switch.
package claudecode

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	agentclient "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentclient"
	agentcore "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentcore"
	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
)

// Compile-time interface assertion: *Agent satisfies the optional
// ModelProvider capability defined in agentruntime/capabilities_optional.go.
var _ agentcore.ModelProvider = (*Agent)(nil)

// PolicyModel returns the trimmed model name from a request policy, or the
// empty string when the request leaves the model unset (in which case the
// embedded claudeacp adapter falls back to its DefaultRuntimeConfig).
//
// Kept exported so the existing run-time call sites (transport_acp /
// runtime.embeddedRuntimeConfig) can continue to use it.
func PolicyModel(req *proto.AgentRunRequestFrame) string {
	if req == nil {
		return ""
	}
	return strings.TrimSpace(req.Policy.Model)
}

// ListModels returns the model picker contents for the Claude family.
//
// Lookup order (first non-empty wins):
//
//  1. ~/.claude/settings.json — ANTHROPIC_*_MODEL env entries surface as
//     "<id> (Default)" / "<id> (Sonnet)" / etc., matching the historical
//     inventory behaviour.
//  2. The built-in default catalogue (Sonnet / Opus + the CLI aliases
//     "sonnet" / "opus").
//
// Errors are not surfaced for "no result" (the function simply returns
// the next fallback); ctx cancellation is honoured between steps.
func (a *Agent) ListModels(ctx context.Context) ([]agentclient.ModelInfo, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if models := readClaudeSettingsModels(); len(models) > 0 {
		return models, nil
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return defaultClaudeModels(), nil
}

// defaultClaudeModels mirrors the legacy inventory.claudeModelProfile
// DefaultModels list, kept private to this package.
func defaultClaudeModels() []agentclient.ModelInfo {
	return []agentclient.ModelInfo{
		{ID: "claude-sonnet-4-5", DisplayName: "Claude Sonnet 4.5"},
		{ID: "claude-opus-4-1", DisplayName: "Claude Opus 4.1"},
		{ID: "sonnet", DisplayName: "Sonnet (CLI alias)"},
		{ID: "opus", DisplayName: "Opus (CLI alias)"},
	}
}

// readClaudeSettingsModels parses ~/.claude/settings.json and surfaces the
// ANTHROPIC_*_MODEL env entries as model picker options. Mirrors the
// (since-decoupled) inventory.readClaudeSettingsModels exactly.
func readClaudeSettingsModels() []agentclient.ModelInfo {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return nil
	}
	data, err := os.ReadFile(filepath.Join(home, ".claude", "settings.json"))
	if err != nil {
		return nil
	}
	var wrapper struct {
		Env map[string]string `json:"env"`
	}
	if err := json.Unmarshal(data, &wrapper); err != nil {
		return nil
	}
	if len(wrapper.Env) == 0 {
		return nil
	}
	ordered := []struct {
		key, label string
	}{
		{"ANTHROPIC_MODEL", "Default"},
		{"ANTHROPIC_DEFAULT_OPUS_MODEL", "Opus"},
		{"ANTHROPIC_DEFAULT_SONNET_MODEL", "Sonnet"},
		{"ANTHROPIC_DEFAULT_HAIKU_MODEL", "Haiku"},
	}
	seen := map[string]struct{}{}
	out := make([]agentclient.ModelInfo, 0, len(ordered))
	for _, entry := range ordered {
		id := strings.TrimSpace(wrapper.Env[entry.key])
		if id == "" {
			continue
		}
		if _, dup := seen[id]; dup {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, agentclient.ModelInfo{
			ID:          id,
			DisplayName: fmt.Sprintf("%s (%s)", id, entry.label),
		})
	}
	return out
}
