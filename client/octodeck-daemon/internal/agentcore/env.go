package agentcore

import (
	daemonconfig "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/config"
	security "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/security"
	workspaceutil "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/workspace"
)

func BuildAgentEnv(cfg *daemonconfig.Config, agentID string, overrides map[string]string, runContext any) []string {
	merged := make(map[string]string)
	if cfg != nil {
		for i := range cfg.AgentRegistry {
			entry := &cfg.AgentRegistry[i]
			if entry.ID != agentID {
				continue
			}
			for k, v := range entry.Env {
				if !security.IsDangerousKey(k) {
					merged[k] = v
				}
			}
			break
		}
	}
	for k, v := range overrides {
		merged[k] = v
	}
	return security.BuildEnv(security.EnvConfig{SessionDir: daemonconfig.SessionDir(cfg)}, merged, runContext, envSnapshot(), workspaceutil.SafeGroupFolder)
}

func envSnapshot() map[string]string { return security.EnvSnapshot() }
