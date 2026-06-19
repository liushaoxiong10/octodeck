// Package session manages the daemon's long-lived work contexts.
//
// A Session corresponds to a platform conversation stream, task, issue run,
// or other sustained execution scope. Each session owns its agent runtime
// instance, workspace, and provider session metadata.
//
// The package is intentionally free of any agentruntime / daemonapp
// dependency to keep callers (agentruntime supervisor, executor, node) from
// pulling cyclic imports. The Runtime field therefore carries an opaque
// `any` value; callers cast it back to agentruntime.Agent as needed.
package session

import (
	"context"
	"sync"
	"time"
)

// Session is the daemon's long-lived work context for a single execution
// scope (conversation, task, issue run, etc.).
type Session struct {
	// Key uniquely identifies this session (e.g. conversation ID, task ID).
	Key string

	// AgentID is the agent client that owns this session.
	AgentID string

	// Cwd is the resolved working directory for this session.
	Cwd string

	// Runtime is the agent runtime instance for this session. It is typed
	// as `any` to avoid an import cycle with internal/agentruntime; callers
	// (such as the executor) assert it to agentruntime.Agent.
	Runtime any

	// ProviderSessionID is the agent provider's native session ID
	// (e.g. Claude sessionId, Codex sessionId). This is metadata, not a
	// scheduling object.
	ProviderSessionID string

	// CreatedAt records when the Session was constructed.
	CreatedAt time.Time

	// LastUsedAt is bumped every time a run is registered or an explicit
	// Touch() happens. The Manager uses it for idle-pool reaping.
	LastUsedAt time.Time

	// Status tracks the lifecycle state of the session.
	Status State

	// parent is the parent context for runs spawned inside this session.
	// It is initialised by Manager.GetOrCreate and cancelled on Close.
	parent    context.Context
	parentCxl context.CancelFunc

	// providerMeta holds free-form provider-specific metadata (e.g. Claude
	// session sub-ids, Codex resume tokens, etc.).
	providerMeta map[string]string

	// subscribers receive SessionEvent notifications. Guarded by mu.
	subscribers []chan SessionEvent

	mu       sync.Mutex
	cancelFn map[string]func() // runID -> cancel
}

// New creates a session with the given key and agent ID. The returned
// session is in the Idle state with an empty parent context; prefer
// Manager.GetOrCreate when a managed lifecycle is desired.
func New(key, agentID string) *Session {
	now := time.Now()
	parent, cxl := context.WithCancel(context.Background())
	return &Session{
		Key:          key,
		AgentID:      agentID,
		CreatedAt:    now,
		LastUsedAt:   now,
		Status:       StateIdle,
		parent:       parent,
		parentCxl:    cxl,
		providerMeta: make(map[string]string),
		cancelFn:     make(map[string]func()),
	}
}

// Context returns the session's parent context. Runs spawned inside the
// session should derive their per-run context from it; cancelling the
// session aborts every run derived from this context.
func (s *Session) Context() context.Context {
	if s == nil {
		return context.Background()
	}
	return s.parent
}

// Touch updates LastUsedAt to now.
func (s *Session) Touch() {
	if s == nil {
		return
	}
	s.mu.Lock()
	s.LastUsedAt = time.Now()
	s.mu.Unlock()
}

// Close cancels the parent context, invokes any outstanding cancel
// functions, and transitions the session to StateClosed. It is safe to
// call multiple times.
func (s *Session) Close() {
	if s == nil {
		return
	}
	s.mu.Lock()
	if s.Status == StateClosed {
		s.mu.Unlock()
		return
	}
	s.Status = StateClosing
	cancels := s.cancelFn
	s.cancelFn = make(map[string]func())
	cxl := s.parentCxl
	s.mu.Unlock()

	for _, c := range cancels {
		if c != nil {
			c()
		}
	}
	if cxl != nil {
		cxl()
	}

	s.mu.Lock()
	s.Status = StateClosed
	s.mu.Unlock()
	s.emit(SessionEvent{Kind: EventClosed, Key: s.Key, At: time.Now()})
}
