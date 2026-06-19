// Package traex — output parser (OutputParser implementation).
//
// 阶段 C: 把 traex stdio 输出解析从公共 internal/output 包下沉到本子包。
// traex 用 codex 的 app-server v2 输出 schema（JSONL，每行是一份 envelope，
// 包含 type=tool_use / tool_result / message / usage / thinking / content_block_*
// 等），与 codex / Anthropic stream 高度兼容，因此实现策略与
// internal/output.NormalizeJSONLineFrames 完全一致。
//
// 该文件刻意不复用 internal/output：family 子包必须自洽，避免在 plan §5.5
// 之外再引入跨包共享解析器。
package traex

import (
	"encoding/json"
	"strings"

	agentcore "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentcore"
	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
)

// ParseLine 实现 agentruntime.OutputParser。逐行解析 traex stdio JSONL 输
// 出，返回零或多个 AgentRunEventFrame。空行 / 非 JSON 行返回空 slice。
func (a *Agent) ParseLine(line string) []proto.AgentRunEventFrame {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" {
		return nil
	}
	var evt map[string]any
	if err := json.Unmarshal([]byte(trimmed), &evt); err != nil {
		return []proto.AgentRunEventFrame{{EventType: "log", Text: line}}
	}
	sessionID, _ := evt["session_id"].(string)
	rawType, _ := evt["type"].(string)

	// --- 1. typed frame types (exact match on evt["type"]) ---
	if rawType == "thinking" || rawType == "reasoning" || rawType == "reasoning_delta" {
		if text := firstStringValue(evt, "thinking", "reasoning", "reason", "text", "content"); text != "" {
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

	// --- 2. anthropic-style stream-json delta wrappers ---
	if rawType == "content_block_delta" {
		if delta, ok := evt["delta"].(map[string]any); ok {
			deltaType, _ := delta["type"].(string)
			if deltaType == "thinking_delta" || deltaType == "reasoning_delta" {
				if text := firstStringValue(delta, "thinking", "reasoning", "reason", "text"); text != "" {
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
				payload := blockPayload(evt, block)
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
	}

	// --- 3. result field (single-shot completion output) ---
	if result, ok := evt["result"].(string); ok && result != "" {
		frames := []proto.AgentRunEventFrame{{EventType: "final_result", Text: result, SessionID: sessionID, Payload: evt}}
		if usage := usageFromPayload(evt); usage != nil {
			frames = append(frames, proto.AgentRunEventFrame{EventType: "usage", SessionID: sessionID, Payload: evt})
		}
		return frames
	}

	// --- 4. standalone thinking fields at top level ---
	if text := firstStringValue(evt, "thinking", "reasoning", "reason"); text != "" {
		return []proto.AgentRunEventFrame{{EventType: "thinking_delta", Text: text, SessionID: sessionID, Payload: evt}}
	}

	// --- 5. delta (generic / stream_event wrapper) ---
	if delta, ok := evt["delta"].(map[string]any); ok {
		deltaType, _ := delta["type"].(string)
		if deltaType == "thinking_delta" || deltaType == "reasoning_delta" {
			if text := firstStringValue(delta, "thinking", "reasoning", "reason"); text != "" {
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

	// --- 6. evt["message"] (assistant message, tool result echoes, ...) ---
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
				payload := blockPayload(evt, m)
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
					if text := firstStringValue(m, "thinking", "reasoning", "reason", "text", "content"); text != "" {
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

var _ agentcore.OutputParser = (*Agent)(nil)

// ----------------------------------------------------------------------------
// Output parser private helpers (inlined copies of internal/output helpers).
// ----------------------------------------------------------------------------

func blockPayload(evt map[string]any, block map[string]any) map[string]any {
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

func firstStringValue(m map[string]any, keys ...string) string {
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
