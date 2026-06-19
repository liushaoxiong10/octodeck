// Consolidated from: repoworkspace/repoworkspace.go (Resolve, MountAt, helpers),
// agentworkspace/agentworkspace.go (ResolveRepoRoot, MountRepos),
// gitops/gitops.go (IsGitDir, IsWorktree, Run, Output, cloneRepo, syncMainBranch, etc.)
package workspace

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	daemonpaths "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/config"
)

var repoLocks sync.Map
var mountedRepoCache sync.Map

const maxConcurrentRepoMounts = 4

// --- git low-level helpers (from gitops) ---

var commandContext = func(ctx context.Context, name string, args ...string) *exec.Cmd {
	return exec.CommandContext(ctx, name, args...)
}

// Run executes a git command in the given directory.
func gitRun(ctx context.Context, cwd string, args ...string) error {
	_, err := gitOutput(ctx, cwd, args...)
	return err
}

// Output executes a git command and returns combined output.
func gitOutput(ctx context.Context, cwd string, args ...string) (string, error) {
	cmd := commandContext(ctx, "git", args...)
	if cwd != "" {
		cmd.Dir = cwd
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return string(out), nil
}

// IsGitDir reports whether dir is inside a git repository.
func IsGitDir(dir string) bool {
	if dir == "" {
		return false
	}
	if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
		return true
	}
	return gitRun(context.Background(), dir, "rev-parse", "--is-inside-work-tree") == nil
}

// IsWorktree reports whether dir is a git worktree.
func IsWorktree(dir string) bool {
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		return false
	}
	if IsGitDir(dir) {
		return true
	}
	gitFile := filepath.Join(dir, ".git")
	if info, err := os.Stat(gitFile); err != nil {
		return false
	} else if info.IsDir() {
		return true
	}
	data, err := os.ReadFile(gitFile)
	if err != nil {
		return false
	}
	return strings.HasPrefix(string(data), "gitdir:")
}

// --- repo resolution (from repoworkspace) ---

// NormalizeRunRequestWorkspaceScopes ensures scope IDs are set on workspace repo specs.
func NormalizeRunRequestWorkspaceScopes(req *RunRequestFrame) {
	if req == nil {
		return
	}
	for _, spec := range req.WorkspaceRepos {
		NormalizeWorkspaceRepoSpecScope(spec, req.BackendID)
	}
	if req.WorkspaceRepo != nil {
		NormalizeWorkspaceRepoSpecScope(req.WorkspaceRepo, req.BackendID)
	}
}

// NormalizeWorkspaceRepoSpecScope fills in ScopeID from AgentID if missing.
func NormalizeWorkspaceRepoSpecScope(spec *WorkspaceRepoSpec, fallbackAgentID string) {
	if spec == nil {
		return
	}
	if spec.Scope != "session" && spec.Scope != "direct_session" && !(spec.Scope == "" && spec.ScopeID != "") {
		return
	}
	if spec.ScopeID != "" {
		return
	}
	agentID := spec.AgentID
	if agentID == "" {
		agentID = fallbackAgentID
	}
	if agentID != "" {
		spec.ScopeID = "octodeck-" + agentID
	}
}

// Resolve resolves a workspace repo spec to a directory on disk.
func Resolve(ctx context.Context, cfg *Config, spec *WorkspaceRepoSpec) (string, error) {
	if spec == nil {
		return "", errors.New("workspace repo spec is required")
	}
	unlock := lockRepoSpec(spec)
	defer unlock()
	switch spec.Kind {
	case "git":
		if spec.GitURL == "" {
			return "", errors.New("gitUrl is required")
		}
		cacheDir := filepath.Join(daemonpaths.ReposDir(cfg), repoCacheName(spec.GitURL))
		if !IsGitDir(cacheDir) {
			if err := cloneRepo(ctx, spec.GitURL, cacheDir); err != nil {
				return "", err
			}
		} else if err := gitRun(ctx, cacheDir, "fetch", "--all", "--prune"); err != nil {
			return "", err
		}
		ref, err := syncMainBranch(ctx, cacheDir, spec.MainBranch)
		if err != nil {
			return "", err
		}
		worktreeDir, err := CreateWorkspaceDir(cfg, spec.GroupFolder)
		if WorkspaceSpecHasScope(spec) {
			base, err := EnsureRepoBaseDir(cfg, spec)
			if err != nil {
				return "", err
			}
			worktreeDir, err = ensureScopedRepoDir(base, spec)
			if err != nil {
				return "", err
			}
		} else if err != nil {
			return "", err
		}
		if IsGitDir(worktreeDir) {
			return worktreeDir, nil
		}
		if err := addWorktreeOnBranch(ctx, cacheDir, worktreeDir, ref, DeriveWorktreeBranch(spec)); err != nil {
			_ = os.RemoveAll(worktreeDir)
			return "", err
		}
		return worktreeDir, nil
	case "workspace":
		return EnsureRepoBaseDir(cfg, spec)
	case "device_path":
		return resolveDevicePath(ctx, cfg, spec)
	default:
		return "", fmt.Errorf("unknown workspace repo kind: %q", spec.Kind)
	}
}

// MountAt resolves a repo spec and mounts it at baseDir/name.
func MountAt(ctx context.Context, cfg *Config, baseDir string, spec *WorkspaceRepoSpec) (string, error) {
	if spec == nil {
		return "", errors.New("workspace repo spec is required")
	}
	name := deriveMountName(spec)
	target := filepath.Join(baseDir, name)
	cacheKey := mountCacheKey(target, spec)
	if _, ok := mountedRepoCache.Load(cacheKey); ok {
		log.Printf("octodeck-daemon: workspace mount-at memory-cache-hit kind=%s target=%s", spec.Kind, target)
		return target, nil
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return "", err
	}
	unlock := lockRepoSpec(spec)
	defer unlock()
	if _, ok := mountedRepoCache.Load(cacheKey); ok {
		log.Printf("octodeck-daemon: workspace mount-at memory-cache-hit kind=%s target=%s afterLock=true", spec.Kind, target)
		return target, nil
	}
	switch spec.Kind {
	case "git":
		if spec.GitURL == "" {
			return "", errors.New("gitUrl is required")
		}
		if IsWorktree(target) {
			log.Printf("octodeck-daemon: workspace mount-at fast-path kind=git target=%s alreadyMounted=true", target)
			mountedRepoCache.Store(cacheKey, true)
			return target, nil
		}
		cacheDir := filepath.Join(daemonpaths.ReposDir(cfg), repoCacheName(spec.GitURL))
		if !IsGitDir(cacheDir) {
			if err := cloneRepo(ctx, spec.GitURL, cacheDir); err != nil {
				return "", err
			}
		} else if err := gitRun(ctx, cacheDir, "fetch", "--all", "--prune"); err != nil {
			return "", err
		}
		ref, err := syncMainBranch(ctx, cacheDir, spec.MainBranch)
		if err != nil {
			return "", err
		}
		if IsWorktree(target) {
			mountedRepoCache.Store(cacheKey, true)
			return target, nil
		}
		cleanupEmptyTarget(target)
		if err := addWorktreeOnBranch(ctx, cacheDir, target, ref, DeriveWorktreeBranch(spec)); err != nil {
			_ = os.RemoveAll(target)
			return "", err
		}
		mountedRepoCache.Store(cacheKey, true)
		return target, nil
	case "device_path":
		if IsWorktree(target) {
			log.Printf("octodeck-daemon: workspace mount-at fast-path kind=device_path target=%s alreadyMounted=true", target)
			mountedRepoCache.Store(cacheKey, true)
			return target, nil
		}
		devicePath, err := cleanDevicePath(spec)
		if err != nil {
			return "", err
		}
		if !IsGitDir(devicePath) {
			mounted, err := symlinkDevicePath(target, devicePath)
			if err != nil {
				return "", err
			}
			mountedRepoCache.Store(cacheKey, true)
			return mounted, nil
		}
		cleanupEmptyTarget(target)
		if err := gitRun(ctx, devicePath, "worktree", "add", "--force", target, "HEAD"); err != nil {
			_ = os.RemoveAll(target)
			return "", err
		}
		mountedRepoCache.Store(cacheKey, true)
		return target, nil
	case "workspace":
		if err := os.MkdirAll(target, 0o755); err != nil {
			return "", err
		}
		mountedRepoCache.Store(cacheKey, true)
		return target, nil
	default:
		return "", fmt.Errorf("unknown workspace repo kind: %q", spec.Kind)
	}
}

// ResolveRepoRoot resolves the repo root for an agent run request with repos.
// From agentworkspace.ResolveRepoRoot.
func ResolveRepoRoot(ctx context.Context, cfg *Config, req *AgentRunRequestFrame, repos []*WorkspaceRepoSpec) (string, error) {
	if len(repos) == 0 || repos[0] == nil {
		return "", errors.New("workspace repo spec is required")
	}
	if HasScopedWorkspace(req.Workspace) {
		return ResolveRoot(cfg, req)
	}
	return EnsureRepoBaseDir(cfg, repos[0])
}

// MountRepos mounts all non-workspace repos into baseDir.
// From agentworkspace.MountRepos.
func MountRepos(ctx context.Context, cfg *Config, baseDir string, repos []*WorkspaceRepoSpec) error {
	mountSpecs := make([]*WorkspaceRepoSpec, 0, len(repos))
	for _, spec := range repos {
		if spec == nil {
			return errors.New("workspace repo spec is required")
		}
		if spec.Kind == "workspace" {
			continue
		}
		mountSpecs = append(mountSpecs, spec)
	}
	if len(mountSpecs) == 0 {
		return nil
	}

	started := time.Now()
	workerCount := maxConcurrentRepoMounts
	if len(mountSpecs) < workerCount {
		workerCount = len(mountSpecs)
	}
	log.Printf("octodeck-daemon: workspace mount-repos start baseDir=%s repoCount=%d workerCount=%d", baseDir, len(mountSpecs), workerCount)
	mountCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	jobs := make(chan *WorkspaceRepoSpec)
	errCh := make(chan error, 1)
	var wg sync.WaitGroup
	for i := 0; i < workerCount; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for spec := range jobs {
				name := deriveMountName(spec)
				mountStarted := time.Now()
				log.Printf("octodeck-daemon: workspace mount-repo start baseDir=%s repo=%s kind=%s", baseDir, name, spec.Kind)
				target, err := MountAt(mountCtx, cfg, baseDir, spec)
				if err != nil {
					log.Printf("octodeck-daemon: workspace mount-repo failed baseDir=%s repo=%s kind=%s elapsedMs=%d err=%v", baseDir, name, spec.Kind, time.Since(mountStarted).Milliseconds(), err)
					select {
					case errCh <- err:
						cancel()
					default:
					}
					return
				}
				log.Printf("octodeck-daemon: workspace mount-repo completed baseDir=%s repo=%s kind=%s target=%s elapsedMs=%d", baseDir, name, spec.Kind, target, time.Since(mountStarted).Milliseconds())
			}
		}()
	}

sendLoop:
	for _, spec := range mountSpecs {
		select {
		case <-mountCtx.Done():
			break sendLoop
		case jobs <- spec:
		}
	}
	close(jobs)
	wg.Wait()

	select {
	case err := <-errCh:
		return err
	default:
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	log.Printf("octodeck-daemon: workspace mount-repos completed baseDir=%s repoCount=%d workerCount=%d elapsedMs=%d", baseDir, len(mountSpecs), workerCount, time.Since(started).Milliseconds())
	return nil
}

// DeriveMountName returns a safe directory name for a repo spec.
func DeriveMountName(spec *WorkspaceRepoSpec) string {
	return deriveMountName(spec)
}

// --- internal helpers ---

func resolveDevicePath(ctx context.Context, cfg *Config, spec *WorkspaceRepoSpec) (string, error) {
	devicePath, err := cleanDevicePath(spec)
	if err != nil {
		return "", err
	}
	if !IsGitDir(devicePath) {
		baseDir, err := EnsureRepoBaseDir(cfg, spec)
		if err != nil {
			return "", err
		}
		_, err = symlinkDevicePath(filepath.Join(baseDir, SafePathSegment(filepath.Base(filepath.Clean(devicePath)))), devicePath)
		return baseDir, err
	}
	worktreeDir, err := CreateWorkspaceDir(cfg, spec.GroupFolder)
	if WorkspaceSpecHasScope(spec) {
		base, err := EnsureRepoBaseDir(cfg, spec)
		if err != nil {
			return "", err
		}
		worktreeDir, err = ensureScopedRepoDir(base, spec)
		if err != nil {
			return "", err
		}
	} else if err != nil {
		return "", err
	}
	if IsGitDir(worktreeDir) {
		return worktreeDir, nil
	}
	if err := gitRun(ctx, devicePath, "worktree", "add", "--force", worktreeDir, "HEAD"); err != nil {
		_ = os.RemoveAll(worktreeDir)
		return "", err
	}
	return worktreeDir, nil
}

func cleanDevicePath(spec *WorkspaceRepoSpec) (string, error) {
	if spec.DevicePath == "" {
		return "", errors.New("devicePath is required")
	}
	if !filepath.IsAbs(spec.DevicePath) {
		return "", fmt.Errorf("devicePath must be absolute: %q", spec.DevicePath)
	}
	return cleanExistingDirectory(spec.DevicePath)
}

// cleanExistingDirectory cleans the path, evaluates symlinks, and verifies that
// the resulting path exists and is a directory. Local copy of
// security.CleanExistingDirectory to avoid an import cycle (security imports
// workspace).
func cleanExistingDirectory(p string) (string, error) {
	clean, err := filepath.Abs(filepath.Clean(p))
	if err != nil {
		return "", err
	}
	realPath, err := filepath.EvalSymlinks(clean)
	if err != nil {
		return "", err
	}
	stat, err := os.Stat(realPath)
	if err != nil {
		return "", err
	}
	if !stat.IsDir() {
		return "", fmt.Errorf("path is not a directory: %s", realPath)
	}
	return realPath, nil
}

func cloneRepo(ctx context.Context, gitURL, cacheDir string) error {
	if err := os.MkdirAll(filepath.Dir(cacheDir), 0o755); err != nil {
		return err
	}
	tmpDir := cacheDir + ".tmp"
	_ = os.RemoveAll(tmpDir)
	if err := gitRun(ctx, "", "clone", gitURL, tmpDir); err != nil {
		_ = os.RemoveAll(tmpDir)
		return err
	}
	if err := os.Rename(tmpDir, cacheDir); err != nil {
		_ = os.RemoveAll(tmpDir)
		return err
	}
	return nil
}

func deriveMountName(spec *WorkspaceRepoSpec) string {
	if spec.Name != "" {
		if n := SafePathSegment(spec.Name); n != "" {
			return n
		}
	}
	switch spec.Kind {
	case "git":
		if spec.GitURL != "" {
			return RepoNameFromURL(spec.GitURL)
		}
	case "device_path":
		if spec.DevicePath != "" {
			if n := SafePathSegment(filepath.Base(filepath.Clean(spec.DevicePath))); n != "" {
				return n
			}
		}
	}
	return "repo"
}

func repoCacheName(gitURL string) string {
	base := RepoNameFromURL(gitURL)
	if base == "" {
		return "repo"
	}
	return base
}

func ensureScopedRepoDir(baseDir string, spec *WorkspaceRepoSpec) (string, error) {
	dir := filepath.Join(baseDir, deriveMountName(spec))
	if info, err := os.Stat(dir); err == nil {
		if !info.IsDir() {
			return "", fmt.Errorf("repo workspace path exists and is not directory: %s", dir)
		}
		if IsGitDir(dir) {
			return dir, nil
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			return "", err
		}
		if len(entries) > 0 {
			return "", fmt.Errorf("repo workspace path exists and is not empty: %s", dir)
		}
		if err := os.Remove(dir); err != nil {
			return "", err
		}
		return dir, nil
	} else if !os.IsNotExist(err) {
		return "", err
	}
	return dir, nil
}

func symlinkDevicePath(target, devicePath string) (string, error) {
	if existing, err := os.Readlink(target); err == nil {
		if existing == devicePath {
			return target, nil
		}
		return "", fmt.Errorf("symlink already exists with different target: %s -> %s", target, existing)
	}
	if _, err := os.Lstat(target); err == nil {
		return "", fmt.Errorf("path already exists and is not symlink: %s", target)
	} else if !os.IsNotExist(err) {
		return "", err
	}
	if err := os.Symlink(devicePath, target); err != nil {
		return "", err
	}
	return target, nil
}

func cleanupEmptyTarget(target string) {
	if info, err := os.Lstat(target); err == nil {
		if info.IsDir() {
			entries, _ := os.ReadDir(target)
			if len(entries) == 0 {
				_ = os.Remove(target)
			}
		} else {
			_ = os.Remove(target)
		}
	}
}

func mountCacheKey(target string, spec *WorkspaceRepoSpec) string {
	return strings.Join([]string{
		filepath.Clean(target),
		spec.Kind,
		spec.GitURL,
		spec.MainBranch,
		spec.DevicePath,
		spec.Name,
		spec.Scope,
		spec.ScopeID,
		DeriveWorktreeBranch(spec),
	}, "\x00")
}

func lockRepoSpec(spec *WorkspaceRepoSpec) func() {
	key := spec.Kind + ":" + spec.GitURL + ":" + spec.MainBranch + ":" + spec.DevicePath
	value, _ := repoLocks.LoadOrStore(key, &sync.Mutex{})
	mu := value.(*sync.Mutex)
	mu.Lock()
	return mu.Unlock
}

func syncMainBranch(ctx context.Context, repoDir, mainBranch string) (string, error) {
	mainBranch = strings.TrimSpace(mainBranch)
	if mainBranch != "" {
		if err := gitRun(ctx, repoDir, "rev-parse", "--verify", "origin/"+mainBranch); err != nil {
			if err := gitRun(ctx, repoDir, "rev-parse", "--verify", mainBranch); err != nil {
				return "", err
			}
			return mainBranch, nil
		}
		defaultRef := "origin/" + mainBranch
		if err := gitRun(ctx, repoDir, "checkout", "-B", mainBranch, defaultRef); err != nil {
			return "", err
		}
		if err := gitRun(ctx, repoDir, "reset", "--hard", defaultRef); err != nil {
			return "", err
		}
		return defaultRef, nil
	}
	return syncDefaultBranch(ctx, repoDir)
}

func syncDefaultBranch(ctx context.Context, repoDir string) (string, error) {
	_ = gitRun(ctx, repoDir, "remote", "set-head", "origin", "--auto")
	defaultRef, err := gitOutput(ctx, repoDir, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD")
	if err != nil || strings.TrimSpace(defaultRef) == "" {
		if err := gitRun(ctx, repoDir, "rev-parse", "--verify", "origin/main"); err == nil {
			defaultRef = "origin/main"
		} else {
			defaultRef = "HEAD"
		}
	}
	defaultRef = strings.TrimSpace(defaultRef)
	branch := strings.TrimPrefix(defaultRef, "origin/")
	if defaultRef != "HEAD" {
		if err := gitRun(ctx, repoDir, "checkout", "-B", branch, defaultRef); err != nil {
			return "", err
		}
		if err := gitRun(ctx, repoDir, "reset", "--hard", defaultRef); err != nil {
			return "", err
		}
		return defaultRef, nil
	}
	return "HEAD", nil
}

func addWorktreeOnBranch(ctx context.Context, repoDir, target, ref, branch string) error {
	if branch == "" {
		return gitRun(ctx, repoDir, "worktree", "add", "--force", target, ref)
	}
	if gitRun(ctx, repoDir, "show-ref", "--verify", "--quiet", "refs/heads/"+branch) == nil {
		return gitRun(ctx, repoDir, "worktree", "add", "--force", target, branch)
	}
	return gitRun(ctx, repoDir, "worktree", "add", "--force", "-B", branch, target, ref)
}
