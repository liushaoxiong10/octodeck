package executor

import (
	"context"

	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
	security "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/security"
	state "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/state"
)

// commandExecutor adapts the package-internal hostRunner to the
// CommandExecutor interface. Since stage 5 absorbed daemonrunner into
// executor, the underlying runner is now an unexported implementation
// detail and not visible outside the package.
type commandExecutor struct {
	deps   Deps
	pool   *state.RunPool
	runner *hostRunner
}

func newCommandExecutor(deps Deps) *commandExecutor {
	pool := deps.Pool
	if pool == nil {
		pool = state.NewRunPool(0)
	}
	envSnap := deps.EnvSnapshot
	if envSnap == nil {
		envSnap = security.EnvSnapshot
	}
	return &commandExecutor{
		deps:   deps,
		pool:   pool,
		runner: newHostRunner(deps.Cfg, pool, deps.Send, envSnap),
	}
}

// Handle dispatches a run.request frame: validate, reserve a run-pool
// slot, emit "accepted", then spawn the child process.
func (e *commandExecutor) Handle(ctx context.Context, req *proto.RunRequestFrame) {
	if e == nil || e.runner == nil || req == nil {
		return
	}
	e.runner.Handle(ctx, req)
}

// CancelRun aborts an in-flight run by id.
func (e *commandExecutor) CancelRun(runID string) bool {
	if e == nil || e.pool == nil {
		return false
	}
	return e.pool.CancelRun(runID)
}

// Pool returns the underlying run pool; useful for heartbeat/ping
// frame construction.
func (e *commandExecutor) Pool() *state.RunPool { return e.pool }
