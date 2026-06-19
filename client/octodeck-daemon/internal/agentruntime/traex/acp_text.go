package traex

import "strings"

// AssistantText extracts the assistant's reply text from an arbitrary ACP
// payload shape (delta / message / direct content).
func AssistantText(payload map[string]any) string {
	if payload == nil {
		return ""
	}
	if delta, ok := payload["delta"].(map[string]any); ok {
		if text := FirstStringDeep(delta, "text", "content", "message", "output"); text != "" {
			return text
		}
	}
	if msg, ok := payload["message"].(map[string]any); ok {
		if text := ContentText(msg["content"], false); text != "" {
			return text
		}
	}
	if text := ContentText(payload["content"], false); text != "" {
		return text
	}
	return FirstString(payload, "text", "delta", "result", "output")
}

// ContentText flattens an ACP-style content array (text / output_text / etc.)
// into a single string.
func ContentText(value any, includeThinking bool) string {
	switch v := value.(type) {
	case string:
		return v
	case []any:
		var b strings.Builder
		for _, item := range v {
			m, ok := item.(map[string]any)
			if !ok {
				continue
			}
			typ := strings.ToLower(FirstString(m, "type", "kind"))
			if typ == "text" || typ == "output_text" || typ == "assistant" || (includeThinking && (typ == "thinking" || typ == "reasoning")) {
				if text := FirstStringDeep(m, "text", "content", "thinking", "reasoning", "reason"); text != "" {
					b.WriteString(text)
				}
			}
		}
		return b.String()
	}
	return ""
}

// EnrichToolPayload pulls common tool-call fields up to the top level so
// downstream renderers don't need to dig into nested variants.
func EnrichToolPayload(payload map[string]any) {
	if payload == nil {
		return
	}
	tool := FindMapDeep(payload, func(m map[string]any) bool {
		typ := strings.ToLower(FirstString(m, "type", "kind"))
		if strings.Contains(typ, "tool") {
			return true
		}
		return (FirstString(m, "name", "toolName") != "" && (m["input"] != nil || m["arguments"] != nil || m["args"] != nil)) || FirstString(m, "toolUseId", "tool_use_id") != ""
	})
	if tool == nil {
		return
	}
	for _, key := range []string{"id", "toolUseId", "tool_use_id", "name", "toolName", "input", "arguments", "args", "content", "result", "output", "text", "is_error", "isError", "error"} {
		if payload[key] == nil && tool[key] != nil {
			payload[key] = tool[key]
		}
	}
	if payload["toolName"] == nil {
		if name := FirstString(tool, "name", "toolName"); name != "" {
			payload["toolName"] = name
		}
	}
	if payload["toolUseId"] == nil {
		if id := FirstString(tool, "id", "toolUseId", "tool_use_id"); id != "" {
			payload["toolUseId"] = id
		}
	}
}

// HasToolStart returns true when the payload looks like a tool_use / tool_call
// start event (vs an in-progress update or a tool_result).
func HasToolStart(payload map[string]any) bool {
	if payload == nil {
		return false
	}
	if payload["toolCall"] != nil || payload["tool_call"] != nil || payload["toolUse"] != nil || payload["tool_use"] != nil {
		return true
	}
	return FindMapDeep(payload, func(m map[string]any) bool {
		typ := strings.ToLower(FirstString(m, "type", "kind"))
		return typ == "tool_use" || typ == "tool_call" || typ == "tool_use_start" || (FirstString(m, "name", "toolName") != "" && (m["input"] != nil || m["arguments"] != nil || m["args"] != nil))
	}) != nil
}
