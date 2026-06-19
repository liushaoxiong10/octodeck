package agentruntime

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"runtime/debug"
	"sync"
	"time"

	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
)

// ChildHandlers carries the business hooks invoked by ChildServer in response
// to each agent.* RPC. daemonapp supplies these closures so the generic JSON-RPC
// loop can live in agentruntime without importing daemonapp.
type ChildHandlers struct {
	OnDiscover      func(ctx context.Context, server *ChildServer, req *proto.AgentDiscoverRequestFrame)
	OnSessionsList  func(ctx context.Context, server *ChildServer, req *proto.AgentSessionsRequestFrame)
	OnSessionDelete func(ctx context.Context, server *ChildServer, req *proto.AgentSessionDeleteRequestFrame)
	OnRun           func(ctx context.Context, server *ChildServer, req *proto.AgentRunRequestFrame)
}

// ChildServer is the JSON-RPC server hosted in the agent-runtime child
// process. It reads framed RPC messages from in, dispatches agent.run /
// agent.cancel / agent.permission.decision / agent.discover / agent.sessions.*
// to caller-supplied handlers, and serialises responses + notifications back
// over out behind a single mutex.
type ChildServer struct {
	encMu     sync.Mutex
	out       io.Writer
	runsMu    sync.Mutex
	cancels   map[string]context.CancelFunc
	decisions map[string]chan proto.AgentPermissionDecisionFrame
	handlers  ChildHandlers
}

// NewChildServer returns a ChildServer that uses out as the response sink.
// The handlers map describes which hooks daemonapp wants invoked.
func NewChildServer(handlers ChildHandlers) *ChildServer {
	return &ChildServer{
		cancels:   make(map[string]context.CancelFunc),
		decisions: make(map[string]chan proto.AgentPermissionDecisionFrame),
		handlers:  handlers,
	}
}

// Serve loops reading newline-delimited RPC messages from in and dispatches
// them via the configured handlers. It returns when the input is exhausted or
// the scanner errors out.
func (s *ChildServer) Serve(in io.Reader, out io.Writer) error {
	s.out = out
	scanner := bufio.NewScanner(in)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		var msg RPCMessage
		if err := json.Unmarshal(scanner.Bytes(), &msg); err != nil {
			continue
		}
		switch msg.Method {
		case "agent.discover":
			var req proto.AgentDiscoverRequestFrame
			if err := json.Unmarshal(msg.Params, &req); err != nil {
				s.Respond(msg.ID, nil, err)
				continue
			}
			s.Respond(msg.ID, map[string]bool{"accepted": true}, nil)
			if s.handlers.OnDiscover != nil {
				go s.runHandler("agent.discover", "", "", func() {
					s.handlers.OnDiscover(context.Background(), s, &req)
				})
			}
		case "agent.sessions.list":
			var req proto.AgentSessionsRequestFrame
			if err := json.Unmarshal(msg.Params, &req); err != nil {
				s.Respond(msg.ID, nil, err)
				continue
			}
			s.Respond(msg.ID, map[string]bool{"accepted": true}, nil)
			if s.handlers.OnSessionsList != nil {
				go s.runHandler("agent.sessions.list", "", req.AgentID, func() {
					s.handlers.OnSessionsList(context.Background(), s, &req)
				})
			}
		case "agent.sessions.delete":
			var req proto.AgentSessionDeleteRequestFrame
			if err := json.Unmarshal(msg.Params, &req); err != nil {
				s.Respond(msg.ID, nil, err)
				continue
			}
			s.Respond(msg.ID, map[string]bool{"accepted": true}, nil)
			if s.handlers.OnSessionDelete != nil {
				go s.runHandler("agent.sessions.delete", "", req.AgentID, func() {
					s.handlers.OnSessionDelete(context.Background(), s, &req)
				})
			}
		case "agent.run":
			var req proto.AgentRunRequestFrame
			if err := json.Unmarshal(msg.Params, &req); err != nil {
				s.Respond(msg.ID, nil, err)
				continue
			}
			s.Respond(msg.ID, map[string]bool{"accepted": true}, nil)
			if s.handlers.OnRun != nil {
				go s.runHandler("agent.run", req.RunID, req.AgentID, func() {
					s.handlers.OnRun(context.Background(), s, &req)
				})
			}
		case "agent.cancel":
			var req proto.AgentRunCancelFrame
			if err := json.Unmarshal(msg.Params, &req); err != nil {
				s.Respond(msg.ID, nil, err)
				continue
			}
			s.runsMu.Lock()
			cancel := s.cancels[req.RunID]
			s.runsMu.Unlock()
			if cancel != nil {
				cancel()
			}
			s.Respond(msg.ID, map[string]bool{"cancelled": cancel != nil}, nil)
		case "agent.permission.decision":
			var req proto.AgentPermissionDecisionFrame
			if err := json.Unmarshal(msg.Params, &req); err != nil {
				s.Respond(msg.ID, nil, err)
				continue
			}
			s.runsMu.Lock()
			decisionCh := s.decisions[req.RunID+":"+req.RequestID]
			s.runsMu.Unlock()
			if decisionCh != nil {
				select {
				case decisionCh <- req:
				default:
				}
			}
			s.Respond(msg.ID, map[string]bool{"delivered": decisionCh != nil}, nil)
		default:
			s.Respond(msg.ID, nil, fmt.Errorf("unknown method: %s", msg.Method))
		}
	}
	return scanner.Err()
}

func (s *ChildServer) runHandler(method, runID, agentID string, fn func()) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("octodeck-daemon: agent-runtime handler panic method=%s runId=%s agent=%s panic=%v stack=%s", method, runID, agentID, r, debug.Stack())
		}
	}()
	fn()
}

// Respond writes a JSON-RPC response (success or error) for the given id.
// A nil id is interpreted as a notification and silently dropped.
func (s *ChildServer) Respond(id *int64, result any, err error) {
	if id == nil {
		return
	}
	msg := RPCMessage{JSONRPC: "2.0", ID: id}
	if err != nil {
		msg.Error = &RPCError{Code: -32000, Message: err.Error()}
	} else {
		b, _ := json.Marshal(result)
		msg.Result = b
	}
	s.write(msg)
}

// Notify emits an unsolicited JSON-RPC notification (no id) carrying params.
// Used for streaming agent.run.event / agent.run.status / etc.
func (s *ChildServer) Notify(method string, params any) {
	b, _ := json.Marshal(params)
	s.write(RPCMessage{JSONRPC: "2.0", Method: method, Params: b})
}

func (s *ChildServer) write(msg RPCMessage) {
	b, err := json.Marshal(msg)
	if err != nil {
		return
	}
	s.encMu.Lock()
	defer s.encMu.Unlock()
	_, _ = s.out.Write(append(b, '\n'))
}

// RegisterCancel publishes a cancel function for runID. The function is
// invoked by an inbound agent.cancel frame.
func (s *ChildServer) RegisterCancel(runID string, cancel context.CancelFunc) {
	s.runsMu.Lock()
	s.cancels[runID] = cancel
	s.runsMu.Unlock()
}

// UnregisterCancel removes the cancel function for runID.
func (s *ChildServer) UnregisterCancel(runID string) {
	s.runsMu.Lock()
	delete(s.cancels, runID)
	s.runsMu.Unlock()
}

// AwaitPermissionDecision blocks waiting for the platform server to deliver a
// decision for runID/requestID, returning either the decision or an error
// when the timeout / context fires.
func (s *ChildServer) AwaitPermissionDecision(ctx context.Context, runID, requestID string, timeout time.Duration) (proto.AgentPermissionDecisionFrame, error) {
	key := runID + ":" + requestID
	ch := make(chan proto.AgentPermissionDecisionFrame, 1)
	s.runsMu.Lock()
	s.decisions[key] = ch
	s.runsMu.Unlock()
	defer func() {
		s.runsMu.Lock()
		delete(s.decisions, key)
		s.runsMu.Unlock()
	}()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case decision := <-ch:
		return decision, nil
	case <-timer.C:
		return proto.AgentPermissionDecisionFrame{}, fmt.Errorf("permission decision timeout")
	case <-ctx.Done():
		return proto.AgentPermissionDecisionFrame{}, ctx.Err()
	}
}
