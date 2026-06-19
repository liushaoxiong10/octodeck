// Package claudecode — factory wiring.
//
// New is the single constructor used by the runtime facade to instantiate a
// Claude agent runtime.
package claudecode

import (
	agentclient "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentclient"
	agentcore "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentcore"
	daemonconfig "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/config"
	inventory "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/inventory"
)

// New constructs a Claude agent bound to the given discovered client info and
// (optional) registry entry. The returned value satisfies the facade Agent
// interface implicitly.
//
// The BaseAgent fields are populated directly via a struct literal; there is
// no constructor on agentcore.BaseAgent, and the fields (Client, Entry)
// are exported precisely so per-family packages can build their own embedding
// structs without depending on a helper function.
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
