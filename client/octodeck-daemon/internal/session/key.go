package session

// The contents of this file were originally hosted in
// internal/agentscope/agentscope.go. They were merged here because the
// workspace-scope id is the natural identifier of a daemon session, so the
// scope helpers and the session-key helpers belong in the same package.
//
// Original package documentation:
//
// agentscope contains the helpers that normalise an AgentRunRequestFrame's
// workspace/session scope before the daemon resolves the on-disk working
// directory. All functions are pure: they take a *proto.AgentRunRequestFrame
// (or its sub-records) and mutate them in place. The package has no
// dependency on daemonconfig/daemonpaths/workspacefs because the actual fs
// resolution happens in agentworkspace; here we only fix up scope/scopeId
// fields.

import (
	"strings"

	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
)

// IsSessionScope reports whether the workspace scope/scopeID combination
// describes a per-session workdir (vs a workspace-level one).
func IsSessionScope(scope, scopeID string) bool {
	return scope == "session" || scope == "direct_session" || (scope == "" && scopeID != "")
}

// StableScopeID returns a deterministic scope id derived from the agent
// identifier so that legacy frames without an explicit scopeId still land in
// a stable directory.
func StableScopeID(agentID string) string {
	agentID = strings.TrimSpace(agentID)
	if agentID == "" {
		return ""
	}
	return "octodeck-" + agentID
}

// MetadataString returns meta[key] as a trimmed string when present.
func MetadataString(meta map[string]any, key string) string {
	if meta == nil {
		return ""
	}
	if v, ok := meta[key].(string); ok && strings.TrimSpace(v) != "" {
		return strings.TrimSpace(v)
	}
	return ""
}

// FirstNonEmpty returns the first non-empty string from values.
func FirstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

// ApplyChatSessionScope synthesises a workspace scopeId from chat metadata
// when the server only provided a session-scope marker. Newer servers send
// an explicit OctoDeck workspace-session id as metadata/scopeId; older frames
// used a provider/workspace scope id here, so we fall back to chat-id for
// those.
func ApplyChatSessionScope(req *proto.AgentRunRequestFrame) {
	if req == nil || req.Workspace == nil || !IsSessionScope(req.Workspace.Scope, req.Workspace.ScopeID) {
		return
	}
	chatID := MetadataString(req.Input.Metadata, "chatId")
	if chatID == "" {
		chatID = FirstNonEmpty(
			MetadataString(req.Input.Metadata, "conversationId"),
			MetadataString(req.Input.Metadata, "conversationID"),
			MetadataString(req.Input.Metadata, "sessionKey"),
			MetadataString(req.Input.Metadata, "chatJid"),
		)
	}
	workspaceSessionID := MetadataString(req.Input.Metadata, "workspaceSessionId")
	if workspaceSessionID != "" {
		req.Workspace.ScopeID = workspaceSessionID
		req.Workspace.SessionRoot = workspaceSessionID
	} else if chatID != "" && (req.Workspace.ScopeID == "" || !strings.HasPrefix(req.Workspace.ScopeID, "octodeck-")) {
		req.Workspace.ScopeID = chatID
	}
}

// NormalizeWorkspaceScope keeps daemon workspace directories stable across
// turns. The native agent session id in req.Input.SessionID is still passed
// to the adapter for resume/load, but it must not decide the local cwd;
// otherwise the first turn may run under sessions/<turn-id> and the next
// under sessions/<native-id>.
func NormalizeWorkspaceScope(req *proto.AgentRunRequestFrame) {
	if req == nil {
		return
	}
	if req.Workspace != nil {
		NormalizeWorkspace(req.Workspace, req.AgentID)
	}
	for _, spec := range req.WorkspaceRepos {
		NormalizeWorkspaceRepoSpecScope(spec, req.AgentID)
	}
	if req.WorkspaceRepo != nil {
		NormalizeWorkspaceRepoSpecScope(req.WorkspaceRepo, req.AgentID)
	}
}

// NormalizeWorkspace fixes up Workspace.ScopeID and any embedded repo specs.
func NormalizeWorkspace(ws *proto.AgentRunWorkspace, fallbackAgentID string) {
	if ws == nil {
		return
	}
	agentID := FirstNonEmpty(ws.AgentID, fallbackAgentID)
	if IsSessionScope(ws.Scope, ws.ScopeID) {
		if ws.ScopeID != "" {
			// Explicit server-provided session scope: this is the OctoDeck
			// conversation id and must remain the directory name under
			// sessions/<scopeId>.
		} else if ws.Scope == "direct_session" {
			ws.ScopeID = "main"
		} else if scopeID := StableScopeID(agentID); scopeID != "" {
			ws.ScopeID = scopeID
		}
	}
	if ws.Repo != nil {
		NormalizeWorkspaceRepoSpecScope(ws.Repo, agentID)
	}
	for _, spec := range ws.Repos {
		NormalizeWorkspaceRepoSpecScope(spec, agentID)
	}
}

// NormalizeWorkspaceRepoSpecScope ensures a repo spec carries an explicit
// scopeId derived from the agent id when the server omitted one.
func NormalizeWorkspaceRepoSpecScope(spec *proto.WorkspaceRepoSpec, fallbackAgentID string) {
	if spec == nil || !IsSessionScope(spec.Scope, spec.ScopeID) {
		return
	}
	if spec.ScopeID != "" {
		return
	}
	if scopeID := StableScopeID(FirstNonEmpty(spec.AgentID, fallbackAgentID)); scopeID != "" {
		spec.ScopeID = scopeID
	}
}

// KeyForRequest derives the daemon session key for a single
// AgentRunRequestFrame. The selection order mirrors how the legacy
// agentscope helpers chose the on-disk scope id:
//
//  1. req.Workspace.ScopeID — explicit server-supplied scope.
//  2. req.Workspace.SessionRoot / metadata.workspaceSessionId — explicit
//     server conversation id.
//  3. metadata.conversationId / conversationID — falling back to other
//     conversation-shaped fields when the server only stamped metadata.
//  4. agentID:runID — last-resort tuple guaranteed to be unique per run.
//
// An empty string is never returned for a non-nil request: the agent id
// alone (or even just the run id) is enough to fall back on. Callers may
// trust that the result is a stable map key.
func KeyForRequest(req *proto.AgentRunRequestFrame) string {
	if req == nil {
		return ""
	}
	if req.Workspace != nil {
		if id := strings.TrimSpace(req.Workspace.ScopeID); id != "" {
			return id
		}
		if id := strings.TrimSpace(req.Workspace.SessionRoot); id != "" {
			return id
		}
	}
	if id := FirstNonEmpty(
		MetadataString(req.Input.Metadata, "workspaceSessionId"),
		MetadataString(req.Input.Metadata, "serverConversationId"),
		MetadataString(req.Input.Metadata, "conversationId"),
		MetadataString(req.Input.Metadata, "conversationID"),
		MetadataString(req.Input.Metadata, "sessionKey"),
		MetadataString(req.Input.Metadata, "chatId"),
		MetadataString(req.Input.Metadata, "chatJid"),
	); id != "" {
		return id
	}
	agent := strings.TrimSpace(req.AgentID)
	run := strings.TrimSpace(req.RunID)
	switch {
	case agent != "" && run != "":
		return agent + ":" + run
	case agent != "":
		return agent
	case run != "":
		return run
	default:
		return ""
	}
}
