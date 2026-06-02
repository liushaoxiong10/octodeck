package main

import (
	"bufio"
	"context"
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
		if req.RemoteCwdPlaceholder != "" {
			req.Argv = replaceArgvPlaceholder(req.Argv, req.RemoteCwdPlaceholder, cwd)
		}
	}
	argv, err := prepareAgentTeamMCPConfig(r.cfg, req.Argv, req.Cwd)
	if err != nil {
		r.sendErr(req.RunID, fmt.Errorf("agent team mcp config: %w", err))
		return
	}
	req.Argv = argv

	cmd := exec.CommandContext(ctx, req.Binary, req.Argv...)
	cmd.Dir = req.Cwd
	cmd.Env = buildEnv(req.Env, req.Context)
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

	var sentBytes atomic.Int64
	pump := func(stream string, src io.Reader) {
		reader := bufio.NewReader(src)
		buf := make([]byte, 8192)
		for {
			n, rerr := reader.Read(buf)
			if n > 0 {
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
		cacheDir := filepath.Join(workspaceDir(cfg), "repos", repoCacheName(spec.GitURL))
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
			_ = runGit(ctx, cacheDir, "fetch", "--all", "--prune")
		}
		worktreeDir := filepath.Join(workspaceDir(cfg), "worktrees", safeGroupFolder(spec.GroupFolder))
		if isGitDir(worktreeDir) {
			return worktreeDir, nil
		}
		_ = os.RemoveAll(worktreeDir)
		if err := os.MkdirAll(filepath.Dir(worktreeDir), 0o755); err != nil {
			return "", err
		}
		if err := runGit(ctx, cacheDir, "worktree", "add", worktreeDir, "HEAD"); err != nil {
			_ = os.RemoveAll(worktreeDir)
			return "", err
		}
		return worktreeDir, nil

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
			return devicePath, nil
		}
		worktreeDir := filepath.Join(workspaceDir(cfg), "worktrees", safeGroupFolder(spec.GroupFolder))
		if isGitDir(worktreeDir) {
			return worktreeDir, nil
		}
		_ = os.RemoveAll(worktreeDir)
		if err := os.MkdirAll(filepath.Dir(worktreeDir), 0o755); err != nil {
			return "", err
		}
		if err := runGit(ctx, devicePath, "worktree", "add", worktreeDir, "HEAD"); err != nil {
			_ = os.RemoveAll(worktreeDir)
			return "", err
		}
		return worktreeDir, nil
	default:
		return "", fmt.Errorf("unknown workspace repo kind: %q", spec.Kind)
	}
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

func prepareAgentTeamMCPConfig(cfg *Config, argv []string, cwd string) ([]string, error) {
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
		path, err := writeAgentTeamMCPConfig(cfg)
		if err != nil {
			return nil, err
		}
		out = replaceArgvPlaceholder(out, agentTeamMCPConfigPlaceholder, path)
	}
	if hasProjectConfigMarker {
		if err := writeAgentTeamMCPProjectConfig(cfg, cwd); err != nil {
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

func writeAgentTeamMCPConfig(cfg *Config) (string, error) {
	dir := filepath.Join(workspaceDir(cfg), "mcp")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	path := filepath.Join(dir, "agent-team-mcp.json")
	data, err := buildAgentTeamMCPConfigJSON(cfg)
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return "", err
	}
	return path, nil
}

func writeAgentTeamMCPProjectConfig(cfg *Config, cwd string) error {
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
	mcpServers["octodeck_agent_team"] = server
	payload["mcpServers"] = mcpServers
	data, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o600)
}

func buildAgentTeamMCPConfigJSON(cfg *Config) ([]byte, error) {
	server, err := buildAgentTeamMCPServerConfig(cfg)
	if err != nil {
		return nil, err
	}
	payload := map[string]any{
		"mcpServers": map[string]any{
			"octodeck_agent_team": server,
		},
	}
	return json.MarshalIndent(payload, "", "  ")
}

func buildAgentTeamMCPServerConfig(cfg *Config) (map[string]any, error) {
	if cfg == nil {
		return nil, errors.New("config is required")
	}
	if strings.TrimSpace(cfg.Server) == "" || strings.TrimSpace(cfg.Token) == "" {
		return nil, errors.New("server and token are required")
	}
	configPath, err := defaultConfigPath()
	if err != nil {
		return nil, err
	}
	command, err := os.Executable()
	if err != nil || command == "" {
		command = os.Args[0]
	}
	if !filepath.IsAbs(command) {
		if abs, absErr := filepath.Abs(command); absErr == nil {
			command = abs
		}
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
	home, err := os.UserHomeDir()
	if err != nil {
		return filepath.Join(os.TempDir(), "octodeck-daemon-workspace")
	}
	return filepath.Join(home, ".octodeck-daemon", "workspace")
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

func (r *runner) sendErr(runID string, err error) {
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

// buildEnv returns the parent process environment with overrides applied.
// Dangerous keys are dropped at validation time, but we also strip them here
// as defense in depth.
func buildEnv(overrides map[string]string, runContext any) []string {
	base := envSnapshot()
	for k, v := range overrides {
		if isDangerousEnvKey(k) {
			continue
		}
		base[k] = v
	}
	if runContext != nil {
		if data, err := json.Marshal(runContext); err == nil {
			base["OCTODECK_RUN_CONTEXT_JSON"] = string(data)
		}
	}
	out := make([]string, 0, len(base))
	for k, v := range base {
		out = append(out, k+"="+v)
	}
	return out
}
