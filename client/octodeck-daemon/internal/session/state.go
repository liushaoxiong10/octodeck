package session

import "fmt"

// State is the lifecycle state of a Session. A session moves monotonically
// through Idle → Running → Idle (zero or more times) → Closing → Closed.
type State int

const (
	// StateIdle means the session has no active run. New() returns sessions
	// in this state.
	StateIdle State = iota
	// StateRunning means at least one run is currently in flight on the
	// session's runtime.
	StateRunning
	// StateClosing means Close() was called and outstanding runs are being
	// cancelled. Brief, transitional.
	StateClosing
	// StateClosed is terminal: no further runs may be registered.
	StateClosed
)

// String renders the state for log lines / diagnostics.
func (s State) String() string {
	switch s {
	case StateIdle:
		return "idle"
	case StateRunning:
		return "running"
	case StateClosing:
		return "closing"
	case StateClosed:
		return "closed"
	default:
		return fmt.Sprintf("state(%d)", int(s))
	}
}

// IsTerminal reports whether the state forbids further work.
func (s State) IsTerminal() bool {
	return s == StateClosing || s == StateClosed
}

// SetState transitions the session to the given state. It refuses to move
// out of a terminal state. Returns the previous state and whether the
// transition occurred.
func (s *Session) SetState(next State) (State, bool) {
	if s == nil {
		return StateClosed, false
	}
	s.mu.Lock()
	prev := s.Status
	if prev.IsTerminal() && next != StateClosed {
		s.mu.Unlock()
		return prev, false
	}
	s.Status = next
	s.mu.Unlock()
	return prev, true
}

// MarkRunning is shorthand for SetState(StateRunning) and bumps LastUsedAt.
func (s *Session) MarkRunning() bool {
	if s == nil {
		return false
	}
	_, ok := s.SetState(StateRunning)
	s.Touch()
	return ok
}

// MarkIdle is shorthand for SetState(StateIdle) used at run completion.
func (s *Session) MarkIdle() bool {
	if s == nil {
		return false
	}
	_, ok := s.SetState(StateIdle)
	s.Touch()
	return ok
}

// CurrentState returns the Status field under the session lock.
func (s *Session) CurrentState() State {
	if s == nil {
		return StateClosed
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.Status
}
