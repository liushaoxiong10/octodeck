// Package traecli implements the Trae CLI agent runtime.
//
// It mirrors the original daemonapp.traecliAgent behaviour for stdio, while
// the built-in descriptor now selects TraeCLI's native ACP subcommand by
// default:
//
//   - Connect: stdio transport writes the per-cwd Trae project MCP config;
//     ACP transport is a no-op because MCP servers are passed via ACP session
//     creation.
//   - RunPrompt: stdio transport spawns the trae CLI; ACP transport
//     delegates to the package-local ACP Connection. TraeCLI runs as an
//     external `traecli acp serve` process, so the family adapter returns nil
//     for EmbeddedACPBackend.
//   - BuildRunCommand: composes the argv via the package-local
//     buildStdioArgv helper.
//
// traecli does not implement EmbeddedACPBackend.Run or
// SupportsNativeSystemPrompt — those defaults are inherited from BaseAgent.
//
// All other lifecycle methods (Discover, CreateSession) are inherited
// from agentcore.BaseAgent. ListSessions / DeleteSession are
// overridden below so the family owns its provider-directory layout.
package traecli

import (
	"context"
	"errors"

	agentcore "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentcore"
	agentprotocol "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentprotocol"
	daemonconfig "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/config"
	mcp "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/mcp"
	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
)

// Agent is the Trae CLI agent runtime. It embeds agentcore.BaseAgent for
// the default lifecycle implementations and overrides Connect, RunPrompt and
// BuildRunCommand.
type Agent struct {
	agentcore.BaseAgent
}

// Connect prepares the per-cwd trae project MCP configuration for stdio runs.
// ACP runs configure MCP servers per-session, so no global config is needed
// in that case.
func (a *Agent) Connect(_ context.Context, run *agentprotocol.RunContext) error {
	if a.Transport() == "acp" {
		return nil
	}
	return mcp.WriteTraeProjectConfigForDaemon(run.Cfg, run.Cwd, run.Req.Env)
}

// BuildRunCommand composes the argv for the trae CLI for stdio runs.
//
// The argv builder lives in this sub-package (transport_stdio.go::buildStdioArgv)
// rather than the family-shared agentruntime layer; that move is part of
// stage B of the daemon-decoupling plan and is what allows
// agentruntime.TraecliArgvBuilder to be retired in stage E.
func (a *Agent) BuildRunCommand(_ *daemonconfig.Config, req *proto.AgentRunRequestFrame) ([]string, bool, error) {
	return buildStdioArgv(req), true, nil
}

// RunPrompt dispatches stdio runs directly. Built-in ACP runs are owned by
// conversation runtime before this fallback path is reached.
func (a *Agent) RunPrompt(ctx context.Context, run *agentprotocol.RunContext) (proto.AgentRunResultFrame, error) {
	if a.Transport() == "acp" {
		return proto.AgentRunResultFrame{}, errors.New("traecli ACP transport must run through conversation runtime")
	}
	argv, outputJSON, err := a.BuildRunCommand(run.Cfg, run.Req)
	if err != nil {
		return proto.AgentRunResultFrame{}, err
	}
	return agentcore.RunStdioAgentPrompt(ctx, run, argv, outputJSON)
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
