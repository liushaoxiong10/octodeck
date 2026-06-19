// Package executor handles individual daemon requests.
//
// Each executor type processes a single request lifecycle: validate,
// execute, emit events/results. Executors are invoked by sessions but
// do not own long-lived daemon context.
//
// Stage 4: this package is independently buildable but not yet wired
// into node/. Stage 5 will switch node to call executor.New(...) and
// retire the daemonapp shims.
package executor

import (
	"context"

	daemonconfig "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/config"
	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
	state "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/state"
)

// CommandExecutor runs host CLI commands (run.request).
type CommandExecutor interface {
	Handle(ctx context.Context, req *proto.RunRequestFrame)
}

// ToolExecutor runs remote tool calls (tool.request).
type ToolExecutor interface {
	Handle(ctx context.Context, req *proto.ToolRequestFrame)
}

// AgentExecutor runs agent prompts (agent.run.request).
type AgentExecutor interface {
	Handle(ctx context.Context, req *proto.AgentRunRequestFrame)
	CancelRun(runID, reason string) bool
	HandleDiscover(ctx context.Context, req *proto.AgentDiscoverRequestFrame)
	HandleSessions(ctx context.Context, req *proto.AgentSessionsRequestFrame)
	HandleSessionDelete(ctx context.Context, req *proto.AgentSessionDeleteRequestFrame)
	HandlePermissionDecision(ctx context.Context, req *proto.AgentPermissionDecisionFrame)
	Close()
}

// MaintenanceExecutor handles maintenance requests (workspace cleanup,
// memory sync, update).
type MaintenanceExecutor interface {
	HandleWorkspaceCleanup(req *proto.WorkspaceCleanupRequestFrame)
	HandleWorkspaceGitStatus(ctx context.Context, req *proto.WorkspaceGitStatusRequestFrame)
	HandleWorkspaceGitCommit(ctx context.Context, req *proto.WorkspaceGitCommitRequestFrame)
	HandleMemorySync(req *proto.MemorySyncFrame)
}

// Deps holds the dependencies executors need from the daemon.
type Deps struct {
	Cfg         *daemonconfig.Config
	Pool        *state.RunPool
	Send        func(any) error
	EnvSnapshot func() map[string]string
}

// Executors aggregates the four executor types so callers (node,
// session) can grab the whole bundle in one call.
type Executors struct {
	Command     CommandExecutor
	Tool        ToolExecutor
	Agent       AgentExecutor
	Maintenance MaintenanceExecutor
}

// New constructs an Executors bundle backed by the daemon's runtime
// components (daemonrunner, toolrunner, agentruntime supervisor,
// workspace helpers).
//
// Stage 5 callers should provide a populated Deps; in particular
// Pool and Send must be non-nil. EnvSnapshot defaults to security's
// EnvSnapshot when nil.
func New(deps Deps) *Executors {
	return &Executors{
		Command:     newCommandExecutor(deps),
		Tool:        newToolExecutor(deps),
		Agent:       newAgentExecutor(deps),
		Maintenance: newMaintenanceExecutor(deps),
	}
}
