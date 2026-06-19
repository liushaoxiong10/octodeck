package agentruntime

import (
	"context"
	"os"

	agentcore "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentcore"
	daemonconfig "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/config"
	session "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/session"
	workspaceutil "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/workspace"
)

// BaseAgent provides the default Agent interface implementation that all
// builtin and custom agent families embed. Callers override individual methods
// by shadowing them on the embedding struct.
type BaseAgent = agentcore.BaseAgent

// StableAgentWorkspaceScopeID returns a deterministic scope ID for an agent's
// workspace scope directory, based on the agent ID.
func StableAgentWorkspaceScopeID(agentID string) string {
	return session.StableScopeID(agentID)
}

// DeleteSessionWithACPCleanup deletes the provider session and also cleans up
// ACP session records and scope directories. Used by the runtime process.
func DeleteSessionWithACPCleanup(a Agent, ctx context.Context, cfg *daemonconfig.Config, workspace, sessionID, agentID string) (bool, error) {
	deleted, err := a.DeleteSession(ctx, cfg, workspace, sessionID)
	if err == nil && workspace != "" && sessionID != "" {
		if DefaultPersistentStore().DeleteByConversation(cfg, sessionID) {
			deleted = true
		}
		if localDir, dirErr := workspaceutil.CleanupScopeDir(cfg, workspace, "session", sessionID, "", ""); dirErr != nil {
			err = dirErr
		} else if removeErr := os.RemoveAll(localDir); removeErr != nil {
			err = removeErr
		} else {
			deleted = true
		}
	}
	return deleted, err
}
