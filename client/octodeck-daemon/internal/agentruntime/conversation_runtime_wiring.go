package agentruntime

import (
	"errors"

	claudecode "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentruntime/claudecode"
	codex "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentruntime/codex"
	traecli "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentruntime/traecli"
	traex "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentruntime/traex"
	daemonconfig "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/config"
	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
)

var ErrNoFamilyDriver = errors.New("conversation runtime resolver: no family driver")

// BuildConversationRuntimeRegistry constructs a per-process conversation
// registry whose family resolver maps an incoming request's AgentID to the
// matching FamilyDriver.
// It builds one Driver per discovered agent client.
//
// Returns nil (not an error) when no agents are configured; callers should
// fall back to the legacy path in that case.
func BuildConversationRuntimeRegistry(cfg *daemonconfig.Config) *Registry {
	drivers := buildFamilyDrivers(cfg)
	if len(drivers) == 0 {
		return nil
	}
	resolver := func(req *proto.AgentRunRequestFrame) (FamilyDriver, error) {
		if req == nil {
			return nil, errors.New("conversation runtime resolver: nil request")
		}
		if d, ok := drivers[req.AgentID]; ok {
			return d, nil
		}
		return nil, errors.Join(ErrNoFamilyDriver, errors.New("agent "+req.AgentID))
	}
	return NewRegistry(DefaultPersistentStore(), resolver)
}

// buildFamilyDrivers instantiates one FamilyDriver per discovered builtin
// agent client (claude-code / codex / traecli / traex-acp). Custom stdio/a2a/
// http agents are intentionally excluded and continue through their custom
// direct transport path.
func buildFamilyDrivers(cfg *daemonconfig.Config) map[string]FamilyDriver {
	out := make(map[string]FamilyDriver)
	if cfg == nil {
		return out
	}
	clients := cfg.AgentClients
	if clients == nil {
		clients = DiscoverAgentClients(cfg)
	}
	for _, client := range clients {
		entry := FindAgentRegistryEntry(cfg, client.ID)
		var d FamilyDriver
		switch agentFamily(client) {
		case "claude":
			d = claudecode.NewDriver(client, entry)
		case "codex":
			d = codex.NewDriver(client, entry)
		case "traecli":
			d = traecli.NewDriver(client, entry)
		case "traex":
			d = traex.NewDriver(client, entry)
		default:
			continue
		}
		if d != nil {
			out[client.ID] = d
		}
	}
	return out
}
