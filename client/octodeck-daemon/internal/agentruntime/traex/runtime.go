// Package traex implements the TraeX (Trae extended / app-server) agent
// runtime.
//
// It mirrors the original daemonapp.traexAgent behaviour exactly:
//
//   - Connect: stdio transport writes the per-cwd Trae MCP config (under
//     the "traex" provider key); ACP transport is a no-op.
//   - RunPrompt: stdio transport spawns the traex CLI; ACP transport
//     delegates to agentruntime.ACPConnection (which uses the embedded
//     codexacp adapter with traex-specific app-server args).
//   - BuildRunCommand: composes the argv via the family-private
//     buildStdioArgv (formerly agentspec.TraexArgvBuilder).
//   - Run: implements EmbeddedACPBackend.Run, delegating to codexacp.RunStdio
//     with InitialAuthMode = "traex_cli".
//   - SupportsNativeSystemPrompt returns false; the first ACP prompt carries
//     the OctoDeck system context explicitly.
//
// All other lifecycle methods (Discover, CreateSession) are inherited from
// agentcore.BaseAgent. ListSessions / DeleteSession are overridden in
// this package to route through the family-private sessions helpers.
package traex

import (
	"context"
	"errors"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"

	"github.com/beyond5959/acp-adapter/pkg/codexacp"

	agentcore "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentcore"
	agentprotocol "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentprotocol"
	daemonconfig "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/config"
	mcp "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/mcp"
	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
)

// Agent is the TraeX agent runtime. It embeds agentcore.BaseAgent for the
// default lifecycle implementations and overrides Connect, RunPrompt, and the
// embedded ACP entrypoints.
type Agent struct {
	agentcore.BaseAgent
}

// Connect prepares the per-cwd traex MCP configuration for stdio runs.
func (a *Agent) Connect(_ context.Context, run *agentprotocol.RunContext) error {
	if a.Transport() == "acp" {
		return nil
	}
	return mcp.WriteCodexConfigForDaemon(run.Cfg, run.Req, run.Cwd, "traex")
}

// BuildRunCommand composes the argv for the traex CLI for stdio runs.
func (a *Agent) BuildRunCommand(_ *daemonconfig.Config, req *proto.AgentRunRequestFrame) ([]string, bool, error) {
	return buildStdioArgv(req), true, nil
}

// ListSessions overrides BaseAgent.ListSessions and routes session
// enumeration through the traex sub-package helper, which keeps the
// provider-directory layout private to the family.
func (a *Agent) ListSessions(ctx context.Context, cfg *daemonconfig.Config, workspace string) ([]proto.AgentSessionInfo, error) {
	return ListSessions(ctx, cfg, a.Client.ID, workspace)
}

// DeleteSession overrides BaseAgent.DeleteSession with the traex
// sub-package implementation.
func (a *Agent) DeleteSession(ctx context.Context, cfg *daemonconfig.Config, workspace, sessionID string) (bool, error) {
	return DeleteSession(ctx, cfg, a.Client.ID, workspace, sessionID)
}

// RunPrompt dispatches stdio runs directly. Built-in ACP runs are owned by
// conversation runtime before this fallback path is reached.
func (a *Agent) RunPrompt(ctx context.Context, run *agentprotocol.RunContext) (proto.AgentRunResultFrame, error) {
	if a.Transport() == "acp" {
		return proto.AgentRunResultFrame{}, errors.New("traex ACP transport must run through conversation runtime")
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

// SupportsNativeSystemPrompt tells ACPConnection to include OctoDeck's system
// prompt in the first session prompt. The traex/acp-adapter profile path does
// not reliably place it in the provider-visible first message.
func (a *Agent) SupportsNativeSystemPrompt() bool { return false }

// MemoryPath implements agentruntime.MemorySource. TraeX shares the TRAE
// home layout; user-level long-form instructions live under
// ~/.trae/AGENTS.md rather than a separate ~/.traex tree.
func (a *Agent) MemoryPath(home string) string {
	if strings.TrimSpace(home) == "" {
		return ""
	}
	return filepath.Join(home, ".trae", "AGENTS.md")
}

var _ agentcore.MemorySource = (*Agent)(nil)

// embeddedRuntimeConfig builds the codexacp.RuntimeConfig for a single run.
// It differs from codex.embeddedRuntimeConfig in the AppServerArgs default,
// the env-var prefix (TRAEX_APP_SERVER_ARGS), and InitialAuthMode = "traex_cli".
func (a *Agent) embeddedRuntimeConfig(req *proto.AgentRunRequestFrame) codexacp.RuntimeConfig {
	config := codexacp.DefaultRuntimeConfig()
	config.AppServerCommand = a.Client.Binary
	config.AppServerArgs = []string{"app-server", "-c", "model_reasoning_summary=\"detailed\""}
	if raw := strings.TrimSpace(os.Getenv("TRAEX_APP_SERVER_ARGS")); raw != "" {
		config.AppServerArgs = strings.Fields(raw)
	}
	permissionMode := ""
	if req != nil {
		permissionMode = req.Policy.PermissionMode
	}
	config.AppServerArgs = withPermissionPrefix(config.AppServerArgs, permissionMode)
	config.LogLevel = agentcore.FirstNonEmpty(os.Getenv("ACP_ADAPTER_LOG_LEVEL"), os.Getenv("LOG_LEVEL"), "info")
	config.TraceJSON = agentcore.ParseBoolEnv(os.Getenv("ACP_ADAPTER_TRACE_JSON"), false)
	config.TraceJSONFile = agentcore.FirstNonEmpty(os.Getenv("ACP_ADAPTER_TRACE_JSON_FILE"), os.Getenv("TRACE_JSON_FILE"), "trace-jsonl.log")
	config.PatchApplyMode = agentcore.FirstNonEmpty(os.Getenv("ACP_ADAPTER_PATCH_APPLY_MODE"), os.Getenv("PATCH_APPLY_MODE"), "appserver")
	config.RetryTurnOnCrash = agentcore.ParseBoolEnv(os.Getenv("RETRY_TURN_ON_CRASH"), true)
	config.InitialAuthMode = "traex_cli"
	if req != nil && (strings.TrimSpace(req.Policy.Model) != "" || strings.TrimSpace(req.Policy.SystemPrompt) != "" || strings.TrimSpace(req.Policy.PermissionMode) != "") {
		config.Profiles = map[string]codexacp.ProfileConfig{
			"octodeck": {Model: strings.TrimSpace(req.Policy.Model), ApprovalPolicy: mapApprovalPolicyPermissionMode(req.Policy.PermissionMode), Sandbox: mapSandboxPermissionMode(req.Policy.PermissionMode), SystemInstructions: strings.TrimSpace(req.Policy.SystemPrompt)},
		}
		config.DefaultProfile = "octodeck"
	}
	log.Printf("octodeck-daemon: traex embedded runtime config permissionMode=%q approvalPolicy=%q sandbox=%q appServerArgs=%q defaultProfile=%q", strings.TrimSpace(permissionMode), mapApprovalPolicyPermissionMode(permissionMode), mapSandboxPermissionMode(permissionMode), strings.Join(config.AppServerArgs, " "), config.DefaultProfile)
	return config
}

func withPermissionPrefix(args []string, permissionMode string) []string {
	if hasPermissionArg(args) {
		return args
	}
	prefix := mapPermissionPrefix(permissionMode)
	if len(prefix) == 0 {
		return args
	}
	out := make([]string, 0, len(prefix)+len(args))
	out = append(out, prefix...)
	out = append(out, args...)
	return out
}

func hasPermissionArg(args []string) bool {
	for _, arg := range args {
		switch {
		case arg == "--permission-mode" || strings.HasPrefix(arg, "--permission-mode="):
			return true
		case arg == "--sandbox" || strings.HasPrefix(arg, "--sandbox="):
			return true
		case arg == "--ask-for-approval" || strings.HasPrefix(arg, "--ask-for-approval="):
			return true
		case arg == "--dangerously-bypass-approvals-and-sandbox" || arg == "-y":
			return true
		}
	}
	return false
}
