package agentcore

import (
	"strings"
	"time"

	daemonconfig "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/config"
	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
)

func PermissionDecisionTimeout(cfg *daemonconfig.Config) time.Duration {
	if cfg != nil && cfg.RuntimePolicy.PermissionTimeoutMs > 0 {
		return time.Duration(cfg.RuntimePolicy.PermissionTimeoutMs) * time.Millisecond
	}
	return 5 * time.Hour
}

func FormatTime(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339Nano)
}

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

func ContainsString(items []string, needle string) bool {
	for _, item := range items {
		if item == needle {
			return true
		}
	}
	return false
}

func FirstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

func PromptWithSystemContext(req *proto.AgentRunRequestFrame, includeSystemContext bool) string {
	if req == nil {
		return ""
	}
	if !includeSystemContext || strings.TrimSpace(req.Policy.SystemPrompt) == "" {
		return req.Input.Prompt
	}
	return strings.Join([]string{
		"<octodeck-system-context>",
		req.Policy.SystemPrompt,
		"</octodeck-system-context>",
		"",
		"<user-prompt>",
		req.Input.Prompt,
		"</user-prompt>",
	}, "\n")
}

func ShouldAutoApprovePermission(policy proto.AgentRunPolicy) bool {
	switch strings.ToLower(strings.TrimSpace(policy.PermissionMode)) {
	case "bypasspermissions", "full-access", "dangerously-skip-permissions", "no-approval", "auto-approve":
		return true
	default:
		return false
	}
}

// PermissionRequestID returns the first non-empty request-id in payload.
func PermissionRequestID(payload map[string]any) string {
	for _, key := range []string{"requestId", "request_id", "id", "permissionRequestId"} {
		if v, ok := payload[key].(string); ok && v != "" {
			return v
		}
	}
	return ""
}

// UsageFromPayload locates an embedded usage block within an arbitrary frame
// payload, returning the canonical token-count map or nil if no usage data is
// present. Kept in agentcore because stdio transports need it as a generic
// payload helper; ACP-specific usage conversion lives in each family package.
func UsageFromPayload(payload map[string]any) map[string]any {
	if payload == nil {
		return nil
	}
	if usage, ok := payload["usage"].(map[string]any); ok {
		return usage
	}
	if usage := findMapDeep(payload, func(m map[string]any) bool {
		_, ok := m["usage"]
		return ok
	}); usage != nil {
		if nested, ok := usage["usage"].(map[string]any); ok {
			return nested
		}
	}
	if hasAnyKey(payload, "inputTokens", "outputTokens", "input_tokens", "output_tokens", "totalTokens", "total_tokens", "cacheReadInputTokens", "cache_read_input_tokens", "costUSD", "cost_usd") {
		return payload
	}
	return nil
}

func findMapDeep(value any, pred func(map[string]any) bool) map[string]any {
	return findMapDeepWithDepth(value, pred, 0)
}

func findMapDeepWithDepth(value any, pred func(map[string]any) bool, depth int) map[string]any {
	if depth > 8 || value == nil {
		return nil
	}
	switch v := value.(type) {
	case map[string]any:
		if pred(v) {
			return v
		}
		for _, child := range v {
			if found := findMapDeepWithDepth(child, pred, depth+1); found != nil {
				return found
			}
		}
	case []any:
		for _, child := range v {
			if found := findMapDeepWithDepth(child, pred, depth+1); found != nil {
				return found
			}
		}
	}
	return nil
}

func hasAnyKey(m map[string]any, keys ...string) bool {
	for _, key := range keys {
		if _, ok := m[key]; ok {
			return true
		}
	}
	return false
}
