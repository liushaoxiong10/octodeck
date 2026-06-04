package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

var repoLocks sync.Map

const agentTeamMCPConfigPlaceholder = "__OCTODECK_AGENT_TEAM_MCP_CONFIG__"
const agentTeamMCPProjectConfigMarker = "__OCTODECK_AGENT_TEAM_MCP_PROJECT_CONFIG__"
const userMCPServersEnv = "OCTODECK_USER_MCP_SERVERS_JSON"
const deviceWorkspaceURIPrefix = "octodeck-workspace://"
const deviceTmpURIPrefix = "octodeck-tmp://"

// runner spawns a child process per run.request and pumps its stdout/stderr
// back to the server as run.event frames.
type runner struct {
	cfg  *Config
	pool *runnerPool
	send func(any) error
}

func newRunner(cfg *Config, pool *runnerPool, send func(any) error) *runner {
	return &runner{cfg: cfg, pool: pool, send: send}
}

// handle starts a new run. It does NOT block the caller; the spawn loop runs
// in a fresh goroutine. Errors that prevent spawning result in an immediate
// run.result frame with exitCode=-1.
func (r *runner) handle(ctx context.Context, req *RunRequestFrame) {
	if err := validateRunRequest(r.cfg, req); err != nil {
		r.sendErr(req.RunID, fmt.Errorf("validation: %w", err))
		return
	}
	if !r.pool.reserve(req.RunID) {
		r.sendErr(req.RunID, errors.New("run pool full or duplicate runId"))
		return
	}
	r.pool.noteAccepted(req.RunID, req.BackendID, req.Cwd)
	r.sendStatus(req.RunID, "accepted", req.BackendID, req.Cwd, "")

	go r.spawn(ctx, req)
}

func (r *runner) spawn(parent context.Context, req *RunRequestFrame) {
	defer r.pool.release(req.RunID)
	timeout := time.Duration(req.TimeoutMs) * time.Millisecond
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()

	if req.WorkspaceRepo != nil {
		cwd, err := resolveWorkspaceRepo(ctx, r.cfg, req.WorkspaceRepo)
		if err != nil {
			r.sendErr(req.RunID, fmt.Errorf("workspace repo: %w", err))
			return
		}
		req.Cwd = cwd
	} else {
		cwd, err := defaultRunCwd(r.cfg, req.Cwd)
		if err != nil {
			r.sendErr(req.RunID, fmt.Errorf("default cwd: %w", err))
			return
		}
		req.Cwd = cwd
	}
	if req.RemoteCwdPlaceholder != "" {
		req.Argv = replaceArgvPlaceholder(req.Argv, req.RemoteCwdPlaceholder, req.Cwd)
		req.Context = replaceContextPlaceholder(req.Context, req.RemoteCwdPlaceholder, req.Cwd)
	}
	r.pool.noteAccepted(req.RunID, req.BackendID, req.Cwd)
	if !isPathAllowedByRoots(req.Cwd, r.cfg.AllowedRoots, req.Cwd) {
		r.sendErr(req.RunID, fmt.Errorf("cwd outside allowed roots: %s", req.Cwd))
		return
	}
	argv, err := prepareAgentTeamMCPConfig(r.cfg, req.Argv, req.Cwd, req.Env)
	if err != nil {
		r.sendErr(req.RunID, fmt.Errorf("agent team mcp config: %w", err))
		return
	}
	req.Argv = argv

	cmd := exec.CommandContext(ctx, req.Binary, req.Argv...)
	cmd.Dir = req.Cwd
	cmd.Env = buildEnv(r.cfg, req.Env, req.Context)
	if req.StdinJSON != "" {
		cmd.Stdin = strings.NewReader(req.StdinJSON)
	}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		r.sendErr(req.RunID, fmt.Errorf("stdout pipe: %w", err))
		return
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		r.sendErr(req.RunID, fmt.Errorf("stderr pipe: %w", err))
		return
	}

	startedAt := time.Now()
	if err := cmd.Start(); err != nil {
		r.sendErr(req.RunID, fmt.Errorf("spawn: %w", err))
		return
	}
	r.pool.attach(req.RunID, cmd, cancel)
	r.sendStatus(req.RunID, "started", req.BackendID, req.Cwd, "")

	var sentBytes atomic.Int64
	pump := func(stream string, src io.Reader) {
		reader := bufio.NewReader(src)
		buf := make([]byte, 8192)
		for {
			n, rerr := reader.Read(buf)
			if n > 0 {
				r.pool.noteActivity(req.RunID)
				if sentBytes.Load() >= req.MaxOutputBytes {
					// silently drop further bytes; server will time out if final
					// result never arrives
					if rerr != nil {
						return
					}
					continue
				}
				chunk := buf[:n]
				if remaining := req.MaxOutputBytes - sentBytes.Load(); int64(n) > remaining {
					chunk = chunk[:remaining]
				}
				sentBytes.Add(int64(len(chunk)))
				_ = r.send(&RunEventFrame{
					Type:   tRunEvent,
					RunID:  req.RunID,
					Stream: stream,
					Data:   string(chunk),
				})
			}
			if rerr != nil {
				return
			}
		}
	}

	doneOut := make(chan struct{})
	doneErr := make(chan struct{})
	go func() { pump("stdout", stdout); close(doneOut) }()
	go func() { pump("stderr", stderr); close(doneErr) }()

	waitErr := cmd.Wait()
	<-doneOut
	<-doneErr

	exitCode := 0
	var signalStr *string
	if waitErr != nil {
		var exitErr *exec.ExitError
		if errors.As(waitErr, &exitErr) {
			exitCode = exitErr.ExitCode()
			if ws := exitErr.ProcessState.Sys(); ws != nil {
				if s, ok := getSignal(ws); ok {
					signalStr = &s
				}
			}
		} else {
			exitCode = -1
		}
	}
	timedOut := errors.Is(ctx.Err(), context.DeadlineExceeded)
	durationMs := time.Since(startedAt).Milliseconds()
	if exitCode == 0 && !timedOut {
		r.sendStatus(req.RunID, "completed", req.BackendID, req.Cwd, "")
	} else {
		r.sendStatus(req.RunID, "failed", req.BackendID, req.Cwd, "")
	}

	exit := exitCode
	_ = r.send(&RunResultFrame{
		Type:       tRunResult,
		RunID:      req.RunID,
		ExitCode:   &exit,
		Signal:     signalStr,
		TimedOut:   timedOut,
		DurationMs: durationMs,
	})
}

func resolveWorkspaceRepo(ctx context.Context, cfg *Config, spec *WorkspaceRepoSpec) (string, error) {
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
		cacheDir := filepath.Join(reposDir(cfg), repoCacheName(spec.GitURL))
		if !isGitDir(cacheDir) {
			if err := os.MkdirAll(filepath.Dir(cacheDir), 0o755); err != nil {
				return "", err
			}
			tmpDir := cacheDir + ".tmp"
			_ = os.RemoveAll(tmpDir)
			if err := runGit(ctx, "", "clone", spec.GitURL, tmpDir); err != nil {
				_ = os.RemoveAll(tmpDir)
				return "", err
			}
			if err := os.Rename(tmpDir, cacheDir); err != nil {
				_ = os.RemoveAll(tmpDir)
				return "", err
			}
		} else {
			if err := runGit(ctx, cacheDir, "fetch", "--all", "--prune"); err != nil {
				return "", err
			}
		}
		ref, err := syncRepoDefaultBranch(ctx, cacheDir)
		if err != nil {
			return "", err
		}
		worktreeDir, err := createWorkspaceRepoDir(cfg, spec)
		if err != nil {
			return "", err
		}
		if err := runGit(ctx, cacheDir, "worktree", "add", "--force", worktreeDir, ref); err != nil {
			_ = os.RemoveAll(worktreeDir)
			return "", err
		}
		return worktreeDir, nil

	case "workspace":
		return ensureWorkspaceRepoBaseDir(cfg, spec)

	case "device_path":
		if spec.DevicePath == "" {
			return "", errors.New("devicePath is required")
		}
		if !filepath.IsAbs(spec.DevicePath) {
			return "", fmt.Errorf("devicePath must be absolute: %q", spec.DevicePath)
		}
		devicePath, err := cleanExistingDirectory(spec.DevicePath)
		if err != nil {
			return "", err
		}
		if !isPathAllowedByConfiguredRoots(devicePath, cfg.AllowedRoots) {
			return "", fmt.Errorf("devicePath outside allowed roots: %s", devicePath)
		}
		if !isGitDir(devicePath) {
			baseDir, err := ensureWorkspaceRepoBaseDir(cfg, spec)
			if err != nil {
				return "", err
			}
			if err := ensureDevicePathSymlink(baseDir, devicePath); err != nil {
				return "", err
			}
			return baseDir, nil
		}
		worktreeDir, err := createWorkspaceRepoDir(cfg, spec)
		if err != nil {
			return "", err
		}
		if err := runGit(ctx, devicePath, "worktree", "add", "--force", worktreeDir, "HEAD"); err != nil {
			_ = os.RemoveAll(worktreeDir)
			return "", err
		}
		return worktreeDir, nil
	default:
		return "", fmt.Errorf("unknown workspace repo kind: %q", spec.Kind)
	}
}

func agentRootDir(cfg *Config, agentID string, customRoot string) (string, error) {
	if customRoot != "" {
		if !filepath.IsAbs(customRoot) {
			return "", fmt.Errorf("agentRoot must be absolute: %q", customRoot)
		}
		return filepath.Clean(customRoot), nil
	}
	return filepath.Join(workspaceDir(cfg), safeGroupFolder(agentID)), nil
}

func agentScopedDir(cfg *Config, agentID, customRoot, scope, scopeID string) (string, error) {
	root, err := agentRootDir(cfg, agentID, customRoot)
	if err != nil {
		return "", err
	}
	switch scope {
	case "direct_session":
		if scopeID == "" {
			scopeID = "new"
		}
		return filepath.Join(sessionDir(cfg), safeGroupFolder(scopeID)), nil
	case "session":
		if scopeID == "" {
			scopeID = "new"
		}
		return filepath.Join(root, "sessions", safeGroupFolder(scopeID)), nil
	case "task":
		if scopeID == "" {
			scopeID = "run"
		}
		return filepath.Join(root, "tasks", safeGroupFolder(scopeID)), nil
	case "skills":
		return filepath.Join(root, "skills"), nil
	case "workspace", "":
		return root, nil
	default:
		return "", fmt.Errorf("unknown workspace scope: %q", scope)
	}
}

func workspaceSpecAgentID(spec *WorkspaceRepoSpec) string {
	if spec.AgentID != "" {
		return spec.AgentID
	}
	return spec.GroupFolder
}

func ensureWorkspaceRepoBaseDir(cfg *Config, spec *WorkspaceRepoSpec) (string, error) {
	if spec.AgentID != "" || spec.AgentRoot != "" || spec.Scope != "" || spec.ScopeID != "" {
		dir, err := agentScopedDir(cfg, workspaceSpecAgentID(spec), spec.AgentRoot, spec.Scope, spec.ScopeID)
		if err != nil {
			return "", err
		}
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return "", err
		}
		return dir, nil
	}
	return ensureNamedWorkspaceDir(cfg, spec.GroupFolder)
}

func createWorkspaceRepoDir(cfg *Config, spec *WorkspaceRepoSpec) (string, error) {
	if spec.AgentID != "" || spec.AgentRoot != "" || spec.Scope != "" || spec.ScopeID != "" {
		base, err := ensureWorkspaceRepoBaseDir(cfg, spec)
		if err != nil {
			return "", err
		}
		return ensureScopedRepoDir(base, spec)
	}
	return createWorkspaceDir(cfg, spec.GroupFolder)
}

func ensureScopedRepoDir(baseDir string, spec *WorkspaceRepoSpec) (string, error) {
	name := "repo"
	if spec.Kind == "device_path" && spec.DevicePath != "" {
		name = filepath.Base(filepath.Clean(spec.DevicePath))
	}
	name = safePathSegment(name)
	if name == "" {
		name = "repo"
	}
	dir := filepath.Join(baseDir, name)
	if info, err := os.Stat(dir); err == nil {
		if !info.IsDir() {
			return "", fmt.Errorf("repo workspace path exists and is not directory: %s", dir)
		}
		if isGitDir(dir) {
			return dir, nil
		}
		entries, readErr := os.ReadDir(dir)
		if readErr != nil {
			return "", readErr
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

func ensureDevicePathSymlink(baseDir, devicePath string) error {
	name := safePathSegment(filepath.Base(filepath.Clean(devicePath)))
	if name == "" {
		name = "repo"
	}
	linkPath := filepath.Join(baseDir, name)
	if existing, err := os.Readlink(linkPath); err == nil {
		if existing == devicePath {
			return nil
		}
		return fmt.Errorf("symlink already exists with different target: %s -> %s", linkPath, existing)
	}
	if _, err := os.Lstat(linkPath); err == nil {
		return fmt.Errorf("path already exists and is not symlink: %s", linkPath)
	} else if !os.IsNotExist(err) {
		return err
	}
	return os.Symlink(devicePath, linkPath)
}

func lockRepoSpec(spec *WorkspaceRepoSpec) func() {
	key := spec.Kind + ":" + spec.GitURL + ":" + spec.DevicePath
	value, _ := repoLocks.LoadOrStore(key, &sync.Mutex{})
	mu := value.(*sync.Mutex)
	mu.Lock()
	return mu.Unlock
}

func replaceArgvPlaceholder(argv []string, placeholder, cwd string) []string {
	replacer := strings.NewReplacer(placeholder, cwd)
	out := make([]string, len(argv))
	for i, arg := range argv {
		out[i] = replacer.Replace(arg)
	}
	return out
}

func replaceContextPlaceholder(ctx any, placeholder, cwd string) any {
	if ctx == nil || placeholder == "" {
		return ctx
	}
	data, err := json.Marshal(ctx)
	if err != nil {
		return ctx
	}
	replaced := strings.ReplaceAll(string(data), placeholder, cwd)
	var out any
	if err := json.Unmarshal([]byte(replaced), &out); err != nil {
		return ctx
	}
	return out
}

func defaultRunCwd(cfg *Config, requestedCwd string) (string, error) {
	if strings.HasPrefix(requestedCwd, deviceWorkspaceURIPrefix) {
		folder := strings.TrimPrefix(requestedCwd, deviceWorkspaceURIPrefix)
		return ensureNamedWorkspaceDir(cfg, folder)
	}
	if strings.HasPrefix(requestedCwd, deviceTmpURIPrefix) {
		folder := strings.TrimPrefix(requestedCwd, deviceTmpURIPrefix)
		return ensureNamedTmpDir(cfg, folder)
	}
	base := filepath.Base(filepath.Clean(requestedCwd))
	return createRandomDir(taskDir(cfg), safeGroupFolder(base))
}

func resolveAgentWorkspaceCwd(cfg *Config, ws *AgentRunWorkspace) (string, error) {
	if ws == nil || (ws.AgentID == "" && ws.AgentRoot == "" && ws.Scope == "" && ws.ScopeID == "") {
		return "", errors.New("agent workspace metadata is required")
	}
	agentID := ws.AgentID
	if agentID == "" {
		agentID = ws.Folder
	}
	dir, err := agentScopedDir(cfg, agentID, ws.AgentRoot, ws.Scope, ws.ScopeID)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	return dir, nil
}

func ensureNamedWorkspaceDir(cfg *Config, groupFolder string) (string, error) {
	dir := filepath.Join(workspaceDir(cfg), safeGroupFolder(groupFolder))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	return dir, nil
}

func ensureNamedTmpDir(cfg *Config, groupFolder string) (string, error) {
	dir := filepath.Join(tmpDir(cfg), safeGroupFolder(groupFolder))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	return dir, nil
}

func createWorkspaceDir(cfg *Config, groupFolder string) (string, error) {
	return createRandomDir(workspaceDir(cfg), safeGroupFolder(groupFolder))
}

func createRandomDir(parent, prefix string) (string, error) {
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
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(buf)
}

func syncRepoDefaultBranch(ctx context.Context, repoDir string) (string, error) {
	if err := runGit(ctx, repoDir, "remote", "set-head", "origin", "--auto"); err != nil {
		// Some test/local remotes do not advertise a symbolic HEAD; fall back below.
		_ = err
	}
	defaultRef, err := gitOutput(ctx, repoDir, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD")
	if err != nil || strings.TrimSpace(defaultRef) == "" {
		if err := runGit(ctx, repoDir, "rev-parse", "--verify", "origin/main"); err == nil {
			defaultRef = "origin/main"
		} else {
			defaultRef = "HEAD"
		}
	}
	defaultRef = strings.TrimSpace(defaultRef)
	branch := strings.TrimPrefix(defaultRef, "origin/")
	if defaultRef != "HEAD" {
		if err := runGit(ctx, repoDir, "checkout", "-B", branch, defaultRef); err != nil {
			return "", err
		}
		if err := runGit(ctx, repoDir, "reset", "--hard", defaultRef); err != nil {
			return "", err
		}
		return defaultRef, nil
	}
	return "HEAD", nil
}

func prepareAgentTeamMCPConfig(cfg *Config, argv []string, cwd string, env ...map[string]string) ([]string, error) {
	hasPlaceholder := false
	hasProjectConfigMarker := false
	for _, arg := range argv {
		if strings.Contains(arg, agentTeamMCPConfigPlaceholder) {
			hasPlaceholder = true
		}
		if arg == agentTeamMCPProjectConfigMarker {
			hasProjectConfigMarker = true
		}
	}
	if !hasPlaceholder && !hasProjectConfigMarker {
		return argv, nil
	}
	out := argv
	if hasPlaceholder {
		path, err := writeAgentTeamMCPConfig(cfg, env...)
		if err != nil {
			return nil, err
		}
		out = replaceArgvPlaceholder(out, agentTeamMCPConfigPlaceholder, path)
	}
	if hasProjectConfigMarker {
		if err := writeAgentTeamMCPProjectConfig(cfg, cwd, env...); err != nil {
			return nil, err
		}
		filtered := make([]string, 0, len(out))
		for _, arg := range out {
			if arg == agentTeamMCPProjectConfigMarker {
				continue
			}
			filtered = append(filtered, arg)
		}
		out = filtered
	}
	return out, nil
}

func writeAgentTeamMCPConfig(cfg *Config, env ...map[string]string) (string, error) {
	dir := daemonDir(cfg)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	path := filepath.Join(dir, "agent-team-mcp.json")
	data, err := buildAgentTeamMCPConfigJSON(cfg, env...)
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return "", err
	}
	return path, nil
}

func writeAgentTeamMCPProjectConfig(cfg *Config, cwd string, env ...map[string]string) error {
	if strings.TrimSpace(cwd) == "" {
		return errors.New("cwd is required")
	}
	if !filepath.IsAbs(cwd) {
		return fmt.Errorf("cwd must be absolute: %q", cwd)
	}
	path := filepath.Join(cwd, ".trae", "mcp.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	payload := map[string]any{}
	if data, err := os.ReadFile(path); err == nil && len(strings.TrimSpace(string(data))) > 0 {
		if err := json.Unmarshal(data, &payload); err != nil {
			return fmt.Errorf("parse existing Trae MCP config: %w", err)
		}
	}
	server, err := buildAgentTeamMCPServerConfig(cfg)
	if err != nil {
		return err
	}
	mcpServers, ok := payload["mcpServers"].(map[string]any)
	if !ok {
		mcpServers = map[string]any{}
	}
	for name, userServer := range loadUserMCPServersFromEnv(env...) {
		mcpServers[name] = userServer
	}
	mcpServers["octodeck_agent_team"] = server
	payload["mcpServers"] = mcpServers
	data, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o600)
}

func writeCodexMCPConfig(cfg *Config, req *AgentRunRequestFrame, cwd string) error {
	folder := groupFolderFromRunContext(req.Context)
	if folder == "" && req.Workspace != nil {
		folder = req.Workspace.Folder
	}
	if folder == "" {
		folder = filepath.Base(filepath.Clean(cwd))
	}
	codexHome := filepath.Join(sessionDir(cfg), safeGroupFolder(folder), "codex")
	if err := os.MkdirAll(codexHome, 0o700); err != nil {
		return err
	}
	server, err := buildAgentTeamMCPServerConfig(cfg)
	if err != nil {
		return err
	}
	command, _ := server["command"].(string)
	args, _ := server["args"].([]string)
	env, _ := server["env"].(map[string]string)
	if len(args) == 0 {
		if raw, ok := server["args"].([]any); ok {
			for _, item := range raw {
				if s, ok := item.(string); ok {
					args = append(args, s)
				}
			}
		}
	}
	if env == nil {
		env = map[string]string{"OCTODECK_AGENT_TEAM_MCP": "1"}
	}
	blocks := []string{}
	for name, userServer := range loadUserMCPServersFromEnv(req.Env) {
		if block, ok := buildCodexMCPServerBlockFromAny(name, userServer); ok {
			blocks = append(blocks, block)
		}
	}
	blocks = append(blocks, buildCodexMCPServerBlock("octodeck_agent_team", command, args, env))
	path := filepath.Join(codexHome, "config.toml")
	existing := ""
	if data, err := os.ReadFile(path); err == nil {
		existing = string(data)
	} else if !os.IsNotExist(err) {
		return err
	}
	next := existing
	for _, block := range blocks {
		name := managedMCPBlockName(block)
		if name == "" {
			continue
		}
		next = replaceManagedBlock(next, name, block)
	}
	return os.WriteFile(path, []byte(next), 0o600)
}

func buildCodexMCPServerBlock(name string, command string, args []string, env map[string]string) string {
	var b strings.Builder
	b.WriteString("[mcp_servers.")
	b.WriteString(name)
	b.WriteString("]\n")
	b.WriteString("command = ")
	b.WriteString(tomlString(command))
	b.WriteByte('\n')
	b.WriteString("args = ")
	b.WriteString(tomlStringArray(args))
	b.WriteByte('\n')
	if len(env) > 0 {
		b.WriteString("env = {")
		i := 0
		for k, v := range env {
			if i > 0 {
				b.WriteString(", ")
			}
			b.WriteString(k)
			b.WriteString(" = ")
			b.WriteString(tomlString(v))
			i++
		}
		b.WriteString("}\n")
	}
	b.WriteString("startup_timeout_sec = 30\n")
	return b.String()
}

func managedMCPBlockName(block string) string {
	line, _, _ := strings.Cut(block, "\n")
	line = strings.TrimSpace(line)
	if !strings.HasPrefix(line, "[mcp_servers.") || !strings.HasSuffix(line, "]") {
		return ""
	}
	return strings.TrimSuffix(strings.TrimPrefix(line, "[mcp_servers."), "]")
}

func buildCodexMCPServerBlockFromAny(name string, server any) (string, bool) {
	m, ok := server.(map[string]any)
	if !ok || m["type"] == "http" || m["type"] == "sse" {
		return "", false
	}
	command, _ := m["command"].(string)
	if strings.TrimSpace(command) == "" {
		return "", false
	}
	args := []string{}
	if rawArgs, ok := m["args"].([]any); ok {
		for _, item := range rawArgs {
			if s, ok := item.(string); ok {
				args = append(args, s)
			}
		}
	}
	env := map[string]string{}
	if rawEnv, ok := m["env"].(map[string]any); ok {
		for k, v := range rawEnv {
			if s, ok := v.(string); ok {
				env[k] = s
			}
		}
	}
	return buildCodexMCPServerBlock(name, command, args, env), true
}

func replaceManagedBlock(existing, name, block string) string {
	startMarker := "# BEGIN OCTODECK MANAGED MCP " + name
	endMarker := "# END OCTODECK MANAGED MCP " + name
	managed := startMarker + "\n" + strings.TrimSpace(block) + "\n" + endMarker + "\n"
	start := strings.Index(existing, startMarker)
	if start >= 0 {
		end := strings.Index(existing[start:], endMarker)
		if end >= 0 {
			end += start + len(endMarker)
			for end < len(existing) && (existing[end] == '\n' || existing[end] == '\r') {
				end++
			}
			return strings.TrimRight(existing[:start], "\r\n") + "\n\n" + managed + strings.TrimLeft(existing[end:], "\r\n")
		}
	}
	if strings.TrimSpace(existing) == "" {
		return managed
	}
	return strings.TrimRight(existing, "\r\n") + "\n\n" + managed
}

func tomlString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

func tomlStringArray(items []string) string {
	b, _ := json.Marshal(items)
	return string(b)
}

func buildAgentTeamMCPConfigJSON(cfg *Config, env ...map[string]string) ([]byte, error) {
	server, err := buildAgentTeamMCPServerConfig(cfg)
	if err != nil {
		return nil, err
	}
	mcpServers := map[string]any{}
	for name, userServer := range loadUserMCPServersFromEnv(env...) {
		mcpServers[name] = userServer
	}
	mcpServers["octodeck_agent_team"] = server
	payload := map[string]any{
		"mcpServers": mcpServers,
	}
	return json.MarshalIndent(payload, "", "  ")
}

func loadUserMCPServersFromEnv(env ...map[string]string) map[string]any {
	rawValue := ""
	if len(env) > 0 && env[0] != nil {
		rawValue = env[0][userMCPServersEnv]
	}
	if rawValue == "" {
		rawValue = os.Getenv(userMCPServersEnv)
	}
	raw := strings.TrimSpace(rawValue)
	if raw == "" {
		return nil
	}
	var parsed map[string]any
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		return nil
	}
	return parsed
}

func buildAgentTeamMCPServerConfig(cfg *Config) (map[string]any, error) {
	if cfg == nil {
		return nil, errors.New("config is required")
	}
	if strings.TrimSpace(cfg.Server) == "" || strings.TrimSpace(cfg.Token) == "" {
		return nil, errors.New("server and token are required")
	}
	configPath, err := daemonConfigPath(cfg)
	if err != nil {
		return nil, err
	}
	command, err := daemonCommandPath(cfg)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"type":    "stdio",
		"command": command,
		"args":    []string{"mcp-agent-team", "--config", configPath},
		"env": map[string]string{
			"OCTODECK_AGENT_TEAM_MCP": "1",
		},
		"timeout": 30,
	}, nil
}

func workspaceDir(cfg *Config) string {
	if cfg != nil && cfg.WorkspaceDir != "" {
		return cfg.WorkspaceDir
	}
	workspace, err := defaultWorkspaceDir()
	if err != nil {
		return filepath.Join(os.TempDir(), "octodeck", "workspace")
	}
	return workspace
}

func daemonDir(cfg *Config) string {
	if cfg != nil && cfg.WorkspaceDir != "" {
		return filepath.Join(filepath.Dir(cfg.WorkspaceDir), "daemon")
	}
	dir, err := defaultDaemonDir()
	if err != nil {
		return filepath.Join(os.TempDir(), "octodeck", "daemon")
	}
	return dir
}

func daemonConfigPath(cfg *Config) (string, error) {
	if p := os.Getenv("OCTODECK_DAEMON_CONFIG"); p != "" && isPathWithinRoot(p, daemonDir(cfg)) {
		return p, nil
	}
	return filepath.Join(daemonDir(cfg), "config.json"), nil
}

func daemonCommandPath(cfg *Config) (string, error) {
	return filepath.Join(daemonDir(cfg), "bin", "octodeck-daemon"), nil
}

func taskDir(cfg *Config) string {
	if cfg != nil && cfg.TaskDir != "" {
		return cfg.TaskDir
	}
	if cfg != nil && cfg.WorkspaceDir != "" {
		return filepath.Join(filepath.Dir(cfg.WorkspaceDir), "task")
	}
	task, err := defaultTaskDir()
	if err != nil {
		return filepath.Join(os.TempDir(), "octodeck", "task")
	}
	return task
}

func sessionDir(cfg *Config) string {
	if cfg != nil && cfg.SessionDir != "" {
		return cfg.SessionDir
	}
	if cfg != nil && cfg.WorkspaceDir != "" {
		return filepath.Join(filepath.Dir(cfg.WorkspaceDir), "session")
	}
	session, err := defaultSessionDir()
	if err != nil {
		return filepath.Join(os.TempDir(), "octodeck", "session")
	}
	return session
}

func reposDir(cfg *Config) string {
	if cfg != nil && cfg.ReposDir != "" {
		return cfg.ReposDir
	}
	if cfg != nil && cfg.WorkspaceDir != "" {
		return filepath.Join(filepath.Dir(cfg.WorkspaceDir), "repos")
	}
	repos, err := defaultReposDir()
	if err != nil {
		return filepath.Join(os.TempDir(), "octodeck", "repos")
	}
	return repos
}

func cacheDir(cfg *Config) string {
	if cfg != nil && cfg.CacheDir != "" {
		return cfg.CacheDir
	}
	if cfg != nil && cfg.WorkspaceDir != "" {
		return filepath.Join(filepath.Dir(cfg.WorkspaceDir), "cache")
	}
	cache, err := defaultCacheDir()
	if err != nil {
		return filepath.Join(os.TempDir(), "octodeck", "cache")
	}
	return cache
}

func tmpDir(cfg *Config) string {
	if cfg != nil && cfg.TmpDir != "" {
		return cfg.TmpDir
	}
	if cfg != nil && cfg.WorkspaceDir != "" {
		return filepath.Join(filepath.Dir(cfg.WorkspaceDir), "tmp")
	}
	tmp, err := defaultTmpDir()
	if err != nil {
		return filepath.Join(os.TempDir(), "octodeck", "tmp")
	}
	return tmp
}

func stateDir(cfg *Config) string {
	if cfg != nil && cfg.StateDir != "" {
		return cfg.StateDir
	}
	if cfg != nil && cfg.WorkspaceDir != "" {
		return filepath.Join(filepath.Dir(cfg.WorkspaceDir), "state")
	}
	state, err := defaultStateDir()
	if err != nil {
		return filepath.Join(os.TempDir(), "octodeck", "state")
	}
	return state
}

func repoCacheName(gitURL string) string {
	base := strings.TrimSuffix(filepath.Base(gitURL), ".git")
	base = safePathSegment(base)
	if base == "" {
		base = "repo"
	}
	sum := sha1.Sum([]byte(gitURL))
	return base + "-" + hex.EncodeToString(sum[:])[:12]
}

func safeGroupFolder(folder string) string {
	if v := safePathSegment(folder); v != "" {
		return v
	}
	return "workspace"
}

var unsafePathSegment = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

func safePathSegment(s string) string {
	s = unsafePathSegment.ReplaceAllString(s, "-")
	s = strings.Trim(s, ".-")
	if len(s) > 120 {
		s = s[:120]
	}
	return s
}

func isGitDir(dir string) bool {
	if dir == "" {
		return false
	}
	if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
		return true
	}
	return runGit(context.Background(), dir, "rev-parse", "--is-inside-work-tree") == nil
}

func runGit(ctx context.Context, cwd string, args ...string) error {
	cmd := exec.CommandContext(ctx, "git", args...)
	if cwd != "" {
		cmd.Dir = cwd
	}
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
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

func (r *runner) sendErr(runID string, err error) {
	r.sendStatus(runID, "failed", "", "", err.Error())
	_ = r.send(&RunEventFrame{
		Type:   tRunEvent,
		RunID:  runID,
		Stream: "stderr",
		Data:   err.Error(),
	})
	exit := -1
	_ = r.send(&RunResultFrame{
		Type:       tRunResult,
		RunID:      runID,
		ExitCode:   &exit,
		Signal:     nil,
		TimedOut:   false,
		DurationMs: 0,
	})
	_ = r.send(&ErrorFrame{
		Type:    tError,
		Code:    "run_failed",
		Message: err.Error(),
	})
}

func (r *runner) sendStatus(runID, status, backendID, cwd, message string) {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_ = r.send(&RunStatusFrame{
		Type:           tRunStatus,
		RunID:          runID,
		Status:         status,
		BackendID:      backendID,
		Cwd:            cwd,
		Message:        message,
		StartedAt:      now,
		LastActivityAt: now,
	})
}

// buildEnv returns the parent process environment with overrides applied.
// Dangerous keys are dropped at validation time, but we also strip them here
// as defense in depth.
func buildEnv(cfg *Config, overrides map[string]string, runContext any) []string {
	base := envSnapshot()
	for k, v := range overrides {
		if isDangerousEnvKey(k) {
			continue
		}
		base[k] = v
	}
	if folder := groupFolderFromRunContext(runContext); folder != "" {
		root := filepath.Join(sessionDir(cfg), safeGroupFolder(folder))
		_ = os.MkdirAll(root, 0o700)
		base["OCTODECK_SESSION_DIR"] = root
		providerDirs := map[string]string{
			"CLAUDE_CONFIG_DIR":  filepath.Join(root, "claude"),
			"CODEX_HOME":         filepath.Join(root, "codex"),
			"TRAECLI_CONFIG_DIR": filepath.Join(root, "traecli"),
		}
		for key, dir := range providerDirs {
			_ = os.MkdirAll(dir, 0o700)
			base[key] = dir
		}
	}
	if runContext != nil {
		if data, err := json.Marshal(runContext); err == nil {
			base["OCTODECK_RUN_CONTEXT_JSON"] = string(data)
		}
		if repo := repoContextFromRunContext(runContext); repo != nil {
			if data, err := json.Marshal(repo); err == nil {
				base["OCTODECK_REPO_CONTEXT_JSON"] = string(data)
			}
		}
	}
	out := make([]string, 0, len(base))
	for k, v := range base {
		out = append(out, k+"="+v)
	}
	return out
}

func groupFolderFromRunContext(runContext any) string {
	if m, ok := runContext.(map[string]any); ok {
		return groupFolderFromParsedContext(m)
	}
	data, err := json.Marshal(runContext)
	if err != nil {
		return ""
	}
	var parsed map[string]any
	if err := json.Unmarshal(data, &parsed); err != nil {
		return ""
	}
	return groupFolderFromParsedContext(parsed)
}

func groupFolderFromParsedContext(parsed map[string]any) string {
	if group, ok := parsed["group"].(map[string]any); ok {
		if folder, ok := group["folder"].(string); ok {
			return folder
		}
	}
	return ""
}

func repoContextFromRunContext(runContext any) any {
	if m, ok := runContext.(map[string]any); ok {
		return m["repo"]
	}
	data, err := json.Marshal(runContext)
	if err != nil {
		return nil
	}
	var parsed map[string]any
	if err := json.Unmarshal(data, &parsed); err != nil {
		return nil
	}
	return parsed["repo"]
}
