package config

// RuntimePolicyConfig constrains agent-runtime behavior and remote policy
// requests. It is embedded inside Config but kept in a dedicated file so
// future policy logic (validation, defaulting, derivation) can grow here
// without bloating config.go.
type RuntimePolicyConfig struct {
	AllowedWorkspaces   []string          `json:"allowedWorkspaces,omitempty"`
	AllowedTools        []string          `json:"allowedTools,omitempty"`
	DisallowedTools     []string          `json:"disallowedTools,omitempty"`
	ToolPolicy          map[string]string `json:"toolPolicy,omitempty"`
	PermissionModes     []string          `json:"permissionModes,omitempty"`
	PermissionTimeoutMs int64             `json:"permissionTimeoutMs,omitempty"`
	MaxRestarts         int               `json:"maxRestarts,omitempty"`
	RestartBackoffMs    int64             `json:"restartBackoffMs,omitempty"`
	DisableAutoDiscover bool              `json:"disableAutoDiscover,omitempty"`
}

// HasWorkspaceRestrictions reports whether the runtime policy explicitly
// restricts which workspace roots are accessible.
func (p RuntimePolicyConfig) HasWorkspaceRestrictions() bool {
	return len(p.AllowedWorkspaces) > 0
}
