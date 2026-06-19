// Runtime session state helpers.
//
// TraeCLI startup/resume semantics are owned by conversation runtime. This file only keeps
// the family-specific permission mode id mapping used when starting a process
// and sending session/set_mode.

package traecli

import (
	"strings"
)

// mapPermissionModeToTraecliModeID maps OctoDeck's permissionMode string to
// the traecli ACP `mode.id` value. Returns the empty string when the input
// does not require an explicit set_mode call (e.g. plain "default" or empty).
//
// traecli announces three built-in modes (probed live):
//   - "default"
//   - "bypass_permissions" (Accept All Tools)
//   - "plan"             (Plan Mode)
func mapPermissionModeToTraecliModeID(mode string) string {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case "", "default":
		return "default"
	case "bypasspermissions",
		"bypass-permissions",
		"bypass_permissions",
		"full-access",
		"dangerously-skip-permissions",
		"no-approval",
		"auto-approve":
		return "bypass_permissions"
	case "plan", "plan-mode", "planning":
		return "plan"
	}
	// Unknown values: pass through so a future traecli release that adds
	// modes still works without daemon changes.
	return strings.TrimSpace(mode)
}
