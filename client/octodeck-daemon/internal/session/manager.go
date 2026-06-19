package session

import "time"

// Manager is the daemon-wide registry of live Sessions. It owns a
// SessionPool, hands out session keys derived via KeyForRequest, and
// coordinates create/close lifecycle events.
//
// A zero-value Manager is not usable; construct via NewManager.
type Manager struct {
	pool *SessionPool
}

// NewManager creates an empty Manager.
func NewManager() *Manager {
	return &Manager{pool: NewSessionPool()}
}

// GetOrCreate returns the session for key, creating one bound to agentID
// when none exists. The boolean reports whether a fresh session was
// created (true) or an existing one was returned (false).
//
// A nil/empty key is rejected with (nil, false).
func (m *Manager) GetOrCreate(key, agentID string) (*Session, bool) {
	if m == nil || key == "" {
		return nil, false
	}
	if existing, ok := m.pool.Load(key); ok {
		existing.Touch()
		return existing, false
	}
	candidate := New(key, agentID)
	got, existed := m.pool.LoadOrStore(key, candidate)
	if existed {
		// Lost the race: discard our candidate's parent context.
		candidate.parentCxl()
		got.Touch()
		return got, false
	}
	got.emit(SessionEvent{Kind: EventCreated, Key: key, At: time.Now()})
	return got, true
}

// Find returns the session for key, if any. It does not create a session.
func (m *Manager) Find(key string) (*Session, bool) {
	if m == nil || key == "" {
		return nil, false
	}
	return m.pool.Load(key)
}

// Close removes the session at key (if present) and cancels its work.
// Returns true if a session was removed.
func (m *Manager) Close(key string) bool {
	if m == nil || key == "" {
		return false
	}
	s, ok := m.pool.Delete(key)
	if !ok {
		return false
	}
	s.Close()
	return true
}

// List returns a snapshot of all live sessions. The returned slice is a
// fresh copy and may be mutated freely.
func (m *Manager) List() []*Session {
	if m == nil {
		return nil
	}
	return m.pool.Snapshot()
}

// Range invokes fn for every session in the manager. Iteration stops
// early when fn returns false.
func (m *Manager) Range(fn func(key string, s *Session) bool) {
	if m == nil {
		return
	}
	m.pool.Range(fn)
}

// CloseAll removes and closes every session in the manager.
func (m *Manager) CloseAll() {
	if m == nil {
		return
	}
	for _, s := range m.pool.Snapshot() {
		if removed, ok := m.pool.Delete(s.Key); ok {
			removed.Close()
		}
	}
}

// Len returns the number of live sessions.
func (m *Manager) Len() int {
	if m == nil {
		return 0
	}
	return m.pool.Len()
}
