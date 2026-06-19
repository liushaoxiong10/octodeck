// Package claudecode — Anthropic stream-json output parser.
//
// Implements agentruntime.OutputParser for the Claude family. Each line of
// the spawned `claude -p ... --output-format stream-json` stdout is fed to
// ParseLine, which decodes the JSON and converts it into zero-or-more
// AgentRunEventFrame values (text_delta / thinking_delta / tool_call /
// tool_result / usage / log / final_result).
//
// The schema we recognise is the Anthropic "Messages" stream protocol:
//
//   - message_start / message_delta / message_stop  (top-level wrappers)
//   - content_block_start / content_block_delta / content_block_stop
//     with delta.type ∈ {text_delta, thinking_delta, input_json_delta}
//     and content_block.type ∈ {tool_use, ...}
//   - message.role == "assistant" with content blocks of type
//     {text, thinking, tool_use, tool_result}
//   - top-level "usage" / "result" / typed convenience frames
//     (thinking / reasoning / tool_use / tool_result / permission_request)
//
// A handful of generic helpers (firstString / findMapDeep / hasAnyKey /
// usageFromPayload / agentBlockPayload) are duplicated locally to keep
// the family package independent from internal/output. Phase E3 will
// expose a parser-injection seam in internal/output that lets the daemon
// main loop dispatch directly via this OutputParser, after which the
// duplicate logic in internal/output/parser.go can be removed.
package claudecode

import (
	"encoding/json"
	"strings"

	agentcore "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentcore"
	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
)

// Compile-time interface assertion: *Agent satisfies the optional
// OutputParser capability defined in agentruntime/capabilities_optional.go.
var _ agentcore.OutputParser = (*Agent)(nil)

// ParseLine decodes a single line of Anthropic stream-json output and
// returns the corresponding event frames. Returns nil when the line is
// invalid JSON or carries no semantically meaningful event.
//
// This is the family-private implementation of OutputParser; daemon-main
// simply does `if p, ok := agent.(OutputParser); ok { p.ParseLine(line) }`
// without knowing whether the underlying agent is claude / codex / traex.
func (a *Agent) ParseLine(line string) []proto.AgentRunEventFrame {
	var evt map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(line)), &evt); err != nil {
		return []proto.AgentRunEventFrame{{EventType: "log", Text: line}}
	}
	sessionID, _ := evt["session_id"].(string)
	rawType, _ := evt["type"].(string)

	// --- 1. Typed frame types (exact match on evt["type"]) ---
	if rawType == "thinking" || rawType == "reasoning" || rawType == "reasoning_delta" {
		if text := firstString(evt, "thinking", "reasoning", "reason", "text", "content"); text != "" {
			return []proto.AgentRunEventFrame{{EventType: "thinking_delta", Text: text, SessionID: sessionID, Payload: evt}}
		}
	}
	if rawType == "tool_use" || rawType == "tool_call" || rawType == "tool_use_start" {
		return []proto.AgentRunEventFrame{{EventType: "tool_call", SessionID: sessionID, Payload: evt}}
	}
	if rawType == "tool_result" || rawType == "tool_use_end" {
		return []proto.AgentRunEventFrame{{EventType: "tool_result", SessionID: sessionID, Payload: evt}}
	}
	if rawType == "usage" {
		return []proto.AgentRunEventFrame{{EventType: "usage", SessionID: sessionID, Payload: evt}}
	}
	if rawType == "permission_request" || rawType == "approval_request" {
		return []proto.AgentRunEventFrame{{EventType: "permission_request", SessionID: sessionID, Payload: evt}}
	}

	// --- 2. Anthropic stream-json: content_block_* / message_delta ---
	if rawType == "content_block_delta" {
		if delta, ok := evt["delta"].(map[string]any); ok {
			deltaType, _ := delta["type"].(string)
			if deltaType == "thinking_delta" || deltaType == "reasoning_delta" {
				if text := firstString(delta, "thinking", "reasoning", "reason", "text"); text != "" {
					return []proto.AgentRunEventFrame{{EventType: "thinking_delta", Text: text, SessionID: sessionID, Payload: evt}}
				}
			}
			if deltaType == "text_delta" {
				if text, _ := delta["text"].(string); text != "" {
					return []proto.AgentRunEventFrame{{EventType: "text_delta", Text: text, SessionID: sessionID, Payload: evt}}
				}
			}
			if deltaType == "input_json_delta" {
				if partial, _ := delta["partial_json"].(string); partial != "" {
					return []proto.AgentRunEventFrame{{EventType: "tool_call", SessionID: sessionID, Payload: evt}}
				}
			}
		}
		return nil
	}
	if rawType == "content_block_start" {
		if block, ok := evt["content_block"].(map[string]any); ok {
			blockType, _ := block["type"].(string)
			if blockType == "tool_use" {
				payload := agentBlockPayload(evt, block)
				return []proto.AgentRunEventFrame{{EventType: "tool_call", SessionID: sessionID, Payload: payload}}
			}
		}
		return nil
	}
	if rawType == "content_block_stop" {
		return nil
	}
	if rawType == "message_stop" {
		if usage, ok := evt["usage"].(map[string]any); ok && len(usage) > 0 {
			return []proto.AgentRunEventFrame{{EventType: "usage", SessionID: sessionID, Payload: evt}}
		}
		return nil
	}
	if rawType == "message_delta" {
		if usage, ok := evt["usage"].(map[string]any); ok && len(usage) > 0 {
			return []proto.AgentRunEventFrame{{EventType: "usage", SessionID: sessionID, Payload: evt}}
		}
		// Don't early-return; section 6 may still extract stop_reason or other useful
		// metadata for tool events. Fall through without emitting text.
	}

	// --- 3. result field (generic single-shot completion output) ---
	if result, ok := evt["result"].(string); ok && result != "" {
		frames := []proto.AgentRunEventFrame{{EventType: "final_result", Text: result, SessionID: sessionID, Payload: evt}}
		if usage := usageFromPayload(evt); usage != nil {
			frames = append(frames, proto.AgentRunEventFrame{EventType: "usage", SessionID: sessionID, Payload: evt})
		}
		return frames
	}

	// --- 4. standalone thinking fields at top level ---
	if text := firstString(evt, "thinking", "reasoning", "reason"); text != "" {
		return []proto.AgentRunEventFrame{{EventType: "thinking_delta", Text: text, SessionID: sessionID, Payload: evt}}
	}

	// --- 5. delta (generic; stream_event wrapper or message_delta) ---
	if delta, ok := evt["delta"].(map[string]any); ok {
		deltaType, _ := delta["type"].(string)
		if deltaType == "thinking_delta" || deltaType == "reasoning_delta" {
			if text := firstString(delta, "thinking", "reasoning", "reason"); text != "" {
				return []proto.AgentRunEventFrame{{EventType: "thinking_delta", Text: text, SessionID: sessionID, Payload: evt}}
			}
		}
		if deltaType == "text_delta" {
			if text, _ := delta["text"].(string); text != "" {
				return []proto.AgentRunEventFrame{{EventType: "text_delta", Text: text, SessionID: sessionID, Payload: evt}}
			}
		}
		if role, _ := delta["role"].(string); role == "assistant" {
			if content, _ := delta["content"].(string); content != "" {
				return []proto.AgentRunEventFrame{{EventType: "text_delta", Text: content, SessionID: sessionID, Payload: evt}}
			}
		}
	}

	// --- 6. evt["message"] (assistant message / user tool-result echo / message_start) ---
	if msg, ok := evt["message"].(map[string]any); ok {
		role, _ := msg["role"].(string)
		isNonAssistantTextTurn := role == "user" || role == "system" || rawType == "user" || rawType == "system"
		isStreamingWrapper := rawType == "message_start" || rawType == "message_stop" ||
			rawType == "message_delta" || rawType == "content_block_stop"
		if content, ok := msg["content"].(string); ok && content != "" {
			if !isNonAssistantTextTurn && !isStreamingWrapper {
				return []proto.AgentRunEventFrame{{EventType: "text_delta", Text: content, SessionID: sessionID, Payload: evt}}
			}
		}
		if blocks, ok := msg["content"].([]any); ok {
			frames := make([]proto.AgentRunEventFrame, 0, len(blocks))
			for _, block := range blocks {
				m, _ := block.(map[string]any)
				typ, _ := m["type"].(string)
				payload := agentBlockPayload(evt, m)
				if typ == "tool_use" || typ == "tool_call" || typ == "tool_use_start" {
					frames = append(frames, proto.AgentRunEventFrame{EventType: "tool_call", SessionID: sessionID, Payload: payload})
					continue
				}
				if typ == "tool_result" || typ == "tool_use_end" {
					frames = append(frames, proto.AgentRunEventFrame{EventType: "tool_result", SessionID: sessionID, Payload: payload})
					continue
				}
				if isNonAssistantTextTurn || isStreamingWrapper {
					continue
				}
				if typ == "thinking" || typ == "reasoning" {
					if text := firstString(m, "thinking", "reasoning", "reason", "text", "content"); text != "" {
						frames = append(frames, proto.AgentRunEventFrame{EventType: "thinking_delta", Text: text, SessionID: sessionID, Payload: payload})
						continue
					}
				}
				if typ == "text" || typ == "output_text" || typ == "assistant" {
					if text, _ := m["text"].(string); text != "" {
						frames = append(frames, proto.AgentRunEventFrame{EventType: "text_delta", Text: text, SessionID: sessionID, Payload: payload})
					}
				}
			}
			if len(frames) > 0 {
				return frames
			}
		}
	}

	// --- 7. standalone usage block at top level ---
	if usage, ok := evt["usage"].(map[string]any); ok {
		evt["usage"] = usage
		return []proto.AgentRunEventFrame{{EventType: "usage", SessionID: sessionID, Payload: evt}}
	}
	return []proto.AgentRunEventFrame{{EventType: "log", SessionID: sessionID, Payload: evt}}
}

// agentBlockPayload duplicates internal/output.agentBlockPayload locally so
// the family package does not import internal/output. Phase E3 plans to
// expose a parser-injection seam there; until then we keep the two copies
// in sync (this one is free-standing and family-agnostic in behaviour).
func agentBlockPayload(evt map[string]any, block map[string]any) map[string]any {
	payload := make(map[string]any, len(block)+4)
	for k, v := range block {
		payload[k] = v
	}
	if sessionID, ok := evt["session_id"].(string); ok && sessionID != "" {
		payload["session_id"] = sessionID
	}
	if msgUUID, ok := evt["uuid"].(string); ok && msgUUID != "" {
		payload["message_uuid"] = msgUUID
	}
	if rawType, ok := evt["type"].(string); ok && rawType != "" {
		payload["message_type"] = rawType
	}
	payload["rawEvent"] = evt
	return payload
}

func firstString(m map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, _ := m[key].(string); value != "" {
			return value
		}
	}
	return ""
}

func usageFromPayload(payload map[string]any) map[string]any {
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
