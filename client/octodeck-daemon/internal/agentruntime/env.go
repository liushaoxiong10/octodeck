package agentruntime

import (
	daemonconfig "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/config"
	inventory "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/inventory"
	security "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/security"
	workspaceutil "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/workspace"
)

// BuildAgentEnv builds the environment variables for an agent process. It
// merges the agent registry entry's env with per-request overrides, filtering
// out dangerous keys, then delegates to security.BuildEnv.
func BuildAgentEnv(cfg *daemonconfig.Config, agentID string, overrides map[string]string, runContext any) []string {
	merged := make(map[string]string)
	if entry := FindAgentRegistryEntry(cfg, agentID); entry != nil {
		for k, v := range entry.Env {
			if !IsDangerousEnvKey(k) {
				merged[k] = v
			}
		}
	}
	for k, v := range overrides {
		merged[k] = v
	}
	return security.BuildEnv(security.EnvConfig{SessionDir: daemonconfig.SessionDir(cfg)}, merged, runContext, envSnapshot(), workspaceutil.SafeGroupFolder)
}

// FindAgentClient finds an agent client info by ID from the config's discovered clients.
func FindAgentClient(cfg *daemonconfig.Config, agentID string) *inventory.Info {
	for i := range cfg.AgentClients {
		if cfg.AgentClients[i].ID == agentID {
			return &cfg.AgentClients[i]
		}
	}
	return nil
}

// FindAgentRegistryEntry finds an agent registry entry by ID from the config.
func FindAgentRegistryEntry(cfg *daemonconfig.Config, agentID string) *daemonconfig.AgentRegistryEntry {
	if cfg == nil {
		return nil
	}
	for i := range cfg.AgentRegistry {
		if cfg.AgentRegistry[i].ID == agentID {
			return &cfg.AgentRegistry[i]
		}
	}
	return nil
}

// IsDangerousEnvKey returns true if the environment variable key is not allowed
// to be set by untrusted callers (e.g. LD_PRELOAD, PATH, NODE_OPTIONS).
func IsDangerousEnvKey(k string) bool { return security.IsDangerousKey(k) }
