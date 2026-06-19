package session

import "time"

// Cancel-function bookkeeping is split out of session.go so that the run
// lifecycle (register → cancel → clear) can evolve independently of the
// session struct itself. The methods below all operate on *Session, with
// the cancel-fn map (Session.cancelFn) hosted in session.go to keep struct
// initialisation in a single place.

// RegisterCancel stores a cancel function for a run. Repeated registration
// for the same runID overwrites the previous function. The session's
// LastUsedAt is bumped, the state is moved to StateRunning, and a
// run_started event is emitted.
func (s *Session) RegisterCancel(runID string, cancel func()) {
	if s == nil || runID == "" {
		return
	}
	s.mu.Lock()
	if s.cancelFn == nil {
		s.cancelFn = make(map[string]func())
	}
	s.cancelFn[runID] = cancel
	s.LastUsedAt = time.Now()
	if !s.Status.IsTerminal() {
		s.Status = StateRunning
	}
	s.mu.Unlock()
	s.emit(SessionEvent{Kind: EventRunStarted, RunID: runID})
}

// CancelRun invokes and removes the cancel function for runID. Returns
// true if a registered run was cancelled.
func (s *Session) CancelRun(runID string) bool {
	if s == nil || runID == "" {
		return false
	}
	s.mu.Lock()
	cancel, ok := s.cancelFn[runID]
	if ok {
		delete(s.cancelFn, runID)
	}
	remaining := len(s.cancelFn)
	if ok && remaining == 0 && s.Status == StateRunning {
		s.Status = StateIdle
	}
	s.mu.Unlock()
	if ok && cancel != nil {
		cancel()
	}
	if ok {
		s.emit(SessionEvent{Kind: EventRunFinished, RunID: runID})
	}
	return ok
}

// ClearCancels drops every registered cancel function without invoking
// them. Used during Close where the parent context cancel has already
// taken care of stopping the work.
func (s *Session) ClearCancels() {
	if s == nil {
		return
	}
	s.mu.Lock()
	s.cancelFn = make(map[string]func())
	if s.Status == StateRunning {
		s.Status = StateIdle
	}
	s.mu.Unlock()
}

// ActiveRuns returns the number of registered cancel functions, useful for
// diagnostics and idle-session reaping.
func (s *Session) ActiveRuns() int {
	if s == nil {
		return 0
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.cancelFn)
}
