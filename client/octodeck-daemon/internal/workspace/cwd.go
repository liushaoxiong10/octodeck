// Consolidated from: repoworkspace/repoworkspace.go (ResolveRunCwd),
// agentworkspace/agentworkspace.go (ResolveRoot),
// workspacefs/workspacefs.go (DefaultRunCwd, ResolveAgentWorkspaceCwd)
package workspace

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"

	daemonpaths "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/config"
)

// DefaultRunCwd resolves a requested CWD string into an actual directory.
// Handles DeviceWorkspaceURIPrefix, DeviceTmpURIPrefix, and plain paths.
// Consolidated from workspacefs.DefaultRunCwd.
func DefaultRunCwd(cfg *Config, requestedCwd string) (string, error) {
	if strings.HasPrefix(requestedCwd, DeviceWorkspaceURIPrefix) {
		folder := strings.TrimPrefix(requestedCwd, DeviceWorkspaceURIPrefix)
		return EnsureNamedWorkspaceDir(cfg, folder)
	}
	if strings.HasPrefix(requestedCwd, DeviceTmpURIPrefix) {
		folder := strings.TrimPrefix(requestedCwd, DeviceTmpURIPrefix)
		return EnsureNamedTmpDir(cfg, folder)
	}
	base := filepath.Base(filepath.Clean(requestedCwd))
	return CreateRandomDir(daemonpaths.TaskDir(cfg), SafeGroupFolder(base))
}

// ResolveAgentWorkspaceCwd resolves workspace CWD from agent workspace metadata.
// Consolidated from workspacefs.ResolveAgentWorkspaceCwd.
func ResolveAgentWorkspaceCwd(cfg *Config, ws *AgentRunWorkspace) (string, error) {
	if ws == nil || (ws.AgentID == "" && ws.AgentRoot == "" && ws.Scope == "" && ws.ScopeID == "") {
		return "", errors.New("agent workspace metadata is required")
	}
	if _, err := EnsureSharedDirForWorkspace(cfg, ws); err != nil {
		return "", err
	}
	if ws.Scope == "task" && (ws.TaskID != "" || ws.TaskRunID != "") {
		dir := TaskScopedDir(cfg, ws.Folder, ws.TaskID, firstNonEmpty(ws.TaskRunID, ws.ScopeID))
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return "", err
		}
		return dir, nil
	}
	agentID := ws.AgentID
	if agentID == "" {
		agentID = ws.Folder
	}
	dir, err := AgentScopedDir(cfg, ws.Folder, agentID, ws.AgentRoot, ws.Scope, ws.ScopeID, ws.TaskID, ws.TaskRunID)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	return dir, nil
}

// ResolveRunCwd resolves the CWD for a run with one or more workspace repo specs.
// Ensures the base directory and mounts all repos. From repoworkspace.ResolveRunCwd.
func ResolveRunCwd(ctx context.Context, cfg *Config, repos []*WorkspaceRepoSpec) (string, error) {
	if len(repos) == 0 || repos[0] == nil {
		return "", errors.New("workspace repo spec is required")
	}
	baseDir, err := EnsureRepoBaseDir(cfg, repos[0])
	if err != nil {
		return "", err
	}
	for _, spec := range repos {
		if spec == nil {
			return "", errors.New("workspace repo spec is required")
		}
		if spec.Kind == "workspace" {
			continue
		}
		if _, err := MountAt(ctx, cfg, baseDir, spec); err != nil {
			return "", err
		}
	}
	return baseDir, nil
}

// ResolveRoot resolves the workspace root for an agent run request.
// From agentworkspace.ResolveRoot.
func ResolveRoot(cfg *Config, req *AgentRunRequestFrame) (string, error) {
	requested := req.Cwd
	if req.Workspace != nil {
		if req.Workspace.Cwd != "" {
			requested = req.Workspace.Cwd
		} else if req.Workspace.Folder != "" && requested == "" {
			requested = DeviceWorkspaceURIPrefix + req.Workspace.Folder
		}
	}
	if HasScopedWorkspace(req.Workspace) {
		return ResolveAgentWorkspaceCwd(cfg, req.Workspace)
	}
	if requested == "" {
		return "", errors.New("workspace root is required (cwd or folder)")
	}
	return DefaultRunCwd(cfg, requested)
}
