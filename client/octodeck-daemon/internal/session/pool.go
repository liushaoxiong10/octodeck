package session

import "sync"

// SessionPool is a concurrency-safe map[string]*Session used by Manager to
// hold its active sessions. It is intentionally minimal: a Manager wraps
// the pool with create/close semantics and event emission, while the pool
// itself only deals with map ops.
type SessionPool struct {
	mu sync.RWMutex
	m  map[string]*Session
}

// NewSessionPool returns an empty pool.
func NewSessionPool() *SessionPool {
	return &SessionPool{m: make(map[string]*Session)}
}

// Load returns the session for key, if any.
func (p *SessionPool) Load(key string) (*Session, bool) {
	if p == nil || key == "" {
		return nil, false
	}
	p.mu.RLock()
	defer p.mu.RUnlock()
	s, ok := p.m[key]
	return s, ok
}

// Store inserts s, overwriting any prior session with the same key.
func (p *SessionPool) Store(key string, s *Session) {
	if p == nil || key == "" || s == nil {
		return
	}
	p.mu.Lock()
	if p.m == nil {
		p.m = make(map[string]*Session)
	}
	p.m[key] = s
	p.mu.Unlock()
}

// LoadOrStore returns the existing session for key, or stores newSession
// and returns it. The boolean reports whether the entry already existed.
func (p *SessionPool) LoadOrStore(key string, newSession *Session) (*Session, bool) {
	if p == nil || key == "" || newSession == nil {
		return newSession, false
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.m == nil {
		p.m = make(map[string]*Session)
	}
	if existing, ok := p.m[key]; ok {
		return existing, true
	}
	p.m[key] = newSession
	return newSession, false
}

// Delete removes and returns the session at key.
func (p *SessionPool) Delete(key string) (*Session, bool) {
	if p == nil || key == "" {
		return nil, false
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	s, ok := p.m[key]
	if ok {
		delete(p.m, key)
	}
	return s, ok
}

// Range invokes fn for every (key, session) pair. The pool is held under a
// read lock for the duration of the iteration; fn must therefore not call
// back into Store/Delete on the same pool.
func (p *SessionPool) Range(fn func(key string, s *Session) bool) {
	if p == nil || fn == nil {
		return
	}
	p.mu.RLock()
	defer p.mu.RUnlock()
	for k, s := range p.m {
		if !fn(k, s) {
			return
		}
	}
}

// Len returns the number of stored sessions.
func (p *SessionPool) Len() int {
	if p == nil {
		return 0
	}
	p.mu.RLock()
	defer p.mu.RUnlock()
	return len(p.m)
}

// Snapshot returns a copy of the pool's contents as a slice.
func (p *SessionPool) Snapshot() []*Session {
	if p == nil {
		return nil
	}
	p.mu.RLock()
	defer p.mu.RUnlock()
	out := make([]*Session, 0, len(p.m))
	for _, s := range p.m {
		out = append(out, s)
	}
	return out
}
