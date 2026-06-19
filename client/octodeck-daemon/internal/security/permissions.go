package security

// PermissionMode is a string identifier for an agent's permission preset.
// It mirrors the values stored in AgentRunRequestFrame.Policy.PermissionMode
// (e.g. "default", "auto", "yolo"). The valid set of values for a given agent
// is derived from the agent registry entry / discovered agent client and is
// enforced by ValidateRuntimePolicy in tools.go.
type PermissionMode string

const (
	// PermissionModeDefault is the conservative default: every tool call
	// requires user approval.
	PermissionModeDefault PermissionMode = "default"
	// PermissionModeAuto auto-approves tool calls within the allowed-tools
	// list.
	PermissionModeAuto PermissionMode = "auto"
	// PermissionModeYolo bypasses tool approval prompts entirely. Reserved for
	// trusted, sandboxed environments.
	PermissionModeYolo PermissionMode = "yolo"
)

// IsKnownPermissionMode returns true if mode is one of the well-known modes.
// Unknown modes are still permitted by ValidateRuntimePolicy so long as the
// agent registry / discovered client lists them; this helper is only a hint
// for diagnostics and UI.
func IsKnownPermissionMode(mode string) bool {
	switch PermissionMode(mode) {
	case PermissionModeDefault, PermissionModeAuto, PermissionModeYolo:
		return true
	default:
		return false
	}
}
