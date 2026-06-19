// Package codex — factory wiring.
//
// New is the single constructor used by the runtime facade to instantiate a
// Codex agent runtime.
package codex

import (
	agentclient "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentclient"
	agentcore "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentcore"
	daemonconfig "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/config"
	inventory "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/inventory"
)

// New constructs a Codex agent bound to the given discovered client info and
// (optional) registry entry. The returned value satisfies the facade Agent
// interface implicitly.
func New(client inventory.Info, entry *daemonconfig.AgentRegistryEntry) *Agent {
	return &Agent{
		BaseAgent: agentcore.BaseAgent{
			Client: client,
			Entry:  entry,
		},
	}
}

// init publishes the family Descriptor to the global agentclient registry.
func init() {
	agentclient.Register(Descriptor())
}
