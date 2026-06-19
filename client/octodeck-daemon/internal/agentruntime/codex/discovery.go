// Package codex — discovery helper.
//
// FamilyID is the canonical agent family string used by inventory, registry
// and BuiltinAgentFactories to identify the Codex family. The actual binary
// discovery is shared across all families and lives in the inventory package.
package codex

import (
	agentclient "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentclient"
)

// FamilyID is the agent family identifier registered in
// agentruntime.BuiltinAgentFactories.
const FamilyID = "codex"

// Family returns the canonical family string.
func Family() string { return FamilyID }

// Descriptor returns the family-agnostic metadata published to the
// daemon-wide agentclient registry. Field values mirror the historical
// entries in inventory.supportedAgentClients / agentClientPermissionModes
// / agentClientCapabilities for the codex (stdio) variant; the ACP variant
// is owned by transport_acp.go and (for now) reuses the inventory metadata
// until phase D moves ACP wiring into this package.
func Descriptor() agentclient.Descriptor {
	return agentclient.Descriptor{
		ID:              "codex",
		DisplayName:     "Codex CLI",
		Family:          FamilyID,
		Provider:        "codex",
		Transport:       TransportStdio,
		Binary:          "codex",
		SearchDirs:      []string{"/usr/local/bin", "/opt/homebrew/bin"},
		VersionArgs:     []string{"--version"},
		PermissionModes: []string{"default", "acceptEdits", "bypassPermissions", "plan"},
		Capabilities:    []string{"exec", "jsonl", "tools", "sandbox", "approval-policy"},
	}
}
