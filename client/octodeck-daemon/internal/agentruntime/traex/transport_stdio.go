// Package traex — stdio transport helper.
//
// All four agent families share a single stdio transport implementation
// hosted in agentcore.RunStdioAgentPrompt. This file is a thin
// family-flavoured wrapper that documents the dispatch and additionally
// hosts the family-private argv builder used to compose the CLI argv for
// stdio runs.
package traex

import (
	agentcore "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentcore"
	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
)

// TransportStdio is the literal transport string registered by the
// inventory and registry layers when an operator selects the stdio
// surface for the TraeX family.
const TransportStdio = "stdio"

// buildStdioArgv composes the argv for the traex CLI for stdio runs. It is
// the family-private successor of agentruntime.TraexArgvBuilder; the
// permission prefix is now resolved through mapPermissionPrefix.
func buildStdioArgv(req *proto.AgentRunRequestFrame) []string {
	prompt := agentcore.PromptWithSystemContext(req, req.Input.SessionID == "")
	prefix := mapPermissionPrefix(req.Policy.PermissionMode)
	if req.Input.SessionID != "" {
		argv := append(prefix, "exec", "resume", "--json", "--skip-git-repo-check")
		if req.Policy.Model != "" {
			argv = append(argv, "-m", req.Policy.Model)
		}
		argv = append(argv, req.Input.SessionID, prompt)
		return argv
	}
	argv := append(prefix, "exec", "--json", "--skip-git-repo-check")
	if req.Policy.Model != "" {
		argv = append(argv, "-m", req.Policy.Model)
	}
	argv = append(argv, prompt)
	return argv
}
