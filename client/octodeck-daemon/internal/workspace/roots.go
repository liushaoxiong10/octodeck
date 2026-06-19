// Consolidated from: agentworkspace/agentworkspace.go (HasScopedWorkspace, EnrichWorkspaceURI)
package workspace

import proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"

// HasScopedWorkspace reports whether the workspace metadata indicates a scoped workspace.
// From agentworkspace.HasScopedWorkspace.
func HasScopedWorkspace(ws *proto.AgentRunWorkspace) bool {
	return ws != nil && (ws.AgentID != "" || ws.AgentRoot != "" || ws.Scope != "" || ws.ScopeID != "")
}

// EnrichWorkspaceURI enriches a requested URI with the workspace folder prefix if empty.
// From agentworkspace.EnrichWorkspaceURI.
func EnrichWorkspaceURI(ws *proto.AgentRunWorkspace, requested string) string {
	if requested == "" && ws != nil && ws.Folder != "" {
		return DeviceWorkspaceURIPrefix + ws.Folder
	}
	return requested
}
