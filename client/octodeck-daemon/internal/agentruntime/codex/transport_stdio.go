// Package codex — stdio transport helper.
//
// All four agent families share a single stdio transport implementation
// hosted in agentcore.RunStdioAgentPrompt. This file is a thin
// family-flavoured wrapper that documents the dispatch and gives the
// codex family a stable place to attach future stdio-only quirks
// (e.g. argv post-processing) without touching the shared runner.
package codex

import (
	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"

	agentcore "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentcore"
)

// TransportStdio is the literal transport string registered by the
// inventory and registry layers when an operator selects the stdio
// surface for the Codex family.
const TransportStdio = "stdio"

// buildStdioArgv composes the argv for the codex CLI when running over the
// stdio transport. It mirrors the legacy
// daemonapp.codexAgent.BuildRunCommand and the family-shared argv builder
// that previously lived in the public agentruntime package.
//
// The PromptWithSystemContext helper still lives in the public agentruntime
// package; phase C will move it into a shared family-agnostic helper. Until
// then we keep depending on it from the codex sub-package — this dependency
// goes "sub-package -> public helper", not the other way around, so it does
// not violate the decoupling rule.
func buildStdioArgv(req *proto.AgentRunRequestFrame) []string {
	prompt := agentcore.PromptWithSystemContext(req, req.Input.SessionID == "")
	if req.Input.SessionID != "" {
		argv := []string{"exec", "resume", "--json", "--skip-git-repo-check"}
		if req.Policy.Model != "" {
			argv = append(argv, "-m", req.Policy.Model)
		}
		if req.Policy.PermissionMode != "" {
			mode := mapPermissionMode(req.Policy.PermissionMode)
			argv = append(argv, "--sandbox", mode)
			if mode == "danger-full-access" {
				argv = append(argv, "--ask-for-approval", "never")
			}
		}
		argv = append(argv, req.Input.SessionID, prompt)
		return argv
	}
	argv := []string{"exec", "--json", "--skip-git-repo-check"}
	if req.Policy.Model != "" {
		argv = append(argv, "-m", req.Policy.Model)
	}
	if req.Policy.PermissionMode != "" {
		mode := mapPermissionMode(req.Policy.PermissionMode)
		argv = append(argv, "--sandbox", mode)
		if mode == "danger-full-access" {
			argv = append(argv, "--ask-for-approval", "never")
		}
	}
	argv = append(argv, prompt)
	return argv
}
