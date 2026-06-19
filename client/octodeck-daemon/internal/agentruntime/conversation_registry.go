package agentruntime

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"

	agentprotocol "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentprotocol"
	daemonconfig "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/config"
	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
)

type FamilyConfig = agentprotocol.FamilyConfig
type FamilyProcess = agentprotocol.FamilyProcess
type FamilyDriver = agentprotocol.FamilyDriver
type RuntimePolicyUpdater = agentprotocol.RuntimePolicyUpdater

func ConversationID(req *proto.AgentRunRequestFrame) string {
	return agentprotocol.ConversationID(req)
}

// Registry is the per-daemon-process map from OctoDeck conversationID to live
// Instance. It is the AgentRuntime layer's main index — replacing the historic
// ProcessKey hash that mixed model/systemPrompt into the key (and made
// permission-mode changes silently miss the pool). Conversation continuity is
// the responsibility of the AgentRuntime layer; family drivers know nothing
// about conversationID, only about SessionID.
type Registry struct {
	mu        sync.Mutex
	instances map[string]*Instance
	store     *PersistentStore
	family    FamilyResolver
}

// FamilyResolver maps an AgentRunRequest to the FamilyDriver that should run
// it. The wiring layer builds this when constructing the Registry; tests
// typically use a closure.
type FamilyResolver func(req *proto.AgentRunRequestFrame) (FamilyDriver, error)

// NewRegistry constructs a Registry. store may be nil to disable persistence
// (mostly useful for tests).
func NewRegistry(store *PersistentStore, resolver FamilyResolver) *Registry {
	if store == nil {
		store = NewPersistentStore()
	}
	if resolver == nil {
		resolver = func(*proto.AgentRunRequestFrame) (FamilyDriver, error) {
			return nil, ErrNoFamilyResolver
		}
	}
	return &Registry{
		instances: make(map[string]*Instance),
		store:     store,
		family:    resolver,
	}
}

// Lookup returns the live Instance for conversationID, or false if none.
func (r *Registry) Lookup(conversationID string) (*Instance, bool) {
	if strings.TrimSpace(conversationID) == "" {
		return nil, false
	}
	r.mu.Lock()
	inst, ok := r.instances[conversationID]
	r.mu.Unlock()
	if !ok || inst == nil || !inst.Alive() {
		return nil, false
	}
	return inst, true
}

// Remove drops the registration for conversationID without stopping the
// instance.
func (r *Registry) Remove(conversationID string) {
	r.mu.Lock()
	delete(r.instances, conversationID)
	r.mu.Unlock()
}

// Close stops and removes the instance for conversationID.
func (r *Registry) Close(conversationID string) {
	r.mu.Lock()
	inst := r.instances[conversationID]
	delete(r.instances, conversationID)
	r.mu.Unlock()
	if inst != nil {
		inst.Stop()
	}
}

// CloseAll stops every registered instance.
func (r *Registry) CloseAll() {
	r.mu.Lock()
	insts := make([]*Instance, 0, len(r.instances))
	for _, inst := range r.instances {
		insts = append(insts, inst)
	}
	r.instances = make(map[string]*Instance)
	r.mu.Unlock()
	for _, inst := range insts {
		inst.Stop()
	}
}

// ReapIdleSince stops every instance whose LastUsedAt is non-zero and earlier
// than cutoff. Returns the number of instances stopped.
func (r *Registry) ReapIdleSince(cutoff time.Time) int {
	r.mu.Lock()
	stopped := make([]*Instance, 0)
	for convID, inst := range r.instances {
		if inst == nil {
			continue
		}
		last := inst.LastUsedAt()
		if last.IsZero() || !last.Before(cutoff) {
			continue
		}
		delete(r.instances, convID)
		stopped = append(stopped, inst)
	}
	r.mu.Unlock()
	for _, inst := range stopped {
		inst.Stop()
	}
	return len(stopped)
}

// GetOrCreate returns the live Instance for the request's conversationID,
// starting a new underlying process via the resolved FamilyDriver if none
// exists. The returned bool is true when a brand-new Instance was created.
//
// On the first turn for a conversation:
//   - resolve the FamilyDriver from req.AgentID
//   - read PersistentStore for any historic SessionID (daemon-restart recovery)
//   - prefer req.Input.SessionID when the caller explicitly resumes
//   - StartProcess with that ResumeSessionID; the family attempts
//     LoadSession→ResumeSession→NewSession internally and fills
//     FamilyProcess.SessionID
//   - persist conversationID→SessionID
func (r *Registry) GetOrCreate(ctx context.Context, req *proto.AgentRunRequestFrame, baseCfg FamilyConfig) (*Instance, bool, error) {
	if req == nil {
		return nil, false, errors.New("Registry.GetOrCreate: nil request")
	}
	convID := ConversationID(req)
	if convID == "" {
		return nil, false, errors.New("Registry.GetOrCreate: empty conversation id")
	}

	r.mu.Lock()
	if inst, ok := r.instances[convID]; ok && inst != nil && inst.Alive() {
		r.mu.Unlock()
		return inst, false, nil
	}
	r.mu.Unlock()

	driver, err := r.family(req)
	if err != nil {
		return nil, false, err
	}

	resume := strings.TrimSpace(req.Input.SessionID)
	if resume == "" && r.store != nil {
		if rec, ok := r.store.LookupByConversation(baseCfg.Cfg, convID); ok {
			resume = rec.SessionID
		}
	}

	startCfg := baseCfg
	startCfg.AgentClientID = req.AgentID
	startCfg.Workspace = req.Workspace
	startCfg.Env = req.Env
	startCfg.MaxOutputBytes = req.MaxOutputBytes
	startCfg.TimeoutMs = req.TimeoutMs
	startCfg.Model = req.Policy.Model
	startCfg.PermissionMode = req.Policy.PermissionMode
	startCfg.SystemPrompt = req.Policy.SystemPrompt
	startCfg.AllowedTools = req.Policy.AllowedTools
	startCfg.DisallowedTools = req.Policy.DisallowedTools
	startCfg.ToolPolicy = req.Policy.ToolPolicy
	startCfg.ResumeSessionID = resume

	r.mu.Lock()
	if inst, ok := r.instances[convID]; ok && inst != nil && inst.Alive() {
		r.mu.Unlock()
		return inst, false, nil
	}
	r.mu.Unlock()

	proc, err := driver.StartProcess(ctx, startCfg)
	if err != nil {
		return nil, false, err
	}
	if proc == nil || strings.TrimSpace(proc.SessionID) == "" {
		// Family contract violation: SessionID must be set on return.
		_ = driver.Stop(proc)
		return nil, false, errors.New("Registry.GetOrCreate: family driver returned empty SessionID")
	}

	inst := newInstance(convID, req.AgentID, baseCfg.Cwd, driver, req)
	inst.Proc = proc
	inst.SessionID = proc.SessionID

	r.mu.Lock()
	if existing, ok := r.instances[convID]; ok && existing != nil && existing.Alive() {
		r.mu.Unlock()
		_ = driver.Stop(proc)
		return existing, false, nil
	}
	r.instances[convID] = inst
	r.mu.Unlock()

	if r.store != nil {
		_ = r.store.Write(baseCfg.Cfg, StoreRecord{
			ConversationID: convID,
			AgentClientID:  req.AgentID,
			Cwd:            baseCfg.Cwd,
			Model:          req.Policy.Model,
			SessionID:      proc.SessionID,
		})
	}
	return inst, true, nil
}

// PersistSession refreshes the persisted record for an instance.
func (r *Registry) PersistSession(cfg *daemonconfig.Config, inst *Instance) {
	if r == nil || r.store == nil || inst == nil {
		return
	}
	if strings.TrimSpace(inst.ConversationID) == "" || strings.TrimSpace(inst.SessionID) == "" {
		return
	}
	_ = r.store.Write(cfg, StoreRecord{
		ConversationID: inst.ConversationID,
		AgentClientID:  inst.AgentClientID,
		Cwd:            inst.Cwd,
		Model:          inst.Model,
		SessionID:      inst.SessionID,
	})
}

// Store returns the PersistentStore backing this registry. Mainly for tests.
func (r *Registry) Store() *PersistentStore { return r.store }

// ErrNoFamilyResolver is returned by GetOrCreate when the Registry was built
// without a resolver (typically a test that forgot to wire one up).
var ErrNoFamilyResolver = errors.New("Registry: no family resolver configured")
