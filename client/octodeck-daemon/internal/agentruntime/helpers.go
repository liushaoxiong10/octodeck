package agentruntime

import (
	"strings"
	"time"

	daemonconfig "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/config"
	inventory "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/inventory"
)

// PermissionRequestID returns the first non-empty request-id in payload.
// ACP servers vary on which key they use ("requestId", "request_id",
// "id" or "permissionRequestId"), so we accept all four.
func PermissionRequestID(payload map[string]any) string {
	for _, key := range []string{"requestId", "request_id", "id", "permissionRequestId"} {
		if v, ok := payload[key].(string); ok && v != "" {
			return v
		}
	}
	return ""
}

// PermissionDecisionTimeout returns how long the runtime waits for a
// permission decision before treating it as cancelled. Falls back to 5h when
// the config does not specify a timeout — long enough to cover an idle user
// without being effectively infinite.
func PermissionDecisionTimeout(cfg *daemonconfig.Config) time.Duration {
	if cfg != nil && cfg.RuntimePolicy.PermissionTimeoutMs > 0 {
		return time.Duration(cfg.RuntimePolicy.PermissionTimeoutMs) * time.Millisecond
	}
	return 5 * time.Hour
}

// RunErrorCode maps a final agent run error onto a stable error code that
// the platform server uses to decide retry / surface behaviour.
func RunErrorCode(err error, timedOut bool) string {
	if timedOut {
		return "timeout"
	}
	if err == nil {
		return "run_failed"
	}
	msg := err.Error()
	if strings.Contains(msg, "outside allowed") || strings.Contains(msg, "not allowed") {
		return "policy_denied"
	}
	return "run_failed"
}

// FormatTime renders a time in UTC RFC3339Nano. Zero time returns empty string.
func FormatTime(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339Nano)
}

// IfEmpty returns fallback when s is empty.
func IfEmpty(s, fallback string) string {
	if s == "" {
		return fallback
	}
	return s
}

// ParseBoolEnv parses a string as a boolean with a fallback for empty/unknown values.
func ParseBoolEnv(raw string, fallback bool) bool {
	switch strings.TrimSpace(strings.ToLower(raw)) {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	case "":
		return fallback
	default:
		return fallback
	}
}

// ContainsString returns true if items contains needle.
func ContainsString(items []string, needle string) bool {
	for _, item := range items {
		if item == needle {
			return true
		}
	}
	return false
}

// IsSupportedPermissionMode accepts both OctoDeck's product-level modes and
// lower-level sandbox aliases understood by Codex/TraeX runtimes. The latter
// keeps existing workspaces and daemon configs from being rejected before the
// family runtime can normalize them.
func IsSupportedPermissionMode(modes []string, needle string) bool {
	if ContainsString(modes, needle) {
		return true
	}
	switch strings.TrimSpace(needle) {
	case "read-only":
		return ContainsString(modes, "default") || ContainsString(modes, "plan")
	case "workspace-write":
		return ContainsString(modes, "acceptEdits")
	case "full-access", "danger-full-access", "bypass_permissions":
		return ContainsString(modes, "bypassPermissions")
	default:
		return false
	}
}

// MergeStringMaps merges two string maps. Values from b override a.
func MergeStringMaps(a, b map[string]string) map[string]string {
	if len(a) == 0 {
		return b
	}
	out := make(map[string]string, len(a)+len(b))
	for k, v := range a {
		out[k] = v
	}
	for k, v := range b {
		out[k] = v
	}
	return out
}

// FirstNonEmpty returns the first non-empty string from values.
func FirstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

// EffectivePermissionModes resolves the effective permission modes for an agent
// client, preferring the registry entry, then runtime policy, then client defaults.
func EffectivePermissionModes(cfg *daemonconfig.Config, entry *daemonconfig.AgentRegistryEntry, client inventory.Info) []string {
	if entry != nil && len(entry.PermissionModes) > 0 {
		return append([]string(nil), entry.PermissionModes...)
	}
	if cfg != nil && len(cfg.RuntimePolicy.PermissionModes) > 0 {
		return append([]string(nil), cfg.RuntimePolicy.PermissionModes...)
	}
	return append([]string(nil), client.PermissionModes...)
}
