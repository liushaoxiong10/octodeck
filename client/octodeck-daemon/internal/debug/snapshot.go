// Package debug owns the debug subcommand implementation. It collects a
// snapshot of the daemon's runtime state (config, agent clients,
// sessions, conversation runtime mappings) and renders it either as
// JSON or via per-section pretty printers.
//
// Stage 5 moved this code out of cmd/octodeck-daemon/debug.go so the
// CLI shell remains a thin entry point.
package debug

import (
	"context"
	"runtime"
	"sort"
	"time"

	agentruntime "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentruntime"
	daemonconfig "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/config"
	inventory "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/inventory"
	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
	state "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/state"
)

// Snapshot is the structured payload emitted by the debug command. The
// JSON tags match the historical daemonapp output so existing tooling
// keeps working.
type Snapshot struct {
	Version                     string                     `json:"version"`
	ConfigPath                  string                     `json:"configPath,omitempty"`
	Server                      string                     `json:"server"`
	LinkID                      string                     `json:"linkId"`
	Hostname                    string                     `json:"hostname,omitempty"`
	OS                          string                     `json:"os"`
	Arch                        string                     `json:"arch"`
	WorkspaceDir                string                     `json:"workspaceDir"`
	SessionDir                  string                     `json:"sessionDir"`
	StateDir                    string                     `json:"stateDir"`
	AgentClients                []inventory.Info           `json:"agentClients"`
	Sessions                    []proto.AgentSessionInfo   `json:"sessions"`
	ConversationRuntimeSessions []agentruntime.StoreRecord `json:"conversationRuntimeSessions"`
	CollectedAt                 string                     `json:"collectedAt"`
}

// CollectSnapshot walks the daemon's on-disk state and returns a fully
// populated Snapshot. version is plumbed in so callers control the
// embedded daemon version string (cmd reads it from go:embed).
func CollectSnapshot(ctx context.Context, cfg *daemonconfig.Config, version string) (Snapshot, error) {
	if cfg.AgentClients == nil {
		cfg.AgentClients = discoverAgentClients(cfg)
	}
	sessions := make([]proto.AgentSessionInfo, 0)
	for _, client := range cfg.AgentClients {
		items, err := state.ListProvider(ctx, cfg, client.ID, providerDirName(client), "")
		if err != nil {
			continue
		}
		sessions = append(sessions, items...)
	}
	sortAgentSessions(sessions)

	return Snapshot{
		Version:                     version,
		ConfigPath:                  cfg.Path,
		Server:                      cfg.Server,
		LinkID:                      cfg.LinkID,
		Hostname:                    hostname(),
		OS:                          runtime.GOOS,
		Arch:                        runtime.GOARCH,
		WorkspaceDir:                cfg.WorkspaceDir,
		SessionDir:                  cfg.SessionDir,
		StateDir:                    cfg.StateDir,
		AgentClients:                cfg.AgentClients,
		Sessions:                    sessions,
		ConversationRuntimeSessions: sortConversationRuntimeSessions(agentruntime.DefaultPersistentStore().All(cfg)),
		CollectedAt:                 time.Now().UTC().Format(time.RFC3339Nano),
	}, nil
}

func sortAgentSessions(items []proto.AgentSessionInfo) {
	sort.Slice(items, func(i, j int) bool {
		if items[i].Workspace != items[j].Workspace {
			return items[i].Workspace < items[j].Workspace
		}
		if items[i].AgentID != items[j].AgentID {
			return items[i].AgentID < items[j].AgentID
		}
		return items[i].ID < items[j].ID
	})
}

func sortConversationRuntimeSessions(items []agentruntime.StoreRecord) []agentruntime.StoreRecord {
	sort.Slice(items, func(i, j int) bool {
		if items[i].ConversationID != items[j].ConversationID {
			return items[i].ConversationID < items[j].ConversationID
		}
		if items[i].AgentClientID != items[j].AgentClientID {
			return items[i].AgentClientID < items[j].AgentClientID
		}
		return items[i].SessionID < items[j].SessionID
	})
	return items
}
