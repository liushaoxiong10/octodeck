// Package codex — output parser (OutputParser implementation).
//
// Codex emits a JSONL stream that mixes generic "typed event" frames
// (tool_use / tool_result / usage / permission_request), the standard
// Anthropic-style content_block_* deltas, single-shot `result` payloads
// and assistant-message blocks. This file owns a self-contained parser
// for that stream so the daemon main loop can drop the family-aware
// switch in internal/output/parser.go and just call ParseLine on the
// agentruntime.OutputParser type assertion.
//
// The implementation mirrors output.NormalizeJSONLineFrames as of the
// C-stage migration: a behaviour-preserving copy whose only purpose is
// to live inside the codex sub-package so it can evolve in lock-step
// with the codex CLI without requiring shared-package edits.
package codex

import (
	"encoding/json"
	"strings"

	agentcore "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentcore"
	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
)

// ParseLine implements agentruntime.OutputParser for the Codex family.
//
// Returns zero or more AgentRunEventFrame values. ParseLine is
// stateless: each call receives a single raw stdout line and decides
// what frames (if any) to emit. The function is safe for concurrent
// use.
func (a *Agent) ParseLine(line string) []proto.AgentRunEventFrame {
	var evt map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(line)), &evt); err != nil {
		return []proto.AgentRunEventFrame{{EventType: "log", Text: line}}
	}
	sessionID, _ := evt["session_id"].(string)
	rawType, _ := evt["type"].(string)

	// --- 1. Typed frame types (exact match on evt["type"]) ---
	if rawType == "thinking" || rawType == "reasoning" || rawType == "reasoning_delta" {
		if text := codexFirstString(evt, "thinking", "reasoning", "reason", "text", "content"); text != "" {
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

	// --- 2. Anthropic-style stream-json: content_block_* / message_* ---
	if rawType == "content_block_delta" {
		if delta, ok := evt["delta"].(map[string]any); ok {
			deltaType, _ := delta["type"].(string)
			if deltaType == "thinking_delta" || deltaType == "reasoning_delta" {
				if text := codexFirstString(delta, "thinking", "reasoning", "reason", "text"); text != "" {
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
				payload := codexAgentBlockPayload(evt, block)
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
		// Don't early-return; section 6 may still extract metadata for tool events.
	}

	// --- 3. result field (generic single-shot completion output) ---
	if result, ok := evt["result"].(string); ok && result != "" {
		frames := []proto.AgentRunEventFrame{{EventType: "final_result", Text: result, SessionID: sessionID, Payload: evt}}
		if usage := codexUsageFromPayload(evt); usage != nil {
			frames = append(frames, proto.AgentRunEventFrame{EventType: "usage", SessionID: sessionID, Payload: evt})
		}
		return frames
	}

	// --- 4. standalone thinking fields at top level ---
	if text := codexFirstString(evt, "thinking", "reasoning", "reason"); text != "" {
		return []proto.AgentRunEventFrame{{EventType: "thinking_delta", Text: text, SessionID: sessionID, Payload: evt}}
	}

	// --- 5. delta (generic; stream_event wrapper or message_delta) ---
	if delta, ok := evt["delta"].(map[string]any); ok {
		deltaType, _ := delta["type"].(string)
		if deltaType == "thinking_delta" || deltaType == "reasoning_delta" {
			if text := codexFirstString(delta, "thinking", "reasoning", "reason"); text != "" {
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
				payload := codexAgentBlockPayload(evt, m)
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
					if text := codexFirstString(m, "thinking", "reasoning", "reason", "text", "content"); text != "" {
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

func codexAgentBlockPayload(evt map[string]any, block map[string]any) map[string]any {
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

func codexFirstString(m map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, _ := m[key].(string); value != "" {
			return value
		}
	}
	return ""
}

func codexUsageFromPayload(payload map[string]any) map[string]any {
	if payload == nil {
		return nil
	}
	if usage, ok := payload["usage"].(map[string]any); ok {
		return usage
	}
	if usage := codexFindMapDeep(payload, func(m map[string]any) bool {
		_, ok := m["usage"]
		return ok
	}); usage != nil {
		if nested, ok := usage["usage"].(map[string]any); ok {
			return nested
		}
	}
	if codexHasAnyKey(payload,
		"inputTokens", "outputTokens", "input_tokens", "output_tokens",
		"totalTokens", "total_tokens",
		"cacheReadInputTokens", "cache_read_input_tokens",
		"costUSD", "cost_usd",
	) {
		return payload
	}
	return nil
}

func codexFindMapDeep(value any, pred func(map[string]any) bool) map[string]any {
	return codexFindMapDeepWithDepth(value, pred, 0)
}

func codexFindMapDeepWithDepth(value any, pred func(map[string]any) bool, depth int) map[string]any {
	if depth > 8 || value == nil {
		return nil
	}
	switch v := value.(type) {
	case map[string]any:
		if pred(v) {
			return v
		}
		for _, child := range v {
			if found := codexFindMapDeepWithDepth(child, pred, depth+1); found != nil {
				return found
			}
		}
	case []any:
		for _, child := range v {
			if found := codexFindMapDeepWithDepth(child, pred, depth+1); found != nil {
				return found
			}
		}
	}
	return nil
}

func codexHasAnyKey(m map[string]any, keys ...string) bool {
	for _, key := range keys {
		if _, ok := m[key]; ok {
			return true
		}
	}
	return false
}

// Compile-time interface assertion.
var _ agentcore.OutputParser = (*Agent)(nil)
