// Package traex — permission helper.
//
// mapPermissionPrefix 把 OctoDeck 标准 permissionMode 字符串映射为 traex CLI
// 的根级前缀参数（--permission-mode bypass_permissions / --sandbox 等），
// 必须在 exec / acp 子命令之前出现。
//
// 该函数从 agentruntime.TraexPermissionPrefix 复制而来，在 traex 子包私有；
// 阶段 E1 完成后，公共层旧函数会被删除。
package traex

import "strings"

// mapPermissionPrefix maps an OctoDeck permission mode to traex's native
// root-level CLI flags. These must appear before the exec/acp subcommand.
func mapPermissionPrefix(permissionMode string) []string {
	switch strings.TrimSpace(permissionMode) {
	case "default", "auto":
		return []string{"--permission-mode", strings.TrimSpace(permissionMode)}
	case "plan":
		return []string{"--sandbox", "read-only", "--ask-for-approval", "on-request"}
	case "acceptEdits":
		return []string{"--sandbox", "workspace-write"}
	case "bypassPermissions", "bypass_permissions", "dangerously-skip-permissions", "no-approval", "auto-approve":
		return []string{"--permission-mode", "bypass_permissions"}
	case "read-only":
		return []string{"--sandbox", "read-only"}
	case "workspace-write":
		return []string{"--sandbox", "workspace-write"}
	case "full-access", "danger-full-access":
		return []string{"--sandbox", "danger-full-access"}
	default:
		return []string{}
	}
}

func mapSandboxPermissionMode(mode string) string {
	switch strings.TrimSpace(mode) {
	case "", "default":
		return "workspace-write"
	case "plan":
		return "read-only"
	case "acceptEdits":
		return "workspace-write"
	case "bypassPermissions", "bypass_permissions", "dangerously-skip-permissions", "no-approval", "auto-approve", "full-access":
		return "danger-full-access"
	case "read-only", "workspace-write", "danger-full-access":
		return strings.TrimSpace(mode)
	default:
		return ""
	}
}

func mapApprovalPolicyPermissionMode(mode string) string {
	switch strings.TrimSpace(mode) {
	case "bypassPermissions", "bypass_permissions", "dangerously-skip-permissions", "no-approval", "auto-approve":
		return "never"
	case "", "default", "acceptEdits", "plan", "read-only", "workspace-write", "full-access", "danger-full-access":
		return "on-request"
	default:
		return ""
	}
}

func normalizedPolicyModeForKey(mode string) string {
	switch strings.TrimSpace(mode) {
	case "", "default":
		return "default"
	case "bypass_permissions", "dangerously-skip-permissions", "no-approval", "auto-approve":
		return "bypassPermissions"
	case "acceptEdits", "plan", "auto":
		return strings.TrimSpace(mode)
	case "full-access":
		return "danger-full-access"
	default:
		return strings.TrimSpace(mode)
	}
}
