// Package claudecode — stdio transport helper.
//
// All four agent families share a single stdio transport implementation
// hosted in agentcore.RunStdioAgentPrompt. This file is a thin
// family-flavoured wrapper that documents the dispatch and gives the
// family a stable place to attach future stdio-only quirks (e.g. custom
// argv post-processing) without touching the shared runner.
package claudecode

import (
	"strings"

	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
)

// TransportStdio is the literal transport string registered by the
// inventory and registry layers when an operator selects the stdio
// surface for the Claude family.
const TransportStdio = "stdio"

// buildStdioArgv composes the argv for the claude CLI when running over
// the stdio transport. It mirrors the legacy daemonapp.claudeAgent.
// BuildRunCommand and the family-shared agentruntime.ClaudeArgvBuilder.
//
// The MCP config flag (--mcp-config <path>) is NOT appended here; that is
// the responsibility of the caller (BuildRunCommand on Agent) because the
// MCP config path comes from the daemon-side mcp installer.
func buildStdioArgv(req *proto.AgentRunRequestFrame) []string {
	argv := []string{"-p", req.Input.Prompt, "--output-format", "stream-json", "--verbose"}
	if req.Input.SessionID != "" {
		argv = append(argv, "--resume", req.Input.SessionID)
	}
	if req.Policy.PermissionMode != "" {
		argv = append(argv, "--permission-mode", mapPermissionMode(req.Policy.PermissionMode))
	}
	if req.Policy.Model != "" {
		argv = append(argv, "--model", req.Policy.Model)
	}
	if req.Input.SessionID == "" && req.Policy.SystemPrompt != "" {
		argv = append(argv, "--append-system-prompt", req.Policy.SystemPrompt)
	}
	if len(req.Policy.AllowedTools) > 0 {
		argv = append(argv, "--allowedTools", strings.Join(req.Policy.AllowedTools, ","))
	}
	if len(req.Policy.DisallowedTools) > 0 {
		argv = append(argv, "--disallowedTools", strings.Join(req.Policy.DisallowedTools, ","))
	}
	return argv
}
