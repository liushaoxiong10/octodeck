// Package traex — discovery helper.
//
// FamilyID is the canonical agent family string used by inventory, registry
// and BuiltinAgentFactories to identify the TraeX family.
package traex

import (
	agentclient "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentclient"
)

// FamilyID is the agent family identifier registered in
// agentruntime.BuiltinAgentFactories.
const FamilyID = "traex"

// Family returns the canonical family string.
func Family() string { return FamilyID }

// Descriptor returns the family-agnostic metadata published to the
// daemon-wide agentclient registry. Field values mirror the historical
// entries in inventory.supportedAgentClients / agentClientPermissionModes
// / agentClientCapabilities for the traex (ACP) variant. Note: the
// inventory layer only publishes traex-acp (stdio is intentionally
// disabled — see agentruntime/inventory comment about codex_app_server v2
// schema), so the Descriptor here also encodes the ACP transport.
func Descriptor() agentclient.Descriptor {
	return agentclient.Descriptor{
		ID:              "traex-acp",
		DisplayName:     "Traex",
		Family:          FamilyID,
		Provider:        "traex",
		Transport:       "acp",
		Binary:          "traex",
		SearchDirs:      []string{"/usr/local/bin", "/opt/homebrew/bin"},
		VersionArgs:     []string{"--version"},
		PermissionModes: []string{"default", "acceptEdits", "bypassPermissions", "plan"},
		Capabilities:    []string{"acp", "jsonrpc", "mcp", "tools", "sandbox", "approval-policy", "session"},
	}
}
