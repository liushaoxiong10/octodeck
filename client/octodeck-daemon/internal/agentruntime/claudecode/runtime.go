// Package claudecode implements the Claude (Claude Code) agent runtime.
//
// It mirrors the original daemonapp.claudeAgent behaviour exactly:
//
//   - Connect: stdio transport writes the global MCP config; ACP transport is
//     a no-op (the ACP backend wires its own MCP servers per session).
//   - RunPrompt: stdio transport pipes prompt text via the stdio CLI surface;
//     ACP transport delegates to agentruntime.ACPConnection (which can use the
//     embedded claudeacp adapter when present).
//   - BuildRunCommand: composes the argv via agentspec.ClaudeArgvBuilder and
//     appends `--mcp-config <path>` so the spawned CLI sees the MCP servers.
//   - Run: implements EmbeddedACPBackend.Run, delegating to claudeacp.RunStdio
//     with a runtime config derived from the per-request policy.
//   - SupportsNativeSystemPrompt returns true: claude accepts the system
//     prompt natively, so ACPConnection should not prepend it to user text.
//
// All other lifecycle methods (Discover, CreateSession, ListSessions,
// DeleteSession) are inherited from agentcore.BaseAgent.
package claudecode

import (
	"context"
	"errors"
	"io"
	"os"
	"strings"

	"github.com/beyond5959/acp-adapter/pkg/claudeacp"

	agentcore "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentcore"
	agentprotocol "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentprotocol"
	daemonconfig "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/config"
	mcp "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/mcp"
	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
)

// Agent is the Claude (Claude Code) agent runtime. It embeds
// agentcore.BaseAgent for the default lifecycle implementations and
// overrides Connect, RunPrompt, and the embedded ACP entrypoints.
type Agent struct {
	agentcore.BaseAgent
}

// Connect prepares the per-process MCP configuration for stdio runs. ACP runs
// configure MCP servers on the per-session NewSession/LoadSession requests, so
// no global config is needed in that case.
func (a *Agent) Connect(_ context.Context, run *agentprotocol.RunContext) error {
	if a.Transport() == "acp" {
		return nil
	}
	_, err := mcp.WriteGlobalConfigForDaemon(run.Cfg, run.Req.Env)
	return err
}

// BuildRunCommand composes the argv passed to the claude CLI for stdio runs,
// and writes the global MCP config so the spawned CLI can pick it up via
// `--mcp-config`. The returned outputJSON flag tells the stdio transport
// whether to expect newline-delimited JSON on stdout.
func (a *Agent) BuildRunCommand(cfg *daemonconfig.Config, req *proto.AgentRunRequestFrame) ([]string, bool, error) {
	argv := buildStdioArgv(req)
	mcpConfig, err := mcp.WriteGlobalConfigForDaemon(cfg, req.Env)
	if err != nil {
		return nil, false, err
	}
	argv = append(argv, "--mcp-config", mcpConfig)
	return argv, true, nil
}

// RunPrompt dispatches stdio runs directly. Built-in ACP runs are owned by
// conversation runtime before this fallback path is reached.
func (a *Agent) RunPrompt(ctx context.Context, run *agentprotocol.RunContext) (proto.AgentRunResultFrame, error) {
	if a.Transport() == "acp" {
		return proto.AgentRunResultFrame{}, errors.New("claude ACP transport must run through conversation runtime")
	}
	argv, outputJSON, err := a.BuildRunCommand(run.Cfg, run.Req)
	if err != nil {
		return proto.AgentRunResultFrame{}, err
	}
	return agentcore.RunStdioAgentPrompt(ctx, run, argv, outputJSON)
}

// Run implements agentruntime.EmbeddedACPBackend by handing control to
// claudeacp.RunStdio with a runtime config derived from the per-request
// policy.
func (a *Agent) Run(ctx context.Context, req *proto.AgentRunRequestFrame, stdin io.Reader, stdout io.Writer, stderr io.Writer) error {
	return claudeacp.RunStdio(ctx, a.embeddedRuntimeConfig(req), stdin, stdout, stderr)
}

// ListSessions overrides the BaseAgent implementation so the family
// owns its provider-directory layout. It delegates to the package-local
// helper, threading the agent's discovered client ID for the legacy
// agent-id sub-directory fallback.
func (a *Agent) ListSessions(ctx context.Context, cfg *daemonconfig.Config, workspace string) ([]proto.AgentSessionInfo, error) {
	return ListSessions(ctx, cfg, a.Client.ID, workspace)
}

// DeleteSession overrides the BaseAgent implementation for the same
// reasons documented on ListSessions.
func (a *Agent) DeleteSession(ctx context.Context, cfg *daemonconfig.Config, workspace, sessionID string) (bool, error) {
	return DeleteSession(ctx, cfg, a.Client.ID, workspace, sessionID)
}

// SupportsNativeSystemPrompt tells ACPConnection that claude accepts the
// system prompt natively, so it should not be prepended to the user prompt
// text on new sessions.
func (a *Agent) SupportsNativeSystemPrompt() bool { return true }

// embeddedRuntimeConfig builds the claudeacp.RuntimeConfig for a single run.
// Identical to the original daemonapp.claudeAgent.embeddedRuntimeConfig:
//
//   - ClaudeBin from the discovered client binary.
//   - Per-request policy maps to a transient "octodeck" profile when either
//     model or system instructions are set; SkipPerms / AllowedTools come from
//     the policy.
//   - Logging, JSON tracing, and patch-apply mode mirror env-var conventions
//     (ACP_ADAPTER_*, with LOG_LEVEL / TRACE_JSON_FILE / PATCH_APPLY_MODE
//     fallbacks) so existing operator runbooks keep working.
func (a *Agent) embeddedRuntimeConfig(req *proto.AgentRunRequestFrame) claudeacp.RuntimeConfig {
	config := claudeacp.DefaultRuntimeConfig()
	config.ClaudeBin = a.Client.Binary
	if req != nil {
		profile := claudeacp.ProfileConfig{}
		if strings.TrimSpace(req.Policy.Model) != "" {
			model := strings.TrimSpace(req.Policy.Model)
			config.DefaultModel = model
			config.AvailableModels = append(config.AvailableModels, config.DefaultModel)
			profile.Model = model
		}
		profile.SystemInstructions = strings.TrimSpace(req.Policy.SystemPrompt)
		if profile.Model != "" || profile.SystemInstructions != "" {
			config.Profiles = map[string]claudeacp.ProfileConfig{"octodeck": profile}
			config.DefaultProfile = "octodeck"
		}
		config.SkipPerms = agentcore.ShouldAutoApprovePermission(req.Policy)
		if len(req.Policy.AllowedTools) > 0 {
			config.AllowedTools = strings.Join(req.Policy.AllowedTools, ",")
		}
	}
	config.LogLevel = agentcore.FirstNonEmpty(os.Getenv("ACP_ADAPTER_LOG_LEVEL"), os.Getenv("LOG_LEVEL"), "info")
	config.TraceJSON = agentcore.ParseBoolEnv(os.Getenv("ACP_ADAPTER_TRACE_JSON"), false)
	config.TraceJSONFile = agentcore.FirstNonEmpty(os.Getenv("ACP_ADAPTER_TRACE_JSON_FILE"), os.Getenv("TRACE_JSON_FILE"), "trace-jsonl.log")
	config.PatchApplyMode = agentcore.FirstNonEmpty(os.Getenv("ACP_ADAPTER_PATCH_APPLY_MODE"), os.Getenv("PATCH_APPLY_MODE"), "appserver")
	return config
}
