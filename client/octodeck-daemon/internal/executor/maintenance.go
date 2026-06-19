package executor

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

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

func (e *maintenanceExecutor) HandleWorkspaceGitStatus(ctx context.Context, req *proto.WorkspaceGitStatusRequestFrame) {
	if e == nil || req == nil || e.deps.Send == nil {
		return
	}
	go func() {
		started := time.Now()
		status, err := e.resolveAndCollectWorkspaceGitStatus(ctx, req)
		if err != nil {
			msg := err.Error()
			_ = e.deps.Send(&proto.WorkspaceGitStatusResultFrame{
				Type:       proto.TWorkspaceGitStatusResult,
				RequestID:  req.RequestID,
				OK:         false,
				Clean:      false,
				Files:      []proto.WorkspaceGitStatusFile{},
				Error:      &msg,
				DurationMs: time.Since(started).Milliseconds(),
			})
			return
		}
		status.Type = proto.TWorkspaceGitStatusResult
		status.RequestID = req.RequestID
		status.OK = true
		status.Error = nil
		status.DurationMs = time.Since(started).Milliseconds()
		_ = e.deps.Send(status)
	}()
}

func (e *maintenanceExecutor) HandleWorkspaceGitCommit(ctx context.Context, req *proto.WorkspaceGitCommitRequestFrame) {
	if e == nil || req == nil || e.deps.Send == nil {
		return
	}
	go func() {
		started := time.Now()
		result, err := e.resolveAndCommitWorkspaceGitChanges(ctx, req)
		if err != nil {
			msg := err.Error()
			_ = e.deps.Send(&proto.WorkspaceGitCommitResultFrame{
				Type:           proto.TWorkspaceGitCommitResult,
				RequestID:      req.RequestID,
				OK:             false,
				Clean:          false,
				FilesCommitted: 0,
				Error:          &msg,
				DurationMs:     time.Since(started).Milliseconds(),
			})
			return
		}
		result.Type = proto.TWorkspaceGitCommitResult
		result.RequestID = req.RequestID
		result.OK = true
		result.Error = nil
		result.DurationMs = time.Since(started).Milliseconds()
		_ = e.deps.Send(result)
	}()
}

func (e *maintenanceExecutor) resolveAndCollectWorkspaceGitStatus(ctx context.Context, req *proto.WorkspaceGitStatusRequestFrame) (*proto.WorkspaceGitStatusResultFrame, error) {
	cwd, err := e.resolveWorkspaceGitCwd(ctx, req.Workspace, req.WorkspaceRepos, req.WorkspaceRepo)
	if err != nil {
		return nil, err
	}
	return collectWorkspaceGitStatus(ctx, cwd, req.IncludeDiffStat, req.IncludePatch)
}

func (e *maintenanceExecutor) resolveAndCommitWorkspaceGitChanges(ctx context.Context, req *proto.WorkspaceGitCommitRequestFrame) (*proto.WorkspaceGitCommitResultFrame, error) {
	cwd, err := e.resolveWorkspaceGitCwd(ctx, req.Workspace, req.WorkspaceRepos, req.WorkspaceRepo)
	if err != nil {
		return nil, err
	}
	return commitWorkspaceGitChanges(ctx, cwd, req.Message)
}

func (e *maintenanceExecutor) resolveWorkspaceGitCwd(ctx context.Context, ws *proto.AgentRunWorkspace, repos []*proto.WorkspaceRepoSpec, repo *proto.WorkspaceRepoSpec) (string, error) {
	if len(repos) == 0 && repo != nil {
		repos = []*proto.WorkspaceRepoSpec{repo}
	}
	if len(repos) > 0 {
		return workspace.Resolve(ctx, e.deps.Cfg, repos[0])
	}
	if ws == nil {
		return "", errors.New("workspace or workspaceRepo is required")
	}
	if workspace.HasScopedWorkspace(ws) || ws.Scope == "task" || ws.TaskID != "" || ws.TaskRunID != "" {
		return workspace.ResolveAgentWorkspaceCwd(e.deps.Cfg, ws)
	}
	if ws.Cwd != "" && filepath.IsAbs(ws.Cwd) {
		return filepath.Clean(ws.Cwd), nil
	}
	if ws.Folder != "" {
		return workspace.EnsureNamedWorkspaceDir(e.deps.Cfg, ws.Folder)
	}
	return "", errors.New("workspace path is required")
}

func commitWorkspaceGitChanges(ctx context.Context, cwd, message string) (*proto.WorkspaceGitCommitResultFrame, error) {
	message = strings.TrimSpace(message)
	if message == "" {
		return nil, errors.New("commit message is required")
	}
	status, err := collectWorkspaceGitStatus(ctx, cwd, false, false)
	if err != nil {
		return nil, err
	}
	if status.Clean {
		return nil, errors.New("no changes to commit")
	}
	filesCommitted := len(status.Files)
	if err := runGit(ctx, cwd, "add", "-A"); err != nil {
		return nil, err
	}
	if err := runGit(ctx, cwd, "commit", "-m", message); err != nil {
		return nil, err
	}
	commit, err := gitOutput(ctx, cwd, "rev-parse", "--short", "HEAD")
	if err != nil {
		return nil, err
	}
	after, err := collectWorkspaceGitStatus(ctx, cwd, false, false)
	if err != nil {
		return nil, err
	}
	return &proto.WorkspaceGitCommitResultFrame{
		WorkspacePath:  cwd,
		Branch:         after.Branch,
		Commit:         strings.TrimSpace(commit),
		Clean:          after.Clean,
		FilesCommitted: filesCommitted,
	}, nil
}

func collectWorkspaceGitStatus(ctx context.Context, cwd string, includeDiffStat bool, includePatch ...bool) (*proto.WorkspaceGitStatusResultFrame, error) {
	if cwd == "" {
		return nil, errors.New("workspace path is required")
	}
	if !workspace.IsGitDir(cwd) {
		return nil, fmt.Errorf("workspace is not a git worktree: %s", cwd)
	}
	branch, _ := gitOutput(ctx, cwd, "rev-parse", "--abbrev-ref", "HEAD")
	head, _ := gitOutput(ctx, cwd, "rev-parse", "--short", "HEAD")
	porcelain, err := gitOutput(ctx, cwd, "status", "--porcelain=v1")
	if err != nil {
		return nil, err
	}
	files := parseGitPorcelainFiles(porcelain)
	applyGitNumstat(ctx, cwd, files)
	if len(includePatch) > 0 && includePatch[0] {
		applyGitPatches(ctx, cwd, files)
	}
	diffStat := ""
	if includeDiffStat {
		if out, statErr := gitOutput(ctx, cwd, "diff", "--stat"); statErr == nil {
			diffStat = strings.TrimRight(out, "\n")
		}
		if staged, statErr := gitOutput(ctx, cwd, "diff", "--cached", "--stat"); statErr == nil && strings.TrimSpace(staged) != "" {
			if diffStat != "" {
				diffStat += "\n"
			}
			diffStat += strings.TrimRight(staged, "\n")
		}
	}
	return &proto.WorkspaceGitStatusResultFrame{
		WorkspacePath: cwd,
		Branch:        strings.TrimSpace(branch),
		Head:          strings.TrimSpace(head),
		Clean:         len(files) == 0,
		Files:         files,
		DiffStat:      diffStat,
	}, nil
}

func applyGitPatches(ctx context.Context, cwd string, files []proto.WorkspaceGitStatusFile) {
	for i := range files {
		path := strings.TrimSpace(files[i].Path)
		if path == "" {
			continue
		}
		patchParts := make([]string, 0, 2)
		if out, err := gitOutput(ctx, cwd, "diff", "--", path); err == nil && strings.TrimSpace(out) != "" {
			patchParts = append(patchParts, strings.TrimRight(out, "\n"))
		}
		if out, err := gitOutput(ctx, cwd, "diff", "--cached", "--", path); err == nil && strings.TrimSpace(out) != "" {
			patchParts = append(patchParts, strings.TrimRight(out, "\n"))
		}
		if files[i].Status == "untracked" {
			if out, err := gitOutput(ctx, cwd, "diff", "--no-index", "--", "/dev/null", path); err == nil && strings.TrimSpace(out) != "" {
				patchParts = append(patchParts, strings.TrimRight(out, "\n"))
			}
		}
		if len(patchParts) > 0 {
			files[i].Patch = strings.Join(patchParts, "\n")
		}
	}
}

func parseGitPorcelainFiles(output string) []proto.WorkspaceGitStatusFile {
	files := make([]proto.WorkspaceGitStatusFile, 0)
	seen := map[string]int{}
	for _, line := range strings.Split(output, "\n") {
		if len(line) < 4 {
			continue
		}
		xy := line[:2]
		pathPart := strings.TrimSpace(line[3:])
		if pathPart == "" {
			continue
		}
		if strings.Contains(pathPart, " -> ") {
			parts := strings.Split(pathPart, " -> ")
			pathPart = parts[len(parts)-1]
		}
		status := gitXYStatusLabel(xy)
		if idx, ok := seen[pathPart]; ok {
			files[idx].Status = mergeGitStatus(files[idx].Status, status)
			continue
		}
		seen[pathPart] = len(files)
		files = append(files, proto.WorkspaceGitStatusFile{Path: pathPart, Status: status})
	}
	return files
}

func gitXYStatusLabel(xy string) string {
	if strings.Contains(xy, "?") {
		return "untracked"
	}
	if strings.Contains(xy, "A") {
		return "added"
	}
	if strings.Contains(xy, "D") {
		return "deleted"
	}
	if strings.Contains(xy, "R") {
		return "renamed"
	}
	if strings.Contains(xy, "C") {
		return "copied"
	}
	if strings.Contains(xy, "M") {
		return "modified"
	}
	return strings.TrimSpace(xy)
}

func mergeGitStatus(a, b string) string {
	if a == b || b == "" {
		return a
	}
	if a == "" {
		return b
	}
	return a + "," + b
}

func applyGitNumstat(ctx context.Context, cwd string, files []proto.WorkspaceGitStatusFile) {
	byPath := map[string]int{}
	for i, f := range files {
		byPath[f.Path] = i
	}
	for _, args := range [][]string{{"diff", "--numstat"}, {"diff", "--cached", "--numstat"}} {
		out, err := gitOutput(ctx, cwd, args...)
		if err != nil {
			continue
		}
		for _, line := range strings.Split(out, "\n") {
			parts := strings.Split(line, "\t")
			if len(parts) < 3 {
				continue
			}
			pathPart := parts[2]
			if strings.Contains(pathPart, " => ") {
				renameParts := strings.Split(pathPart, " => ")
				pathPart = renameParts[len(renameParts)-1]
			}
			idx, ok := byPath[pathPart]
			if !ok {
				continue
			}
			files[idx].Additions += parseNumstatCount(parts[0])
			files[idx].Deletions += parseNumstatCount(parts[1])
		}
	}
}

func parseNumstatCount(value string) int {
	if value == "-" || value == "" {
		return 0
	}
	n, err := strconv.Atoi(value)
	if err != nil {
		return 0
	}
	return n
}

func runGit(ctx context.Context, cwd string, args ...string) error {
	_, err := gitOutput(ctx, cwd, args...)
	return err
}

func gitOutput(ctx context.Context, cwd string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	if cwd != "" {
		cmd.Dir = cwd
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return string(out), nil
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
