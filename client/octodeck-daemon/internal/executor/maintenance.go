package executor

import (
	"os"

	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
	workspace "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/workspace"
)

// maintenanceExecutor implements MaintenanceExecutor: it handles
// workspace cleanup requests and acts as a placeholder for memory
// sync (real polling lives in the state package and is launched from
// the connection loop).
type maintenanceExecutor struct {
	deps Deps
}

func newMaintenanceExecutor(deps Deps) *maintenanceExecutor {
	return &maintenanceExecutor{deps: deps}
}

// HandleWorkspaceCleanup resolves the directory to clean for the given
// scope and removes it. Mirrors handleWorkspaceCleanup in node/.
func (e *maintenanceExecutor) HandleWorkspaceCleanup(req *proto.WorkspaceCleanupRequestFrame) {
	if e == nil || req == nil {
		return
	}
	scope := req.Scope
	if scope == "" {
		scope = "workspace"
	}
	dir, err := workspace.CleanupScopeDir(e.deps.Cfg, req.Workspace, scope, req.SessionID, req.TaskID, req.TaskRunID)
	if err != nil {
		e.sendErr("workspace_cleanup_failed", err.Error())
		return
	}
	if err := os.RemoveAll(dir); err != nil {
		e.sendErr("workspace_cleanup_failed", err.Error())
	}
}

// HandleMemorySync acknowledges a memory.sync frame coming from the
// server. The actual file watching is driven by the state package's
// Poller in the connection loop, so the executor only needs to relay
// the inbound frame back to the daemon's send pipe (e.g. for echo /
// ack semantics) or store an audit trail. This reserved hook lets
// stage 5 callers route inbound memory frames through the executor
// bundle without changing the interface.
func (e *maintenanceExecutor) HandleMemorySync(req *proto.MemorySyncFrame) {
	if e == nil || req == nil || e.deps.Send == nil {
		return
	}
	// Currently the daemon never receives inbound memory.sync frames
	// from the server side; this is a forward-compatible no-op that
	// keeps the interface honest. A future implementation can mirror
	// the frame back or apply it to local state.
}

func (e *maintenanceExecutor) sendErr(code, msg string) {
	if e.deps.Send == nil {
		return
	}
	_ = e.deps.Send(&proto.ErrorFrame{Type: proto.TError, Code: code, Message: msg, Fatal: false})
}
