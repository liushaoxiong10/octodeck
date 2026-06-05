package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type agentRuntimeSupervisor struct {
	cfg         *Config
	pool        *runnerPool
	send        func(any) error
	mu          sync.Mutex
	cmd         *exec.Cmd
	stdin       io.WriteCloser
	seq         int64
	pending     map[int64]chan error
	startedAt   time.Time
	crashCount  int
	lastCrashAt time.Time
}

type runtimeRPCMessage struct {
	JSONRPC string           `json:"jsonrpc"`
	ID      *int64           `json:"id,omitempty"`
	Method  string           `json:"method,omitempty"`
	Params  json.RawMessage  `json:"params,omitempty"`
	Result  json.RawMessage  `json:"result,omitempty"`
	Error   *runtimeRPCError `json:"error,omitempty"`
}

type runtimeRPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func newAgentRuntimeSupervisor(cfg *Config, pool *runnerPool, send func(any) error) *agentRuntimeSupervisor {
	return &agentRuntimeSupervisor{cfg: cfg, pool: pool, send: send, pending: make(map[int64]chan error)}
}

func runtimeRestartBackoff(cfg *Config, crashCount int) time.Duration {
	base := cfg.RuntimePolicy.RestartBackoffMs
	if base <= 0 {
		base = 1000
	}
	if crashCount < 1 {
		crashCount = 1
	}
	mult := 1 << minInt(crashCount-1, 5)
	return time.Duration(base*int64(mult)) * time.Millisecond
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func buildRuntimeCapabilities(cfg *Config, pool *runnerPool) []RuntimeCapability {
	if cfg == nil {
		return nil
	}
	out := make([]RuntimeCapability, 0, len(cfg.AgentClients))
	maxRuns := 0
	available := 0
	if pool != nil {
		maxRuns = pool.maxConcurrentRuns()
		available = pool.availableSlots()
	}
	for _, client := range cfg.AgentClients {
		entry := findAgentRegistryEntry(cfg, client.ID)
		allowedWorkspaces := cfg.RuntimePolicy.AllowedWorkspaces
		allowedTools := cfg.RuntimePolicy.AllowedTools
		disallowedTools := cfg.RuntimePolicy.DisallowedTools
		toolPolicy := cfg.RuntimePolicy.ToolPolicy
		if entry != nil {
			if len(entry.AllowedWorkspaces) > 0 {
				allowedWorkspaces = entry.AllowedWorkspaces
			}
			if len(entry.AllowedTools) > 0 {
				allowedTools = entry.AllowedTools
			}
			if len(entry.DisallowedTools) > 0 {
				disallowedTools = entry.DisallowedTools
			}
			if len(entry.ToolPolicy) > 0 {
				toolPolicy = entry.ToolPolicy
			}
		}
		out = append(out, RuntimeCapability{
			RuntimeID:         cfg.LinkID + ":" + client.ID,
			AgentID:           client.ID,
			Provider:          ifEmpty(client.Provider, client.ID),
			Transport:         ifEmpty(client.Transport, "stdio"),
			Features:          append([]string(nil), client.Capabilities...),
			PermissionModes:   effectivePermissionModes(cfg, entry, client),
			AllowedWorkspaces: allowedWorkspaces,
			AllowedTools:      allowedTools,
			DisallowedTools:   disallowedTools,
			ToolPolicy:        toolPolicy,
			MaxConcurrentRuns: maxRuns,
			AvailableSlots:    available,
		})
	}
	return out
}

func (s *agentRuntimeSupervisor) handle(ctx context.Context, req *AgentRunRequestFrame) {
	if err := validateAgentRunRequest(s.cfg, req); err != nil {
		s.sendAgentRunErr(req.RunID, req.AgentID, fmt.Errorf("validation: %w", err))
		return
	}
	if !s.pool.reserve(req.RunID) {
		s.sendAgentRunErr(req.RunID, req.AgentID, errors.New("run pool full or duplicate runId"))
		return
	}
	s.pool.noteAccepted(req.RunID, req.AgentID, req.Cwd)
	_ = s.send(&AgentRunStatusFrame{Type: tAgentRunStatus, RunID: req.RunID, AgentID: req.AgentID, Status: "accepted", Cwd: req.Cwd})

	runCtx, cancel := context.WithTimeout(ctx, time.Duration(req.TimeoutMs)*time.Millisecond)
	s.pool.attach(req.RunID, nil, cancel)
	go func() {
		if err := s.ensureStarted(runCtx); err != nil {
			s.sendAgentRunErr(req.RunID, req.AgentID, fmt.Errorf("runtime start: %w", err))
			return
		}
		if err := s.call(runCtx, "agent.run", req); err != nil {
			s.sendAgentRunErr(req.RunID, req.AgentID, err)
		}
	}()
}

func (s *agentRuntimeSupervisor) cancelRun(runID, reason string) bool {
	found := s.pool.cancelRun(runID)
	_ = s.call(context.Background(), "agent.cancel", &AgentRunCancelFrame{Type: tAgentRunCancel, RunID: runID, Reason: reason})
	return found
}

func (s *agentRuntimeSupervisor) handleDiscover(ctx context.Context, req *AgentDiscoverRequestFrame) {
	go func() {
		if err := s.call(ctx, "agent.discover", req); err != nil {
			msg := err.Error()
			_ = s.send(&AgentDiscoverResultFrame{Type: tAgentDiscoverResult, RequestID: req.RequestID, OK: false, Agents: []AgentClientInfo{}, Error: &msg})
		}
	}()
}

func (s *agentRuntimeSupervisor) handleSessions(ctx context.Context, req *AgentSessionsRequestFrame) {
	go func() {
		if err := s.call(ctx, "agent.sessions.list", req); err != nil {
			msg := err.Error()
			_ = s.send(&AgentSessionsResultFrame{Type: tAgentSessionsResult, RequestID: req.RequestID, OK: false, Sessions: []AgentSessionInfo{}, Error: &msg})
		}
	}()
}

func (s *agentRuntimeSupervisor) handleSessionDelete(ctx context.Context, req *AgentSessionDeleteRequestFrame) {
	go func() {
		if err := s.call(ctx, "agent.sessions.delete", req); err != nil {
			msg := err.Error()
			_ = s.send(&AgentSessionDeleteResultFrame{Type: tAgentSessionDeleteResult, RequestID: req.RequestID, OK: false, Deleted: false, Error: &msg})
		}
	}()
}

func (s *agentRuntimeSupervisor) handlePermissionDecision(ctx context.Context, req *AgentPermissionDecisionFrame) {
	go func() { _ = s.call(ctx, "agent.permission.decision", req) }()
}

func (s *agentRuntimeSupervisor) ensureStarted(ctx context.Context) error {
	s.mu.Lock()
	if s.cmd != nil && s.stdin != nil && s.cmd.Process != nil {
		s.mu.Unlock()
		return nil
	}
	if max := s.cfg.RuntimePolicy.MaxRestarts; max > 0 && s.crashCount >= max {
		crashes := s.crashCount
		s.mu.Unlock()
		return fmt.Errorf("runtime restart budget exhausted after %d crashes", crashes)
	}
	if !s.lastCrashAt.IsZero() {
		backoff := runtimeRestartBackoff(s.cfg, s.crashCount)
		if wait := time.Until(s.lastCrashAt.Add(backoff)); wait > 0 {
			s.mu.Unlock()
			_ = s.send(&AgentRuntimeStatusFrame{Type: tAgentRuntimeStatus, RuntimeID: s.cfg.LinkID + ":agent-runtime", Status: "restarting", Message: fmt.Sprintf("restart backoff %s", wait.Round(time.Millisecond)), CrashCount: s.crashCount})
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(wait):
			}
			s.mu.Lock()
			if s.cmd != nil && s.stdin != nil && s.cmd.Process != nil {
				s.mu.Unlock()
				return nil
			}
		}
	}
	exe, err := os.Executable()
	if err != nil {
		s.mu.Unlock()
		return err
	}
	args := []string{"agent-runtime"}
	if s.cfg.Path != "" {
		args = append(args, "--config", s.cfg.Path)
	}
	cmd := exec.CommandContext(context.Background(), exe, args...)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		s.mu.Unlock()
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		s.mu.Unlock()
		return err
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		s.mu.Unlock()
		return err
	}
	s.cmd = cmd
	s.stdin = stdin
	s.startedAt = time.Now()
	startedAt := s.startedAt
	crashCount := s.crashCount
	s.mu.Unlock()
	_ = s.send(&AgentRuntimeStatusFrame{Type: tAgentRuntimeStatus, RuntimeID: s.cfg.LinkID + ":agent-runtime", Status: "running", StartedAt: formatTime(startedAt), CrashCount: crashCount})

	go s.readLoop(stdout)
	go func() {
		_ = cmd.Wait()
		s.mu.Lock()
		if s.cmd == cmd {
			s.cmd = nil
			s.stdin = nil
			s.crashCount++
			s.lastCrashAt = time.Now()
			crashCount = s.crashCount
			for id, ch := range s.pending {
				delete(s.pending, id)
				ch <- errors.New("runtime exited")
				close(ch)
			}
		}
		s.mu.Unlock()
		_ = s.send(&AgentRuntimeStatusFrame{Type: tAgentRuntimeStatus, RuntimeID: s.cfg.LinkID + ":agent-runtime", Status: "offline", Message: "runtime exited", CrashCount: crashCount})
	}()
	return nil
}

func (s *agentRuntimeSupervisor) call(ctx context.Context, method string, params any) error {
	if err := s.ensureStarted(ctx); err != nil {
		return err
	}
	id := atomic.AddInt64(&s.seq, 1)
	paramsJSON, err := json.Marshal(params)
	if err != nil {
		return err
	}
	msg := runtimeRPCMessage{JSONRPC: "2.0", ID: &id, Method: method, Params: paramsJSON}
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	ch := make(chan error, 1)
	s.mu.Lock()
	s.pending[id] = ch
	stdin := s.stdin
	_, err = stdin.Write(append(data, '\n'))
	if err != nil {
		delete(s.pending, id)
	}
	s.mu.Unlock()
	if err != nil {
		return err
	}
	select {
	case err := <-ch:
		return err
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(10 * time.Second):
		return errors.New("runtime rpc timeout")
	}
}

func (s *agentRuntimeSupervisor) readLoop(r io.Reader) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		var msg runtimeRPCMessage
		if err := json.Unmarshal(scanner.Bytes(), &msg); err != nil {
			continue
		}
		if msg.ID != nil && msg.Method == "" {
			s.mu.Lock()
			ch := s.pending[*msg.ID]
			delete(s.pending, *msg.ID)
			s.mu.Unlock()
			if ch != nil {
				if msg.Error != nil {
					ch <- errors.New(msg.Error.Message)
				} else {
					ch <- nil
				}
				close(ch)
			}
			continue
		}
		s.handleNotification(msg)
	}
}

func (s *agentRuntimeSupervisor) handleNotification(msg runtimeRPCMessage) {
	switch msg.Method {
	case "agent.run.status":
		var f AgentRunStatusFrame
		if json.Unmarshal(msg.Params, &f) == nil {
			_ = s.send(&f)
		}
	case "agent.run.event":
		var f AgentRunEventFrame
		if json.Unmarshal(msg.Params, &f) == nil {
			s.pool.noteActivity(f.RunID)
			_ = s.send(&f)
		}
	case "agent.run.result":
		var f AgentRunResultFrame
		if json.Unmarshal(msg.Params, &f) == nil {
			s.pool.cancelRun(f.RunID)
			s.pool.release(f.RunID)
			_ = s.send(&f)
		}
	case "agent.discover.result":
		var f AgentDiscoverResultFrame
		if json.Unmarshal(msg.Params, &f) == nil {
			s.cfg.AgentClients = f.Agents
			_ = s.send(&f)
		}
	case "agent.sessions.result":
		var f AgentSessionsResultFrame
		if json.Unmarshal(msg.Params, &f) == nil {
			_ = s.send(&f)
		}
	case "agent.session.delete.result":
		var f AgentSessionDeleteResultFrame
		if json.Unmarshal(msg.Params, &f) == nil {
			_ = s.send(&f)
		}
	case "agent.runtime.status":
		var f AgentRuntimeStatusFrame
		if json.Unmarshal(msg.Params, &f) == nil {
			_ = s.send(&f)
		}
	}
}

func (s *agentRuntimeSupervisor) sendAgentRunErr(runID, agentID string, err error) {
	msg := err.Error()
	s.pool.cancelRun(runID)
	s.pool.release(runID)
	_ = s.send(&AgentRunStatusFrame{Type: tAgentRunStatus, RunID: runID, AgentID: agentID, Status: "failed", Message: msg})
	_ = s.send(&AgentRunResultFrame{Type: tAgentRunResult, RunID: runID, AgentID: agentID, OK: false, Error: &msg, ErrorInfo: &AgentRunError{Code: "runtime_error", Message: msg, Retryable: true}, TimedOut: false, DurationMs: 0})
}

type agentRuntimeProcess struct {
	cfg       *Config
	encMu     sync.Mutex
	runsMu    sync.Mutex
	cancels   map[string]context.CancelFunc
	decisions map[string]chan AgentPermissionDecisionFrame
	adapters  map[string]agentAdapter
}

type agentAdapter interface {
	Discover(ctx context.Context) AgentClientInfo
	BuildRunCommand(cfg *Config, req *AgentRunRequestFrame) (argv []string, outputJSON bool, err error)
	ListSessions(ctx context.Context, cfg *Config, workspace string) ([]AgentSessionInfo, error)
	DeleteSession(ctx context.Context, cfg *Config, workspace, sessionID string) (bool, error)
}

type agentDirectRunner interface {
	RunDirect(ctx context.Context, cfg *Config, req *AgentRunRequestFrame, emit func(AgentRunEventFrame)) (AgentRunResultFrame, error)
}

func runAgentRuntimeCommand(args []string) error {
	fs := flag.NewFlagSet("agent-runtime", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	var configPath string
	fs.StringVar(&configPath, "config", "", "path to config.json")
	if err := fs.Parse(args); err != nil {
		return err
	}
	cfg, err := loadConfig(configPath)
	if err != nil {
		return err
	}
	cfg.AgentClients = discoverAgentClientsForConfig(cfg)
	rt := &agentRuntimeProcess{cfg: cfg, cancels: make(map[string]context.CancelFunc), decisions: make(map[string]chan AgentPermissionDecisionFrame), adapters: buildAgentAdapters(cfg)}
	return rt.serve(os.Stdin, os.Stdout)
}

func (rt *agentRuntimeProcess) serve(in io.Reader, out io.Writer) error {
	scanner := bufio.NewScanner(in)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		var msg runtimeRPCMessage
		if err := json.Unmarshal(scanner.Bytes(), &msg); err != nil {
			continue
		}
		switch msg.Method {
		case "agent.discover":
			var req AgentDiscoverRequestFrame
			if err := json.Unmarshal(msg.Params, &req); err != nil {
				rt.respond(out, msg.ID, nil, err)
				continue
			}
			rt.respond(out, msg.ID, map[string]bool{"accepted": true}, nil)
			go rt.discoverAgents(context.Background(), out, &req)
		case "agent.sessions.list":
			var req AgentSessionsRequestFrame
			if err := json.Unmarshal(msg.Params, &req); err != nil {
				rt.respond(out, msg.ID, nil, err)
				continue
			}
			rt.respond(out, msg.ID, map[string]bool{"accepted": true}, nil)
			go rt.listSessions(context.Background(), out, &req)
		case "agent.sessions.delete":
			var req AgentSessionDeleteRequestFrame
			if err := json.Unmarshal(msg.Params, &req); err != nil {
				rt.respond(out, msg.ID, nil, err)
				continue
			}
			rt.respond(out, msg.ID, map[string]bool{"accepted": true}, nil)
			go rt.deleteSession(context.Background(), out, &req)
		case "agent.run":
			var req AgentRunRequestFrame
			if err := json.Unmarshal(msg.Params, &req); err != nil {
				rt.respond(out, msg.ID, nil, err)
				continue
			}
			rt.respond(out, msg.ID, map[string]bool{"accepted": true}, nil)
			go rt.runAgent(context.Background(), out, &req)
		case "agent.cancel":
			var req AgentRunCancelFrame
			if err := json.Unmarshal(msg.Params, &req); err != nil {
				rt.respond(out, msg.ID, nil, err)
				continue
			}
			rt.runsMu.Lock()
			cancel := rt.cancels[req.RunID]
			rt.runsMu.Unlock()
			if cancel != nil {
				cancel()
			}
			rt.respond(out, msg.ID, map[string]bool{"cancelled": cancel != nil}, nil)
		case "agent.permission.decision":
			var req AgentPermissionDecisionFrame
			if err := json.Unmarshal(msg.Params, &req); err != nil {
				rt.respond(out, msg.ID, nil, err)
				continue
			}
			rt.runsMu.Lock()
			decisionCh := rt.decisions[req.RunID+":"+req.RequestID]
			rt.runsMu.Unlock()
			if decisionCh != nil {
				select {
				case decisionCh <- req:
				default:
				}
			}
			rt.respond(out, msg.ID, map[string]bool{"delivered": decisionCh != nil}, nil)
		default:
			rt.respond(out, msg.ID, nil, fmt.Errorf("unknown method: %s", msg.Method))
		}
	}
	return scanner.Err()
}

func (rt *agentRuntimeProcess) respond(out io.Writer, id *int64, result any, err error) {
	if id == nil {
		return
	}
	msg := runtimeRPCMessage{JSONRPC: "2.0", ID: id}
	if err != nil {
		msg.Error = &runtimeRPCError{Code: -32000, Message: err.Error()}
	} else {
		b, _ := json.Marshal(result)
		msg.Result = b
	}
	rt.write(out, msg)
}

func (rt *agentRuntimeProcess) notify(out io.Writer, method string, params any) {
	b, _ := json.Marshal(params)
	rt.write(out, runtimeRPCMessage{JSONRPC: "2.0", Method: method, Params: b})
}

func (rt *agentRuntimeProcess) write(out io.Writer, msg runtimeRPCMessage) {
	b, err := json.Marshal(msg)
	if err != nil {
		return
	}
	rt.encMu.Lock()
	defer rt.encMu.Unlock()
	_, _ = out.Write(append(b, '\n'))
}

func (rt *agentRuntimeProcess) discoverAgents(ctx context.Context, out io.Writer, req *AgentDiscoverRequestFrame) {
	started := time.Now()
	rt.cfg.AgentClients = discoverAgentClientsForConfig(rt.cfg)
	rt.adapters = buildAgentAdapters(rt.cfg)
	agents := make([]AgentClientInfo, 0, len(rt.adapters))
	for _, adapter := range rt.adapters {
		agents = append(agents, adapter.Discover(ctx))
	}
	rt.cfg.AgentClients = agents
	errPtr := (*string)(nil)
	rt.notify(out, "agent.discover.result", AgentDiscoverResultFrame{Type: tAgentDiscoverResult, RequestID: req.RequestID, OK: true, Agents: agents, RuntimeCapabilities: buildRuntimeCapabilities(rt.cfg, nil), Error: errPtr, DurationMs: time.Since(started).Milliseconds()})
}

func (rt *agentRuntimeProcess) listSessions(ctx context.Context, out io.Writer, req *AgentSessionsRequestFrame) {
	started := time.Now()
	var sessions []AgentSessionInfo
	var err error
	if req.AgentID != "" {
		adapter := rt.adapters[req.AgentID]
		if adapter == nil {
			err = fmt.Errorf("agent adapter not found: %s", req.AgentID)
		} else {
			sessions, err = adapter.ListSessions(ctx, rt.cfg, req.Workspace)
		}
	} else {
		for _, adapter := range rt.adapters {
			items, itemErr := adapter.ListSessions(ctx, rt.cfg, req.Workspace)
			if itemErr != nil && err == nil {
				err = itemErr
			}
			sessions = append(sessions, items...)
		}
	}
	if sessions == nil {
		sessions = []AgentSessionInfo{}
	}
	var errPtr *string
	if err != nil {
		msg := err.Error()
		errPtr = &msg
	}
	rt.notify(out, "agent.sessions.result", AgentSessionsResultFrame{Type: tAgentSessionsResult, RequestID: req.RequestID, OK: err == nil, Sessions: sessions, Error: errPtr, DurationMs: time.Since(started).Milliseconds()})
}

func (rt *agentRuntimeProcess) deleteSession(ctx context.Context, out io.Writer, req *AgentSessionDeleteRequestFrame) {
	started := time.Now()
	adapter := rt.adapters[req.AgentID]
	var deleted bool
	var err error
	if adapter == nil {
		err = fmt.Errorf("agent adapter not found: %s", req.AgentID)
	} else {
		deleted, err = adapter.DeleteSession(ctx, rt.cfg, req.Workspace, req.SessionID)
		if err == nil && req.Workspace != "" && req.SessionID != "" {
			if localDir, dirErr := cleanupWorkspaceScopeDir(rt.cfg, req.Workspace, "session", req.SessionID, "", ""); dirErr != nil {
				err = dirErr
			} else if removeErr := os.RemoveAll(localDir); removeErr != nil {
				err = removeErr
			} else {
				deleted = true
			}
		}
	}
	var errPtr *string
	if err != nil {
		msg := err.Error()
		errPtr = &msg
	}
	rt.notify(out, "agent.session.delete.result", AgentSessionDeleteResultFrame{Type: tAgentSessionDeleteResult, RequestID: req.RequestID, OK: err == nil, Deleted: deleted, Error: errPtr, DurationMs: time.Since(started).Milliseconds()})
}

func (rt *agentRuntimeProcess) awaitPermissionDecision(ctx context.Context, runID, requestID string, timeout time.Duration) (AgentPermissionDecisionFrame, error) {
	key := runID + ":" + requestID
	ch := make(chan AgentPermissionDecisionFrame, 1)
	rt.runsMu.Lock()
	rt.decisions[key] = ch
	rt.runsMu.Unlock()
	defer func() {
		rt.runsMu.Lock()
		delete(rt.decisions, key)
		rt.runsMu.Unlock()
	}()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case decision := <-ch:
		return decision, nil
	case <-timer.C:
		return AgentPermissionDecisionFrame{}, errors.New("permission decision timeout")
	case <-ctx.Done():
		return AgentPermissionDecisionFrame{}, ctx.Err()
	}
}

func permissionRequestID(payload map[string]any) string {
	for _, key := range []string{"requestId", "request_id", "id", "permissionRequestId"} {
		if v, ok := payload[key].(string); ok && v != "" {
			return v
		}
	}
	return ""
}

func permissionDecisionTimeout(cfg *Config) time.Duration {
	if cfg != nil && cfg.RuntimePolicy.PermissionTimeoutMs > 0 {
		return time.Duration(cfg.RuntimePolicy.PermissionTimeoutMs) * time.Millisecond
	}
	return 30 * time.Minute
}

func (rt *agentRuntimeProcess) runAgent(parent context.Context, out io.Writer, req *AgentRunRequestFrame) {
	started := time.Now()
	ctx, cancel := context.WithTimeout(parent, time.Duration(req.TimeoutMs)*time.Millisecond)
	rt.runsMu.Lock()
	rt.cancels[req.RunID] = cancel
	rt.runsMu.Unlock()
	defer func() {
		cancel()
		rt.runsMu.Lock()
		delete(rt.cancels, req.RunID)
		rt.runsMu.Unlock()
	}()

	cwd, err := rt.resolveCwd(ctx, req)
	if err != nil {
		rt.finishErr(out, req, started, err, errors.Is(ctx.Err(), context.DeadlineExceeded))
		return
	}
	rt.notify(out, "agent.run.status", AgentRunStatusFrame{Type: tAgentRunStatus, RunID: req.RunID, AgentID: req.AgentID, Status: "started", Cwd: cwd, StartedAt: formatTime(started)})

	client := findAgentClient(rt.cfg, req.AgentID)
	if client == nil {
		rt.finishErr(out, req, started, fmt.Errorf("agent client not found: %s", req.AgentID), false)
		return
	}
	adapter := rt.adapters[req.AgentID]
	if adapter == nil {
		rt.finishErr(out, req, started, fmt.Errorf("agent adapter not found: %s", req.AgentID), false)
		return
	}
	if err := prepareAgentRuntimeMCPConfig(rt.cfg, req, cwd); err != nil {
		rt.finishErr(out, req, started, fmt.Errorf("agent runtime mcp config: %w", err), false)
		return
	}
	if direct, ok := adapter.(agentDirectRunner); ok {
		result, err := direct.RunDirect(ctx, rt.cfg, req, func(frame AgentRunEventFrame) { rt.notify(out, "agent.run.event", frame) })
		if err != nil {
			rt.finishErr(out, req, started, err, errors.Is(ctx.Err(), context.DeadlineExceeded))
			return
		}
		result.Type = tAgentRunResult
		result.RunID = req.RunID
		result.AgentID = req.AgentID
		if result.DurationMs == 0 {
			result.DurationMs = time.Since(started).Milliseconds()
		}
		if result.Error == nil && result.ErrorInfo != nil {
			msg := result.ErrorInfo.Message
			result.Error = &msg
		}
		status := "completed"
		if !result.OK {
			status = "failed"
		}
		rt.notify(out, "agent.run.status", AgentRunStatusFrame{Type: tAgentRunStatus, RunID: req.RunID, AgentID: req.AgentID, Status: status, Cwd: cwd})
		if result.SessionID != "" {
			_ = writeSessionMetadata(rt.cfg, req, result.SessionID, result.Result)
		}
		rt.notify(out, "agent.run.result", result)
		return
	}
	argv, outputJSON, err := adapter.BuildRunCommand(rt.cfg, req)
	if err != nil {
		rt.finishErr(out, req, started, err, false)
		return
	}
	cmd := exec.CommandContext(ctx, client.Binary, argv...)
	cmd.Dir = cwd
	cmd.Env = buildAgentEnv(rt.cfg, req.AgentID, req.Env, req.Context)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		rt.finishErr(out, req, started, err, false)
		return
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		rt.finishErr(out, req, started, err, false)
		return
	}
	if err := cmd.Start(); err != nil {
		rt.finishErr(out, req, started, err, false)
		return
	}

	var sent atomic.Int64
	var textMu sync.Mutex
	var finalText string
	var sessionID string
	pumpStdoutDone := make(chan struct{})
	pumpStderrDone := make(chan struct{})
	go func() {
		defer close(pumpStdoutDone)
		pumpAgentStdout(ctx, stdout, req, outputJSON, &sent, func(frame AgentRunEventFrame) {
			if frame.EventType == "text_delta" && frame.Text != "" {
				textMu.Lock()
				finalText += frame.Text
				textMu.Unlock()
			}
			if frame.SessionID != "" {
				sessionID = frame.SessionID
			}
			if frame.EventType == "permission_request" {
				requestID := permissionRequestID(frame.Payload)
				if requestID == "" {
					requestID = fmt.Sprintf("%s-%d", req.RunID, time.Now().UnixNano())
					if frame.Payload == nil {
						frame.Payload = map[string]any{}
					}
					frame.Payload["requestId"] = requestID
				}
				rt.notify(out, "agent.run.event", frame)
				decision, decisionErr := rt.awaitPermissionDecision(ctx, req.RunID, requestID, permissionDecisionTimeout(rt.cfg))
				if decisionErr != nil || decision.Decision == "reject" {
					cancel()
				}
				return
			}
			rt.notify(out, "agent.run.event", frame)
		})
	}()
	go func() {
		defer close(pumpStderrDone)
		pumpAgentLog(stderr, req, &sent, func(frame AgentRunEventFrame) { rt.notify(out, "agent.run.event", frame) })
	}()
	waitErr := cmd.Wait()
	<-pumpStdoutDone
	<-pumpStderrDone
	timedOut := errors.Is(ctx.Err(), context.DeadlineExceeded)
	if waitErr != nil && finalText == "" {
		rt.finishErr(out, req, started, waitErr, timedOut)
		return
	}
	rt.notify(out, "agent.run.status", AgentRunStatusFrame{Type: tAgentRunStatus, RunID: req.RunID, AgentID: req.AgentID, Status: "completed", Cwd: cwd})
	if sessionID != "" {
		_ = writeSessionMetadata(rt.cfg, req, sessionID, finalText)
	}
	errPtr := (*string)(nil)
	rt.notify(out, "agent.run.result", AgentRunResultFrame{Type: tAgentRunResult, RunID: req.RunID, AgentID: req.AgentID, OK: true, Result: finalText, Error: errPtr, SessionID: sessionID, TimedOut: timedOut, DurationMs: time.Since(started).Milliseconds()})
}

func (rt *agentRuntimeProcess) resolveCwd(ctx context.Context, req *AgentRunRequestFrame) (string, error) {
	// Normalize to a unified list of repos: prefer Workspace.Repos, fall back to
	// Workspace.Repo (single), then to the legacy WorkspaceRepo.
	var repos []*WorkspaceRepoSpec
	if req.Workspace != nil && len(req.Workspace.Repos) > 0 {
		repos = req.Workspace.Repos
	} else if req.Workspace != nil && req.Workspace.Repo != nil {
		repos = []*WorkspaceRepoSpec{req.Workspace.Repo}
	} else if req.WorkspaceRepo != nil {
		repos = []*WorkspaceRepoSpec{req.WorkspaceRepo}
	}

	if len(repos) > 0 {
		// First, resolve the workspace/session/task root (this handles
		// octodeck-workspace:// URI or custom CWD folder fallback, or the
		// scope-aware workspace directory).
		wsRoot, err := rt.resolveWorkspaceRoot(req)
		if err != nil {
			return "", err
		}
		// Repos are materialized as direct children of the workspace/session/task
		// root. Keep cwd fixed at the root for both single-repo and multi-repo
		// runs so paths remain stable when a workspace gains more repos later.
		for _, spec := range repos {
			if _, err := mountWorkspaceRepoAt(ctx, rt.cfg, wsRoot, spec); err != nil {
				return "", err
			}
		}
		req.Cwd = wsRoot
	} else {
		requested := req.Cwd
		if req.Workspace != nil && (req.Workspace.AgentID != "" || req.Workspace.AgentRoot != "" || req.Workspace.Scope != "" || req.Workspace.ScopeID != "") {
			cwd, err := resolveAgentWorkspaceCwd(rt.cfg, req.Workspace)
			if err != nil {
				return "", err
			}
			req.Cwd = cwd
		} else if req.Workspace != nil && req.Workspace.Cwd != "" {
			requested = req.Workspace.Cwd
		} else if req.Workspace != nil && req.Workspace.Folder != "" {
			requested = deviceWorkspaceURIPrefix + req.Workspace.Folder
		}
		if req.Cwd == "" {
			cwd, err := defaultRunCwd(rt.cfg, requested)
			if err != nil {
				return "", err
			}
			req.Cwd = cwd
		}
	}
	if req.RemoteCwdPlaceholder != "" {
		req.Context = replaceContextPlaceholder(req.Context, req.RemoteCwdPlaceholder, req.Cwd)
	}
	req.Context = enrichRunContextWorkspacePaths(rt.cfg, req.Context, req.Workspace, req.Cwd)
	if !isRunCwdAllowed(rt.cfg, req.Cwd) {
		return "", fmt.Errorf("cwd outside allowed roots: %s", req.Cwd)
	}
	if !isWorkspaceAllowedByRuntimePolicy(rt.cfg, req.AgentID, req.Cwd) {
		return "", fmt.Errorf("cwd outside runtime allowedWorkspaces: %s", req.Cwd)
	}
	return req.Cwd, nil
}

func (rt *agentRuntimeProcess) finishErr(out io.Writer, req *AgentRunRequestFrame, started time.Time, err error, timedOut bool) {
	msg := err.Error()
	rt.notify(out, "agent.run.status", AgentRunStatusFrame{Type: tAgentRunStatus, RunID: req.RunID, AgentID: req.AgentID, Status: "failed", Message: msg})
	rt.notify(out, "agent.run.result", AgentRunResultFrame{Type: tAgentRunResult, RunID: req.RunID, AgentID: req.AgentID, OK: false, Error: &msg, ErrorInfo: &AgentRunError{Code: agentRunErrorCode(err, timedOut), Message: msg, Retryable: timedOut}, TimedOut: timedOut, DurationMs: time.Since(started).Milliseconds()})
}

func agentRunErrorCode(err error, timedOut bool) string {
	if timedOut {
		return "timeout"
	}
	msg := err.Error()
	if strings.Contains(msg, "outside allowed") || strings.Contains(msg, "not allowed") {
		return "policy_denied"
	}
	return "run_failed"
}

func findAgentClient(cfg *Config, agentID string) *AgentClientInfo {
	for i := range cfg.AgentClients {
		if cfg.AgentClients[i].ID == agentID {
			return &cfg.AgentClients[i]
		}
	}
	return nil
}

func findAgentRegistryEntry(cfg *Config, agentID string) *AgentRegistryEntry {
	if cfg == nil {
		return nil
	}
	for i := range cfg.AgentRegistry {
		if cfg.AgentRegistry[i].ID == agentID {
			return &cfg.AgentRegistry[i]
		}
	}
	return nil
}

func effectivePermissionModes(cfg *Config, entry *AgentRegistryEntry, client AgentClientInfo) []string {
	if entry != nil && len(entry.PermissionModes) > 0 {
		return append([]string(nil), entry.PermissionModes...)
	}
	if cfg != nil && len(cfg.RuntimePolicy.PermissionModes) > 0 {
		return append([]string(nil), cfg.RuntimePolicy.PermissionModes...)
	}
	return append([]string(nil), client.PermissionModes...)
}

func buildAgentEnv(cfg *Config, agentID string, overrides map[string]string, runContext any) []string {
	merged := make(map[string]string)
	if entry := findAgentRegistryEntry(cfg, agentID); entry != nil {
		for k, v := range entry.Env {
			if !isDangerousEnvKey(k) {
				merged[k] = v
			}
		}
	}
	for k, v := range overrides {
		merged[k] = v
	}
	return buildEnv(cfg, merged, runContext)
}

func buildAgentAdapters(cfg *Config) map[string]agentAdapter {
	out := make(map[string]agentAdapter)
	for _, client := range cfg.AgentClients {
		if client.Transport == "acp" {
			out[client.ID] = &acpAdapter{baseAgentAdapter: baseAgentAdapter{client: client}, entry: findAgentRegistryEntry(cfg, client.ID)}
			continue
		}
		if client.Transport == "a2a" {
			out[client.ID] = &customA2AAdapter{baseAgentAdapter: baseAgentAdapter{client: client}, entry: findAgentRegistryEntry(cfg, client.ID)}
			continue
		}
		if entry := findAgentRegistryEntry(cfg, client.ID); entry != nil {
			transport := entry.Transport
			if transport == "" {
				transport = "stdio"
			}
			if transport == "a2a" {
				out[client.ID] = &customA2AAdapter{baseAgentAdapter: baseAgentAdapter{client: client}, entry: entry}
			} else if transport == "acp" {
				out[client.ID] = &acpAdapter{baseAgentAdapter: baseAgentAdapter{client: client}, entry: entry}
			} else if transport == "http" {
				out[client.ID] = &customHTTPAdapter{baseAgentAdapter: baseAgentAdapter{client: client}, entry: *entry}
			} else {
				out[client.ID] = &customStdioAdapter{baseAgentAdapter: baseAgentAdapter{client: client}, entry: *entry}
			}
			continue
		}
		switch client.ID {
		case "claude-code":
			out[client.ID] = &claudeCodeAdapter{baseAgentAdapter{client: client}}
		case "codex":
			out[client.ID] = &codexAdapter{baseAgentAdapter{client: client}}
		case "traecli":
			out[client.ID] = &traecliAdapter{baseAgentAdapter{client: client}}
		default:
			out[client.ID] = &plainCLIAdapter{baseAgentAdapter{client: client}}
		}
	}
	return out
}

type baseAgentAdapter struct {
	client AgentClientInfo
}

func (a *baseAgentAdapter) Discover(context.Context) AgentClientInfo { return a.client }

func (a *baseAgentAdapter) providerDirName() string {
	switch a.client.ID {
	case "claude-code":
		return "claude"
	case "claude-acp":
		return "claude-acp"
	case "codex":
		return "codex"
	case "codex-acp":
		return "codex-acp"
	case "traecli":
		return "traecli"
	case "traecli-acp":
		return "traecli-acp"
	default:
		return safePathSegment(a.client.ID)
	}
}

func (a *baseAgentAdapter) ListSessions(ctx context.Context, cfg *Config, workspace string) ([]AgentSessionInfo, error) {
	return listProviderSessions(ctx, cfg, a.client.ID, a.providerDirName(), workspace)
}

func (a *baseAgentAdapter) DeleteSession(ctx context.Context, cfg *Config, workspace, sessionID string) (bool, error) {
	deleted, err := deleteProviderSession(ctx, cfg, a.providerDirName(), workspace, sessionID)
	if err != nil || deleted || a.providerDirName() == a.client.ID {
		return deleted, err
	}
	return deleteProviderSession(ctx, cfg, safePathSegment(a.client.ID), workspace, sessionID)
}

type claudeCodeAdapter struct{ baseAgentAdapter }
type codexAdapter struct{ baseAgentAdapter }
type traecliAdapter struct{ baseAgentAdapter }
type plainCLIAdapter struct{ baseAgentAdapter }
type acpAdapter struct {
	baseAgentAdapter
	entry *AgentRegistryEntry
}
type customStdioAdapter struct {
	baseAgentAdapter
	entry AgentRegistryEntry
}
type customA2AAdapter struct {
	baseAgentAdapter
	entry *AgentRegistryEntry
}
type customHTTPAdapter struct {
	baseAgentAdapter
	entry AgentRegistryEntry
}

func (a *claudeCodeAdapter) BuildRunCommand(cfg *Config, req *AgentRunRequestFrame) ([]string, bool, error) {
	argv := []string{"-p", req.Input.Prompt, "--output-format", "stream-json", "--verbose"}
	if req.Input.SessionID != "" {
		argv = append(argv, "--resume", req.Input.SessionID)
	}
	if req.Policy.PermissionMode != "" {
		argv = append(argv, "--permission-mode", req.Policy.PermissionMode)
	}
	if req.Policy.Model != "" {
		argv = append(argv, "--model", req.Policy.Model)
	}
	if req.Policy.SystemPrompt != "" {
		argv = append(argv, "--append-system-prompt", req.Policy.SystemPrompt)
	}
	if len(req.Policy.AllowedTools) > 0 {
		argv = append(argv, "--allowedTools", strings.Join(req.Policy.AllowedTools, ","))
	}
	if len(req.Policy.DisallowedTools) > 0 {
		argv = append(argv, "--disallowedTools", strings.Join(req.Policy.DisallowedTools, ","))
	}
	mcpConfig, err := writeAgentTeamMCPConfig(cfg, req.Env)
	if err != nil {
		return nil, false, err
	}
	argv = append(argv, "--mcp-config", mcpConfig)
	return argv, true, nil
}

func (a *codexAdapter) BuildRunCommand(_ *Config, req *AgentRunRequestFrame) ([]string, bool, error) {
	argv := []string{"exec", "--json"}
	if req.Policy.Model != "" {
		argv = append(argv, "-m", req.Policy.Model)
	}
	if req.Policy.PermissionMode != "" {
		argv = append(argv, "--sandbox", req.Policy.PermissionMode)
	}
	argv = append(argv, req.Input.Prompt)
	return argv, true, nil
}

func (a *traecliAdapter) BuildRunCommand(_ *Config, req *AgentRunRequestFrame) ([]string, bool, error) {
	return []string{"-p", req.Input.Prompt}, false, nil
}

func (a *acpAdapter) BuildRunCommand(_ *Config, req *AgentRunRequestFrame) ([]string, bool, error) {
	return nil, false, fmt.Errorf("acp agent adapter %s runs via protocol transport", a.client.ID)
}

func (a *acpAdapter) RunDirect(ctx context.Context, cfg *Config, req *AgentRunRequestFrame, emit func(AgentRunEventFrame)) (AgentRunResultFrame, error) {
	return a.runACPAgent(ctx, cfg, req, emit)
}

func prepareAgentRuntimeMCPConfig(cfg *Config, req *AgentRunRequestFrame, cwd string) error {
	switch req.AgentID {
	case "claude-code":
		_, err := writeAgentTeamMCPConfig(cfg, req.Env)
		return err
	case "codex":
		return writeCodexMCPConfig(cfg, req, cwd)
	case "traecli":
		return writeAgentTeamMCPProjectConfig(cfg, cwd, req.Env)
	default:
		return nil
	}
}

func (a *plainCLIAdapter) BuildRunCommand(_ *Config, req *AgentRunRequestFrame) ([]string, bool, error) {
	return []string{req.Input.Prompt}, false, nil
}

func (a *customStdioAdapter) BuildRunCommand(_ *Config, req *AgentRunRequestFrame) ([]string, bool, error) {
	args := append([]string(nil), a.entry.Args...)
	if len(args) == 0 {
		args = []string{"{{prompt}}"}
	}
	replacer := strings.NewReplacer(
		"{{prompt}}", req.Input.Prompt,
		"{{sessionId}}", req.Input.SessionID,
		"{{cwd}}", req.Cwd,
		"{{model}}", req.Policy.Model,
	)
	for i := range args {
		args[i] = replacer.Replace(args[i])
	}
	return args, containsString(a.client.Capabilities, "stream-json"), nil
}

func (a *customA2AAdapter) BuildRunCommand(_ *Config, req *AgentRunRequestFrame) ([]string, bool, error) {
	return nil, false, fmt.Errorf("a2a agent adapter %s runs via protocol transport", a.client.ID)
}

func (a *customA2AAdapter) RunDirect(ctx context.Context, cfg *Config, req *AgentRunRequestFrame, emit func(AgentRunEventFrame)) (AgentRunResultFrame, error) {
	started := time.Now()
	args := []string{}
	if a.entry != nil {
		args = append(args, a.entry.Args...)
	}
	cmd := exec.CommandContext(ctx, a.client.Binary, args...)
	cmd.Dir = req.Cwd
	cmd.Env = buildAgentEnv(cfg, req.AgentID, req.Env, req.Context)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return AgentRunResultFrame{}, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return AgentRunResultFrame{}, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return AgentRunResultFrame{}, err
	}
	if err := cmd.Start(); err != nil {
		return AgentRunResultFrame{}, err
	}

	var sent atomic.Int64
	var logDone = make(chan struct{})
	go func() {
		defer close(logDone)
		pumpAgentLog(stderr, req, &sent, emit)
	}()

	params := map[string]any{
		"runId":     req.RunID,
		"agentId":   req.AgentID,
		"workspace": req.Workspace,
		"input":     req.Input,
		"policy":    req.Policy,
		"context":   req.Context,
		"cwd":       req.Cwd,
	}
	if server, err := buildAgentTeamMCPServerConfig(cfg); err == nil {
		params["mcpServers"] = map[string]any{"octodeck_agent_team": server}
	}
	paramsJSON, _ := json.Marshal(params)
	id := int64(1)
	call := runtimeRPCMessage{JSONRPC: "2.0", ID: &id, Method: "agent.run", Params: paramsJSON}
	callJSON, err := json.Marshal(call)
	if err != nil {
		_ = stdin.Close()
		return AgentRunResultFrame{}, err
	}
	if _, err := stdin.Write(append(callJSON, '\n')); err != nil {
		_ = stdin.Close()
		return AgentRunResultFrame{}, err
	}
	_ = stdin.Close()

	result, readErr := readA2AAgentResult(ctx, stdout, req, &sent, emit)
	waitErr := cmd.Wait()
	<-logDone
	if readErr != nil {
		return AgentRunResultFrame{}, readErr
	}
	if waitErr != nil && result.Result == "" && result.Error == nil && result.ErrorInfo == nil {
		return AgentRunResultFrame{}, waitErr
	}
	if result.Error == nil && result.ErrorInfo != nil {
		msg := result.ErrorInfo.Message
		result.Error = &msg
	}
	result.TimedOut = errors.Is(ctx.Err(), context.DeadlineExceeded)
	if result.DurationMs == 0 {
		result.DurationMs = time.Since(started).Milliseconds()
	}
	if result.RunID == "" {
		result.RunID = req.RunID
	}
	if result.AgentID == "" {
		result.AgentID = req.AgentID
	}
	return result, nil
}

func readA2AAgentResult(ctx context.Context, r io.Reader, req *AgentRunRequestFrame, sent *atomic.Int64, emit func(AgentRunEventFrame)) (AgentRunResultFrame, error) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	var final AgentRunResultFrame
	var text strings.Builder
	for scanner.Scan() {
		if ctx.Err() != nil {
			break
		}
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var msg runtimeRPCMessage
		if err := json.Unmarshal([]byte(line), &msg); err != nil {
			if allowAgentBytes(sent, int64(len(line)), req.MaxOutputBytes) {
				chunk := line + "\n"
				text.WriteString(chunk)
				emit(AgentRunEventFrame{Type: tAgentRunEvent, RunID: req.RunID, AgentID: req.AgentID, EventType: "text_delta", Text: chunk, At: formatTime(time.Now())})
			}
			continue
		}
		if msg.Method != "" {
			switch msg.Method {
			case "agent.run.event":
				var event AgentRunEventFrame
				if json.Unmarshal(msg.Params, &event) == nil {
					if event.Type == "" {
						event.Type = tAgentRunEvent
					}
					if event.RunID == "" {
						event.RunID = req.RunID
					}
					if event.AgentID == "" {
						event.AgentID = req.AgentID
					}
					if event.At == "" {
						event.At = formatTime(time.Now())
					}
					if event.Text != "" && allowAgentBytes(sent, int64(len(event.Text)), req.MaxOutputBytes) {
						text.WriteString(event.Text)
					}
					emit(event)
				}
			case "agent.run.result":
				_ = json.Unmarshal(msg.Params, &final)
			}
			continue
		}
		if msg.ID != nil {
			if msg.Error != nil {
				m := msg.Error.Message
				return AgentRunResultFrame{OK: false, Error: &m, ErrorInfo: &AgentRunError{Code: "a2a_error", Message: m}}, nil
			}
			var direct AgentRunResultFrame
			if len(msg.Result) > 0 && json.Unmarshal(msg.Result, &direct) == nil && (direct.Result != "" || direct.Error != nil || direct.ErrorInfo != nil || direct.SessionID != "") {
				final = direct
				continue
			}
			var wrapped customHTTPRunResponse
			if len(msg.Result) > 0 && json.Unmarshal(msg.Result, &wrapped) == nil {
				for _, event := range wrapped.Events {
					if event.Type == "" {
						event.Type = tAgentRunEvent
					}
					if event.RunID == "" {
						event.RunID = req.RunID
					}
					if event.AgentID == "" {
						event.AgentID = req.AgentID
					}
					emit(event)
				}
				final = AgentRunResultFrame{OK: wrapped.OK, Result: wrapped.Result, Error: wrapped.Error, ErrorInfo: wrapped.ErrorInfo, SessionID: wrapped.SessionID, Usage: wrapped.Usage}
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return final, err
	}
	if final.Result == "" && text.Len() > 0 {
		final.Result = text.String()
	}
	if final.Error == nil && final.ErrorInfo != nil {
		msg := final.ErrorInfo.Message
		final.Error = &msg
	}
	if final.Error == nil && !final.OK {
		if final.Result != "" {
			final.OK = true
		}
	}
	return final, nil
}

func (a *customHTTPAdapter) BuildRunCommand(_ *Config, req *AgentRunRequestFrame) ([]string, bool, error) {
	return nil, false, fmt.Errorf("http agent adapter %s runs via direct transport", a.entry.ID)
}

type customHTTPRunResponse struct {
	OK        bool                 `json:"ok"`
	Result    string               `json:"result,omitempty"`
	Error     *string              `json:"error"`
	ErrorInfo *AgentRunError       `json:"errorInfo,omitempty"`
	SessionID string               `json:"sessionId,omitempty"`
	Usage     map[string]any       `json:"usage,omitempty"`
	Events    []AgentRunEventFrame `json:"events,omitempty"`
}

func (a *customHTTPAdapter) RunDirect(ctx context.Context, _ *Config, req *AgentRunRequestFrame, emit func(AgentRunEventFrame)) (AgentRunResultFrame, error) {
	started := time.Now()
	payload := map[string]any{
		"runId":     req.RunID,
		"agentId":   req.AgentID,
		"workspace": req.Workspace,
		"input":     req.Input,
		"policy":    req.Policy,
		"context":   req.Context,
		"cwd":       req.Cwd,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return AgentRunResultFrame{}, err
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, a.entry.URL, bytes.NewReader(body))
	if err != nil {
		return AgentRunResultFrame{}, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	client := &http.Client{}
	resp, err := client.Do(httpReq)
	if err != nil {
		return AgentRunResultFrame{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return AgentRunResultFrame{}, fmt.Errorf("http agent %s returned %s: %s", a.entry.ID, resp.Status, strings.TrimSpace(string(data)))
	}
	var parsed customHTTPRunResponse
	if err := json.NewDecoder(io.LimitReader(resp.Body, 16*1024*1024)).Decode(&parsed); err != nil {
		return AgentRunResultFrame{}, err
	}
	for _, event := range parsed.Events {
		if event.RunID == "" {
			event.RunID = req.RunID
		}
		if event.AgentID == "" {
			event.AgentID = req.AgentID
		}
		if event.Type == "" {
			event.Type = tAgentRunEvent
		}
		if event.At == "" {
			event.At = formatTime(time.Now())
		}
		emit(event)
	}
	if !parsed.OK && parsed.Error == nil && parsed.ErrorInfo == nil {
		msg := "http agent reported failure"
		parsed.Error = &msg
	}
	return AgentRunResultFrame{OK: parsed.OK, Result: parsed.Result, Error: parsed.Error, ErrorInfo: parsed.ErrorInfo, SessionID: parsed.SessionID, Usage: parsed.Usage, TimedOut: errors.Is(ctx.Err(), context.DeadlineExceeded), DurationMs: time.Since(started).Milliseconds()}, nil
}

type acpClient struct {
	enc     *json.Encoder
	mu      sync.Mutex
	nextID  int64
	pending map[int64]chan runtimeRPCMessage
	closed  chan struct{}
	onEvent func(runtimeRPCMessage)
}

func (a *acpAdapter) runACPAgent(ctx context.Context, cfg *Config, req *AgentRunRequestFrame, emit func(AgentRunEventFrame)) (AgentRunResultFrame, error) {
	started := time.Now()
	args := append([]string(nil), a.client.Args...)
	env := req.Env
	if a.entry != nil {
		if len(a.entry.Args) > 0 {
			args = append([]string(nil), a.entry.Args...)
		}
		env = mergeStringMaps(a.entry.Env, req.Env)
	}
	cmd := exec.CommandContext(ctx, a.client.Binary, args...)
	cmd.Dir = req.Cwd
	cmd.Env = buildAgentEnv(cfg, req.AgentID, env, req.Context)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return AgentRunResultFrame{}, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return AgentRunResultFrame{}, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return AgentRunResultFrame{}, err
	}
	client := &acpClient{enc: json.NewEncoder(stdin), pending: map[int64]chan runtimeRPCMessage{}, closed: make(chan struct{})}
	var sent atomic.Int64
	var finalMu sync.Mutex
	var finalText string
	var sessionID string
	var finalUsage map[string]any
	client.onEvent = func(msg runtimeRPCMessage) {
		frame := acpNotificationToFrame(req, msg)
		if frame == nil {
			return
		}
		if frame.Text != "" && !allowAgentBytes(&sent, int64(len(frame.Text)), req.MaxOutputBytes) {
			return
		}
		if frame.EventType == "text_delta" && frame.Text != "" {
			finalMu.Lock()
			finalText += frame.Text
			finalMu.Unlock()
		}
		if frame.SessionID != "" {
			sessionID = frame.SessionID
		}
		if frame.EventType == "usage" {
			if usage := acpUsageFromPayload(frame.Payload); usage != nil {
				finalMu.Lock()
				finalUsage = usage
				finalMu.Unlock()
			}
		}
		emit(*frame)
	}
	if err := cmd.Start(); err != nil {
		return AgentRunResultFrame{}, err
	}
	readDone := make(chan struct{})
	logDone := make(chan struct{})
	go func() {
		defer close(readDone)
		client.readLoop(stdout)
	}()
	go func() {
		defer close(logDone)
		pumpAgentLog(stderr, req, &sent, emit)
	}()

	if _, err := client.call(ctx, "initialize", map[string]any{"protocolVersion": 1, "clientInfo": map[string]any{"name": "octodeck-daemon", "version": daemonVersion}}); err != nil {
		_ = stdin.Close()
		_ = cmd.Wait()
		<-readDone
		<-logDone
		return AgentRunResultFrame{}, err
	}
	created, err := client.call(ctx, "session/new", map[string]any{"cwd": req.Cwd, "mcpServers": acpMCPServers(cfg), "_meta": map[string]any{"octodeckSessionId": req.Input.SessionID, "runId": req.RunID}})
	if err != nil {
		_ = stdin.Close()
		_ = cmd.Wait()
		<-readDone
		<-logDone
		return AgentRunResultFrame{}, err
	}
	sessionID = acpSessionIDFromResult(created, req.Input.SessionID)
	if sessionID == "" {
		sessionID = req.RunID
	}
	promptResult, promptErr := client.call(ctx, "session/prompt", map[string]any{"sessionId": sessionID, "prompt": req.Input.Prompt, "content": []map[string]any{{"type": "text", "text": req.Input.Prompt}}, "_meta": map[string]any{"policy": req.Policy, "context": req.Context}})
	if promptErr == nil {
		if text := acpTextFromResult(promptResult); text != "" {
			finalMu.Lock()
			if finalText == "" {
				finalText = text
			}
			finalMu.Unlock()
		}
		if usage := acpUsageFromResult(promptResult); usage != nil {
			finalMu.Lock()
			finalUsage = usage
			finalMu.Unlock()
		}
	}
	_ = stdin.Close()
	waitErr := cmd.Wait()
	<-readDone
	<-logDone
	timedOut := errors.Is(ctx.Err(), context.DeadlineExceeded)
	var errPtr *string
	if promptErr != nil {
		msg := promptErr.Error()
		errPtr = &msg
	} else if waitErr != nil {
		msg := waitErr.Error()
		errPtr = &msg
	}
	return AgentRunResultFrame{OK: errPtr == nil, Result: finalText, Error: errPtr, SessionID: sessionID, Usage: finalUsage, TimedOut: timedOut, DurationMs: time.Since(started).Milliseconds()}, nil
}

func (c *acpClient) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	c.mu.Lock()
	c.nextID++
	id := c.nextID
	ch := make(chan runtimeRPCMessage, 1)
	c.pending[id] = ch
	paramsJSON, _ := json.Marshal(params)
	err := c.enc.Encode(runtimeRPCMessage{JSONRPC: "2.0", ID: &id, Method: method, Params: paramsJSON})
	if err != nil {
		delete(c.pending, id)
	}
	c.mu.Unlock()
	if err != nil {
		return nil, err
	}
	select {
	case msg := <-ch:
		if msg.Error != nil {
			return msg.Result, errors.New(msg.Error.Message)
		}
		return msg.Result, nil
	case <-c.closed:
		c.forget(id)
		return nil, io.ErrUnexpectedEOF
	case <-ctx.Done():
		c.forget(id)
		return nil, ctx.Err()
	case <-time.After(30 * time.Second):
		c.forget(id)
		return nil, fmt.Errorf("acp method %s timeout", method)
	}
}

func (c *acpClient) forget(id int64) {
	c.mu.Lock()
	delete(c.pending, id)
	c.mu.Unlock()
}

func (c *acpClient) readLoop(r io.Reader) {
	defer close(c.closed)
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var msg runtimeRPCMessage
		if err := json.Unmarshal([]byte(line), &msg); err != nil {
			continue
		}
		if msg.ID != nil {
			c.mu.Lock()
			ch := c.pending[*msg.ID]
			delete(c.pending, *msg.ID)
			c.mu.Unlock()
			if ch != nil {
				ch <- msg
				close(ch)
			}
			continue
		}
		if c.onEvent != nil {
			c.onEvent(msg)
		}
	}
}

func acpNotificationToFrame(req *AgentRunRequestFrame, msg runtimeRPCMessage) *AgentRunEventFrame {
	if msg.Method == "" {
		return nil
	}
	payload := acpPayloadMap(msg)
	enrichACPToolPayload(payload)
	eventType := acpEventType(msg.Method, payload)
	text := ""
	if eventType == "thinking_delta" {
		text = firstStringDeep(payload, "thinking", "reasoning", "reason", "thought", "thoughts", "text", "content", "delta")
	} else if eventType == "text_delta" {
		text = acpAssistantText(payload)
	}
	sessionID := firstStringDeep(payload, "sessionId", "session_id", "sessionID")
	return &AgentRunEventFrame{Type: tAgentRunEvent, RunID: req.RunID, AgentID: req.AgentID, EventType: eventType, Text: text, SessionID: sessionID, Payload: payload, At: formatTime(time.Now())}
}

func acpPayloadMap(msg runtimeRPCMessage) map[string]any {
	payload := map[string]any{"method": msg.Method, "acpMethod": msg.Method}
	if len(msg.Params) == 0 {
		return payload
	}
	var params any
	if err := json.Unmarshal(msg.Params, &params); err != nil {
		payload["paramsRaw"] = string(msg.Params)
		return payload
	}
	if m, ok := params.(map[string]any); ok {
		for k, v := range m {
			payload[k] = v
		}
		payload["params"] = m
		return payload
	}
	payload["params"] = params
	return payload
}

func acpEventType(method string, payload map[string]any) string {
	method = strings.ToLower(method)
	rawType := strings.ToLower(firstStringDeep(payload, "type", "event", "eventType", "kind", "phase", "status"))
	if rawType == "usage" || strings.Contains(method, "usage") || acpUsageFromPayload(payload) != nil {
		return "usage"
	}
	if rawType == "permission_request" || rawType == "approval_request" || strings.Contains(method, "permission") || strings.Contains(method, "approval") {
		return "permission_request"
	}
	if rawType == "tool_result" || rawType == "tool_use_end" || rawType == "tool_call_result" || strings.Contains(method, "toolresult") || (strings.Contains(method, "tool") && (strings.Contains(method, "result") || strings.Contains(method, "end") || strings.Contains(method, "response"))) {
		return "tool_use_end"
	}
	if rawType == "tool_use" || rawType == "tool_call" || rawType == "tool_use_start" || rawType == "tool_call_start" || hasACPToolStart(payload) || (strings.Contains(method, "tool") && (strings.Contains(method, "call") || strings.Contains(method, "use") || strings.Contains(method, "start"))) {
		return "tool_use_start"
	}
	if rawType == "thinking" || rawType == "reasoning" || rawType == "reasoning_delta" || rawType == "thinking_delta" || strings.Contains(method, "thought") || strings.Contains(method, "reason") || strings.Contains(method, "thinking") || firstStringDeep(payload, "thinking", "reasoning", "reason", "thought", "thoughts") != "" {
		return "thinking_delta"
	}
	if acpAssistantText(payload) != "" {
		return "text_delta"
	}
	if rawType == "session" || rawType == "session_created" || rawType == "session_resumed" || (strings.Contains(method, "session") && firstStringDeep(payload, "sessionId", "session_id", "id") != "") {
		return "session"
	}
	return "log"
}

func acpSessionIDFromResult(raw json.RawMessage, fallback string) string {
	var m map[string]any
	if len(raw) > 0 && json.Unmarshal(raw, &m) == nil {
		if id := firstString(m, "sessionId", "session_id", "id"); id != "" {
			return id
		}
	}
	return fallback
}

func acpTextFromResult(raw json.RawMessage) string {
	var m map[string]any
	if len(raw) > 0 && json.Unmarshal(raw, &m) == nil {
		if text := acpAssistantText(m); text != "" {
			return text
		}
		return firstStringDeep(m, "text", "content", "result", "output")
	}
	return ""
}

func acpUsageFromResult(raw json.RawMessage) map[string]any {
	var m map[string]any
	if len(raw) > 0 && json.Unmarshal(raw, &m) == nil {
		return acpUsageFromPayload(m)
	}
	return nil
}

func acpUsageFromPayload(payload map[string]any) map[string]any {
	if payload == nil {
		return nil
	}
	if usage, ok := payload["usage"].(map[string]any); ok {
		return usage
	}
	if usage := findMapDeep(payload, func(m map[string]any) bool {
		_, ok := m["usage"]
		return ok
	}); usage != nil {
		if nested, ok := usage["usage"].(map[string]any); ok {
			return nested
		}
	}
	if hasAnyKey(payload, "inputTokens", "outputTokens", "input_tokens", "output_tokens", "totalTokens", "total_tokens", "cacheReadInputTokens", "cache_read_input_tokens", "costUSD", "cost_usd") {
		return payload
	}
	return nil
}

func acpAssistantText(payload map[string]any) string {
	if payload == nil {
		return ""
	}
	if delta, ok := payload["delta"].(map[string]any); ok {
		if text := firstStringDeep(delta, "text", "content", "message", "output"); text != "" {
			return text
		}
	}
	if msg, ok := payload["message"].(map[string]any); ok {
		if text := acpContentText(msg["content"], false); text != "" {
			return text
		}
	}
	if text := acpContentText(payload["content"], false); text != "" {
		return text
	}
	return firstString(payload, "text", "delta", "result", "output")
}

func acpContentText(value any, includeThinking bool) string {
	switch v := value.(type) {
	case string:
		return v
	case []any:
		var b strings.Builder
		for _, item := range v {
			m, ok := item.(map[string]any)
			if !ok {
				continue
			}
			typ := strings.ToLower(firstString(m, "type", "kind"))
			if typ == "text" || typ == "output_text" || typ == "assistant" || (includeThinking && (typ == "thinking" || typ == "reasoning")) {
				if text := firstStringDeep(m, "text", "content", "thinking", "reasoning", "reason"); text != "" {
					b.WriteString(text)
				}
			}
		}
		return b.String()
	}
	return ""
}

func enrichACPToolPayload(payload map[string]any) {
	if payload == nil {
		return
	}
	tool := findMapDeep(payload, func(m map[string]any) bool {
		typ := strings.ToLower(firstString(m, "type", "kind"))
		if strings.Contains(typ, "tool") {
			return true
		}
		return (firstString(m, "name", "toolName") != "" && (m["input"] != nil || m["arguments"] != nil || m["args"] != nil)) || firstString(m, "toolUseId", "tool_use_id") != ""
	})
	if tool == nil {
		return
	}
	for _, key := range []string{"id", "toolUseId", "tool_use_id", "name", "toolName", "input", "arguments", "args", "content", "result", "output", "text", "is_error", "isError", "error"} {
		if payload[key] == nil && tool[key] != nil {
			payload[key] = tool[key]
		}
	}
	if payload["toolName"] == nil {
		if name := firstString(tool, "name", "toolName"); name != "" {
			payload["toolName"] = name
		}
	}
	if payload["toolUseId"] == nil {
		if id := firstString(tool, "id", "toolUseId", "tool_use_id"); id != "" {
			payload["toolUseId"] = id
		}
	}
}

func hasACPToolStart(payload map[string]any) bool {
	if payload == nil {
		return false
	}
	if payload["toolCall"] != nil || payload["tool_call"] != nil || payload["toolUse"] != nil || payload["tool_use"] != nil {
		return true
	}
	return findMapDeep(payload, func(m map[string]any) bool {
		typ := strings.ToLower(firstString(m, "type", "kind"))
		return typ == "tool_use" || typ == "tool_call" || typ == "tool_use_start" || (firstString(m, "name", "toolName") != "" && (m["input"] != nil || m["arguments"] != nil || m["args"] != nil))
	}) != nil
}

func firstStringDeep(value any, keys ...string) string {
	return firstStringDeepWithDepth(value, 0, keys...)
}

func firstStringDeepWithDepth(value any, depth int, keys ...string) string {
	if depth > 8 || value == nil {
		return ""
	}
	switch v := value.(type) {
	case map[string]any:
		for _, key := range keys {
			if s, ok := v[key].(string); ok && s != "" {
				return s
			}
		}
		for _, child := range v {
			if text := firstStringDeepWithDepth(child, depth+1, keys...); text != "" {
				return text
			}
		}
	case []any:
		for _, child := range v {
			if text := firstStringDeepWithDepth(child, depth+1, keys...); text != "" {
				return text
			}
		}
	}
	return ""
}

func findMapDeep(value any, pred func(map[string]any) bool) map[string]any {
	return findMapDeepWithDepth(value, pred, 0)
}

func findMapDeepWithDepth(value any, pred func(map[string]any) bool, depth int) map[string]any {
	if depth > 8 || value == nil {
		return nil
	}
	switch v := value.(type) {
	case map[string]any:
		if pred(v) {
			return v
		}
		for _, child := range v {
			if found := findMapDeepWithDepth(child, pred, depth+1); found != nil {
				return found
			}
		}
	case []any:
		for _, child := range v {
			if found := findMapDeepWithDepth(child, pred, depth+1); found != nil {
				return found
			}
		}
	}
	return nil
}

func hasAnyKey(m map[string]any, keys ...string) bool {
	for _, key := range keys {
		if _, ok := m[key]; ok {
			return true
		}
	}
	return false
}

func acpMCPServers(cfg *Config) map[string]any {
	server, err := buildAgentTeamMCPServerConfig(cfg)
	if err != nil {
		return nil
	}
	return map[string]any{"octodeck_agent_team": server}
}

func mergeStringMaps(a, b map[string]string) map[string]string {
	if len(a) == 0 {
		return b
	}
	out := make(map[string]string, len(a)+len(b))
	for k, v := range a {
		out[k] = v
	}
	for k, v := range b {
		out[k] = v
	}
	return out
}

func listProviderSessions(ctx context.Context, cfg *Config, agentID, providerDir, workspace string) ([]AgentSessionInfo, error) {
	root := sessionDir(cfg)
	workspaces := []string{workspace}
	if workspace == "" {
		entries, err := os.ReadDir(root)
		if err != nil {
			if os.IsNotExist(err) {
				return []AgentSessionInfo{}, nil
			}
			return nil, err
		}
		workspaces = workspaces[:0]
		for _, e := range entries {
			if e.IsDir() {
				workspaces = append(workspaces, e.Name())
			}
		}
	}
	sessions := make([]AgentSessionInfo, 0)
	for _, ws := range workspaces {
		if ctx.Err() != nil {
			return sessions, ctx.Err()
		}
		if ws == "" {
			continue
		}
		if providerDir != agentID {
			metaRoot := filepath.Join(root, safeGroupFolder(ws), safePathSegment(agentID))
			items, err := listSessionEntries(metaRoot, agentID, safeGroupFolder(ws))
			if err == nil {
				sessions = append(sessions, items...)
			} else if err != nil && !os.IsNotExist(err) {
				return sessions, err
			}
		}
		providerRoot := filepath.Join(root, safeGroupFolder(ws), providerDir)
		items, err := listSessionEntries(providerRoot, agentID, safeGroupFolder(ws))
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return sessions, err
		}
		sessions = append(sessions, items...)
	}
	return sessions, nil
}

func writeSessionMetadata(cfg *Config, req *AgentRunRequestFrame, sessionID, finalText string) error {
	workspace := groupFolderFromRunContext(req.Context)
	if workspace == "" && req.Workspace != nil {
		workspace = req.Workspace.Folder
	}
	if workspace == "" {
		workspace = filepath.Base(filepath.Clean(req.Cwd))
	}
	dir := filepath.Join(sessionDir(cfg), safeGroupFolder(workspace), safePathSegment(req.AgentID), safePathSegment(sessionID))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	title := strings.TrimSpace(finalText)
	if len(title) > 120 {
		title = title[:120]
	}
	payload := map[string]any{
		"id":        sessionID,
		"sessionId": sessionID,
		"agentId":   req.AgentID,
		"workspace": safeGroupFolder(workspace),
		"title":     title,
		"updatedAt": formatTime(time.Now()),
		"cwd":       req.Cwd,
		"runId":     req.RunID,
	}
	data, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "session.json"), data, 0o600)
}

func listSessionEntries(providerRoot, agentID, workspace string) ([]AgentSessionInfo, error) {
	entries, err := os.ReadDir(providerRoot)
	if err != nil {
		return nil, err
	}
	out := make([]AgentSessionInfo, 0, len(entries))
	seen := map[string]struct{}{}
	for _, e := range entries {
		info, err := e.Info()
		if err != nil {
			continue
		}
		path := filepath.Join(providerRoot, e.Name())
		id, title := sessionEntryMetadata(path, e.Name())
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, AgentSessionInfo{ID: id, AgentID: agentID, Workspace: workspace, Provider: agentID, Title: title, Path: path, UpdatedAt: formatTime(info.ModTime()), SizeBytes: sessionEntrySize(path, info)})
	}
	return out, nil
}

func sessionEntryMetadata(path, fallbackID string) (string, string) {
	info, err := os.Stat(path)
	if err != nil {
		return fallbackID, ""
	}
	if info.IsDir() {
		for _, name := range []string{"session.json", "metadata.json", "conversation.json"} {
			if id, title := sessionEntryMetadata(filepath.Join(path, name), fallbackID); id != fallbackID || title != "" {
				return id, title
			}
		}
		return fallbackID, ""
	}
	data, err := os.ReadFile(path)
	if err != nil || len(data) == 0 || len(data) > 2*1024*1024 {
		return fallbackID, ""
	}
	var obj map[string]any
	if err := json.Unmarshal(data, &obj); err != nil {
		return fallbackID, ""
	}
	id := fallbackID
	for _, key := range []string{"session_id", "sessionId", "id", "conversation_id"} {
		if v, ok := obj[key].(string); ok && v != "" {
			id = v
			break
		}
	}
	title := ""
	for _, key := range []string{"title", "summary", "name"} {
		if v, ok := obj[key].(string); ok && v != "" {
			title = v
			break
		}
	}
	return id, title
}

func sessionEntrySize(path string, info os.FileInfo) int64 {
	if !info.IsDir() {
		return info.Size()
	}
	var total int64
	_ = filepath.WalkDir(path, func(_ string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if st, statErr := d.Info(); statErr == nil {
			total += st.Size()
		}
		return nil
	})
	return total
}

func deleteProviderSession(ctx context.Context, cfg *Config, providerDir, workspace, sessionID string) (bool, error) {
	if ctx.Err() != nil {
		return false, ctx.Err()
	}
	if workspace == "" || sessionID == "" {
		return false, errors.New("workspace and sessionId are required")
	}
	root := filepath.Join(sessionDir(cfg), safeGroupFolder(workspace), providerDir)
	target := filepath.Clean(filepath.Join(root, sessionID))
	cleanRoot := filepath.Clean(root)
	if target != cleanRoot && !strings.HasPrefix(target, cleanRoot+string(os.PathSeparator)) {
		return false, fmt.Errorf("session path escapes provider root: %s", sessionID)
	}
	if _, err := os.Stat(target); err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, err
	}
	return true, os.RemoveAll(target)
}

func pumpAgentStdout(ctx context.Context, r io.Reader, req *AgentRunRequestFrame, jsonLines bool, sent *atomic.Int64, emit func(AgentRunEventFrame)) {
	if !jsonLines {
		pumpAgentLogAsText(r, req, sent, emit)
		return
	}
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		if ctx.Err() != nil {
			return
		}
		line := scanner.Text()
		eventType, text, sessionID, payload := normalizeAgentJSONLine(line)
		if text == "" && sessionID == "" && eventType == "log" {
			continue
		}
		if !allowAgentBytes(sent, int64(len(text)), req.MaxOutputBytes) {
			continue
		}
		if text == "" && sessionID != "" {
			eventType = "session"
		}
		emit(AgentRunEventFrame{Type: tAgentRunEvent, RunID: req.RunID, AgentID: req.AgentID, EventType: eventType, Text: text, SessionID: sessionID, Payload: payload, At: formatTime(time.Now())})
	}
}

func pumpAgentLog(r io.Reader, req *AgentRunRequestFrame, sent *atomic.Int64, emit func(AgentRunEventFrame)) {
	pumpAgentLogAsText(r, req, sent, func(frame AgentRunEventFrame) {
		frame.EventType = "log"
		emit(frame)
	})
}

func pumpAgentLogAsText(r io.Reader, req *AgentRunRequestFrame, sent *atomic.Int64, emit func(AgentRunEventFrame)) {
	reader := bufio.NewReader(r)
	buf := make([]byte, 8192)
	for {
		n, err := reader.Read(buf)
		if n > 0 && allowAgentBytes(sent, int64(n), req.MaxOutputBytes) {
			emit(AgentRunEventFrame{Type: tAgentRunEvent, RunID: req.RunID, AgentID: req.AgentID, EventType: "text_delta", Text: string(buf[:n]), At: formatTime(time.Now())})
		}
		if err != nil {
			return
		}
	}
}

func allowAgentBytes(sent *atomic.Int64, n, max int64) bool {
	if n <= 0 {
		return true
	}
	for {
		cur := sent.Load()
		if cur >= max {
			return false
		}
		if cur+n > max {
			n = max - cur
		}
		if sent.CompareAndSwap(cur, cur+n) {
			return true
		}
	}
}

func normalizeAgentJSONLine(line string) (string, string, string, map[string]any) {
	var evt map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(line)), &evt); err != nil {
		return "log", "", "", nil
	}
	sessionID, _ := evt["session_id"].(string)
	rawType, _ := evt["type"].(string)
	if rawType == "thinking" || rawType == "reasoning" || rawType == "reasoning_delta" {
		if text := firstString(evt, "thinking", "reasoning", "reason", "text", "content"); text != "" {
			return "thinking_delta", text, sessionID, evt
		}
	}
	if rawType == "tool_use" || rawType == "tool_call" || rawType == "tool_use_start" {
		return "tool_call", "", sessionID, evt
	}
	if rawType == "tool_result" || rawType == "tool_use_end" {
		return "tool_result", "", sessionID, evt
	}
	if rawType == "usage" {
		return "usage", "", sessionID, evt
	}
	if rawType == "permission_request" || rawType == "approval_request" {
		return "permission_request", "", sessionID, evt
	}
	if result, ok := evt["result"].(string); ok && result != "" {
		return "text_delta", result, sessionID, evt
	}
	if text := firstString(evt, "thinking", "reasoning", "reason"); text != "" {
		return "thinking_delta", text, sessionID, evt
	}
	if delta, ok := evt["delta"].(map[string]any); ok {
		if thinking := firstString(delta, "thinking", "reasoning", "reason", "text"); thinking != "" {
			return "thinking_delta", thinking, sessionID, evt
		}
		if role, _ := delta["role"].(string); role == "assistant" {
			if content, _ := delta["content"].(string); content != "" {
				return "text_delta", content, sessionID, evt
			}
		}
	}
	if msg, ok := evt["message"].(map[string]any); ok {
		if content, ok := msg["content"].(string); ok && content != "" {
			return "text_delta", content, sessionID, evt
		}
		if blocks, ok := msg["content"].([]any); ok {
			var b strings.Builder
			for _, block := range blocks {
				m, _ := block.(map[string]any)
				typ, _ := m["type"].(string)
				if typ == "tool_use" {
					return "tool_call", "", sessionID, evt
				}
				if typ == "tool_result" {
					return "tool_result", "", sessionID, evt
				}
				if typ == "thinking" || typ == "reasoning" {
					if text := firstString(m, "thinking", "reasoning", "reason", "text", "content"); text != "" {
						return "thinking_delta", text, sessionID, evt
					}
				}
				if typ == "text" {
					if text, _ := m["text"].(string); text != "" {
						b.WriteString(text)
					}
				}
			}
			if b.Len() > 0 {
				return "text_delta", b.String(), sessionID, evt
			}
		}
	}
	if usage, ok := evt["usage"].(map[string]any); ok {
		evt["usage"] = usage
		return "usage", "", sessionID, evt
	}
	return "log", "", sessionID, evt
}

func firstString(m map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, _ := m[key].(string); value != "" {
			return value
		}
	}
	return ""
}

func validateAgentRunRequest(cfg *Config, req *AgentRunRequestFrame) error {
	if req.RunID == "" || req.AgentID == "" {
		return errors.New("runId and agentId are required")
	}
	if req.Input.Prompt == "" {
		return errors.New("input.prompt is required")
	}
	if findAgentClient(cfg, req.AgentID) == nil {
		return fmt.Errorf("agent client not discovered: %s", req.AgentID)
	}
	if req.Cwd == "" && (req.Workspace == nil || (req.Workspace.Cwd == "" && req.Workspace.Folder == "" && req.Workspace.Repo == nil)) {
		return errors.New("cwd is required")
	}
	if req.Cwd != "" && !filepath.IsAbs(req.Cwd) && !isDeviceManagedURI(req.Cwd) {
		return fmt.Errorf("cwd must be absolute: %q", req.Cwd)
	}
	if req.Workspace != nil && req.Workspace.Cwd != "" && !filepath.IsAbs(req.Workspace.Cwd) && !isDeviceManagedURI(req.Workspace.Cwd) {
		return fmt.Errorf("workspace.cwd must be absolute: %q", req.Workspace.Cwd)
	}
	for k := range req.Env {
		if isDangerousEnvKey(k) {
			return fmt.Errorf("env key not allowed: %q", k)
		}
	}
	if err := validateRuntimePolicy(cfg, req); err != nil {
		return err
	}
	if req.TimeoutMs <= 0 {
		return errors.New("timeoutMs must be positive")
	}
	if req.MaxOutputBytes <= 0 {
		return errors.New("maxOutputBytes must be positive")
	}
	return nil
}

func validateRuntimePolicy(cfg *Config, req *AgentRunRequestFrame) error {
	entry := findAgentRegistryEntry(cfg, req.AgentID)
	allowedTools := cfg.RuntimePolicy.AllowedTools
	disallowedTools := cfg.RuntimePolicy.DisallowedTools
	if entry != nil {
		if len(entry.AllowedTools) > 0 {
			allowedTools = entry.AllowedTools
		}
		if len(entry.DisallowedTools) > 0 {
			disallowedTools = entry.DisallowedTools
		}
	}
	if req.Policy.PermissionMode != "" {
		client := findAgentClient(cfg, req.AgentID)
		if client != nil {
			modes := effectivePermissionModes(cfg, entry, *client)
			if len(modes) > 0 && !containsString(modes, req.Policy.PermissionMode) {
				return fmt.Errorf("permissionMode not allowed for agent %s: %s", req.AgentID, req.Policy.PermissionMode)
			}
		}
	}
	if len(allowedTools) > 0 {
		for _, tool := range req.Policy.AllowedTools {
			if !containsString(allowedTools, tool) {
				return fmt.Errorf("tool not allowed by runtime policy: %s", tool)
			}
		}
	}
	for _, tool := range req.Policy.AllowedTools {
		if containsString(disallowedTools, tool) {
			return fmt.Errorf("tool disallowed by runtime policy: %s", tool)
		}
	}
	for _, tool := range req.Policy.DisallowedTools {
		if len(allowedTools) > 0 && !containsString(allowedTools, tool) {
			return fmt.Errorf("tool policy references unknown tool: %s", tool)
		}
	}
	return nil
}

func isWorkspaceAllowedByRuntimePolicy(cfg *Config, agentID, cwd string) bool {
	if cfg == nil {
		return true
	}
	allowed := cfg.RuntimePolicy.AllowedWorkspaces
	if entry := findAgentRegistryEntry(cfg, agentID); entry != nil && len(entry.AllowedWorkspaces) > 0 {
		allowed = entry.AllowedWorkspaces
	}
	if len(allowed) == 0 {
		return true
	}
	return isPathAllowedByConfiguredRoots(cwd, allowed)
}

func containsString(items []string, needle string) bool {
	for _, item := range items {
		if item == needle {
			return true
		}
	}
	return false
}
