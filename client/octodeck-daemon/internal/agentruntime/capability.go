// Package agentruntime: capability.go owns the helpers that translate
// daemon configuration + discovered agent clients into RuntimeCapability /
// RuntimeStatus descriptors that the platform server consumes.
//
// These helpers were absorbed from daemonapp during stage 3A so that the
// node uplink layer can build capability/heartbeat frames without crossing
// back into daemonapp.
package agentruntime

import (
	daemonconfig "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/config"
	inventory "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/inventory"
	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
	state "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/state"
)

// BuildRuntimeCapabilities builds runtime capability descriptors for every
// discovered agent client, applying both the global runtime policy and any
// per-agent registry overrides. The returned slice is the contents of the
// AgentRuntimeCapabilities field of a hello frame.
func BuildRuntimeCapabilities(cfg *daemonconfig.Config, pool *state.RunPool) []proto.RuntimeCapability {
	if cfg == nil {
		return nil
	}
	out := make([]proto.RuntimeCapability, 0, len(cfg.AgentClients))
	maxRuns := 0
	available := 0
	if pool != nil {
		maxRuns = pool.MaxConcurrentRuns()
		available = pool.AvailableSlots()
	}
	for _, client := range cfg.AgentClients {
		entry := FindAgentRegistryEntry(cfg, client.ID)
		allowedWorkspaces := cfg.RuntimePolicy.AllowedWorkspaces
		allowedTools := cfg.RuntimePolicy.AllowedTools
		disallowedTools := cfg.RuntimePolicy.DisallowedTools
		toolPolicy := cfg.RuntimePolicy.ToolPolicy
		if entry != nil {
			if len(entry.AllowedWorkspaces) > 0 {
				allowedWorkspaces = entry.AllowedWorkspaces
			}
			if len(entry.AllowedTools) > 0 {
				allowedTools = entry.AllowedTools
			}
			if len(entry.DisallowedTools) > 0 {
				disallowedTools = entry.DisallowedTools
			}
			if len(entry.ToolPolicy) > 0 {
				toolPolicy = entry.ToolPolicy
			}
		}
		out = append(out, proto.RuntimeCapability{
			RuntimeID:         cfg.LinkID + ":" + client.ID,
			AgentID:           client.ID,
			Family:            client.Family,
			Provider:          IfEmpty(client.Provider, client.ID),
			Transport:         IfEmpty(client.Transport, "stdio"),
			Features:          append([]string(nil), client.Capabilities...),
			PermissionModes:   EffectivePermissionModes(cfg, entry, client),
			AllowedWorkspaces: allowedWorkspaces,
			AllowedTools:      allowedTools,
			DisallowedTools:   disallowedTools,
			ToolPolicy:        toolPolicy,
			MaxConcurrentRuns: maxRuns,
			AvailableSlots:    available,
		})
	}
	return out
}

// BuildRuntimeStatuses produces the RuntimeStatus snapshot embedded inside a
// heartbeat ping frame. Each element corresponds to an enabled agent client
// on the device.
func BuildRuntimeStatuses(linkID string, clients []inventory.Info, running []proto.RunningRunInfo, maxRuns, available int, deviceStatus string) []proto.RuntimeStatus {
	out := make([]proto.RuntimeStatus, 0, len(clients))
	status := deviceStatus
	if status == "" {
		status = "idle"
	}
	if status == "idle" && len(running) > 0 {
		status = "busy"
	}
	for _, client := range clients {
		out = append(out, proto.RuntimeStatus{
			RuntimeID:         linkID + ":" + client.ID,
			DeviceLinkID:      linkID,
			AgentClientID:     client.ID,
			DisplayName:       client.DisplayName,
			Family:            client.Family,
			Provider:          IfEmpty(client.Provider, client.ID),
			Transport:         IfEmpty(client.Transport, "stdio"),
			Status:            status,
			MaxConcurrentRuns: maxRuns,
			RunningRuns:       running,
			AvailableSlots:    available,
		})
	}
	return out
}
