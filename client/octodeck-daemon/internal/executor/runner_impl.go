// Package executor: runner_impl.go is the host-CLI runner that
// previously lived in internal/daemonrunner. Stage 5 collapsed
// daemonrunner into executor since the runner is purely an executor
// implementation detail (the rest of the daemon talks to executor via
// CommandExecutor, never to the runner directly).
package executor

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"

	daemonconfig "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/config"
	mcp "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/mcp"
	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
	security "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/security"
	state "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/state"
	workspace "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/workspace"
)

// hostRunner is the renamed daemonrunner.Runner. It owns the lifecycle
// of a single host-CLI run.request: validation, fork/exec, output
// streaming, run-pool bookkeeping. commandExecutor wraps it to satisfy
// CommandExecutor.
type hostRunner struct {
	cfg         *daemonconfig.Config
	pool        *state.RunPool
	send        func(any) error
	envSnapshot func() map[string]string
}

func newHostRunner(cfg *daemonconfig.Config, pool *state.RunPool, send func(any) error, envSnapshot func() map[string]string) *hostRunner {
	if envSnapshot == nil {
		envSnapshot = security.EnvSnapshot
	}
	return &hostRunner{cfg: cfg, pool: pool, send: send, envSnapshot: envSnapshot}
}

func (r *hostRunner) Handle(ctx context.Context, req *proto.RunRequestFrame) {
	if err := validateRunRequest(r.cfg, req); err != nil {
		r.sendErr(req.RunID, fmt.Errorf("validation: %w", err))
		return
	}
	if !r.pool.Reserve(req.RunID) {
		r.sendErr(req.RunID, errors.New("run pool full or duplicate runId"))
		return
	}
	r.pool.NoteAccepted(req.RunID, req.BackendID, req.Cwd)
	r.sendStatus(req.RunID, "accepted", req.BackendID, req.Cwd, "")

	go r.spawn(ctx, req)
}

func (r *hostRunner) spawn(parent context.Context, req *proto.RunRequestFrame) {
	defer r.pool.Release(req.RunID)
	timeout := time.Duration(req.TimeoutMs) * time.Millisecond
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	workspace.NormalizeRunRequestWorkspaceScopes(req)

	if len(req.WorkspaceRepos) > 0 || req.WorkspaceRepo != nil {
		repos := req.WorkspaceRepos
		if len(repos) == 0 && req.WorkspaceRepo != nil {
			repos = []*proto.WorkspaceRepoSpec{req.WorkspaceRepo}
		}
		cwd, err := workspace.ResolveRunCwd(ctx, r.cfg, repos)
		if err != nil {
			r.sendErr(req.RunID, fmt.Errorf("workspace repo: %w", err))
			return
		}
		req.Cwd = cwd
	} else {
		cwd, err := workspace.DefaultRunCwd(r.cfg, req.Cwd)
		if err != nil {
			r.sendErr(req.RunID, fmt.Errorf("default cwd: %w", err))
			return
		}
		req.Cwd = cwd
	}
	if req.RemoteCwdPlaceholder != "" {
		req.Argv = state.ReplaceArgvPlaceholder(req.Argv, req.RemoteCwdPlaceholder, req.Cwd)
		req.Context = state.ReplaceContextPlaceholder(req.Context, req.RemoteCwdPlaceholder, req.Cwd)
	}
	r.pool.NoteAccepted(req.RunID, req.BackendID, req.Cwd)
	if !isRunCwdAllowed(r.cfg, req.Cwd) {
		r.sendErr(req.RunID, fmt.Errorf("cwd outside allowed roots: %s", req.Cwd))
		return
	}
	argv, err := mcp.PrepareArgvForDaemon(r.cfg, req.Argv, req.Cwd, req.Env)
	if err != nil {
		r.sendErr(req.RunID, fmt.Errorf("agent team mcp config: %w", err))
		return
	}
	req.Argv = argv

	cmd := exec.CommandContext(ctx, req.Binary, req.Argv...)
	cmd.Dir = req.Cwd
	cmd.Env = r.buildEnv(req.Env, req.Context)
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
	r.pool.Attach(req.RunID, cmd, cancel)
	r.sendStatus(req.RunID, "started", req.BackendID, req.Cwd, "")

	var sentBytes atomic.Int64
	pump := func(stream string, src io.Reader) {
		reader := bufio.NewReader(src)
		buf := make([]byte, 8192)
		for {
			n, rerr := reader.Read(buf)
			if n > 0 {
				r.pool.NoteActivity(req.RunID)
				if sentBytes.Load() >= req.MaxOutputBytes {
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
				_ = r.send(&proto.RunEventFrame{Type: proto.TRunEvent, RunID: req.RunID, Stream: stream, Data: string(chunk)})
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
				if s, ok := getRunSignal(ws); ok {
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
	_ = r.send(&proto.RunResultFrame{Type: proto.TRunResult, RunID: req.RunID, ExitCode: &exit, Signal: signalStr, TimedOut: timedOut, DurationMs: durationMs})
}

func validateRunRequest(cfg *daemonconfig.Config, req *proto.RunRequestFrame) error {
	if !filepath.IsAbs(req.Binary) {
		return fmt.Errorf("binary must be absolute: %q", req.Binary)
	}
	if !isAllowedBinary(cfg, req.Binary) && !isDiscoveredAgentClientBinary(cfg, req.Binary) {
		return fmt.Errorf("binary not in allowedBinaries or discovered agent clients: %q", req.Binary)
	}
	if req.Cwd == "" {
		return errors.New("cwd is required")
	}
	if !filepath.IsAbs(req.Cwd) && !workspace.IsManagedURI(req.Cwd) {
		return fmt.Errorf("cwd must be absolute: %q", req.Cwd)
	}
	for _, a := range req.Argv {
		if strings.ContainsRune(a, 0) {
			return errors.New("argv contains NUL byte")
		}
	}
	for k := range req.Env {
		if security.IsDangerousKey(k) {
			return fmt.Errorf("env key not allowed: %q", k)
		}
	}
	if req.TimeoutMs <= 0 {
		return errors.New("timeoutMs must be positive")
	}
	if req.MaxOutputBytes <= 0 {
		return errors.New("maxOutputBytes must be positive")
	}
	switch req.OutputProtocol {
	case "jsonline-stream-json", "plain-text":
		return nil
	default:
		return fmt.Errorf("unknown outputProtocol: %q", req.OutputProtocol)
	}
}

func isRunCwdAllowed(cfg *daemonconfig.Config, cwd string) bool {
	if security.IsPathAllowedByRoots(cwd, cfg.AllowedRoots, cwd) {
		return true
	}
	managedRoots := []string{daemonconfig.WorkspaceDir(cfg), daemonconfig.SessionDir(cfg), daemonconfig.TaskDir(cfg), daemonconfig.TmpDir(cfg)}
	return security.IsPathAllowedByCleanRoots(cwd, managedRoots)
}

func (r *hostRunner) sendErr(runID string, err error) {
	r.sendStatus(runID, "failed", "", "", err.Error())
	_ = r.send(&proto.RunEventFrame{Type: proto.TRunEvent, RunID: runID, Stream: "stderr", Data: err.Error()})
	exit := -1
	_ = r.send(&proto.RunResultFrame{Type: proto.TRunResult, RunID: runID, ExitCode: &exit, TimedOut: false, DurationMs: 0})
	_ = r.send(&proto.ErrorFrame{Type: proto.TError, Code: "run_failed", Message: err.Error()})
}

func (r *hostRunner) sendStatus(runID, status, backendID, cwd, message string) {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_ = r.send(&proto.RunStatusFrame{Type: proto.TRunStatus, RunID: runID, Status: status, BackendID: backendID, Cwd: cwd, Message: message, StartedAt: now, LastActivityAt: now})
}

func (r *hostRunner) buildEnv(overrides map[string]string, runCtx any) []string {
	return security.BuildEnv(security.EnvConfig{SessionDir: daemonconfig.SessionDir(r.cfg)}, overrides, runCtx, r.envSnapshot(), workspace.SafeGroupFolder)
}

func isDiscoveredAgentClientBinary(cfg *daemonconfig.Config, bin string) bool {
	clean := filepath.Clean(bin)
	for _, c := range cfg.AgentClients {
		if filepath.Clean(c.Binary) == clean {
			return true
		}
	}
	return false
}

func isAllowedBinary(cfg *daemonconfig.Config, bin string) bool {
	clean := filepath.Clean(bin)
	for _, allowed := range cfg.AllowedBinaries {
		if filepath.Clean(allowed) == clean {
			return true
		}
	}
	return false
}
