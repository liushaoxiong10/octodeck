package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"sync/atomic"
	"time"
)

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
			base["HAPPYCLAW_RUN_CONTEXT_JSON"] = string(data)
		}
	}
	out := make([]string, 0, len(base))
	for k, v := range base {
		out = append(out, k+"="+v)
	}
	return out
}
