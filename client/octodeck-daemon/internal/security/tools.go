package security

import (
	daemonconfig "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/config"
)

// ToolPolicy is a thin view over a per-agent / runtime tool allow/deny pair.
// It is computed by callers (typically agentruntime) and consumed by security
// helpers such as IsToolAllowedByPolicy without forcing security to depend on
// agentruntime (which would form an import cycle: agentruntime -> security ->
// agentruntime).
type ToolPolicy struct {
	AllowedTools    []string
	DisallowedTools []string
}

// EffectiveToolPolicy resolves the active allow/deny tool lists for a given
// runtime policy plus optional agent-registry overrides. The override lists
// only take effect when non-empty, mirroring the original agentruntime logic.
func EffectiveToolPolicy(cfg *daemonconfig.Config, allowedOverride, disallowedOverride []string) ToolPolicy {
	tp := ToolPolicy{}
	if cfg != nil {
		tp.AllowedTools = cfg.RuntimePolicy.AllowedTools
		tp.DisallowedTools = cfg.RuntimePolicy.DisallowedTools
	}
	if len(allowedOverride) > 0 {
		tp.AllowedTools = allowedOverride
	}
	if len(disallowedOverride) > 0 {
		tp.DisallowedTools = disallowedOverride
	}
	return tp
}

// IsToolAllowedByPolicy returns true if tool is permitted by the given policy.
// Empty AllowedTools means "no allowlist restriction"; tools listed in
// DisallowedTools are always rejected.
func IsToolAllowedByPolicy(p ToolPolicy, tool string) bool {
	for _, t := range p.DisallowedTools {
		if t == tool {
			return false
		}
	}
	if len(p.AllowedTools) == 0 {
		return true
	}
	for _, t := range p.AllowedTools {
		if t == tool {
			return true
		}
	}
	return false
}
