package executor

import (
	"context"
	"time"

	agentruntime "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentruntime"
	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
	state "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/state"
)

// agentExecutor wraps agentruntime.Supervisor. The supervisor owns
// the long-lived agent-runtime child process and exposes Handle*
// methods that exactly correspond to the AgentExecutor interface, so
// the executor is a thin forwarding shell.
type agentExecutor struct {
	deps Deps
	sup  *agentruntime.Supervisor
}

func newAgentExecutor(deps Deps) *agentExecutor {
	pool := deps.Pool
	if pool == nil {
		pool = state.NewRunPool(0)
	}
	cfg := deps.Cfg
	sup := agentruntime.NewSupervisor(cfg, pool, deps.Send, agentruntime.SupervisorDeps{
		Validate: func(req *proto.AgentRunRequestFrame) error {
			return agentruntime.ValidateAgentRunRequest(cfg, req)
		},
		FormatTime: formatTime,
	})
	return &agentExecutor{deps: deps, sup: sup}
}

// Handle dispatches an agent.run.request to the supervisor.
func (e *agentExecutor) Handle(ctx context.Context, req *proto.AgentRunRequestFrame) {
	if e == nil || e.sup == nil || req == nil {
		return
	}
	e.sup.Handle(ctx, req)
}

// CancelRun aborts a running agent run by id.
func (e *agentExecutor) CancelRun(runID, reason string) bool {
	if e == nil || e.sup == nil {
		return false
	}
	return e.sup.CancelRun(runID, reason)
}

// HandleDiscover forwards an agent.discover.request to the supervisor.
func (e *agentExecutor) HandleDiscover(ctx context.Context, req *proto.AgentDiscoverRequestFrame) {
	if e == nil || e.sup == nil || req == nil {
		return
	}
	e.sup.HandleDiscover(ctx, req)
}

// HandleSessions forwards an agent.sessions.list request.
func (e *agentExecutor) HandleSessions(ctx context.Context, req *proto.AgentSessionsRequestFrame) {
	if e == nil || e.sup == nil || req == nil {
		return
	}
	e.sup.HandleSessions(ctx, req)
}

// HandleSessionDelete forwards an agent.sessions.delete request.
func (e *agentExecutor) HandleSessionDelete(ctx context.Context, req *proto.AgentSessionDeleteRequestFrame) {
	if e == nil || e.sup == nil || req == nil {
		return
	}
	e.sup.HandleSessionDelete(ctx, req)
}

// HandlePermissionDecision forwards a permission decision back to the
// supervisor.
func (e *agentExecutor) HandlePermissionDecision(ctx context.Context, req *proto.AgentPermissionDecisionFrame) {
	if e == nil || e.sup == nil || req == nil {
		return
	}
	e.sup.HandlePermissionDecision(ctx, req)
}

// Close stops the supervised agent-runtime child process.
func (e *agentExecutor) Close() {
	if e == nil || e.sup == nil {
		return
	}
	e.sup.Close()
}

// formatTime renders a timestamp the way daemonapp formats status
// frames (UTC RFC3339Nano), matching SupervisorDeps.FormatTime.
func formatTime(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339Nano)
}
