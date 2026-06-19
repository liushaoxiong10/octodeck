package uplink

import (
	"context"

	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
)

// dispatch routes a parsed inbound frame to the matching handler. Unknown or
// no-op frames are silently ignored (HelloAckFrame, etc.). The error return
// indicates whether the connection should terminate (set by OnFatalError).
func (h *Handlers) dispatch(ctx context.Context, frame any) (fatalErr error) {
	if h == nil {
		return nil
	}
	switch f := frame.(type) {
	case *proto.RunRequestFrame:
		if h.OnRunRequest != nil {
			h.OnRunRequest(ctx, f)
		}
	case *proto.RunCancelFrame:
		if h.OnRunCancel != nil {
			h.OnRunCancel(f)
		}
	case *proto.AgentRunRequestFrame:
		if h.OnAgentRunRequest != nil {
			h.OnAgentRunRequest(ctx, f)
		}
	case *proto.AgentRunCancelFrame:
		if h.OnAgentRunCancel != nil {
			h.OnAgentRunCancel(f)
		}
	case *proto.AgentDiscoverRequestFrame:
		if h.OnAgentDiscover != nil {
			h.OnAgentDiscover(ctx, f)
		}
	case *proto.AgentSessionsRequestFrame:
		if h.OnAgentSessions != nil {
			h.OnAgentSessions(ctx, f)
		}
	case *proto.AgentSessionDeleteRequestFrame:
		if h.OnAgentSessionDel != nil {
			h.OnAgentSessionDel(ctx, f)
		}
	case *proto.AgentPermissionDecisionFrame:
		if h.OnAgentPermission != nil {
			h.OnAgentPermission(ctx, f)
		}
	case *proto.WorkspaceCleanupRequestFrame:
		if h.OnWorkspaceCleanup != nil {
			h.OnWorkspaceCleanup(f)
		}
	case *proto.WorkspaceGitStatusRequestFrame:
		if h.OnWorkspaceGitStatus != nil {
			h.OnWorkspaceGitStatus(ctx, f)
		}
	case *proto.WorkspaceGitCommitRequestFrame:
		if h.OnWorkspaceGitCommit != nil {
			h.OnWorkspaceGitCommit(ctx, f)
		}
	case *proto.ToolRequestFrame:
		if h.OnToolRequest != nil {
			h.OnToolRequest(ctx, f)
		}
	case *proto.ToolCancelFrame:
		if h.OnToolCancel != nil {
			h.OnToolCancel(f)
		}
	case *proto.ModelsRequestFrame:
		if h.OnModelsRequest != nil {
			h.OnModelsRequest(ctx, f)
		}
	case *proto.SkillsRequestFrame:
		if h.OnSkillsRequest != nil {
			h.OnSkillsRequest(ctx, f)
		}
	case *proto.DaemonUpdateRequestFrame:
		if h.OnDaemonUpdate != nil {
			h.OnDaemonUpdate(ctx, f)
		}
	case *proto.ErrorFrame:
		if f != nil && f.Fatal && h.OnFatalError != nil {
			return h.OnFatalError(f)
		}
	}
	return nil
}
