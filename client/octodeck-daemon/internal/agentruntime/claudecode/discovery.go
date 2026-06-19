// Package claudecode — discovery helper.
//
// FamilyID is the canonical agent family string used by inventory, registry
// and BuiltinAgentFactories to identify the Claude (Claude Code) family.
// BaseAgent.Discover already returns the inventory.Info captured at process
// start, so this file only carries the family-specific identifier and a
// thin convenience accessor — the actual binary discovery is shared across
// all families and lives in the inventory package.
package claudecode

import (
	agentclient "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentclient"
)

// FamilyID is the agent family identifier registered in
// agentruntime.BuiltinAgentFactories.
const FamilyID = "claude"

// Family returns the canonical family string. It exists so external
// callers can refer to claudecode.Family() rather than hard-coding the
// literal "claude" everywhere.
func Family() string { return FamilyID }

// Descriptor returns the family-agnostic metadata published to the
// daemon-wide agentclient registry. Field values mirror the historical
// entries in inventory.supportedAgentClients / agentClientPermissionModes
// / agentClientCapabilities for the claude-code (stdio) variant; the ACP
// variant is owned by transport_acp.go and (for now) reuses the inventory
// metadata until phase D moves ACP wiring into this package.
func Descriptor() agentclient.Descriptor {
	return agentclient.Descriptor{
		ID:              "claude-code",
		DisplayName:     "Claude Code",
		Family:          FamilyID,
		Provider:        "claude-code",
		Transport:       TransportStdio,
		Binary:          "claude",
		SearchDirs:      []string{"/usr/local/bin", "/opt/homebrew/bin"},
		VersionArgs:     []string{"--version"},
		PermissionModes: []string{"default", "acceptEdits", "bypassPermissions", "plan"},
		Capabilities:    []string{"print", "stream-json", "mcp", "permissions", "tools", "session", "skills", "system-prompt"},
	}
}
