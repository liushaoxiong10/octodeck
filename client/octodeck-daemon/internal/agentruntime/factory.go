package agentruntime

import (
	"strings"

	claudecode "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentruntime/claudecode"
	codex "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentruntime/codex"
	traecli "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentruntime/traecli"
	traex "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentruntime/traex"
	daemonconfig "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/config"
	inventory "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/inventory"
)

// AgentFactory is a function that creates an Agent for a given client and
// optional registry entry.
type AgentFactory func(inventory.Info, *daemonconfig.AgentRegistryEntry) Agent

var builtinAgentFactories = map[string]AgentFactory{
	claudecode.FamilyID: func(client inventory.Info, entry *daemonconfig.AgentRegistryEntry) Agent {
		return claudecode.New(client, entry)
	},
	codex.FamilyID: func(client inventory.Info, entry *daemonconfig.AgentRegistryEntry) Agent {
		return codex.New(client, entry)
	},
	traecli.FamilyID: func(client inventory.Info, entry *daemonconfig.AgentRegistryEntry) Agent {
		return traecli.New(client, entry)
	},
	traex.FamilyID: func(client inventory.Info, entry *daemonconfig.AgentRegistryEntry) Agent {
		return traex.New(client, entry)
	},
}

// NewBuiltinAgent creates a builtin agent for the given client and entry.
func NewBuiltinAgent(client inventory.Info, entry *daemonconfig.AgentRegistryEntry) Agent {
	if factory := builtinAgentFactories[agentFamily(client)]; factory != nil {
		return factory(client, entry)
	}
	return &PlainAgent{BaseAgent: BaseAgent{Client: client, Entry: entry}}
}

// NewCustomAgent creates a custom agent based on the configured transport.
func NewCustomAgent(client inventory.Info, entry *daemonconfig.AgentRegistryEntry) Agent {
	transport := client.Transport
	if entry != nil && entry.Transport != "" {
		transport = entry.Transport
	}
	if transport == "" {
		transport = "stdio"
	}
	switch transport {
	case "a2a":
		return &CustomA2AAgent{BaseAgent: BaseAgent{Client: client}, Entry: entry}
	case "http":
		if entry != nil {
			return &CustomHTTPAgent{BaseAgent: BaseAgent{Client: client}, Entry: *entry}
		}
	case "stdio", "acp":
		if entry != nil {
			return &CustomStdioAgent{BaseAgent: BaseAgent{Client: client}, Entry: *entry}
		}
	}
	return &PlainAgent{BaseAgent: BaseAgent{Client: client, Entry: entry}}
}

// NewAgent creates the appropriate agent type for the given client.
func NewAgent(client inventory.Info, entry *daemonconfig.AgentRegistryEntry) Agent {
	if entry != nil && agentFamily(client) == "" {
		return NewCustomAgent(client, entry)
	}
	return NewBuiltinAgent(client, entry)
}

func agentFamily(client inventory.Info) string {
	return strings.TrimSpace(client.Family)
}

// BuildAgents builds the agent map from the config's discovered clients.
func BuildAgents(cfg *daemonconfig.Config) map[string]Agent {
	out := make(map[string]Agent)
	if cfg == nil {
		return out
	}
	for _, client := range cfg.AgentClients {
		out[client.ID] = NewAgent(client, FindAgentRegistryEntry(cfg, client.ID))
	}
	return out
}
