package main

import (
	"os"

	mcp "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/mcp"
)

// runAgentTeamMCPCommand is the `octodeck-daemon mcp-agent-team`
// subcommand entry point. The whole MCP server implementation lives in
// internal/mcp; this shell only forwards stdio.
func runAgentTeamMCPCommand(args []string) error {
	return mcp.RunCommand(args, os.Stdin, os.Stdout)
}
