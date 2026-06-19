// Consolidated from: workspacefs/workspacefs.go (CleanupScopeDir),
// agentworkspace/agentworkspace.go (CleanupScopeDir delegate, EnsureSharedDirForWorkspace delegate)
package workspace

import (
	"errors"
	"fmt"
	"path/filepath"

	daemonpaths "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/config"
)

// CleanupScopeDir returns the directory to clean up for a given scope.
// Consolidated from workspacefs.CleanupScopeDir (agentworkspace.CleanupScopeDir was a delegate).
func CleanupScopeDir(cfg *Config, groupFolder, scope, scopeID, taskID, taskRunID string) (string, error) {
	switch scope {
	case "workspace", "":
		if groupFolder == "" {
			return "", errors.New("workspace folder is required")
		}
		return filepath.Join(daemonpaths.WorkspaceDir(cfg), SafeGroupFolder(groupFolder)), nil
	case "direct_session", "session":
		if groupFolder == "" {
			return "", errors.New("workspace folder is required")
		}
		if scopeID == "" {
			return "", errors.New("session id is required")
		}
		return filepath.Join(daemonpaths.WorkspaceDir(cfg), SafeGroupFolder(groupFolder), "sessions", SafeGroupFolder(scopeID)), nil
	case "task":
		return TaskScopedDir(cfg, groupFolder, taskID, firstNonEmpty(taskRunID, scopeID)), nil
	default:
		return "", fmt.Errorf("unknown cleanup scope: %q", scope)
	}
}
