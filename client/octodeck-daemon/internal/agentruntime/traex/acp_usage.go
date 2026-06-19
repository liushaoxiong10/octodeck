package traex

import acpsdk "github.com/coder/acp-go-sdk"

// UsageToMap normalises an acpsdk.Usage into the wire-friendly map shape
// the daemon emits inside AgentRunResultFrame.Usage.
func UsageToMap(usage *acpsdk.Usage) map[string]any {
	if usage == nil {
		return nil
	}
	out := SDKPayload(usage)
	out["input_tokens"] = usage.InputTokens
	out["output_tokens"] = usage.OutputTokens
	out["total_tokens"] = usage.TotalTokens
	if usage.CachedReadTokens != nil {
		out["cache_read_input_tokens"] = *usage.CachedReadTokens
	}
	if usage.CachedWriteTokens != nil {
		out["cache_creation_input_tokens"] = *usage.CachedWriteTokens
	}
	return out
}

// UsageFromPayload locates an embedded usage block within an arbitrary frame
// payload, returning the canonical token-count map or nil if no usage data
// is present.
func UsageFromPayload(payload map[string]any) map[string]any {
	if payload == nil {
		return nil
	}
	if usage, ok := payload["usage"].(map[string]any); ok {
		return usage
	}
	if usage := FindMapDeep(payload, func(m map[string]any) bool {
		_, ok := m["usage"]
		return ok
	}); usage != nil {
		if nested, ok := usage["usage"].(map[string]any); ok {
			return nested
		}
	}
	if HasAnyKey(
		payload,
		"inputTokens", "outputTokens",
		"input_tokens", "output_tokens",
		"totalTokens", "total_tokens",
		"cacheReadInputTokens", "cache_read_input_tokens",
		"costUSD", "cost_usd",
		"used", "usedTokens", "used_tokens",
	) {
		return payload
	}
	return nil
}
