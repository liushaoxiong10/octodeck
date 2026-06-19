// Package codex implements the Codex (OpenAI Codex CLI) agent runtime.
//
// It mirrors the original daemonapp.codexAgent behaviour exactly:
//
//   - Connect: stdio transport writes the per-cwd Codex MCP config; ACP
//     transport is a no-op.
//   - RunPrompt: stdio transport spawns the codex CLI; ACP transport
//     delegates to agentruntime.ACPConnection (which can use the embedded
//     codexacp adapter when present).
//   - BuildRunCommand: composes the argv via agentspec.CodexArgvBuilder.
//   - Run: implements EmbeddedACPBackend.Run, delegating to codexacp.RunStdio
//     with a runtime config derived from the per-request policy.
//   - SupportsNativeSystemPrompt returns true: codex accepts the system
//     prompt natively.
//
// All other lifecycle methods (Discover, CreateSession, ListSessions,
// DeleteSession) are inherited from agentcore.BaseAgent.
package codex

import (
	"context"
	"errors"
	"io"
	"os"
	"strings"

	"github.com/beyond5959/acp-adapter/pkg/codexacp"

	agentcore "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentcore"
	agentprotocol "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentprotocol"
	daemonconfig "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/config"
	mcp "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/mcp"
	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
)

// Agent is the Codex agent runtime. It embeds agentcore.BaseAgent for the
// default lifecycle implementations and overrides Connect, RunPrompt, and the
// embedded ACP entrypoints.
type Agent struct {
	agentcore.BaseAgent
}

// Connect prepares the per-cwd codex MCP configuration for stdio runs. ACP
// runs configure MCP servers per-session, so no global config is needed in
// that case.
func (a *Agent) Connect(_ context.Context, run *agentprotocol.RunContext) error {
	if a.Transport() == "acp" {
		return nil
	}
	return mcp.WriteCodexConfigForDaemon(run.Cfg, run.Req, run.Cwd, "codex")
}

// BuildRunCommand composes the argv for the codex CLI for stdio runs.
func (a *Agent) BuildRunCommand(_ *daemonconfig.Config, req *proto.AgentRunRequestFrame) ([]string, bool, error) {
	return buildStdioArgv(req), true, nil
}

// ListSessions overrides BaseAgent.ListSessions and routes session
// enumeration through the codex sub-package helper, which keeps the
// provider-directory layout private to the family.
func (a *Agent) ListSessions(ctx context.Context, cfg *daemonconfig.Config, workspace string) ([]proto.AgentSessionInfo, error) {
	return ListSessions(ctx, cfg, a.Client.ID, workspace)
}

// DeleteSession overrides BaseAgent.DeleteSession with the codex
// sub-package implementation.
func (a *Agent) DeleteSession(ctx context.Context, cfg *daemonconfig.Config, workspace, sessionID string) (bool, error) {
	return DeleteSession(ctx, cfg, a.Client.ID, workspace, sessionID)
}

// RunPrompt dispatches stdio runs directly. Built-in ACP runs are owned by
// conversation runtime before this fallback path is reached.
func (a *Agent) RunPrompt(ctx context.Context, run *agentprotocol.RunContext) (proto.AgentRunResultFrame, error) {
	if a.Transport() == "acp" {
		return proto.AgentRunResultFrame{}, errors.New("codex ACP transport must run through conversation runtime")
	}
	argv, outputJSON, err := a.BuildRunCommand(run.Cfg, run.Req)
	if err != nil {
		return proto.AgentRunResultFrame{}, err
	}
	return agentcore.RunStdioAgentPrompt(ctx, run, argv, outputJSON)
}

// Run implements agentruntime.EmbeddedACPBackend by handing control to
// codexacp.RunStdio with a runtime config derived from the per-request policy.
func (a *Agent) Run(ctx context.Context, req *proto.AgentRunRequestFrame, stdin io.Reader, stdout io.Writer, stderr io.Writer) error {
	return codexacp.RunStdio(ctx, a.embeddedRuntimeConfig(req), stdin, stdout, stderr)
}

// SupportsNativeSystemPrompt tells ACPConnection that codex accepts the system
// prompt natively, so it should not be prepended to the user prompt text.
func (a *Agent) SupportsNativeSystemPrompt() bool { return true }

// embeddedRuntimeConfig builds the codexacp.RuntimeConfig for a single run.
func (a *Agent) embeddedRuntimeConfig(req *proto.AgentRunRequestFrame) codexacp.RuntimeConfig {
	config := codexacp.DefaultRuntimeConfig()
	config.AppServerCommand = a.Client.Binary
	config.AppServerArgs = []string{"app-server", "-c", "model_reasoning_summary=\"detailed\""}
	if raw := strings.TrimSpace(os.Getenv("CODEX_APP_SERVER_ARGS")); raw != "" {
		config.AppServerArgs = strings.Fields(raw)
	}
	config.LogLevel = agentcore.FirstNonEmpty(os.Getenv("ACP_ADAPTER_LOG_LEVEL"), os.Getenv("LOG_LEVEL"), "info")
	config.TraceJSON = agentcore.ParseBoolEnv(os.Getenv("ACP_ADAPTER_TRACE_JSON"), false)
	config.TraceJSONFile = agentcore.FirstNonEmpty(os.Getenv("ACP_ADAPTER_TRACE_JSON_FILE"), os.Getenv("TRACE_JSON_FILE"), "trace-jsonl.log")
	config.PatchApplyMode = agentcore.FirstNonEmpty(os.Getenv("ACP_ADAPTER_PATCH_APPLY_MODE"), os.Getenv("PATCH_APPLY_MODE"), "appserver")
	config.RetryTurnOnCrash = agentcore.ParseBoolEnv(os.Getenv("RETRY_TURN_ON_CRASH"), true)
	config.InitialAuthMode = detectCodexAuthMode()
	if req != nil && (strings.TrimSpace(req.Policy.Model) != "" || strings.TrimSpace(req.Policy.SystemPrompt) != "" || strings.TrimSpace(req.Policy.PermissionMode) != "") {
		config.Profiles = map[string]codexacp.ProfileConfig{
			"octodeck": {Model: strings.TrimSpace(req.Policy.Model), Sandbox: mapPermissionMode(req.Policy.PermissionMode), SystemInstructions: strings.TrimSpace(req.Policy.SystemPrompt)},
		}
		config.DefaultProfile = "octodeck"
	}
	return config
}

// detectCodexAuthMode resolves the InitialAuthMode passed into codexacp from
// the environment. Order matters: explicit Codex API key wins over OPENAI_API_KEY,
// which wins over an active ChatGPT subscription.
func detectCodexAuthMode() string {
	if strings.TrimSpace(os.Getenv("CODEX_API_KEY")) != "" {
		return "codex_api_key"
	}
	if strings.TrimSpace(os.Getenv("OPENAI_API_KEY")) != "" {
		return "openai_api_key"
	}
	if agentcore.ParseBoolEnv(os.Getenv("CHATGPT_SUBSCRIPTION_ACTIVE"), true) {
		return "chatgpt_subscription"
	}
	return ""
}
