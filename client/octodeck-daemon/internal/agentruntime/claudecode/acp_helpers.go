package claudecode

// FirstString returns the first non-empty string value among the given keys.
func FirstString(m map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, _ := m[key].(string); value != "" {
			return value
		}
	}
	return ""
}

// FirstStringDeep recursively walks the payload up to depth 8 looking for the
// first non-empty string value matching any of the provided keys.
func FirstStringDeep(value any, keys ...string) string {
	return firstStringDeepWithDepth(value, 0, keys...)
}

func firstStringDeepWithDepth(value any, depth int, keys ...string) string {
	if depth > 8 || value == nil {
		return ""
	}
	switch v := value.(type) {
	case map[string]any:
		for _, key := range keys {
			if s, ok := v[key].(string); ok && s != "" {
				return s
			}
		}
		for _, child := range v {
			if text := firstStringDeepWithDepth(child, depth+1, keys...); text != "" {
				return text
			}
		}
	case []any:
		for _, child := range v {
			if text := firstStringDeepWithDepth(child, depth+1, keys...); text != "" {
				return text
			}
		}
	}
	return ""
}

// FindMapDeep recursively walks the payload up to depth 8 looking for the
// first map satisfying pred.
func FindMapDeep(value any, pred func(map[string]any) bool) map[string]any {
	return findACPMapDeepWithDepth(value, pred, 0)
}

func findACPMapDeepWithDepth(value any, pred func(map[string]any) bool, depth int) map[string]any {
	if depth > 8 || value == nil {
		return nil
	}
	switch v := value.(type) {
	case map[string]any:
		if pred(v) {
			return v
		}
		for _, child := range v {
			if found := findACPMapDeepWithDepth(child, pred, depth+1); found != nil {
				return found
			}
		}
	case []any:
		for _, child := range v {
			if found := findACPMapDeepWithDepth(child, pred, depth+1); found != nil {
				return found
			}
		}
	}
	return nil
}

// HasAnyKey returns true when any of the listed keys is present in m.
func HasAnyKey(m map[string]any, keys ...string) bool {
	for _, key := range keys {
		if _, ok := m[key]; ok {
			return true
		}
	}
	return false
}
