// Consolidated from: workspacefs/workspacefs.go
package workspace

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	daemonconfig "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/config"
	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
)

type Config = daemonconfig.Config
type AgentRunRequestFrame = proto.AgentRunRequestFrame
type RunRequestFrame = proto.RunRequestFrame
type AgentRunWorkspace = proto.AgentRunWorkspace
type WorkspaceRepoSpec = proto.WorkspaceRepoSpec

const DeviceWorkspaceURIPrefix = "octodeck-workspace://"
const DeviceTmpURIPrefix = "octodeck-tmp://"

func AgentRootDir(cfg *Config, agentID string, customRoot string) (string, error) {
	if customRoot != "" {
		if !filepath.IsAbs(customRoot) {
			return "", fmt.Errorf("agentRoot must be absolute: %q", customRoot)
		}
		return filepath.Clean(customRoot), nil
	}
	return filepath.Join(daemonconfig.WorkspaceDir(cfg), SafeGroupFolder(agentID)), nil
}

func WorkspaceRootDir(cfg *Config, groupFolder, legacyAgentID, customRoot string) (string, error) {
	if customRoot != "" {
		if !filepath.IsAbs(customRoot) {
			return "", fmt.Errorf("agentRoot must be absolute: %q", customRoot)
		}
		return filepath.Clean(customRoot), nil
	}
	if groupFolder != "" {
		return filepath.Join(daemonconfig.WorkspaceDir(cfg), SafeGroupFolder(groupFolder)), nil
	}
	return AgentRootDir(cfg, legacyAgentID, "")
}

func AgentScopedDir(cfg *Config, groupFolder, legacyAgentID, customRoot, scope, scopeID, taskID, taskRunID string) (string, error) {
	root, err := WorkspaceRootDir(cfg, groupFolder, legacyAgentID, customRoot)
	if err != nil {
		return "", err
	}
	switch scope {
	case "direct_session", "session":
		if scopeID == "" {
			scopeID = "main"
		}
		return filepath.Join(root, "sessions", SafeGroupFolder(scopeID)), nil
	case "task":
		if taskID == "" {
			return "", errors.New("task id is required")
		}
		if runID := firstNonEmpty(taskRunID, scopeID); runID != "" {
			return TaskScopedDir(cfg, groupFolder, taskID, runID), nil
		}
		if groupFolder != "" {
			return filepath.Join(daemonconfig.WorkspaceDir(cfg), SafeGroupFolder(groupFolder), "tasks", SafeGroupFolder(taskID)), nil
		}
		return filepath.Join(daemonconfig.TaskDir(cfg), SafeGroupFolder(taskID)), nil
	case "skills":
		return filepath.Join(root, "skills"), nil
	case "workspace", "":
		return root, nil
	default:
		return "", fmt.Errorf("unknown workspace scope: %q", scope)
	}
}

func TaskScopedDir(cfg *Config, groupFolder, taskID, taskRunID string) string {
	if taskID == "" {
		taskID = "task"
	}
	if taskRunID == "" {
		taskRunID = "run"
	}
	if groupFolder != "" {
		return filepath.Join(daemonconfig.WorkspaceDir(cfg), SafeGroupFolder(groupFolder), "tasks", SafeGroupFolder(taskID), SafeGroupFolder(taskRunID))
	}
	return filepath.Join(daemonconfig.TaskDir(cfg), SafeGroupFolder(taskID), SafeGroupFolder(taskRunID))
}

func WorkspaceSpecAgentID(spec *WorkspaceRepoSpec) string {
	if spec.AgentID != "" {
		return spec.AgentID
	}
	return spec.GroupFolder
}

func WorkspaceSpecHasScope(spec *WorkspaceRepoSpec) bool {
	return spec.AgentID != "" || spec.AgentRoot != "" || spec.Scope != "" || spec.ScopeID != "" || spec.TaskID != "" || spec.TaskRunID != ""
}

func EnsureRepoBaseDir(cfg *Config, spec *WorkspaceRepoSpec) (string, error) {
	if spec != nil {
		if _, err := EnsureSharedDirForWorkspace(cfg, &AgentRunWorkspace{Folder: spec.GroupFolder, AgentID: WorkspaceSpecAgentID(spec), AgentRoot: spec.AgentRoot, WorkdirMode: spec.WorkdirMode, Scope: spec.Scope, ScopeID: spec.ScopeID, TaskID: spec.TaskID, TaskRunID: spec.TaskRunID}); err != nil {
			return "", err
		}
	}
	if spec.Scope == "task" && (spec.TaskID != "" || spec.TaskRunID != "") {
		dir := TaskScopedDir(cfg, spec.GroupFolder, spec.TaskID, firstNonEmpty(spec.TaskRunID, spec.ScopeID))
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return "", err
		}
		return dir, nil
	}
	if spec.AgentID != "" || spec.AgentRoot != "" || spec.Scope != "" || spec.ScopeID != "" {
		dir, err := AgentScopedDir(cfg, spec.GroupFolder, WorkspaceSpecAgentID(spec), spec.AgentRoot, spec.Scope, spec.ScopeID, spec.TaskID, spec.TaskRunID)
		if err != nil {
			return "", err
		}
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return "", err
		}
		return dir, nil
	}
	return EnsureNamedWorkspaceDir(cfg, spec.GroupFolder)
}

func EnsureNamedWorkspaceDir(cfg *Config, groupFolder string) (string, error) {
	if err := ValidateNamedWorkspaceFolder(groupFolder); err != nil {
		return "", err
	}
	dir := filepath.Join(daemonconfig.WorkspaceDir(cfg), SafeGroupFolder(groupFolder))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	if _, err := EnsureSharedDir(dir); err != nil {
		return "", err
	}
	return dir, nil
}

func EnsureNamedTmpDir(cfg *Config, groupFolder string) (string, error) {
	if err := ValidateNamedWorkspaceFolder(groupFolder); err != nil {
		return "", err
	}
	dir := filepath.Join(daemonconfig.TmpDir(cfg), SafeGroupFolder(groupFolder))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	return dir, nil
}

func CreateWorkspaceDir(cfg *Config, groupFolder string) (string, error) {
	return CreateRandomDir(daemonconfig.WorkspaceDir(cfg), SafeGroupFolder(groupFolder))
}

func EnsureSharedDirForWorkspace(cfg *Config, ws *AgentRunWorkspace) (string, error) {
	if ws == nil || (ws.Folder == "" && ws.AgentRoot == "") {
		return "", nil
	}
	agentID := ws.AgentID
	if agentID == "" {
		agentID = ws.Folder
	}
	root, err := WorkspaceRootDir(cfg, ws.Folder, agentID, ws.AgentRoot)
	if err != nil {
		return "", err
	}
	return EnsureSharedDir(root)
}

func EnsureSharedDir(workspaceRoot string) (string, error) {
	if workspaceRoot == "" {
		return "", nil
	}
	dir := filepath.Join(workspaceRoot, "shared")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	return dir, nil
}

func CreateRandomDir(parent, prefix string) (string, error) {
	if prefix == "" {
		prefix = "run"
	}
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return "", err
	}
	for i := 0; i < 16; i++ {
		dir := filepath.Join(parent, prefix+"-"+randomHex(8))
		if err := os.Mkdir(dir, 0o755); err == nil {
			return dir, nil
		} else if !os.IsExist(err) {
			return "", err
		}
	}
	return "", errors.New("failed to allocate random run directory")
}

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("%d", os.Getpid())
	}
	return hex.EncodeToString(b)
}
