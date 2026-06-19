// Package codex — permission mode mapping.
//
// Codex's CLI accepts sandbox values, so OctoDeck's product-level approval
// modes are translated into the closest sandbox policy here.
package codex

import "strings"

// mapPermissionMode normalises an OctoDeck permission mode for the codex CLI.
func mapPermissionMode(mode string) string {
	switch strings.TrimSpace(mode) {
	case "", "default", "plan":
		return "read-only"
	case "acceptEdits":
		return "workspace-write"
	case "bypassPermissions", "dangerously-skip-permissions", "no-approval", "auto-approve", "full-access":
		return "danger-full-access"
	default:
		return mode
	}
}
