package agentruntime

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	daemonconfig "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/config"
)

// PersistentStoreFileName is the on-disk file holding the conversation→session
// map. It replaces the four per-family `agent-session-map.json` files (one per
// claude/codex/traecli/traex sub-package, all writing the same path with
// different in-memory mutexes — a quiet correctness hazard).
//
// The new layout keys records by ConversationID, the platform-stable id the
// AgentRuntime layer uses to look up a live Instance. Daemon restart can
// therefore restore conversation continuity by LoadSession on the recorded
// SessionID.
const PersistentStoreFileName = "conversation-session-map.json"

// StoreRecord is one conversation↔session mapping persisted to disk.
type StoreRecord struct {
	ConversationID string `json:"conversationId"`
	AgentClientID  string `json:"agentClientId"`
	Cwd            string `json:"cwd,omitempty"`
	Model          string `json:"model,omitempty"` // diagnostic only
	SessionID      string `json:"sessionId"`
	UpdatedAt      string `json:"updatedAt"`
}

// storeFileData is the serialized form of the store. Version is reserved for
// future migrations.
type storeFileData struct {
	Version int                    `json:"version"`
	Records map[string]StoreRecord `json:"records"`
}

// PersistentStore is the thread-safe accessor for the conversation→session
// map. Like the per-family Store it replaces, it reads/writes the underlying
// file on every call (no in-memory cache) so concurrent daemon and runtime-
// child processes stay consistent.
type PersistentStore struct {
	mu sync.Mutex
}

// NewPersistentStore returns a fresh PersistentStore. Callers usually share
// one per daemon process via DefaultPersistentStore.
func NewPersistentStore() *PersistentStore { return &PersistentStore{} }

// PersistentStorePath is the on-disk path for the conversation map.
func PersistentStorePath(cfg *daemonconfig.Config) string {
	return filepath.Join(daemonconfig.StateDir(cfg), PersistentStoreFileName)
}

// LookupByConversation returns the stored record for conversationID, or false
// if none exists.
func (s *PersistentStore) LookupByConversation(cfg *daemonconfig.Config, conversationID string) (StoreRecord, bool) {
	if strings.TrimSpace(conversationID) == "" {
		return StoreRecord{}, false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	data := readStoreFile(cfg)
	rec, ok := data.Records[conversationID]
	return rec, ok
}

// Write persists rec under its ConversationID, stamping UpdatedAt.
func (s *PersistentStore) Write(cfg *daemonconfig.Config, rec StoreRecord) error {
	if strings.TrimSpace(rec.ConversationID) == "" || strings.TrimSpace(rec.SessionID) == "" {
		return errors.New("PersistentStore.Write: ConversationID and SessionID are required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	data := readStoreFile(cfg)
	rec.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	data.Records[rec.ConversationID] = rec
	return writeStoreFile(cfg, data)
}

// DeleteByConversation removes the record (if any) for conversationID.
func (s *PersistentStore) DeleteByConversation(cfg *daemonconfig.Config, conversationID string) bool {
	if strings.TrimSpace(conversationID) == "" {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	data := readStoreFile(cfg)
	if _, ok := data.Records[conversationID]; !ok {
		return false
	}
	delete(data.Records, conversationID)
	_ = writeStoreFile(cfg, data)
	return true
}

// All returns a snapshot of all records (for diagnostics / migration).
func (s *PersistentStore) All(cfg *daemonconfig.Config) []StoreRecord {
	s.mu.Lock()
	defer s.mu.Unlock()
	data := readStoreFile(cfg)
	out := make([]StoreRecord, 0, len(data.Records))
	for _, rec := range data.Records {
		out = append(out, rec)
	}
	return out
}

func readStoreFile(cfg *daemonconfig.Config) storeFileData {
	data := storeFileData{Version: 1, Records: map[string]StoreRecord{}}
	raw, err := os.ReadFile(PersistentStorePath(cfg))
	if err != nil || len(raw) == 0 {
		return data
	}
	if err := json.Unmarshal(raw, &data); err != nil || data.Records == nil {
		data.Version = 1
		data.Records = map[string]StoreRecord{}
	}
	return data
}

func writeStoreFile(cfg *daemonconfig.Config, data storeFileData) error {
	path := PersistentStorePath(cfg)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

var (
	defaultPersistentStoreOnce sync.Once
	defaultPersistentStore     *PersistentStore
)

// DefaultPersistentStore returns the per-process shared store.
func DefaultPersistentStore() *PersistentStore {
	defaultPersistentStoreOnce.Do(func() { defaultPersistentStore = NewPersistentStore() })
	return defaultPersistentStore
}
