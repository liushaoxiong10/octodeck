package agentruntime

import (
	"context"

	agentprotocol "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentprotocol"
	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
)

// RunStdioAgentPrompt runs an agent prompt via the stdio transport (piping
// prompt text to the agent binary's stdin and parsing stdout).
func RunStdioAgentPrompt(ctx context.Context, run *agentprotocol.RunContext, argv []string, outputJSON bool) (proto.AgentRunResultFrame, error) {
	req := run.Req
	waiter := run.Runtime
	env := BuildAgentEnv(run.Cfg, req.AgentID, req.Env, req.Context)
	wait := func(ctx context.Context, runID, requestID string) (proto.AgentPermissionDecisionFrame, error) {
		return waiter.AwaitPermissionDecision(ctx, runID, requestID, PermissionDecisionTimeout(run.Cfg))
	}
	return RunStdio(ctx, run.Client.Binary, argv, run.Cwd, env, req, run.Started, outputJSON, run.ParseLine, run.Emit, wait)
}

// RunDirectAgentPrompt runs an agent prompt via a direct transport (HTTP,
// A2A, ACP) that bypasses the stdio CLI surface.
func RunDirectAgentPrompt(ctx context.Context, run *agentprotocol.RunContext, direct DirectPromptRunner) (proto.AgentRunResultFrame, error) {
	result, err := direct.RunDirect(ctx, run.Cfg, run.Req, run.Emit)
	if err != nil {
		return proto.AgentRunResultFrame{}, err
	}
	result.Type = proto.TAgentRunResult
	result.RunID = run.Req.RunID
	result.AgentID = run.Req.AgentID
	return result, nil
}
