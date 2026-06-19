package output

import (
	"strings"

	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
)

type AgentRunRequestFrame = proto.AgentRunRequestFrame
type AgentRunEventFrame = proto.AgentRunEventFrame

func firstString(m map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, _ := m[key].(string); value != "" {
			return value
		}
	}
	return ""
}

func LooksLikeSessionNotification(payload map[string]any) bool {
	if len(payload) == 0 {
		return false
	}
	rawType := strings.ToLower(firstString(payload, "type", "event", "eventType", "kind", "status", "phase"))
	switch rawType {
	case "session", "session_created", "session_resumed", "session_loaded", "session_new", "new_session", "resume_session", "create_session":
		return true
	}
	for _, key := range []string{"event", "action", "notification", "notice"} {
		if v, _ := payload[key].(string); v != "" {
			lower := strings.ToLower(v)
			if strings.Contains(lower, "session") && (strings.Contains(lower, "creat") || strings.Contains(lower, "resum") || strings.Contains(lower, "load") || strings.Contains(lower, "new") || strings.Contains(lower, "start")) {
				return true
			}
		}
	}
	return false
}
