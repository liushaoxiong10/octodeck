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

// MergeUsageMaps combines usage snapshots without letting partial snapshots
// erase token counts that arrived on earlier ACP usage events.
func MergeUsageMaps(existing, next map[string]any) map[string]any {
	if len(existing) == 0 {
		return cloneUsageMap(next)
	}
	if len(next) == 0 {
		return cloneUsageMap(existing)
	}
	out := cloneUsageMap(existing)
	for key, value := range next {
		if isTokenCountKey(key) && numericValue(value) == 0 && numericValue(out[key]) > 0 {
			continue
		}
		out[key] = value
	}
	return out
}

func cloneUsageMap(input map[string]any) map[string]any {
	if input == nil {
		return nil
	}
	out := make(map[string]any, len(input))
	for key, value := range input {
		out[key] = value
	}
	return out
}

func isTokenCountKey(key string) bool {
	switch key {
	case "inputTokens", "input_tokens",
		"outputTokens", "output_tokens",
		"totalTokens", "total_tokens",
		"cachedReadTokens", "cacheReadInputTokens", "cache_read_input_tokens",
		"cachedWriteTokens", "cacheCreationInputTokens", "cache_creation_input_tokens",
		"thoughtTokens", "thought_tokens":
		return true
	default:
		return false
	}
}

func numericValue(value any) float64 {
	switch v := value.(type) {
	case int:
		return float64(v)
	case int8:
		return float64(v)
	case int16:
		return float64(v)
	case int32:
		return float64(v)
	case int64:
		return float64(v)
	case uint:
		return float64(v)
	case uint8:
		return float64(v)
	case uint16:
		return float64(v)
	case uint32:
		return float64(v)
	case uint64:
		return float64(v)
	case float32:
		return float64(v)
	case float64:
		return v
	default:
		return 0
	}
}
