// Package traecli — discovery helper.
//
// FamilyID is the canonical agent family string used by inventory, registry
// and BuiltinAgentFactories to identify the Trae CLI family.
package traecli

import (
	agentclient "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentclient"
)

// FamilyID is the agent family identifier registered in
// agentruntime.BuiltinAgentFactories.
const FamilyID = "traecli"

// Family returns the canonical family string.
func Family() string { return FamilyID }

// Descriptor returns the family-agnostic metadata published to the
// daemon-wide agentclient registry. TraeCLI now publishes the ACP transport
// directly because current traecli/coco exposes a native `acp serve` subcommand
// and daemon agent.run should speak ACP instead of the legacy stream-json stdio
// path.
//
// Note on Binary: inventory.supportedAgentClients lists `command: "traecli"`
// for the stdio variant, so we publish "traecli" here. Some operator
// installations also expose a `coco` symlink — that is handled by the
// inventory PATH lookup, not the descriptor.
func Descriptor() agentclient.Descriptor {
	return agentclient.Descriptor{
		ID:              "traecli",
		DisplayName:     "TraeCLI",
		Family:          FamilyID,
		Provider:        "traecli",
		Transport:       TransportACP,
		Binary:          "traecli",
		Args:            []string{"acp", "serve"},
		SearchDirs:      []string{"/usr/local/bin", "/opt/homebrew/bin"},
		VersionArgs:     []string{"--version"},
		PermissionModes: []string{"default", "acceptEdits", "bypassPermissions"},
		Capabilities:    []string{"acp", "jsonrpc", "mcp", "permissions", "tools", "session"},
	}
}
