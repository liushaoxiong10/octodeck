package agentruntime

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"sync"
	"sync/atomic"
	"time"

	daemonconfig "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/config"
	inventory "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/inventory"
	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
	state "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/state"
)

// SupervisorDeps captures the daemonapp-side helpers the supervisor needs.
// Keeping them as injected callbacks lets agentruntime live below daemonapp
// in the dependency graph (no import cycle).
type SupervisorDeps struct {
	// Validate runs the daemon's pre-flight checks before reserving a run
	// pool slot. Returning a non-nil error causes the supervisor to send an
	// error result frame instead of forwarding the request.
	Validate func(*proto.AgentRunRequestFrame) error

	// FormatTime renders a time.Time the way daemonapp formats it for status
	// frames (UTC RFC3339Nano). Injected to avoid an import on
	// daemonapp's helpers.
	FormatTime func(time.Time) string
}

// Supervisor lives in the daemon's main process and owns the agent-runtime
// child process. It speaks JSON-RPC over the child's stdin/stdout, multiplexes
// requests through pending callbacks, and translates inbound notifications
// back into agent-link frames.
type Supervisor struct {
	cfg  *daemonconfig.Config
	pool *state.RunPool
	send func(any) error
	deps SupervisorDeps

	mu          sync.Mutex
	cmd         *exec.Cmd
	stdin       io.WriteCloser
	childCtx    context.Context
	childCancel context.CancelFunc
	seq         int64
	pending     map[int64]chan error
	startedAt   time.Time
	crashCount  int
	lastCrashAt time.Time
}

// NewSupervisor returns a supervisor that lazily starts the agent-runtime
// child process on the first call to one of the Handle* methods.
func NewSupervisor(cfg *daemonconfig.Config, pool *state.RunPool, send func(any) error, deps SupervisorDeps) *Supervisor {
	return &Supervisor{cfg: cfg, pool: pool, send: send, deps: deps, pending: make(map[int64]chan error)}
}

// Close stops the managed agent-runtime child and releases pending RPC calls.
func (s *Supervisor) Close() {
	if s == nil {
		return
	}
	s.mu.Lock()
	cancel := s.childCancel
	stdin := s.stdin
	cmd := s.cmd
	pending := len(s.pending)
	s.childCancel = nil
	s.childCtx = nil
	s.stdin = nil
	s.cmd = nil
	for id, ch := range s.pending {
		delete(s.pending, id)
		ch <- errors.New("runtime stopped")
		close(ch)
	}
	s.mu.Unlock()
	if cmd != nil && cmd.Process != nil {
		log.Printf("octodeck-daemon: stopping agent-runtime pid=%d pending=%d", cmd.Process.Pid, pending)
	} else {
		log.Printf("octodeck-daemon: stopping agent-runtime pending=%d (no live child)", pending)
	}
	if stdin != nil {
		_ = stdin.Close()
	}
	if cancel != nil {
		cancel()
	}
	if cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
}

// Handle dispatches an agent.run request: validate, reserve a pool slot,
// announce "accepted", spawn the child if necessary, and forward the call.
func (s *Supervisor) Handle(ctx context.Context, req *proto.AgentRunRequestFrame) {
	acceptedAt := time.Now()
	log.Printf("octodeck-daemon: agent.run accepted request runId=%s agent=%s cwd=%s timeoutMs=%d promptBytes=%d sessionId=%s", req.RunID, req.AgentID, req.Cwd, req.TimeoutMs, len(req.Input.Prompt), req.Input.SessionID)
	if s.deps.Validate != nil {
		if err := s.deps.Validate(req); err != nil {
			log.Printf("octodeck-daemon: agent.run validation failed runId=%s agent=%s elapsedMs=%d err=%v", req.RunID, req.AgentID, time.Since(acceptedAt).Milliseconds(), err)
			s.sendAgentRunErr(req.RunID, req.AgentID, fmt.Errorf("validation: %w", err))
			return
		}
	}
	if !s.pool.Reserve(req.RunID) {
		log.Printf("octodeck-daemon: agent.run reserve failed runId=%s agent=%s elapsedMs=%d", req.RunID, req.AgentID, time.Since(acceptedAt).Milliseconds())
		s.sendAgentRunErr(req.RunID, req.AgentID, errors.New("run pool full or duplicate runId"))
		return
	}
	s.pool.NoteAccepted(req.RunID, req.AgentID, req.Cwd)
	_ = s.send(&proto.AgentRunStatusFrame{Type: proto.TAgentRunStatus, RunID: req.RunID, AgentID: req.AgentID, Status: "accepted", Cwd: req.Cwd})
	log.Printf("octodeck-daemon: agent.run accepted status sent runId=%s agent=%s elapsedMs=%d", req.RunID, req.AgentID, time.Since(acceptedAt).Milliseconds())

	runCtx, cancel := context.WithTimeout(ctx, time.Duration(req.TimeoutMs)*time.Millisecond)
	s.pool.Attach(req.RunID, nil, cancel)
	go func() {
		log.Printf("octodeck-daemon: agent.run goroutine start runId=%s agent=%s elapsedMs=%d", req.RunID, req.AgentID, time.Since(acceptedAt).Milliseconds())
		if err := s.ensureStarted(runCtx); err != nil {
			log.Printf("octodeck-daemon: agent.run ensure runtime failed runId=%s agent=%s elapsedMs=%d err=%v", req.RunID, req.AgentID, time.Since(acceptedAt).Milliseconds(), err)
			s.sendAgentRunErr(req.RunID, req.AgentID, fmt.Errorf("runtime start: %w", err))
			return
		}
		log.Printf("octodeck-daemon: agent.run runtime ready runId=%s agent=%s elapsedMs=%d", req.RunID, req.AgentID, time.Since(acceptedAt).Milliseconds())
		if err := s.call(runCtx, "agent.run", req); err != nil {
			log.Printf("octodeck-daemon: agent.run child rpc failed runId=%s agent=%s elapsedMs=%d err=%v", req.RunID, req.AgentID, time.Since(acceptedAt).Milliseconds(), err)
			s.sendAgentRunErr(req.RunID, req.AgentID, err)
			return
		}
		log.Printf("octodeck-daemon: agent.run child rpc completed runId=%s agent=%s elapsedMs=%d", req.RunID, req.AgentID, time.Since(acceptedAt).Milliseconds())
	}()
}

// CancelRun aborts a running agent.run by run id.
func (s *Supervisor) CancelRun(runID, reason string) bool {
	found := s.pool.CancelRun(runID)
	_ = s.call(context.Background(), "agent.cancel", &proto.AgentRunCancelFrame{Type: proto.TAgentRunCancel, RunID: runID, Reason: reason})
	return found
}

// HandleDiscover forwards an agent.discover request to the child runtime.
func (s *Supervisor) HandleDiscover(ctx context.Context, req *proto.AgentDiscoverRequestFrame) {
	log.Printf("octodeck-daemon: forwarding agent.discover requestId=%s", req.RequestID)
	go func() {
		if err := s.call(ctx, "agent.discover", req); err != nil {
			msg := err.Error()
			_ = s.send(&proto.AgentDiscoverResultFrame{Type: proto.TAgentDiscoverResult, RequestID: req.RequestID, OK: false, Agents: []inventory.Info{}, Error: &msg})
		}
	}()
}

// HandleSessions forwards an agent.sessions.list request.
func (s *Supervisor) HandleSessions(ctx context.Context, req *proto.AgentSessionsRequestFrame) {
	log.Printf("octodeck-daemon: forwarding agent.sessions.list requestId=%s workspace=%s", req.RequestID, req.Workspace)
	go func() {
		if err := s.call(ctx, "agent.sessions.list", req); err != nil {
			msg := err.Error()
			_ = s.send(&proto.AgentSessionsResultFrame{Type: proto.TAgentSessionsResult, RequestID: req.RequestID, OK: false, Sessions: []proto.AgentSessionInfo{}, Error: &msg})
		}
	}()
}

// HandleSessionDelete forwards an agent.sessions.delete request.
func (s *Supervisor) HandleSessionDelete(ctx context.Context, req *proto.AgentSessionDeleteRequestFrame) {
	log.Printf("octodeck-daemon: forwarding agent.sessions.delete requestId=%s agent=%s session=%s workspace=%s", req.RequestID, req.AgentID, req.SessionID, req.Workspace)
	go func() {
		if err := s.call(ctx, "agent.sessions.delete", req); err != nil {
			msg := err.Error()
			_ = s.send(&proto.AgentSessionDeleteResultFrame{Type: proto.TAgentSessionDeleteResult, RequestID: req.RequestID, OK: false, Deleted: false, Error: &msg})
		}
	}()
}

// HandlePermissionDecision forwards a permission decision back to the child.
func (s *Supervisor) HandlePermissionDecision(ctx context.Context, req *proto.AgentPermissionDecisionFrame) {
	go func() { _ = s.call(ctx, "agent.permission.decision", req) }()
}

func (s *Supervisor) formatTime(t time.Time) string {
	if s.deps.FormatTime != nil {
		return s.deps.FormatTime(t)
	}
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339Nano)
}

func (s *Supervisor) ensureStarted(ctx context.Context) error {
	s.mu.Lock()
	if s.cmd != nil && s.stdin != nil && s.cmd.Process != nil {
		pid := s.cmd.Process.Pid
		s.mu.Unlock()
		log.Printf("octodeck-daemon: reuse agent-runtime pid=%d", pid)
		return nil
	}
	if max := s.cfg.RuntimePolicy.MaxRestarts; max > 0 && s.crashCount >= max {
		crashes := s.crashCount
		s.mu.Unlock()
		return fmt.Errorf("runtime restart budget exhausted after %d crashes", crashes)
	}
	if !s.lastCrashAt.IsZero() {
		backoff := RestartBackoff(s.cfg.RuntimePolicy.RestartBackoffMs, s.crashCount)
		if wait := time.Until(s.lastCrashAt.Add(backoff)); wait > 0 {
			s.mu.Unlock()
			_ = s.send(&proto.AgentRuntimeStatusFrame{Type: proto.TAgentRuntimeStatus, RuntimeID: s.cfg.LinkID + ":agent-runtime", Status: "restarting", Message: fmt.Sprintf("restart backoff %s", wait.Round(time.Millisecond)), CrashCount: s.crashCount})
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
	log.Printf("octodeck-daemon: starting agent-runtime exe=%s args=%v crashCount=%d", exe, args, s.crashCount)
	childCtx, cancel := context.WithCancel(context.Background())
	cmd := exec.CommandContext(childCtx, exe, args...)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		cancel()
		s.mu.Unlock()
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		s.mu.Unlock()
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		cancel()
		s.mu.Unlock()
		return err
	}
	if err := cmd.Start(); err != nil {
		cancel()
		s.mu.Unlock()
		return err
	}
	s.cmd = cmd
	s.stdin = stdin
	s.childCtx = childCtx
	s.childCancel = cancel
	s.startedAt = time.Now()
	startedAt := s.startedAt
	crashCount := s.crashCount
	pid := cmd.Process.Pid
	s.mu.Unlock()
	log.Printf("octodeck-daemon: agent-runtime started pid=%d startedAt=%s crashCount=%d", pid, s.formatTime(startedAt), crashCount)
	_ = s.send(&proto.AgentRuntimeStatusFrame{Type: proto.TAgentRuntimeStatus, RuntimeID: s.cfg.LinkID + ":agent-runtime", Status: "running", StartedAt: s.formatTime(startedAt), CrashCount: crashCount})

	go s.readLoop(stdout)
	go s.stderrLoop(pid, stderr)
	go func() {
		waitErr := cmd.Wait()
		s.mu.Lock()
		wasCurrent := s.cmd == cmd
		if s.cmd == cmd {
			s.cmd = nil
			s.stdin = nil
			s.childCtx = nil
			s.childCancel = nil
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
		log.Printf("octodeck-daemon: agent-runtime exited pid=%d current=%t err=%v crashCount=%d", pid, wasCurrent, waitErr, crashCount)
		_ = s.send(&proto.AgentRuntimeStatusFrame{Type: proto.TAgentRuntimeStatus, RuntimeID: s.cfg.LinkID + ":agent-runtime", Status: "offline", Message: "runtime exited", CrashCount: crashCount})
	}()
	return nil
}

func (s *Supervisor) stderrLoop(pid int, r io.Reader) {
	log.Printf("octodeck-daemon: agent-runtime stderr loop started pid=%d", pid)
	defer log.Printf("octodeck-daemon: agent-runtime stderr loop stopped pid=%d", pid)
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		log.Printf("octodeck-daemon: agent-runtime stderr pid=%d line=%q", pid, scanner.Text())
	}
	if err := scanner.Err(); err != nil {
		log.Printf("octodeck-daemon: agent-runtime stderr scan failed pid=%d err=%v", pid, err)
	}
}

func (s *Supervisor) call(ctx context.Context, method string, params any) error {
	if err := s.ensureStarted(ctx); err != nil {
		return err
	}
	id := atomic.AddInt64(&s.seq, 1)
	paramsJSON, err := json.Marshal(params)
	if err != nil {
		return err
	}
	msg := RPCMessage{JSONRPC: "2.0", ID: &id, Method: method, Params: paramsJSON}
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	ch := make(chan error, 1)
	s.mu.Lock()
	s.pending[id] = ch
	stdin := s.stdin
	pid := 0
	if s.cmd != nil && s.cmd.Process != nil {
		pid = s.cmd.Process.Pid
	}
	runID := ""
	agentID := ""
	if req, ok := params.(*proto.AgentRunRequestFrame); ok && req != nil {
		runID = req.RunID
		agentID = req.AgentID
	}
	_, err = stdin.Write(append(data, '\n'))
	if err != nil {
		delete(s.pending, id)
	}
	s.mu.Unlock()
	if err != nil {
		return err
	}
	log.Printf("octodeck-daemon: agent-runtime rpc sent id=%d method=%s pid=%d runId=%s agent=%s", id, method, pid, runID, agentID)
	defer s.cleanupPending(id, ch)
	timer := time.NewTimer(10 * time.Second)
	defer timer.Stop()
	select {
	case err := <-ch:
		if err != nil {
			log.Printf("octodeck-daemon: agent-runtime rpc failed id=%d method=%s pid=%d runId=%s agent=%s err=%v", id, method, pid, runID, agentID, err)
		} else {
			log.Printf("octodeck-daemon: agent-runtime rpc completed id=%d method=%s pid=%d runId=%s agent=%s", id, method, pid, runID, agentID)
		}
		return err
	case <-ctx.Done():
		log.Printf("octodeck-daemon: agent-runtime rpc context done id=%d method=%s pid=%d runId=%s agent=%s err=%v", id, method, pid, runID, agentID, ctx.Err())
		return ctx.Err()
	case <-timer.C:
		log.Printf("octodeck-daemon: agent-runtime rpc timeout id=%d method=%s pid=%d runId=%s agent=%s", id, method, pid, runID, agentID)
		return errors.New("runtime rpc timeout")
	}
}

func (s *Supervisor) cleanupPending(id int64, ch chan error) {
	s.mu.Lock()
	if s.pending[id] == ch {
		delete(s.pending, id)
	}
	s.mu.Unlock()
}

func (s *Supervisor) readLoop(r io.Reader) {
	log.Printf("octodeck-daemon: agent-runtime read loop started")
	defer log.Printf("octodeck-daemon: agent-runtime read loop stopped")
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		var msg RPCMessage
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
					ch <- errors.New(FormatRPCErrorString(msg.Error))
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

func (s *Supervisor) handleNotification(msg RPCMessage) {
	switch msg.Method {
	case "agent.run.status":
		var f proto.AgentRunStatusFrame
		if json.Unmarshal(msg.Params, &f) == nil {
			log.Printf("octodeck-daemon: agent-runtime notify status runId=%s agent=%s status=%s", f.RunID, f.AgentID, f.Status)
			_ = s.send(&f)
		}
	case "agent.run.event":
		var f proto.AgentRunEventFrame
		if json.Unmarshal(msg.Params, &f) == nil {
			s.pool.NoteActivity(f.RunID)
			if f.EventType != "log" {
				log.Printf("octodeck-daemon: agent-runtime notify event runId=%s agent=%s eventType=%s textBytes=%d sessionId=%s", f.RunID, f.AgentID, f.EventType, len(f.Text), f.SessionID)
			}
			_ = s.send(&f)
		}
	case "agent.run.result":
		var f proto.AgentRunResultFrame
		if json.Unmarshal(msg.Params, &f) == nil {
			s.pool.CancelRun(f.RunID)
			s.pool.Release(f.RunID)
			log.Printf("octodeck-daemon: agent-runtime notify result runId=%s agent=%s ok=%t timedOut=%t durationMs=%d resultBytes=%d hasError=%t", f.RunID, f.AgentID, f.OK, f.TimedOut, f.DurationMs, len(f.Result), f.Error != nil)
			_ = s.send(&f)
		}
	case "agent.discover.result":
		var f proto.AgentDiscoverResultFrame
		if json.Unmarshal(msg.Params, &f) == nil {
			s.cfg.AgentClients = f.Agents
			_ = s.send(&f)
		}
	case "agent.sessions.result":
		var f proto.AgentSessionsResultFrame
		if json.Unmarshal(msg.Params, &f) == nil {
			_ = s.send(&f)
		}
	case "agent.session.delete.result":
		var f proto.AgentSessionDeleteResultFrame
		if json.Unmarshal(msg.Params, &f) == nil {
			_ = s.send(&f)
		}
	case "agent.runtime.status":
		var f proto.AgentRuntimeStatusFrame
		if json.Unmarshal(msg.Params, &f) == nil {
			_ = s.send(&f)
		}
	}
}

func (s *Supervisor) sendAgentRunErr(runID, agentID string, err error) {
	msg := err.Error()
	s.pool.CancelRun(runID)
	s.pool.Release(runID)
	_ = s.send(&proto.AgentRunStatusFrame{Type: proto.TAgentRunStatus, RunID: runID, AgentID: agentID, Status: "failed", Message: msg})
	_ = s.send(&proto.AgentRunResultFrame{Type: proto.TAgentRunResult, RunID: runID, AgentID: agentID, OK: false, Error: &msg, ErrorInfo: &proto.AgentRunError{Code: "runtime_error", Message: msg, Retryable: true}, TimedOut: false, DurationMs: 0})
}
