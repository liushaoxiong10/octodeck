package claudecode

import (
	"strings"

	acpsdk "github.com/coder/acp-go-sdk"
)

// PermissionRequestID returns the first request-identifying string field
// inside a permission_request payload.
func PermissionRequestID(payload map[string]any) string {
	for _, key := range []string{"requestId", "request_id", "id", "permissionRequestId"} {
		if v, ok := payload[key].(string); ok && v != "" {
			return v
		}
	}
	return ""
}

// ShouldAutoApprovePermission returns true when the OctoDeck permission mode
// indicates the user has opted into bypassing per-call permission prompts.
func ShouldAutoApprovePermissionMode(mode string) bool {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case "bypasspermissions", "full-access", "dangerously-skip-permissions", "no-approval", "auto-approve":
		return true
	default:
		return false
	}
}

// SelectPermissionApprovalOption picks an "approve" option from the ACP
// permission options list, preferring AllowAlways then AllowOnce. Returns
// ("", false) when no obviously-approving option exists.
func SelectPermissionApprovalOption(options []acpsdk.PermissionOption) (acpsdk.PermissionOptionId, bool) {
	for _, want := range []acpsdk.PermissionOptionKind{acpsdk.PermissionOptionKindAllowAlways, acpsdk.PermissionOptionKindAllowOnce} {
		for _, option := range options {
			if option.Kind == want && option.OptionId != "" {
				return option.OptionId, true
			}
		}
	}
	for _, option := range options {
		label := strings.ToLower(string(option.OptionId) + " " + option.Name + " " + string(option.Kind))
		if option.OptionId != "" && (strings.Contains(label, "allow") || strings.Contains(label, "approve") || strings.Contains(label, "accept")) {
			return option.OptionId, true
		}
	}
	return "", false
}
