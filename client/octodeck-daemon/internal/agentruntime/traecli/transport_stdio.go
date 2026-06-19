// Package traecli — stdio transport helper.
//
// All four agent families share a single stdio transport implementation
// hosted in agentcore.RunStdioAgentPrompt. This file is a thin
// family-flavoured wrapper that documents the dispatch and gives the
// family a stable place to attach future stdio-only quirks (e.g. custom
// argv post-processing) without touching the shared runner.
package traecli

import (
	agentcore "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentcore"
	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
)

// TransportStdio is the literal transport string registered by the
// inventory and registry layers when an operator selects the stdio
// surface for the Trae CLI family.
const TransportStdio = "stdio"

// buildStdioArgv composes the argv for the trae CLI when running over
// the stdio transport. It mirrors the legacy daemonapp behaviour and
// the family-shared agentruntime.TraecliArgvBuilder, but lives inside
// the family sub-package so that the shared layer can eventually be
// retired (see docs/daemon-decoupling-execution-plan.md, stage E).
//
// The trae CLI exposes:
//
//   - -p <prompt>                 the prompt text (with OctoDeck-side
//     system context wrapping when this is a
//     fresh session)
//   - --output-format=stream-json structured event stream on stdout
//   - -y                          auto-approve permission prompts when the
//     OctoDeck-side policy resolves to "bypass"
//   - --resume=<sid>              continue an existing trae session
//   - -c model.name=<model>       per-run model override
func buildStdioArgv(req *proto.AgentRunRequestFrame) []string {
	argv := []string{
		"-p",
		agentcore.PromptWithSystemContext(req, req.Input.SessionID == ""),
		"--output-format=stream-json",
	}
	if shouldAutoApprove(req.Policy.PermissionMode) {
		argv = append(argv, "-y")
	}
	if req.Input.SessionID != "" {
		argv = append(argv, "--resume="+req.Input.SessionID)
	}
	if req.Policy.Model != "" {
		argv = append(argv, "-c", "model.name="+req.Policy.Model)
	}
	return argv
}
