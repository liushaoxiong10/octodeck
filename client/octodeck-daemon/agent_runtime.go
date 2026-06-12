package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/beyond5959/acp-adapter/pkg/claudeacp"
	"github.com/beyond5959/acp-adapter/pkg/codexacp"
	acpsdk "github.com/coder/acp-go-sdk"
)

const acpSessionMapFile = "agent-session-map.json"

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
	Data    any    `json:"data,omitempty"`
}

// runtimeRPCErrorString formats a JSON-RPC error into a single readable string
// that includes both the message and any details from the data field.
// This ensures transport-disconnect messages buried in data.error are
// visible to error-detection functions like isACPTransportDisconnect.
func runtimeRPCErrorString(e *runtimeRPCError) string {
	if e == nil {
		return ""
	}
	msg := e.Message
	if e.Data != nil {
		if dataMap, ok := e.Data.(map[string]any); ok {
			if inner, ok := dataMap["error"].(string); ok && inner != "" {
				if msg != "" {
					msg = msg + ": " + inner
				} else {
					msg = inner
				}
			}
		}
		// Fallback: append JSON of data if it carries useful info and message is generic
		if msg == "Internal error" || msg == "" {
			if dataJSON, err := json.Marshal(e.Data); err == nil && len(dataJSON) > 2 {
				if msg != "" {
					msg = msg + " " + string(dataJSON)
				} else {
					msg = string(dataJSON)
				}
			}
		}
	}
	return msg
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
					ch <- errors.New(runtimeRPCErrorString(msg.Error))
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
		if err == nil && deleteACPSessionRecords(rt.cfg, req.AgentID, req.SessionID) > 0 {
			deleted = true
		}
		if err == nil && req.Workspace != "" && req.SessionID != "" {
			localScopeID := stableAgentWorkspaceScopeID(req.AgentID)
			if localScopeID == "" {
				localScopeID = req.SessionID
			}
			if localDir, dirErr := cleanupWorkspaceScopeDir(rt.cfg, req.Workspace, "session", localScopeID, "", ""); dirErr != nil {
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
	return 5 * time.Hour
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
	processKey := acpSessionProcessKey(req)
	conversationID := acpConversationID(req)
	if rec, ok := lookupACPSessionRecord(rt.cfg, processKey); ok && rec.SessionID != "" {
		req.Input.SessionID = rec.SessionID
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
			_ = writeACPSessionRecord(rt.cfg, agentSessionMapRecord(processKey, conversationID, *client, req, result.SessionID))
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
	var finalResultFallback string
	var sessionID string
	pumpStdoutDone := make(chan struct{})
	pumpStderrDone := make(chan struct{})
	go func() {
		defer close(pumpStdoutDone)
		pumpAgentStdout(ctx, stdout, req, outputJSON, &sent, func(frame AgentRunEventFrame) {
			if frame.EventType == "final_result" && frame.Text != "" {
				// Fallback result for single-shot CLIs that only emit a
				// complete answer (no streaming chunks). Accumulated lazily
				// only when no streaming text was seen so streaming CLIs
				// that append the full answer as a trailing result frame
				// don't get their output doubled.
				textMu.Lock()
				finalResultFallback = frame.Text
				textMu.Unlock()
				return
			}
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
	// Fallback to the trailing result-event payload for single-shot CLIs that
	// don't emit streaming text_delta chunks. When both streaming chunks and
	// a trailing result event exist (streaming CLIs like traecli), the
	// streaming text already represents the complete answer so we keep only
	// the streaming copy to avoid duplication.
	textMu.Lock()
	if finalText == "" && finalResultFallback != "" {
		finalText = finalResultFallback
	}
	textMu.Unlock()
	timedOut := errors.Is(ctx.Err(), context.DeadlineExceeded)
	if waitErr != nil && finalText == "" {
		rt.finishErr(out, req, started, waitErr, timedOut)
		return
	}
	rt.notify(out, "agent.run.status", AgentRunStatusFrame{Type: tAgentRunStatus, RunID: req.RunID, AgentID: req.AgentID, Status: "completed", Cwd: cwd})
	if sessionID != "" {
		_ = writeSessionMetadata(rt.cfg, req, sessionID, finalText)
		_ = writeACPSessionRecord(rt.cfg, agentSessionMapRecord(processKey, conversationID, *client, req, sessionID))
	}
	errPtr := (*string)(nil)
	rt.notify(out, "agent.run.result", AgentRunResultFrame{Type: tAgentRunResult, RunID: req.RunID, AgentID: req.AgentID, OK: true, Result: finalText, Error: errPtr, SessionID: sessionID, TimedOut: timedOut, DurationMs: time.Since(started).Milliseconds()})
}

func (rt *agentRuntimeProcess) resolveCwd(ctx context.Context, req *AgentRunRequestFrame) (string, error) {
	normalizeAgentRunWorkspaceScope(req)
	applyAgentRunChatSessionScope(req)

	// Normalize to a unified list of repos: prefer Workspace.Repos, fall back to
	// Workspace.Repo (single), then to the legacy WorkspaceRepo.
	var repos []*WorkspaceRepoSpec
	if len(req.WorkspaceRepos) > 0 {
		repos = req.WorkspaceRepos
	} else if req.Workspace != nil && len(req.Workspace.Repos) > 0 {
		repos = req.Workspace.Repos
	} else if req.Workspace != nil && req.Workspace.Repo != nil {
		repos = []*WorkspaceRepoSpec{req.Workspace.Repo}
	} else if req.WorkspaceRepo != nil {
		repos = []*WorkspaceRepoSpec{req.WorkspaceRepo}
	}

	if len(repos) > 0 {
		if repos[0] == nil {
			return "", errors.New("workspace repo spec is required")
		}
		// First, resolve the workspace/session/task root (this handles
		// octodeck-workspace:// URI or custom CWD folder fallback, or the
		// scope-aware workspace directory).
		var wsRoot string
		var err error
		if req.Workspace != nil && (req.Workspace.AgentID != "" || req.Workspace.AgentRoot != "" || req.Workspace.Scope != "" || req.Workspace.ScopeID != "") {
			wsRoot, err = rt.resolveWorkspaceRoot(req)
		} else {
			wsRoot, err = ensureWorkspaceRepoBaseDir(rt.cfg, repos[0])
		}
		if err != nil {
			return "", err
		}
		// Repos are materialized as direct children of the workspace/session/task
		// root. Keep cwd fixed at the root for both single-repo and multi-repo
		// runs so paths remain stable when a workspace gains more repos later.
		for _, spec := range repos {
			if spec == nil {
				return "", errors.New("workspace repo spec is required")
			}
			if spec.Kind == "workspace" {
				continue
			}
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

func applyAgentRunChatSessionScope(req *AgentRunRequestFrame) {
	if req == nil || req.Workspace == nil || !isAgentSessionScope(req.Workspace.Scope, req.Workspace.ScopeID) {
		return
	}
	chatID := metadataString(req.Input.Metadata, "chatId")
	if chatID == "" {
		chatID = firstNonEmpty(
			metadataString(req.Input.Metadata, "conversationId"),
			metadataString(req.Input.Metadata, "conversationID"),
			metadataString(req.Input.Metadata, "sessionKey"),
			metadataString(req.Input.Metadata, "chatJid"),
		)
	}
	workspaceSessionID := metadataString(req.Input.Metadata, "workspaceSessionId")
	// Keep Workspace.Folder as the workspace/group root. Newer servers send an
	// explicit OctoDeck workspace-session id as metadata/scopeId; preserve it so
	// /clear or "new session" gets an isolated workdir:
	//   workspace/<workspace-folder>/sessions/<workspaceSessionId>
	// Older frames used a provider/workspace scope id here, so keep falling back
	// to chat-id for those.
	if workspaceSessionID != "" {
		req.Workspace.ScopeID = workspaceSessionID
	} else if chatID != "" && (req.Workspace.ScopeID == "" || !strings.HasPrefix(req.Workspace.ScopeID, "octodeck-")) {
		req.Workspace.ScopeID = chatID
	}
}

func metadataString(meta map[string]any, key string) string {
	if meta == nil {
		return ""
	}
	if v, ok := meta[key].(string); ok && strings.TrimSpace(v) != "" {
		return strings.TrimSpace(v)
	}
	return ""
}

func normalizeAgentRunWorkspaceScope(req *AgentRunRequestFrame) {
	if req == nil {
		return
	}
	// Keep daemon workspace directories stable across turns. The native agent
	// session id in req.Input.SessionID is still passed to the adapter for
	// resume/load, but it must not decide the local cwd; otherwise the first turn
	// may run under sessions/<turn-id> and the next under sessions/<native-id>.
	// Newer servers send the OctoDeck conversation id directly as ScopeID; preserve
	// any explicit ScopeID and only synthesize a legacy fallback when it is absent.
	if req.Workspace != nil {
		normalizeAgentRunWorkspace(req.Workspace, req.AgentID)
	}
	for _, spec := range req.WorkspaceRepos {
		normalizeWorkspaceRepoSpecScope(spec, req.AgentID)
	}
	if req.WorkspaceRepo != nil {
		normalizeWorkspaceRepoSpecScope(req.WorkspaceRepo, req.AgentID)
	}
}

func normalizeAgentRunWorkspace(ws *AgentRunWorkspace, fallbackAgentID string) {
	if ws == nil {
		return
	}
	agentID := firstNonEmpty(ws.AgentID, fallbackAgentID)
	if isAgentSessionScope(ws.Scope, ws.ScopeID) {
		if ws.ScopeID != "" {
			// Explicit server-provided session scope: this is the OctoDeck conversation
			// id and must remain the directory name under sessions/<scopeId>.
		} else if ws.Scope == "direct_session" {
			ws.ScopeID = "main"
		} else if scopeID := stableAgentWorkspaceScopeID(agentID); scopeID != "" {
			ws.ScopeID = scopeID
		}
	}
	if ws.Repo != nil {
		normalizeWorkspaceRepoSpecScope(ws.Repo, agentID)
	}
	for _, spec := range ws.Repos {
		normalizeWorkspaceRepoSpecScope(spec, agentID)
	}
}

func normalizeWorkspaceRepoSpecScope(spec *WorkspaceRepoSpec, fallbackAgentID string) {
	if spec == nil || !isAgentSessionScope(spec.Scope, spec.ScopeID) {
		return
	}
	if spec.ScopeID != "" {
		return
	}
	if scopeID := stableAgentWorkspaceScopeID(firstNonEmpty(spec.AgentID, fallbackAgentID)); scopeID != "" {
		spec.ScopeID = scopeID
	}
}

func isAgentSessionScope(scope, scopeID string) bool {
	return scope == "session" || scope == "direct_session" || (scope == "" && scopeID != "")
}

func stableAgentWorkspaceScopeID(agentID string) string {
	agentID = strings.TrimSpace(agentID)
	if agentID == "" {
		return ""
	}
	return "octodeck-" + agentID
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
		case "traex":
			// traex 的 stdio 调用约定与 codex 一致（exec --json），直接复用
			// codexAdapter，避免维护重复 BuildRunCommand。ACP 路径走 traex-acp，
			// 上面的 client.Transport == "acp" 分支已经把它指向 acpAdapter。
			out[client.ID] = &codexAdapter{baseAgentAdapter{client: client}}
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
	case "traex":
		return "traex"
	case "traex-acp":
		return "traex-acp"
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

func promptWithSystemContext(req *AgentRunRequestFrame, includeSystemContext bool) string {
	if req == nil || !includeSystemContext || strings.TrimSpace(req.Policy.SystemPrompt) == "" {
		if req == nil {
			return ""
		}
		return req.Input.Prompt
	}
	return strings.Join([]string{
		"<octodeck-system-context>",
		req.Policy.SystemPrompt,
		"</octodeck-system-context>",
		"",
		"<user-prompt>",
		req.Input.Prompt,
		"</user-prompt>",
	}, "\n")
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
	if req.Input.SessionID == "" && req.Policy.SystemPrompt != "" {
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

func normalizeCodexPermissionMode(mode string) string {
	switch strings.TrimSpace(mode) {
	case "bypassPermissions", "dangerously-skip-permissions", "no-approval", "auto-approve", "full-access":
		return "danger-full-access"
	default:
		return mode
	}
}

func (a *codexAdapter) BuildRunCommand(_ *Config, req *AgentRunRequestFrame) ([]string, bool, error) {
	prompt := promptWithSystemContext(req, req.Input.SessionID == "")
	if req.Input.SessionID != "" {
		argv := []string{"exec", "resume", "--json", "--skip-git-repo-check"}
		if req.Policy.Model != "" {
			argv = append(argv, "-m", req.Policy.Model)
		}
		if req.Policy.PermissionMode != "" {
			mode := normalizeCodexPermissionMode(req.Policy.PermissionMode)
			argv = append(argv, "--sandbox", mode)
			if mode == "danger-full-access" {
				argv = append(argv, "--ask-for-approval", "never")
			}
		}
		argv = append(argv, req.Input.SessionID, prompt)
		return argv, true, nil
	}
	argv := []string{"exec", "--json", "--skip-git-repo-check"}
	if req.Policy.Model != "" {
		argv = append(argv, "-m", req.Policy.Model)
	}
	if req.Policy.PermissionMode != "" {
		mode := normalizeCodexPermissionMode(req.Policy.PermissionMode)
		argv = append(argv, "--sandbox", mode)
		if mode == "danger-full-access" {
			argv = append(argv, "--ask-for-approval", "never")
		}
	}
	argv = append(argv, prompt)
	return argv, true, nil
}

func (a *traecliAdapter) BuildRunCommand(_ *Config, req *AgentRunRequestFrame) ([]string, bool, error) {
	// NOTE: --include-partial-messages is intentionally omitted.
	// stream-json already emits incremental content_block_delta events; the
	// partial-message snapshots would carry the fully accumulated text in
	// evt["message"]["content"] and be extracted a second time by section 6
	// of normalizeAgentJSONLineFrames, causing duplicated output. The daemon
	// internally assembles finalText from the streamed deltas anyway.
	argv := []string{"-p", promptWithSystemContext(req, req.Input.SessionID == ""), "--output-format=stream-json"}
	if shouldAutoApprovePermission(req.Policy) {
		argv = append(argv, "-y")
	}
	if req.Input.SessionID != "" {
		argv = append(argv, "--resume="+req.Input.SessionID)
	}
	if req.Policy.Model != "" {
		argv = append(argv, "-c", "model.name="+req.Policy.Model)
	}
	return argv, true, nil
}

func (a *acpAdapter) BuildRunCommand(_ *Config, req *AgentRunRequestFrame) ([]string, bool, error) {
	return nil, false, fmt.Errorf("acp agent adapter %s runs via protocol transport", a.client.ID)
}

func (a *acpAdapter) RunDirect(ctx context.Context, cfg *Config, req *AgentRunRequestFrame, emit func(AgentRunEventFrame)) (AgentRunResultFrame, error) {
	result, err := a.runACPAgent(ctx, cfg, req, emit)
	if err == nil || !isACPTransportDisconnect(err) || ctx.Err() != nil {
		return result, err
	}

	processKey := acpSessionProcessKey(req)
	logACPRetry(emit, req, fmt.Sprintf("ACP transport disconnected before response (%s); restarting agent process and retrying with the persisted session\n", err.Error()))
	stopLiveACPProcess(processKey)
	result, err = a.runACPAgent(ctx, cfg, req, emit)
	if err == nil || !isACPTransportDisconnect(err) || ctx.Err() != nil {
		return result, err
	}

	// A second transport disconnect usually means the native ACP session itself
	// is stale/corrupt (common after macOS sleep or a provider CLI crash). Drop the
	// daemon-side mapping and retry once with a fresh native ACP session while
	// keeping the OctoDeck conversation/workspace identity unchanged via metadata.
	deleteACPSessionRecordByKey(cfg, processKey)
	stopLiveACPProcess(processKey)
	freshReq := *req
	freshReq.Input = req.Input
	freshReq.Input.SessionID = ""
	logACPRetry(emit, req, fmt.Sprintf("ACP transport disconnected again (%s); dropping persisted ACP session and retrying with a fresh session\n", err.Error()))
	return a.runACPAgent(ctx, cfg, &freshReq, emit)
}

func logACPRetry(emit func(AgentRunEventFrame), req *AgentRunRequestFrame, text string) {
	if emit == nil || req == nil {
		return
	}
	emit(AgentRunEventFrame{
		Type:      tAgentRunEvent,
		RunID:     req.RunID,
		AgentID:   req.AgentID,
		EventType: "log",
		Text:      text,
		At:        formatTime(time.Now()),
	})
}

func isACPTransportDisconnect(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, io.EOF) || errors.Is(err, os.ErrClosed) {
		return true
	}
	msg := strings.ToLower(err.Error())
	// Direct transport-error phrases
	if strings.Contains(msg, "peer disconnected before response") ||
		strings.Contains(msg, "peer disconnected") ||
		strings.Contains(msg, "broken pipe") ||
		strings.Contains(msg, "use of closed") ||
		strings.Contains(msg, "unexpected eof") ||
		strings.Contains(msg, "connection reset") ||
		strings.Contains(msg, "transport error") {
		return true
	}
	// JSON-RPC internal error (-32603) that wraps a transport disconnect.
	// Some SDKs surface the real reason inside data.error of an Internal error.
	if strings.Contains(msg, "-32603") || strings.Contains(msg, `"internal error"`) {
		if strings.Contains(msg, "disconnect") ||
			strings.Contains(msg, "transport") ||
			strings.Contains(msg, "broken pipe") ||
			strings.Contains(msg, "eof") {
			return true
		}
	}
	return false
}

func acpConversationID(req *AgentRunRequestFrame) string {
	if req == nil {
		return ""
	}
	if req.Input.Metadata != nil {
		for _, key := range []string{"chatId", "conversationId", "conversationID", "sessionKey", "chatJid"} {
			if v, ok := req.Input.Metadata[key].(string); ok && strings.TrimSpace(v) != "" {
				return strings.TrimSpace(v)
			}
		}
	}
	if req.Workspace != nil && req.Workspace.ScopeID != "" && isAgentSessionScope(req.Workspace.Scope, req.Workspace.ScopeID) {
		return req.Workspace.ScopeID
	}
	if req.Input.SessionID != "" {
		return req.Input.SessionID
	}
	if req.Workspace != nil && req.Workspace.Folder != "" {
		return req.Workspace.Folder
	}
	return req.RunID
}

func acpSessionProcessKey(req *AgentRunRequestFrame) string {
	conversationID := acpConversationID(req)
	// ACP agents can pin the model and system instructions at native session
	// creation time. Include both in the warm-process/session key so a platform
	// model change or cloud-global-memory/system-prompt change cannot silently
	// reuse an ACP process/session that was created with stale instructions.
	digest := sha256.Sum256([]byte(req.AgentID + "\x00" + req.Cwd + "\x00" + conversationID + "\x00" + req.Policy.Model + "\x00" + req.Policy.SystemPrompt))
	return fmt.Sprintf("%s:%x", safePathSegment(req.AgentID), digest[:12])
}

func acpSessionMapPath(cfg *Config) string {
	return filepath.Join(stateDir(cfg), acpSessionMapFile)
}

func agentSessionMapRecord(key, conversationID string, client AgentClientInfo, req *AgentRunRequestFrame, sessionID string) acpSessionMapRecord {
	transport := client.Transport
	if transport == "" {
		transport = "stdio"
	}
	return acpSessionMapRecord{
		Key:            key,
		ConversationID: conversationID,
		AgentID:        req.AgentID,
		CLIName:        client.DisplayName,
		Provider:       ifEmpty(client.Provider, req.AgentID),
		Transport:      transport,
		Model:          req.Policy.Model,
		Cwd:            req.Cwd,
		SessionID:      sessionID,
	}
}

func readACPSessionMapLocked(cfg *Config) acpSessionMapFileData {
	data := acpSessionMapFileData{Version: 1, Records: map[string]acpSessionMapRecord{}}
	raw, err := os.ReadFile(acpSessionMapPath(cfg))
	if err != nil || len(strings.TrimSpace(string(raw))) == 0 {
		return data
	}
	if err := json.Unmarshal(raw, &data); err != nil || data.Records == nil {
		data.Version = 1
		data.Records = map[string]acpSessionMapRecord{}
	}
	return data
}

func lookupACPSessionRecord(cfg *Config, key string) (acpSessionMapRecord, bool) {
	acpSessionMapMu.Lock()
	defer acpSessionMapMu.Unlock()
	data := readACPSessionMapLocked(cfg)
	rec, ok := data.Records[key]
	return rec, ok
}

func writeACPSessionRecord(cfg *Config, rec acpSessionMapRecord) error {
	if rec.Key == "" || rec.SessionID == "" {
		return nil
	}
	acpSessionMapMu.Lock()
	defer acpSessionMapMu.Unlock()
	data := readACPSessionMapLocked(cfg)
	rec.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	data.Records[rec.Key] = rec
	path := acpSessionMapPath(cfg)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, raw, 0o600)
}

func deleteACPSessionRecordByKey(cfg *Config, key string) bool {
	if key == "" {
		return false
	}
	acpSessionMapMu.Lock()
	defer acpSessionMapMu.Unlock()
	data := readACPSessionMapLocked(cfg)
	if _, ok := data.Records[key]; !ok {
		return false
	}
	delete(data.Records, key)
	path := acpSessionMapPath(cfg)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return true
	}
	if raw, err := json.MarshalIndent(data, "", "  "); err == nil {
		_ = os.WriteFile(path, raw, 0o600)
	}
	return true
}

func deleteACPSessionRecords(cfg *Config, agentID, sessionID string) int {
	if agentID == "" || sessionID == "" {
		return 0
	}
	acpSessionMapMu.Lock()
	defer acpSessionMapMu.Unlock()
	data := readACPSessionMapLocked(cfg)
	deleted := 0
	for key, rec := range data.Records {
		if rec.AgentID == agentID && rec.SessionID == sessionID {
			delete(data.Records, key)
			deleted++
			stopLiveACPProcess(key)
		}
	}
	if deleted == 0 {
		return 0
	}
	path := acpSessionMapPath(cfg)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return deleted
	}
	if raw, err := json.MarshalIndent(data, "", "  "); err == nil {
		_ = os.WriteFile(path, raw, 0o600)
	}
	return deleted
}

func stopLiveACPProcess(key string) {
	acpProcessesMu.Lock()
	proc := acpProcesses[key]
	delete(acpProcesses, key)
	acpProcessesMu.Unlock()
	if proc != nil {
		proc.stop()
	}
}

func (p *acpSessionProcess) alive() bool {
	if p == nil || p.client == nil {
		return false
	}
	select {
	case <-p.done:
		return false
	default:
		return true
	}
}

func (p *acpSessionProcess) setHandler(handler func(*AgentRunEventFrame)) {
	p.mu.Lock()
	p.handler = handler
	p.mu.Unlock()
}

func (p *acpSessionProcess) dispatch(frame *AgentRunEventFrame) {
	p.mu.Lock()
	handler := p.handler
	p.mu.Unlock()
	if handler != nil && frame != nil {
		handler(frame)
	}
}

func (p *acpSessionProcess) stop() {
	if p == nil {
		return
	}
	if p.stdin != nil {
		_ = p.stdin.Close()
	}
	if p.cancel != nil {
		p.cancel()
	}
	if p.cmd != nil && p.cmd.Process != nil {
		_ = p.cmd.Process.Kill()
	}
}

func acpRemoveProcess(key string, p *acpSessionProcess) {
	acpProcessesMu.Lock()
	if acpProcesses[key] == p {
		delete(acpProcesses, key)
	}
	acpProcessesMu.Unlock()
}

func (a *acpAdapter) getOrStartACPProcess(ctx context.Context, cfg *Config, req *AgentRunRequestFrame, initSessionID string, emit func(AgentRunEventFrame)) (*acpSessionProcess, *acpsdk.InitializeResponse, error) {
	key := acpSessionProcessKey(req)
	acpProcessesMu.Lock()
	if p := acpProcesses[key]; p != nil && p.alive() {
		acpProcessesMu.Unlock()
		return p, nil, nil
	} else if p != nil {
		delete(acpProcesses, key)
	}
	acpProcessesMu.Unlock()
	if a.usesEmbeddedACPAdapter() {
		return a.startEmbeddedACPProcess(ctx, cfg, req, initSessionID, emit)
	}

	args := append([]string(nil), a.client.Args...)
	env := req.Env
	if a.entry != nil {
		if len(a.entry.Args) > 0 {
			args = append([]string(nil), a.entry.Args...)
		}
		env = mergeStringMaps(a.entry.Env, req.Env)
	}
	args = normalizeACPServerArgs(a.client.Binary, args, req.Policy)
	cmd := exec.Command(a.client.Binary, args...)
	cmd.Dir = req.Cwd
	cmd.Env = buildAgentEnv(cfg, req.AgentID, env, req.Context)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, nil, err
	}
	bridge := &acpSDKClientBridge{req: req}
	client := acpsdk.NewClientSideConnection(bridge, stdin, stdout)
	proc := &acpSessionProcess{key: key, agentID: req.AgentID, cwd: req.Cwd, cmd: cmd, stdin: stdin, client: client, done: make(chan error, 1), sessionID: initSessionID}
	bridge.dispatch = proc.dispatch
	var logSent atomic.Int64
	if err := cmd.Start(); err != nil {
		return nil, nil, err
	}
	go pumpAgentLog(stderr, req, &logSent, emit)
	go func() {
		err := cmd.Wait()
		proc.done <- err
		close(proc.done)
		acpRemoveProcess(key, proc)
	}()

	initResult, err := client.Initialize(ctx, acpsdk.InitializeRequest{
		ProtocolVersion: acpsdk.ProtocolVersionNumber,
		ClientInfo:      &acpsdk.Implementation{Name: "octodeck-daemon", Version: daemonVersion},
		ClientCapabilities: acpsdk.ClientCapabilities{
			Fs: acpsdk.FileSystemCapabilities{ReadTextFile: false, WriteTextFile: false},
		},
	})
	if err != nil {
		proc.stop()
		return nil, nil, err
	}
	acpProcessesMu.Lock()
	if existing := acpProcesses[key]; existing != nil && existing.alive() {
		acpProcessesMu.Unlock()
		proc.stop()
		return existing, nil, nil
	}
	acpProcesses[key] = proc
	acpProcessesMu.Unlock()
	return proc, &initResult, nil
}

func (a *acpAdapter) usesEmbeddedACPAdapter() bool {
	if a == nil {
		return false
	}
	switch a.client.ID {
	case "claude-acp", "codex-acp":
		return true
	default:
		return false
	}
}

func (a *acpAdapter) supportsNativeSystemPrompt() bool {
	return a != nil && a.usesEmbeddedACPAdapter()
}

func (a *acpAdapter) acpPromptText(req *AgentRunRequestFrame, createdNewSession bool) string {
	return promptWithSystemContext(req, createdNewSession && !a.supportsNativeSystemPrompt())
}

func (a *acpAdapter) startEmbeddedACPProcess(ctx context.Context, cfg *Config, req *AgentRunRequestFrame, initSessionID string, emit func(AgentRunEventFrame)) (*acpSessionProcess, *acpsdk.InitializeResponse, error) {
	key := acpSessionProcessKey(req)
	serverStdin, clientStdin := io.Pipe()
	clientStdout, serverStdout := io.Pipe()
	stderrReader, stderrWriter := io.Pipe()
	bridge := &acpSDKClientBridge{req: req}
	client := acpsdk.NewClientSideConnection(bridge, clientStdin, clientStdout)
	runCtx, cancel := context.WithCancel(context.Background())
	proc := &acpSessionProcess{key: key, agentID: req.AgentID, cwd: req.Cwd, stdin: clientStdin, client: client, done: make(chan error, 1), sessionID: initSessionID, cancel: cancel}
	bridge.dispatch = proc.dispatch
	var logSent atomic.Int64
	go pumpAgentLog(stderrReader, req, &logSent, emit)
	go func() {
		defer func() {
			_ = serverStdin.Close()
			_ = serverStdout.Close()
			_ = stderrWriter.Close()
			acpRemoveProcess(key, proc)
		}()
		var err error
		switch a.client.ID {
		case "claude-acp":
			err = claudeacp.RunStdio(runCtx, a.embeddedClaudeRuntimeConfig(req), serverStdin, serverStdout, stderrWriter)
		case "codex-acp":
			err = codexacp.RunStdio(runCtx, a.embeddedCodexRuntimeConfig(req), serverStdin, serverStdout, stderrWriter)
		default:
			err = fmt.Errorf("unsupported embedded ACP adapter: %s", a.client.ID)
		}
		proc.done <- err
		close(proc.done)
	}()

	initResult, err := client.Initialize(ctx, acpsdk.InitializeRequest{
		ProtocolVersion: acpsdk.ProtocolVersionNumber,
		ClientInfo:      &acpsdk.Implementation{Name: "octodeck-daemon", Version: daemonVersion},
		ClientCapabilities: acpsdk.ClientCapabilities{
			Fs: acpsdk.FileSystemCapabilities{ReadTextFile: false, WriteTextFile: false},
		},
	})
	if err != nil {
		proc.stop()
		return nil, nil, err
	}
	acpProcessesMu.Lock()
	if existing := acpProcesses[key]; existing != nil && existing.alive() {
		acpProcessesMu.Unlock()
		proc.stop()
		return existing, nil, nil
	}
	acpProcesses[key] = proc
	acpProcessesMu.Unlock()
	return proc, &initResult, nil
}

func (a *acpAdapter) embeddedClaudeRuntimeConfig(req *AgentRunRequestFrame) claudeacp.RuntimeConfig {
	config := claudeacp.DefaultRuntimeConfig()
	config.ClaudeBin = a.client.Binary
	if req != nil {
		profile := claudeacp.ProfileConfig{}
		if strings.TrimSpace(req.Policy.Model) != "" {
			model := strings.TrimSpace(req.Policy.Model)
			config.DefaultModel = model
			config.AvailableModels = append(config.AvailableModels, config.DefaultModel)
			profile.Model = model
		}
		profile.SystemInstructions = strings.TrimSpace(req.Policy.SystemPrompt)
		if profile.Model != "" || profile.SystemInstructions != "" {
			config.Profiles = map[string]claudeacp.ProfileConfig{"octodeck": profile}
			config.DefaultProfile = "octodeck"
		}
		config.SkipPerms = shouldAutoApprovePermission(req.Policy)
		if len(req.Policy.AllowedTools) > 0 {
			config.AllowedTools = strings.Join(req.Policy.AllowedTools, ",")
		}
	}
	config.LogLevel = firstNonEmpty(os.Getenv("ACP_ADAPTER_LOG_LEVEL"), os.Getenv("LOG_LEVEL"), "info")
	config.TraceJSON = parseBoolEnv(os.Getenv("ACP_ADAPTER_TRACE_JSON"), false)
	config.TraceJSONFile = firstNonEmpty(os.Getenv("ACP_ADAPTER_TRACE_JSON_FILE"), os.Getenv("TRACE_JSON_FILE"), "trace-jsonl.log")
	config.PatchApplyMode = firstNonEmpty(os.Getenv("ACP_ADAPTER_PATCH_APPLY_MODE"), os.Getenv("PATCH_APPLY_MODE"), "appserver")
	return config
}

func (a *acpAdapter) embeddedCodexRuntimeConfig(req *AgentRunRequestFrame) codexacp.RuntimeConfig {
	config := codexacp.DefaultRuntimeConfig()
	config.AppServerCommand = a.client.Binary
	config.AppServerArgs = []string{"app-server", "-c", "model_reasoning_summary=\"detailed\""}
	if raw := strings.TrimSpace(os.Getenv("CODEX_APP_SERVER_ARGS")); raw != "" {
		config.AppServerArgs = strings.Fields(raw)
	}
	config.LogLevel = firstNonEmpty(os.Getenv("ACP_ADAPTER_LOG_LEVEL"), os.Getenv("LOG_LEVEL"), "info")
	config.TraceJSON = parseBoolEnv(os.Getenv("ACP_ADAPTER_TRACE_JSON"), false)
	config.TraceJSONFile = firstNonEmpty(os.Getenv("ACP_ADAPTER_TRACE_JSON_FILE"), os.Getenv("TRACE_JSON_FILE"), "trace-jsonl.log")
	config.PatchApplyMode = firstNonEmpty(os.Getenv("ACP_ADAPTER_PATCH_APPLY_MODE"), os.Getenv("PATCH_APPLY_MODE"), "appserver")
	config.RetryTurnOnCrash = parseBoolEnv(os.Getenv("RETRY_TURN_ON_CRASH"), true)
	config.InitialAuthMode = detectCodexAuthMode()
	if req != nil && (strings.TrimSpace(req.Policy.Model) != "" || strings.TrimSpace(req.Policy.SystemPrompt) != "" || strings.TrimSpace(req.Policy.PermissionMode) != "") {
		config.Profiles = map[string]codexacp.ProfileConfig{
			"octodeck": {Model: strings.TrimSpace(req.Policy.Model), Sandbox: normalizeCodexPermissionMode(req.Policy.PermissionMode), SystemInstructions: strings.TrimSpace(req.Policy.SystemPrompt)},
		}
		config.DefaultProfile = "octodeck"
	}
	return config
}

func detectCodexAuthMode() string {
	if strings.TrimSpace(os.Getenv("CODEX_API_KEY")) != "" {
		return "codex_api_key"
	}
	if strings.TrimSpace(os.Getenv("OPENAI_API_KEY")) != "" {
		return "openai_api_key"
	}
	if parseBoolEnv(os.Getenv("CHATGPT_SUBSCRIPTION_ACTIVE"), true) {
		return "chatgpt_subscription"
	}
	return ""
}

func parseBoolEnv(raw string, fallback bool) bool {
	switch strings.TrimSpace(strings.ToLower(raw)) {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	case "":
		return fallback
	default:
		return fallback
	}
}

func normalizeACPServerArgs(binary string, args []string, policy AgentRunPolicy) []string {
	normalized := append([]string(nil), args...)
	name := filepath.Base(binary)
	if len(normalized) == 1 && normalized[0] == "acp" && requiresACPServeSubcommand(name) {
		normalized = append(normalized, "serve")
	}
	normalized = injectACPModelArgs(name, normalized, policy)
	if !shouldAutoApprovePermission(policy) {
		return normalized
	}
	return injectACPBypassArgs(name, normalized)
}

// injectACPModelArgs forwards the platform-selected model to the trae CLI ACP
// server. trae's ACP server does not honor the model carried via
// session/new meta, so without this flag the agent silently uses its own
// default model instead of the one the user picked. Mirrors the stdio path's
// "-c model.name=..." override.
func injectACPModelArgs(binaryName string, args []string, policy AgentRunPolicy) []string {
	model := strings.TrimSpace(policy.Model)
	if model == "" {
		return args
	}
	switch binaryName {
	case "coco", "traecli", "traex":
		// traex/coco/traecli all override config via `-c key=value`; the model
		// key is `model.name` for coco and `model` for traex, so we keep them
		// separate below.
		key := "model.name"
		if binaryName == "traex" {
			key = "model"
		}
		if acpHasConfigOverride(args, key) {
			return args
		}
		return append([]string{"-c", key + "=" + model}, args...)
	}
	return args
}

// acpHasConfigOverride checks whether an existing -c/--config k=v already sets
// the requested key, so we don't double-inject.
func acpHasConfigOverride(args []string, key string) bool {
	prefix := key + "="
	for i, v := range args {
		if v == "-c" || v == "--config" {
			if i+1 < len(args) && strings.HasPrefix(args[i+1], prefix) {
				return true
			}
		}
		if strings.HasPrefix(v, "-c=") && strings.HasPrefix(v[3:], prefix) {
			return true
		}
		if strings.HasPrefix(v, "--config=") && strings.HasPrefix(v[len("--config="):], prefix) {
			return true
		}
	}
	return false
}

// injectACPBypassArgs prepends the agent-specific bypass flag so the
// platform-side bypassPermissions / full-access setting actually reaches the
// device CLI. trae does NOT round-trip permission requests through ACP
// session/request_permission, so the daemon-side acpSDKClientBridge
// auto-allow path never fires for trae; the flag must be set at process
// spawn time. Both flags are global and must precede the acp subcommand.
func injectACPBypassArgs(binaryName string, args []string) []string {
	switch binaryName {
	case "coco", "traecli":
		if containsString(args, "-y") || containsString(args, "--yolo") {
			return args
		}
		return append([]string{"--yolo"}, args...)
	case "traex":
		if containsString(args, "--dangerously-bypass-approvals-and-sandbox") || containsString(args, "-y") {
			return args
		}
		return append([]string{"--dangerously-bypass-approvals-and-sandbox"}, args...)
	}
	return args
}

func requiresACPServeSubcommand(binaryName string) bool {
	switch binaryName {
	case "coco", "traecli", "traex":
		return true
	default:
		return false
	}
}

func prepareAgentRuntimeMCPConfig(cfg *Config, req *AgentRunRequestFrame, cwd string) error {
	switch req.AgentID {
	case "claude-code":
		_, err := writeAgentTeamMCPConfig(cfg, req.Env)
		return err
	case "codex", "traex":
		// traex 与 codex 共用 codex 风格 mcp 配置（在 $sessionDir/<provider>/config.toml）。
		return writeCodexMCPConfig(cfg, req, cwd)
	case "traecli":
		return writeAgentTeamMCPProjectConfig(cfg, cwd, req.Env)
	default:
		return nil
	}
}

func (a *plainCLIAdapter) BuildRunCommand(_ *Config, req *AgentRunRequestFrame) ([]string, bool, error) {
	return []string{promptWithSystemContext(req, req.Input.SessionID == "")}, false, nil
}

func (a *customStdioAdapter) BuildRunCommand(_ *Config, req *AgentRunRequestFrame) ([]string, bool, error) {
	args := append([]string(nil), a.entry.Args...)
	if len(args) == 0 {
		args = []string{"{{prompt}}"}
	}
	prompt := promptWithSystemContext(req, req.Input.SessionID == "")
	replacer := strings.NewReplacer(
		"{{prompt}}", prompt,
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
	if server, err := buildAgentTeamMCPServerConfig(cfg, req.Env); err == nil {
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
				m := runtimeRPCErrorString(msg.Error)
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

type acpSessionMapRecord struct {
	Key            string `json:"key"`
	ConversationID string `json:"conversationId"`
	AgentID        string `json:"agentId"`
	CLIName        string `json:"cliName,omitempty"`
	Provider       string `json:"provider,omitempty"`
	Transport      string `json:"transport,omitempty"`
	Model          string `json:"model,omitempty"`
	Cwd            string `json:"cwd"`
	SessionID      string `json:"sessionId"`
	UpdatedAt      string `json:"updatedAt"`
}

type acpSessionMapFileData struct {
	Version int                            `json:"version"`
	Records map[string]acpSessionMapRecord `json:"records"`
}

type acpSessionProcess struct {
	key       string
	agentID   string
	cwd       string
	cmd       *exec.Cmd
	stdin     io.WriteCloser
	client    *acpsdk.ClientSideConnection
	done      chan error
	sessionID string
	cancel    context.CancelFunc

	runMu   sync.Mutex
	mu      sync.Mutex
	handler func(*AgentRunEventFrame)
}

var (
	acpProcessesMu  sync.Mutex
	acpProcesses    = map[string]*acpSessionProcess{}
	acpSessionMapMu sync.Mutex
)

type acpSDKClientBridge struct {
	req      *AgentRunRequestFrame
	dispatch func(*AgentRunEventFrame)
}

func (b *acpSDKClientBridge) emit(frame AgentRunEventFrame) {
	if b.dispatch != nil {
		b.dispatch(&frame)
	}
}

func (b *acpSDKClientBridge) SessionUpdate(_ context.Context, params acpsdk.SessionNotification) error {
	if b == nil || b.req == nil {
		return nil
	}
	sessionID := string(params.SessionId)
	base := AgentRunEventFrame{Type: tAgentRunEvent, RunID: b.req.RunID, AgentID: b.req.AgentID, SessionID: sessionID, At: formatTime(time.Now())}
	u := params.Update
	switch {
	case u.AgentMessageChunk != nil:
		base.EventType = "text_delta"
		base.Text = acpSDKContentBlockText(u.AgentMessageChunk.Content, false)
		base.Payload = acpSDKPayloadVariant(u.AgentMessageChunk)
	case u.AgentThoughtChunk != nil:
		base.EventType = "thinking_delta"
		base.Text = acpSDKContentBlockText(u.AgentThoughtChunk.Content, true)
		base.Payload = acpSDKPayloadVariant(u.AgentThoughtChunk)
	case u.ToolCall != nil:
		base.EventType = "tool_use_start"
		tc := u.ToolCall
		payload := acpSDKPayloadVariant(tc)
		payload["toolUseId"] = string(tc.ToolCallId)
		payload["id"] = string(tc.ToolCallId)
		payload["toolName"] = tc.Title
		payload["name"] = tc.Title
		payload["title"] = tc.Title
		if tc.RawInput != nil {
			payload["input"] = tc.RawInput
			payload["rawInput"] = tc.RawInput
		}
		if tc.Status != "" {
			payload["status"] = string(tc.Status)
		}
		payload["content"] = tc.Content
		base.Payload = payload
	case u.ToolCallUpdate != nil:
		tcu := u.ToolCallUpdate
		base.EventType = "tool_use_end"
		if tcu.Status != nil && (*tcu.Status == acpsdk.ToolCallStatusPending || *tcu.Status == acpsdk.ToolCallStatusInProgress) {
			base.EventType = "tool_use_start"
		}
		payload := acpSDKPayloadVariant(tcu)
		payload["toolUseId"] = string(tcu.ToolCallId)
		payload["id"] = string(tcu.ToolCallId)
		if tcu.Title != nil {
			payload["toolName"] = *tcu.Title
			payload["name"] = *tcu.Title
			payload["title"] = *tcu.Title
		}
		if tcu.RawInput != nil {
			payload["input"] = tcu.RawInput
			payload["rawInput"] = tcu.RawInput
		}
		if tcu.RawOutput != nil {
			payload["result"] = tcu.RawOutput
			payload["content"] = tcu.RawOutput
		}
		if tcu.Status != nil {
			payload["status"] = string(*tcu.Status)
		}
		payload["toolCallContent"] = tcu.Content
		base.Payload = payload
	case u.UsageUpdate != nil:
		base.EventType = "usage"
		base.Payload = acpSDKPayloadVariant(u.UsageUpdate)
	case u.SessionInfoUpdate != nil:
		base.EventType = "session"
		base.Payload = acpSDKPayloadVariant(u.SessionInfoUpdate)
	default:
		base.EventType = "log"
		base.Payload = acpSDKPayload(params)
	}
	b.emit(base)
	return nil
}

func (b *acpSDKClientBridge) RequestPermission(_ context.Context, params acpsdk.RequestPermissionRequest) (acpsdk.RequestPermissionResponse, error) {
	if b != nil && b.req != nil && shouldAutoApprovePermission(b.req.Policy) {
		if optionID, ok := selectACPPermissionApprovalOption(params.Options); ok {
			return acpsdk.RequestPermissionResponse{Outcome: acpsdk.NewRequestPermissionOutcomeSelected(optionID)}, nil
		}
	}
	payload := acpSDKPayload(params)
	requestID := permissionRequestID(payload)
	if requestID == "" {
		requestID = fmt.Sprintf("%s-%d", b.req.RunID, time.Now().UnixNano())
		payload["requestId"] = requestID
	}
	b.emit(AgentRunEventFrame{Type: tAgentRunEvent, RunID: b.req.RunID, AgentID: b.req.AgentID, EventType: "permission_request", Payload: payload, At: formatTime(time.Now())})
	return acpsdk.RequestPermissionResponse{Outcome: acpsdk.NewRequestPermissionOutcomeCancelled()}, nil
}

func shouldAutoApprovePermission(policy AgentRunPolicy) bool {
	mode := strings.ToLower(strings.TrimSpace(policy.PermissionMode))
	switch mode {
	case "bypasspermissions", "full-access", "dangerously-skip-permissions", "no-approval", "auto-approve":
		return true
	default:
		return false
	}
}

func selectACPPermissionApprovalOption(options []acpsdk.PermissionOption) (acpsdk.PermissionOptionId, bool) {
	for _, want := range []acpsdk.PermissionOptionKind{acpsdk.PermissionOptionKindAllowAlways, acpsdk.PermissionOptionKindAllowOnce} {
		for _, option := range options {
			if option.Kind == want && option.OptionId != "" {
				return option.OptionId, true
			}
		}
	}
	for _, option := range options {
		label := strings.ToLower(string(option.OptionId) + " " + option.Name + " " + string(option.Kind))
		if option.OptionId != "" && (strings.Contains(label, "allow") || strings.Contains(label, "approve") || strings.Contains(label, "accept")) {
			return option.OptionId, true
		}
	}
	return "", false
}

func (b *acpSDKClientBridge) ReadTextFile(context.Context, acpsdk.ReadTextFileRequest) (acpsdk.ReadTextFileResponse, error) {
	return acpsdk.ReadTextFileResponse{}, errors.New("octodeck ACP bridge does not expose client fs.readTextFile")
}

func (b *acpSDKClientBridge) WriteTextFile(context.Context, acpsdk.WriteTextFileRequest) (acpsdk.WriteTextFileResponse, error) {
	return acpsdk.WriteTextFileResponse{}, errors.New("octodeck ACP bridge does not expose client fs.writeTextFile")
}

func (b *acpSDKClientBridge) CreateTerminal(context.Context, acpsdk.CreateTerminalRequest) (acpsdk.CreateTerminalResponse, error) {
	return acpsdk.CreateTerminalResponse{}, errors.New("octodeck ACP bridge does not expose client terminal/create")
}

func (b *acpSDKClientBridge) KillTerminal(context.Context, acpsdk.KillTerminalRequest) (acpsdk.KillTerminalResponse, error) {
	return acpsdk.KillTerminalResponse{}, nil
}

func (b *acpSDKClientBridge) TerminalOutput(context.Context, acpsdk.TerminalOutputRequest) (acpsdk.TerminalOutputResponse, error) {
	return acpsdk.TerminalOutputResponse{}, nil
}

func (b *acpSDKClientBridge) ReleaseTerminal(context.Context, acpsdk.ReleaseTerminalRequest) (acpsdk.ReleaseTerminalResponse, error) {
	return acpsdk.ReleaseTerminalResponse{}, nil
}

func (b *acpSDKClientBridge) WaitForTerminalExit(context.Context, acpsdk.WaitForTerminalExitRequest) (acpsdk.WaitForTerminalExitResponse, error) {
	return acpsdk.WaitForTerminalExitResponse{}, nil
}

func acpSDKPayload(value any) map[string]any {
	data, err := json.Marshal(value)
	if err != nil {
		return map[string]any{}
	}
	var payload map[string]any
	if err := json.Unmarshal(data, &payload); err != nil || payload == nil {
		return map[string]any{}
	}
	enrichACPToolPayload(payload)
	return payload
}

// acpSDKPayloadVariant serializes an ACP variant type (one of the SessionUpdate discriminated
// union members) to a map. These types declare their variant fields with `json:"-"` and rely on
// custom UnmarshalJSON, so a plain json.Marshal would drop most data. This helper marshals the
// value through reflection so we surface every exported field to the caller.
func acpSDKPayloadVariant(value any) map[string]any {
	payload := make(map[string]any)
	v := reflect.ValueOf(value)
	if v.Kind() == reflect.Ptr {
		if v.IsNil() {
			return payload
		}
		v = v.Elem()
	}
	if v.Kind() != reflect.Struct {
		data, err := json.Marshal(value)
		if err != nil {
			return payload
		}
		_ = json.Unmarshal(data, &payload)
		enrichACPToolPayload(payload)
		return payload
	}
	t := v.Type()
	for i := 0; i < v.NumField(); i++ {
		fv := v.Field(i)
		ft := t.Field(i)
		if !ft.IsExported() {
			continue
		}
		name := ft.Name
		if tag, ok := ft.Tag.Lookup("json"); ok {
			parts := strings.Split(tag, ",")
			if parts[0] == "-" {
				// Fields tagged json:"-" are still important for ACP variant types (they
				// carry the actual data under a different JSON key in the wire format, but
				// after the SDK's custom UnmarshalJSON they live here). Keep the Go name.
			} else if parts[0] != "" {
				name = parts[0]
			}
		}
		if fv.Kind() == reflect.Ptr {
			if fv.IsNil() {
				continue
			}
			payload[name] = fv.Elem().Interface()
			continue
		}
		if fv.Kind() == reflect.Interface {
			if fv.IsNil() {
				continue
			}
		}
		if fv.Kind() == reflect.Slice || fv.Kind() == reflect.Map {
			if fv.IsNil() {
				continue
			}
		}
		payload[name] = fv.Interface()
	}
	enrichACPToolPayload(payload)
	return payload
}

func acpSDKContentBlockText(block acpsdk.ContentBlock, includeThinking bool) string {
	if block.Text != nil {
		return block.Text.Text
	}
	data, err := json.Marshal(block)
	if err != nil {
		return ""
	}
	var payload any
	if json.Unmarshal(data, &payload) != nil {
		return ""
	}
	return acpContentText(payload, includeThinking)
}

func acpUsageToMap(usage *acpsdk.Usage) map[string]any {
	if usage == nil {
		return nil
	}
	out := acpSDKPayload(usage)
	out["input_tokens"] = usage.InputTokens
	out["output_tokens"] = usage.OutputTokens
	out["total_tokens"] = usage.TotalTokens
	if usage.CachedReadTokens != nil {
		out["cache_read_input_tokens"] = *usage.CachedReadTokens
	}
	if usage.CachedWriteTokens != nil {
		out["cache_creation_input_tokens"] = *usage.CachedWriteTokens
	}
	return out
}

func acpSDKMCPServers(cfg *Config, env ...map[string]string) []acpsdk.McpServer {
	server, err := buildAgentTeamMCPServerConfig(cfg, env...)
	if err != nil {
		return []acpsdk.McpServer{}
	}
	command, _ := server["command"].(string)
	if strings.TrimSpace(command) == "" {
		return []acpsdk.McpServer{}
	}
	args := make([]string, 0)
	switch raw := server["args"].(type) {
	case []string:
		args = append(args, raw...)
	case []any:
		for _, item := range raw {
			if s, ok := item.(string); ok {
				args = append(args, s)
			}
		}
	}
	envVars := make([]acpsdk.EnvVariable, 0)
	if rawEnv, ok := server["env"].(map[string]string); ok {
		for name, value := range rawEnv {
			envVars = append(envVars, acpsdk.EnvVariable{Name: name, Value: value})
		}
	} else if rawEnv, ok := server["env"].(map[string]any); ok {
		for name, value := range rawEnv {
			if s, ok := value.(string); ok {
				envVars = append(envVars, acpsdk.EnvVariable{Name: name, Value: s})
			}
		}
	}
	return []acpsdk.McpServer{{Stdio: &acpsdk.McpServerStdio{Name: "octodeck_agent_team", Command: command, Args: args, Env: envVars}}}
}

func (a *acpAdapter) runACPAgent(ctx context.Context, cfg *Config, req *AgentRunRequestFrame, emit func(AgentRunEventFrame)) (AgentRunResultFrame, error) {
	started := time.Now()
	conversationID := acpConversationID(req)
	processKey := acpSessionProcessKey(req)
	var sent atomic.Int64
	var finalMu sync.Mutex
	var finalText string
	sessionID := ""
	var finalUsage map[string]any
	proc, initResult, err := a.getOrStartACPProcess(ctx, cfg, req, "", emit)
	if err != nil {
		return AgentRunResultFrame{}, err
	}
	proc.runMu.Lock()
	defer proc.runMu.Unlock()
	defer proc.setHandler(nil)

	mcpServers := acpSDKMCPServers(cfg, req.Env)
	desiredSessionID := ""
	createdNewSession := false
	if rec, ok := lookupACPSessionRecord(cfg, processKey); ok && rec.SessionID != "" {
		// The daemon owns the chat-id -> native ACP session mapping. Prefer the
		// persisted local mapping over any server-provided sessionId so a workspace-
		// level/stale id cannot override the chat-specific session once established.
		desiredSessionID = rec.SessionID
	}
	if desiredSessionID == "" {
		desiredSessionID = req.Input.SessionID
	}
	if proc.sessionID != "" {
		sessionID = proc.sessionID
	} else if desiredSessionID != "" {
		// The daemon starts a fresh ACP process for each OctoDeck turn. For
		// continuity across processes we must load the persisted ACP session first;
		// session/resume is only a fallback for agents that support reconnecting to
		// an already-live session.
		if initResult != nil && initResult.AgentCapabilities.LoadSession {
			if _, err := proc.client.LoadSession(ctx, acpsdk.LoadSessionRequest{Cwd: req.Cwd, SessionId: acpsdk.SessionId(desiredSessionID), McpServers: mcpServers, Meta: map[string]any{"runId": req.RunID, "octodeckConversationId": conversationID, "policy": req.Policy}}); err == nil {
				sessionID = desiredSessionID
			}
		}
		if sessionID == "" && initResult != nil && initResult.AgentCapabilities.SessionCapabilities.Resume != nil {
			if _, err := proc.client.ResumeSession(ctx, acpsdk.ResumeSessionRequest{Cwd: req.Cwd, SessionId: acpsdk.SessionId(desiredSessionID), McpServers: mcpServers, Meta: map[string]any{"runId": req.RunID, "octodeckConversationId": conversationID, "policy": req.Policy}}); err == nil {
				sessionID = desiredSessionID
			}
		}
	}
	if sessionID == "" {
		created, err := proc.client.NewSession(ctx, acpsdk.NewSessionRequest{Cwd: req.Cwd, McpServers: mcpServers, Meta: map[string]any{"octodeckSessionId": req.Input.SessionID, "octodeckConversationId": conversationID, "runId": req.RunID, "policy": req.Policy}})
		if err != nil {
			return AgentRunResultFrame{}, err
		}
		createdNewSession = true
		sessionID = string(created.SessionId)
	}
	if sessionID == "" {
		sessionID = req.RunID
	}
	proc.sessionID = sessionID
	_ = writeACPSessionRecord(cfg, agentSessionMapRecord(processKey, conversationID, a.client, req, sessionID))

	// Attach the stream handler only for the actual prompt turn. Some ACP servers
	// (notably macOS traecli/coco) emit historical assistant messages while
	// session/load rehydrates an existing conversation. Treating those replayed
	// snapshots as fresh text_delta events makes OctoDeck resend every previous
	// assistant reply on each new user turn.
	proc.setHandler(func(frame *AgentRunEventFrame) {
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
		if frame.SessionID != "" && (sessionID == "" || req.Input.SessionID == "") {
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
	})
	promptResult, promptErr := proc.client.Prompt(ctx, acpsdk.PromptRequest{SessionId: acpsdk.SessionId(sessionID), Prompt: []acpsdk.ContentBlock{acpsdk.TextBlock(a.acpPromptText(req, createdNewSession))}, Meta: map[string]any{"policy": req.Policy, "context": req.Context, "octodeckConversationId": conversationID, "runId": req.RunID}})
	if promptErr == nil {
		if promptResult.Usage != nil {
			finalMu.Lock()
			finalUsage = acpUsageToMap(promptResult.Usage)
			finalMu.Unlock()
		}
	}
	timedOut := errors.Is(ctx.Err(), context.DeadlineExceeded)
	var errPtr *string
	if promptErr != nil {
		msg := promptErr.Error()
		errPtr = &msg
		if isACPTransportDisconnect(promptErr) {
			return AgentRunResultFrame{}, promptErr
		}
	}
	return AgentRunResultFrame{OK: errPtr == nil, Result: finalText, Error: errPtr, SessionID: sessionID, Usage: finalUsage, TimedOut: timedOut, DurationMs: time.Since(started).Milliseconds()}, nil
}

func callACPSessionMethod(ctx context.Context, client *acpClient, method, cwd, sessionID string, mcpServers map[string]any, meta map[string]any) (json.RawMessage, error) {
	params := acpSessionParams(cwd, sessionID, mcpServers, meta)
	result, err := client.call(ctx, method, params)
	if err == nil || len(mcpServers) == 0 || !strings.Contains(strings.ToLower(err.Error()), "mcp") {
		return result, err
	}
	// Some ACP bridges do not support per-session MCP server configuration. Retry
	// without mcpServers instead of silently falling back to session/new, which
	// would break OctoDeck session continuity.
	params = acpSessionParams(cwd, sessionID, nil, meta)
	return client.call(ctx, method, params)
}

func acpSessionParams(cwd, sessionID string, mcpServers map[string]any, meta map[string]any) map[string]any {
	params := map[string]any{"cwd": cwd}
	if sessionID != "" {
		params["sessionId"] = sessionID
	}
	if len(mcpServers) > 0 {
		params["mcpServers"] = mcpServers
	}
	if len(meta) > 0 {
		params["_meta"] = meta
	}
	return params
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
			return msg.Result, errors.New(runtimeRPCErrorString(msg.Error))
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

func acpSupportsLoadSession(raw json.RawMessage) bool {
	var m map[string]any
	if len(raw) == 0 || json.Unmarshal(raw, &m) != nil {
		return false
	}
	capabilities, _ := m["agentCapabilities"].(map[string]any)
	if capabilities == nil {
		return false
	}
	supported, _ := capabilities["loadSession"].(bool)
	return supported
}

func acpSupportsSessionResume(raw json.RawMessage) bool {
	var m map[string]any
	if len(raw) == 0 || json.Unmarshal(raw, &m) != nil {
		return false
	}
	capabilities, _ := m["agentCapabilities"].(map[string]any)
	if capabilities == nil {
		return false
	}
	sessionCapabilities, _ := capabilities["sessionCapabilities"].(map[string]any)
	if sessionCapabilities == nil {
		return false
	}
	resume, ok := sessionCapabilities["resume"]
	return ok && resume != nil
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

func acpMCPServers(cfg *Config, env ...map[string]string) map[string]any {
	server, err := buildAgentTeamMCPServerConfig(cfg, env...)
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
		frames := normalizeAgentJSONLineFrames(line)
		for _, frame := range frames {
			if frame.Text == "" && frame.SessionID == "" && frame.EventType == "log" {
				continue
			}
			if !allowAgentBytes(sent, int64(len(frame.Text)), req.MaxOutputBytes) {
				continue
			}
			if frame.Text == "" && frame.SessionID != "" && frame.EventType == "log" && looksLikeSessionNotification(frame.Payload) {
				frame.EventType = "session"
			}
			frame.Type = tAgentRunEvent
			frame.RunID = req.RunID
			frame.AgentID = req.AgentID
			frame.At = formatTime(time.Now())
			emit(frame)
		}
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
	frames := normalizeAgentJSONLineFrames(line)
	if len(frames) == 0 {
		return "log", "", "", nil
	}
	frame := frames[0]
	return frame.EventType, frame.Text, frame.SessionID, frame.Payload
}

func normalizeAgentJSONLineFrames(line string) []AgentRunEventFrame {
	var evt map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(line)), &evt); err != nil {
		return []AgentRunEventFrame{{EventType: "log"}}
	}
	sessionID, _ := evt["session_id"].(string)
	rawType, _ := evt["type"].(string)

	// --- 1. Typed frame types (exact match on evt["type"]) ---
	if rawType == "thinking" || rawType == "reasoning" || rawType == "reasoning_delta" {
		if text := firstString(evt, "thinking", "reasoning", "reason", "text", "content"); text != "" {
			return []AgentRunEventFrame{{EventType: "thinking_delta", Text: text, SessionID: sessionID, Payload: evt}}
		}
	}
	if rawType == "tool_use" || rawType == "tool_call" || rawType == "tool_use_start" {
		return []AgentRunEventFrame{{EventType: "tool_call", SessionID: sessionID, Payload: evt}}
	}
	if rawType == "tool_result" || rawType == "tool_use_end" {
		return []AgentRunEventFrame{{EventType: "tool_result", SessionID: sessionID, Payload: evt}}
	}
	if rawType == "usage" {
		return []AgentRunEventFrame{{EventType: "usage", SessionID: sessionID, Payload: evt}}
	}
	if rawType == "permission_request" || rawType == "approval_request" {
		return []AgentRunEventFrame{{EventType: "permission_request", SessionID: sessionID, Payload: evt}}
	}

	// --- 2. Anthropic stream-json: content_block_delta / content_block_start / message_delta ---
	if rawType == "content_block_delta" {
		if delta, ok := evt["delta"].(map[string]any); ok {
			deltaType, _ := delta["type"].(string)
			if deltaType == "thinking_delta" || deltaType == "reasoning_delta" {
				if text := firstString(delta, "thinking", "reasoning", "reason", "text"); text != "" {
					return []AgentRunEventFrame{{EventType: "thinking_delta", Text: text, SessionID: sessionID, Payload: evt}}
				}
			}
			if deltaType == "text_delta" {
				if text, _ := delta["text"].(string); text != "" {
					return []AgentRunEventFrame{{EventType: "text_delta", Text: text, SessionID: sessionID, Payload: evt}}
				}
			}
			if deltaType == "input_json_delta" {
				if partial, _ := delta["partial_json"].(string); partial != "" {
					return []AgentRunEventFrame{{EventType: "tool_call", SessionID: sessionID, Payload: evt}}
				}
			}
		}
		return nil
	}
	if rawType == "content_block_start" {
		if block, ok := evt["content_block"].(map[string]any); ok {
			blockType, _ := block["type"].(string)
			if blockType == "tool_use" {
				payload := agentBlockPayload(evt, block)
				return []AgentRunEventFrame{{EventType: "tool_call", SessionID: sessionID, Payload: payload}}
			}
		}
		return nil
	}
	if rawType == "content_block_stop" {
		return nil
	}
	if rawType == "message_stop" {
		// Final turn frame; may carry aggregate usage.
		if usage, ok := evt["usage"].(map[string]any); ok && len(usage) > 0 {
			return []AgentRunEventFrame{{EventType: "usage", SessionID: sessionID, Payload: evt}}
		}
		return nil
	}
	if rawType == "message_delta" {
		// message_delta may carry aggregate usage on turn completion.
		if usage, ok := evt["usage"].(map[string]any); ok && len(usage) > 0 {
			return []AgentRunEventFrame{{EventType: "usage", SessionID: sessionID, Payload: evt}}
		}
		// Don't early-return; section 6 may still extract stop_reason or other useful
		// metadata for tool events. Fall through without emitting text.
	}

	// --- 3. result field (generic single-shot completion output) ---
	//
	// NOTE: Some streaming CLIs (e.g. traecli --output-format=stream-json)
	// emit both incremental content_block_delta chunks AND a trailing
	// {"type":"result","result":"<complete answer>"} frame. If we treated
	// both as text_delta, the daemon-side finalText accumulator would double
	// up (chunks + full result). Use a separate event type so the accumulator
	// can only pick this up as a fallback when no streaming text was seen.
	if result, ok := evt["result"].(string); ok && result != "" {
		return []AgentRunEventFrame{{EventType: "final_result", Text: result, SessionID: sessionID, Payload: evt}}
	}

	// --- 4. standalone thinking fields at top level ---
	if text := firstString(evt, "thinking", "reasoning", "reason"); text != "" {
		return []AgentRunEventFrame{{EventType: "thinking_delta", Text: text, SessionID: sessionID, Payload: evt}}
	}

	// --- 5. delta (generic; stream_event wrapper or message_delta) ---
	if delta, ok := evt["delta"].(map[string]any); ok {
		deltaType, _ := delta["type"].(string)
		if deltaType == "thinking_delta" || deltaType == "reasoning_delta" {
			if text := firstString(delta, "thinking", "reasoning", "reason"); text != "" {
				return []AgentRunEventFrame{{EventType: "thinking_delta", Text: text, SessionID: sessionID, Payload: evt}}
			}
		}
		if deltaType == "text_delta" {
			if text, _ := delta["text"].(string); text != "" {
				return []AgentRunEventFrame{{EventType: "text_delta", Text: text, SessionID: sessionID, Payload: evt}}
			}
		}
		// message_delta may carry role=assistant + content
		if role, _ := delta["role"].(string); role == "assistant" {
			if content, _ := delta["content"].(string); content != "" {
				return []AgentRunEventFrame{{EventType: "text_delta", Text: content, SessionID: sessionID, Payload: evt}}
			}
		}
	}

	// --- 6. evt["message"] (assistant message / user tool-result echo / message_start) ---
	if msg, ok := evt["message"].(map[string]any); ok {
		role, _ := msg["role"].(string)
		isNonAssistantTextTurn := role == "user" || role == "system" || rawType == "user" || rawType == "system"
		// Streaming wrapper types (message_start, message_stop, message_delta, content_block_stop)
		// typically carry the fully assembled content after the incremental deltas have already
		// been streamed. Extracting text/thinking from these frames would duplicate the output.
		// Tool_use and tool_result blocks are still routed because some CLIs only include full
		// tool metadata in the assembled message.
		isStreamingWrapper := rawType == "message_start" || rawType == "message_stop" ||
			rawType == "message_delta" || rawType == "content_block_stop"
		if content, ok := msg["content"].(string); ok && content != "" {
			// Never emit text_delta for user/system turns; they contain the prompt, not the model response.
			if !isNonAssistantTextTurn && !isStreamingWrapper {
				return []AgentRunEventFrame{{EventType: "text_delta", Text: content, SessionID: sessionID, Payload: evt}}
			}
		}
		if blocks, ok := msg["content"].([]any); ok {
			frames := make([]AgentRunEventFrame, 0, len(blocks))
			for _, block := range blocks {
				m, _ := block.(map[string]any)
				typ, _ := m["type"].(string)
				payload := agentBlockPayload(evt, m)
				if typ == "tool_use" || typ == "tool_call" || typ == "tool_use_start" {
					frames = append(frames, AgentRunEventFrame{EventType: "tool_call", SessionID: sessionID, Payload: payload})
					continue
				}
				if typ == "tool_result" || typ == "tool_use_end" {
					frames = append(frames, AgentRunEventFrame{EventType: "tool_result", SessionID: sessionID, Payload: payload})
					continue
				}
				// thinking and assistant text are gated on non-user/system message role;
				// user turns sometimes contain tool_result content blocks (handled above) but never valid thinking/text output.
				if isNonAssistantTextTurn || isStreamingWrapper {
					continue
				}
				if typ == "thinking" || typ == "reasoning" {
					if text := firstString(m, "thinking", "reasoning", "reason", "text", "content"); text != "" {
						frames = append(frames, AgentRunEventFrame{EventType: "thinking_delta", Text: text, SessionID: sessionID, Payload: payload})
						continue
					}
				}
				if typ == "text" || typ == "output_text" || typ == "assistant" {
					if text, _ := m["text"].(string); text != "" {
						frames = append(frames, AgentRunEventFrame{EventType: "text_delta", Text: text, SessionID: sessionID, Payload: payload})
					}
				}
			}
			if len(frames) > 0 {
				return frames
			}
		}
	}

	// --- 7. standalone usage block at top level ---
	if usage, ok := evt["usage"].(map[string]any); ok {
		evt["usage"] = usage
		return []AgentRunEventFrame{{EventType: "usage", SessionID: sessionID, Payload: evt}}
	}
	return []AgentRunEventFrame{{EventType: "log", SessionID: sessionID, Payload: evt}}
}

func agentBlockPayload(evt map[string]any, block map[string]any) map[string]any {
	payload := make(map[string]any, len(block)+4)
	for k, v := range block {
		payload[k] = v
	}
	if sessionID, ok := evt["session_id"].(string); ok && sessionID != "" {
		payload["session_id"] = sessionID
	}
	if msgUUID, ok := evt["uuid"].(string); ok && msgUUID != "" {
		payload["message_uuid"] = msgUUID
	}
	if rawType, ok := evt["type"].(string); ok && rawType != "" {
		payload["message_type"] = rawType
	}
	payload["rawEvent"] = evt
	return payload
}

func firstString(m map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, _ := m[key].(string); value != "" {
			return value
		}
	}
	return ""
}

// looksLikeSessionNotification returns true when an otherwise-unclassified event
// payload appears to announce a session lifecycle event (created, resumed, etc.)
// rather than a generic streaming wrapper. We use this to gate the log→session
// promotion in pumpAgentStdout so that routine frame types such as message_start
// (which CLIs often tag with a session_id) do not flood the UI trace with
// spurious "状态: session" entries.
func looksLikeSessionNotification(payload map[string]any) bool {
	if len(payload) == 0 {
		return false
	}
	rawType := strings.ToLower(firstString(payload, "type", "event", "eventType", "kind", "status", "phase"))
	switch rawType {
	case "session", "session_created", "session_resumed", "session_loaded", "session_new", "new_session", "resume_session", "create_session":
		return true
	}
	// Some CLIs emit `{"event":"session","sessionId":"..."}` style notices.
	for _, key := range []string{"event", "action", "notification", "notice"} {
		if v, _ := payload[key].(string); v != "" {
			lower := strings.ToLower(v)
			if strings.Contains(lower, "session") && (strings.Contains(lower, "creat") || strings.Contains(lower, "resum") || strings.Contains(lower, "load") || strings.Contains(lower, "new") || strings.Contains(lower, "start")) {
				return true
			}
		}
	}
	return false
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
