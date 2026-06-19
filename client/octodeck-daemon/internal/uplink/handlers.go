package uplink

import (
	"context"

	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
)

// Handlers holds the caller-supplied callbacks for every inbound frame the
// daemon cares about. Any nil callback is a no-op so callers can opt into
// only the frame types they need.
//
// All callbacks are invoked from the read loop's goroutine. Long-running work
// must be moved off-goroutine by the callback itself.
type Handlers struct {
	OnRunRequest       func(context.Context, *proto.RunRequestFrame)
	OnRunCancel        func(*proto.RunCancelFrame)
	OnAgentRunRequest  func(context.Context, *proto.AgentRunRequestFrame)
	OnAgentRunCancel   func(*proto.AgentRunCancelFrame)
	OnAgentDiscover    func(context.Context, *proto.AgentDiscoverRequestFrame)
	OnAgentSessions    func(context.Context, *proto.AgentSessionsRequestFrame)
	OnAgentSessionDel  func(context.Context, *proto.AgentSessionDeleteRequestFrame)
	OnAgentPermission  func(context.Context, *proto.AgentPermissionDecisionFrame)
	OnWorkspaceCleanup func(*proto.WorkspaceCleanupRequestFrame)
	OnToolRequest      func(context.Context, *proto.ToolRequestFrame)
	OnToolCancel       func(*proto.ToolCancelFrame)
	OnModelsRequest    func(context.Context, *proto.ModelsRequestFrame)
	OnSkillsRequest    func(context.Context, *proto.SkillsRequestFrame)
	OnDaemonUpdate     func(context.Context, *proto.DaemonUpdateRequestFrame)
	OnFatalError       func(*proto.ErrorFrame) error
}
