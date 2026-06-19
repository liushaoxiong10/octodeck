package session

import "strings"

// Provider metadata helpers.
//
// A Session carries two layers of provider-specific data:
//
//   - ProviderSessionID — the most recent native session id reported by the
//     agent backend (Claude sessionId, Codex sessionId, …). It is a single
//     string because adapters need to feed it back on resume.
//   - providerMeta      — a free-form map for everything else (resume token,
//     last model, last child pid, etc.).
//
// All accessors are safe under concurrent use.

// GetProviderSessionID returns the native session id last set via
// SetProviderSessionID.
func (s *Session) GetProviderSessionID() string {
	if s == nil {
		return ""
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.ProviderSessionID
}

// SetProviderSessionID stores the agent backend's native session id, after
// trimming whitespace. Empty values clear the field.
func (s *Session) SetProviderSessionID(id string) {
	if s == nil {
		return
	}
	id = strings.TrimSpace(id)
	s.mu.Lock()
	s.ProviderSessionID = id
	s.mu.Unlock()
}

// GetMeta returns the metadata value for key (or "" if unset).
func (s *Session) GetMeta(key string) string {
	if s == nil {
		return ""
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.providerMeta == nil {
		return ""
	}
	return s.providerMeta[key]
}

// SetMeta records a metadata pair for the session. An empty value deletes
// the key.
func (s *Session) SetMeta(key, value string) {
	if s == nil || key == "" {
		return
	}
	s.mu.Lock()
	if s.providerMeta == nil {
		s.providerMeta = make(map[string]string)
	}
	if value == "" {
		delete(s.providerMeta, key)
	} else {
		s.providerMeta[key] = value
	}
	s.mu.Unlock()
}

// SnapshotMeta returns a copy of the metadata map; safe to mutate by the
// caller without affecting the session.
func (s *Session) SnapshotMeta() map[string]string {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[string]string, len(s.providerMeta))
	for k, v := range s.providerMeta {
		out[k] = v
	}
	return out
}
