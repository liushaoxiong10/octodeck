// Package traecli — output parser (OutputParser implementation).
//
// The trae CLI emits one event per stdout line. The schema is intentionally
// simple compared to claude/codex stream-json:
//
//   - When `--output-format=stream-json` is in effect, lines are JSON
//     objects with at least a `type` field, plus optional `text`,
//     `session_id`, `delta` and `usage` fields.
//   - When the operator runs the CLI without that flag (or before the
//     first JSON record), lines are plain text — those are surfaced as
//     `text_delta` frames so the chat page still streams something.
//
// We map a deliberately small subset of `type` values; everything else
// falls through to a `log` frame carrying the raw payload.
package traecli

import (
	"encoding/json"
	"strings"

	agentcore "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentcore"
	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
)

// ParseLine implements agentruntime.OutputParser for the Trae CLI family.
//
// The function is stateless: each call processes exactly one line. Empty /
// whitespace-only lines produce no frames.
func (a *Agent) ParseLine(line string) []proto.AgentRunEventFrame {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" {
		return nil
	}

	// Fast path: not JSON => surface as plain text_delta.
	if !strings.HasPrefix(trimmed, "{") {
		return []proto.AgentRunEventFrame{{
			EventType: "text_delta",
			Text:      line,
		}}
	}

	var evt map[string]any
	if err := json.Unmarshal([]byte(trimmed), &evt); err != nil {
		// Malformed JSON: still better than dropping it; surface as log
		// so the operator can find it via debug snapshot.
		return []proto.AgentRunEventFrame{{EventType: "log", Text: line}}
	}

	sessionID, _ := evt["session_id"].(string)
	rawType, _ := evt["type"].(string)

	switch rawType {
	case "text", "text_delta":
		if text := traeFirstString(evt, "text", "content", "delta"); text != "" {
			return []proto.AgentRunEventFrame{{EventType: "text_delta", Text: text, SessionID: sessionID, Payload: evt}}
		}
	case "thinking", "reasoning", "reasoning_delta":
		if text := traeFirstString(evt, "thinking", "reasoning", "reason", "text", "content"); text != "" {
			return []proto.AgentRunEventFrame{{EventType: "thinking_delta", Text: text, SessionID: sessionID, Payload: evt}}
		}
	case "tool_use", "tool_call", "tool_use_start":
		return []proto.AgentRunEventFrame{{EventType: "tool_call", SessionID: sessionID, Payload: evt}}
	case "tool_result", "tool_use_end":
		return []proto.AgentRunEventFrame{{EventType: "tool_result", SessionID: sessionID, Payload: evt}}
	case "usage":
		return []proto.AgentRunEventFrame{{EventType: "usage", SessionID: sessionID, Payload: evt}}
	case "permission_request", "approval_request":
		return []proto.AgentRunEventFrame{{EventType: "permission_request", SessionID: sessionID, Payload: evt}}
	}

	// Generic `result` field: single-shot completion line.
	if result, ok := evt["result"].(string); ok && result != "" {
		frames := []proto.AgentRunEventFrame{{EventType: "final_result", Text: result, SessionID: sessionID, Payload: evt}}
		if usage, ok := evt["usage"].(map[string]any); ok && len(usage) > 0 {
			frames = append(frames, proto.AgentRunEventFrame{EventType: "usage", SessionID: sessionID, Payload: evt})
		}
		return frames
	}

	// Generic `delta` wrapper — handle assistant/text deltas without a top
	// level type.
	if delta, ok := evt["delta"].(map[string]any); ok {
		deltaType, _ := delta["type"].(string)
		if deltaType == "text_delta" {
			if text, _ := delta["text"].(string); text != "" {
				return []proto.AgentRunEventFrame{{EventType: "text_delta", Text: text, SessionID: sessionID, Payload: evt}}
			}
		}
		if deltaType == "thinking_delta" || deltaType == "reasoning_delta" {
			if text := traeFirstString(delta, "thinking", "reasoning", "reason", "text"); text != "" {
				return []proto.AgentRunEventFrame{{EventType: "thinking_delta", Text: text, SessionID: sessionID, Payload: evt}}
			}
		}
	}

	// Top-level `usage` block.
	if usage, ok := evt["usage"].(map[string]any); ok && len(usage) > 0 {
		return []proto.AgentRunEventFrame{{EventType: "usage", SessionID: sessionID, Payload: evt}}
	}

	// Top-level standalone thinking/reasoning fields.
	if text := traeFirstString(evt, "thinking", "reasoning", "reason"); text != "" {
		return []proto.AgentRunEventFrame{{EventType: "thinking_delta", Text: text, SessionID: sessionID, Payload: evt}}
	}

	return []proto.AgentRunEventFrame{{EventType: "log", SessionID: sessionID, Payload: evt}}
}

func traeFirstString(m map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, _ := m[key].(string); value != "" {
			return value
		}
	}
	return ""
}

// Compile-time assertion that *Agent implements agentruntime.OutputParser.
var _ agentcore.OutputParser = (*Agent)(nil)
