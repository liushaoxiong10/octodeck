package agentruntime

import (
	"context"
	"log"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
)

// Instance is the explicit, stateful counterpart to the historic stateless
// ProcessKey lookup. One Instance per OctoDeck conversationID owns the live
// underlying agent process (FamilyProcess) plus the runtime configuration
// (model / permissionMode / systemPrompt) currently injected into it.
//
// The contract:
//   - First message: Registry.GetOrCreate builds an Instance, the family
//     exposes its SessionID, and the mapping conversationID→sessionID is
//     persisted.
//   - Subsequent messages: Lookup by conversationID returns the Instance.
//     If the incoming model/permissionMode/systemPrompt differ from what the
//     Instance holds, Stop the old process, StartProcess a new one with the
//     old SessionID to resume the conversation, inject the new policy, and
//     send the prompt.
//
// mu serializes Send so a restart (Stop+StartProcess+Prompt) is never
// interleaved with a concurrent prompt on the same conversation.
type Instance struct {
	ConversationID string
	AgentClientID  string
	Cwd            string
	Family         FamilyDriver

	// Current injected runtime config. Compared against each incoming request
	// in Send to decide restart.
	Model          string
	PermissionMode string
	SystemPrompt   string

	// Live process + its bound session id (family-exposed). SessionID is the
	// snapshot Registry persists; on restart it is reused as ResumeSessionID.
	Proc      *FamilyProcess
	SessionID string

	mu     sync.Mutex
	closed atomic.Bool

	lastUsedAtUnixNano atomic.Int64
}

// newInstance constructs an Instance populated with the initial policy. Callers
// (Registry) then StartProcess and set Proc/SessionID.
func newInstance(convID, agentClientID, cwd string, family FamilyDriver, req *proto.AgentRunRequestFrame) *Instance {
	return &Instance{
		ConversationID: convID,
		AgentClientID:  agentClientID,
		Cwd:            cwd,
		Family:         family,
		Model:          req.Policy.Model,
		PermissionMode: req.Policy.PermissionMode,
		SystemPrompt:   req.Policy.SystemPrompt,
	}
}

// Alive reports whether the underlying process is still usable.
func (inst *Instance) Alive() bool {
	if inst == nil || inst.closed.Load() {
		return false
	}
	inst.mu.Lock()
	alive := inst.Proc != nil
	inst.mu.Unlock()
	return alive
}

// TouchUsed records that the instance just serviced a turn, for the idle reaper.
func (inst *Instance) TouchUsed() {
	if inst == nil {
		return
	}
	inst.lastUsedAtUnixNano.Store(time.Now().UnixNano())
}

// LastUsedAt returns the wall-clock time of the most recent TouchUsed.
func (inst *Instance) LastUsedAt() time.Time {
	if inst == nil {
		return time.Time{}
	}
	v := inst.lastUsedAtUnixNano.Load()
	if v == 0 {
		return time.Time{}
	}
	return time.Unix(0, v)
}

// configChanged reports whether the incoming request's policy differs from the
// instance's currently-injected policy. Model / permissionMode / systemPrompt
// are process-level for the ACP families (folded into argv or embedded-runtime
// config at start time), so any change means the live process cannot honour it
// and must be restarted with the old SessionID to resume.
func (inst *Instance) configChanged(req *proto.AgentRunRequestFrame) bool {
	if req == nil {
		return false
	}
	return strings.TrimSpace(inst.Model) != strings.TrimSpace(req.Policy.Model) ||
		strings.TrimSpace(inst.PermissionMode) != strings.TrimSpace(req.Policy.PermissionMode) ||
		strings.TrimSpace(inst.SystemPrompt) != strings.TrimSpace(req.Policy.SystemPrompt)
}

func (inst *Instance) canUpdateRuntimePolicy(req *proto.AgentRunRequestFrame) bool {
	if inst == nil || inst.Family == nil {
		return false
	}
	updater, ok := inst.Family.(RuntimePolicyUpdater)
	return ok && updater.CanUpdateRuntimePolicy(req)
}

// Send executes one prompt turn on the instance. It:
//  1. Compares the incoming model/permissionMode/systemPrompt against the
//     instance's cached values.
//  2. On change (and an existing Proc), Stops the old process and StartProcess
//     a new one with the old SessionID as ResumeSessionID so the conversation
//     continues; the new policy is injected via FamilyConfig.
//  3. Calls family.Prompt to run the turn, streaming events through emit.
func (inst *Instance) Send(ctx context.Context, req *proto.AgentRunRequestFrame, cfg FamilyConfig, emit func(proto.AgentRunEventFrame)) (proto.AgentRunResultFrame, error) {
	inst.mu.Lock()
	defer inst.mu.Unlock()
	inst.TouchUsed()
	defer inst.TouchUsed()

	if inst.closed.Load() {
		return proto.AgentRunResultFrame{}, ErrInstanceClosed
	}

	if inst.configChanged(req) && inst.Proc != nil && inst.canUpdateRuntimePolicy(req) {
		inst.Model = req.Policy.Model
		inst.PermissionMode = req.Policy.PermissionMode
		inst.SystemPrompt = req.Policy.SystemPrompt
	}

	if inst.configChanged(req) && inst.Proc != nil {
		resumeSessionID := inst.SessionID
		log.Printf("octodeck-daemon: conversation runtime policy changed conversationId=%s agent=%s oldModel=%q newModel=%q oldPermission=%q newPermission=%q restart=true", inst.ConversationID, req.AgentID, strings.TrimSpace(inst.Model), strings.TrimSpace(req.Policy.Model), strings.TrimSpace(inst.PermissionMode), strings.TrimSpace(req.Policy.PermissionMode))
		_ = inst.Family.Stop(inst.Proc)
		inst.Proc = nil

		restartCfg := cfg
		restartCfg.ResumeSessionID = resumeSessionID
		restartCfg.Model = req.Policy.Model
		restartCfg.PermissionMode = req.Policy.PermissionMode
		restartCfg.SystemPrompt = req.Policy.SystemPrompt
		restartCfg.AgentClientID = req.AgentID
		proc, err := inst.Family.StartProcess(ctx, restartCfg)
		if err != nil {
			inst.closed.Store(true)
			return proto.AgentRunResultFrame{}, err
		}
		inst.Proc = proc
		inst.SessionID = proc.SessionID
		inst.Model = req.Policy.Model
		inst.PermissionMode = req.Policy.PermissionMode
		inst.SystemPrompt = req.Policy.SystemPrompt
	}

	if inst.Proc == nil {
		return proto.AgentRunResultFrame{}, ErrInstanceClosed
	}

	result, err := inst.Family.Prompt(ctx, inst.Proc, req, emit)

	// Transport-disconnect retry. The underlying ACP child or embedded runtime
	// may close mid-turn (broken pipe, peer disconnected, EOF). Try twice:
	//
	//   1. Restart the process with the current SessionID (LoadSession on
	//      the same conversation). Most disconnects are transient and the
	//      provider can resume.
	//   2. If that still fails with another transport disconnect, drop the
	//      SessionID (NewSession) and try once more — the provider session
	//      may itself be in a corrupted state.
	//
	// The retry is bounded to two extra attempts so a permanent failure does
	// not loop forever. ctx.Err() short-circuits cancellation.
	if err != nil && IsTransportDisconnect(err) && ctx.Err() == nil {
		retryCfg := cfg
		retryCfg.AgentClientID = req.AgentID
		retryCfg.Model = req.Policy.Model
		retryCfg.PermissionMode = req.Policy.PermissionMode
		retryCfg.SystemPrompt = req.Policy.SystemPrompt
		retryCfg.ResumeSessionID = inst.SessionID

		_ = inst.Family.Stop(inst.Proc)
		inst.Proc = nil

		proc, startErr := inst.Family.StartProcess(ctx, retryCfg)
		if startErr == nil {
			inst.Proc = proc
			inst.SessionID = proc.SessionID
			result, err = inst.Family.Prompt(ctx, inst.Proc, req, emit)

			// Second disconnect: drop SessionID and try a fresh session.
			if err != nil && IsTransportDisconnect(err) && ctx.Err() == nil {
				_ = inst.Family.Stop(inst.Proc)
				inst.Proc = nil

				freshCfg := retryCfg
				freshCfg.ResumeSessionID = ""
				proc2, freshErr := inst.Family.StartProcess(ctx, freshCfg)
				if freshErr == nil {
					inst.Proc = proc2
					inst.SessionID = proc2.SessionID
					result, err = inst.Family.Prompt(ctx, inst.Proc, req, emit)
				}
			}
		}

		if err != nil {
			// Both retries failed; mark closed so Registry.GetOrCreate
			// rebuilds from PersistentStore on the next turn.
			inst.closed.Store(true)
		}
	}

	if err == nil && strings.TrimSpace(result.SessionID) != "" && result.SessionID != inst.SessionID {
		inst.SessionID = result.SessionID
	}
	return result, err
}

// Stop tears the instance down and marks it closed. Safe to call repeatedly.
func (inst *Instance) Stop() {
	if inst == nil {
		return
	}
	inst.mu.Lock()
	proc := inst.Proc
	inst.Proc = nil
	inst.closed.Store(true)
	inst.mu.Unlock()
	if proc != nil {
		_ = inst.Family.Stop(proc)
	}
}

// ErrInstanceClosed is returned by Send when the instance has been closed.
var ErrInstanceClosed = errInstanceClosed{}

type errInstanceClosed struct{}

func (errInstanceClosed) Error() string { return "agent runtime instance closed" }
