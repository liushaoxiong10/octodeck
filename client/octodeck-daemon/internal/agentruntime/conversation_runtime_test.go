package agentruntime

import (
	"context"
	"errors"
	"io"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	agentprotocol "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentprotocol"
	daemonconfig "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/config"
	inventory "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/inventory"
	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
)

// runtimeStubDriver is a minimal FamilyDriver for exercising the AgentRuntime layer
// without pulling in any real family. Records StartProcess/Stop/Prompt calls
// and lets tests assert SessionID-exposure + restart behavior.
type runtimeStubDriver struct {
	mu sync.Mutex

	id               string
	updatePolicyLive bool
	startCount       atomic.Int64
	stopCount        atomic.Int64
	promptCount      atomic.Int64
	startErr         error
	startSessions    []string // SessionID to assign on each StartProcess (FIFO)
	createdNewQueue  []bool   // CreatedNew flag per StartProcess (FIFO; default true)
	receivedResume   []string // ResumeSessionIDs seen on StartProcess
	promptSessionIDs []string
	promptErrs       []error // errors to return on each Prompt call (FIFO; nil = success)
	lastCreatedNew   []bool  // CreatedNew flag observed per Prompt call
}

func newRuntimeStubDriver(id string) *runtimeStubDriver { return &runtimeStubDriver{id: id} }

func (d *runtimeStubDriver) ID() string { return d.id }

func (d *runtimeStubDriver) CanUpdateRuntimePolicy(req *proto.AgentRunRequestFrame) bool {
	return d.updatePolicyLive
}

func (d *runtimeStubDriver) StartProcess(ctx context.Context, cfg FamilyConfig) (*FamilyProcess, error) {
	if d.startErr != nil {
		return nil, d.startErr
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	d.startCount.Add(1)
	d.receivedResume = append(d.receivedResume, cfg.ResumeSessionID)
	var sessionID string
	if len(d.startSessions) > 0 {
		sessionID = d.startSessions[0]
		d.startSessions = d.startSessions[1:]
	} else {
		sessionID = "session-from-new-" + cfg.AgentClientID
	}
	createdNew := true
	if len(d.createdNewQueue) > 0 {
		createdNew = d.createdNewQueue[0]
		d.createdNewQueue = d.createdNewQueue[1:]
	}
	return &FamilyProcess{SessionID: sessionID, CreatedNew: createdNew}, nil
}

func (d *runtimeStubDriver) Prompt(ctx context.Context, fp *FamilyProcess, req *proto.AgentRunRequestFrame, emit func(proto.AgentRunEventFrame)) (proto.AgentRunResultFrame, error) {
	d.promptCount.Add(1)
	d.mu.Lock()
	d.promptSessionIDs = append(d.promptSessionIDs, fp.SessionID)
	d.lastCreatedNew = append(d.lastCreatedNew, fp.CreatedNew)
	var perr error
	if len(d.promptErrs) > 0 {
		perr = d.promptErrs[0]
		d.promptErrs = d.promptErrs[1:]
	}
	d.mu.Unlock()
	if perr != nil {
		return proto.AgentRunResultFrame{}, perr
	}
	return proto.AgentRunResultFrame{OK: true, Result: "ok", SessionID: fp.SessionID}, nil
}

func (d *runtimeStubDriver) Stop(fp *FamilyProcess) error { d.stopCount.Add(1); return nil }

func (d *runtimeStubDriver) ListSessions(ctx context.Context, cfg *daemonconfig.Config, workspace string) ([]proto.AgentSessionInfo, error) {
	return nil, nil
}
func (d *runtimeStubDriver) DeleteSession(ctx context.Context, cfg *daemonconfig.Config, workspace, sessionID string) (bool, error) {
	root := daemonconfig.SessionDir(cfg)
	deleted := false
	for _, dir := range []string{
		root + "/" + workspace + "/" + d.id + "/" + sessionID,
		root + "/" + workspace + "/stub-provider/" + sessionID,
	} {
		if err := os.RemoveAll(dir); err == nil {
			deleted = true
		}
	}
	return deleted, nil
}

type cleanupStubAgent struct {
	BaseAgent
}

func (a *cleanupStubAgent) DeleteSession(ctx context.Context, cfg *daemonconfig.Config, workspace, sessionID string) (bool, error) {
	root := daemonconfig.SessionDir(cfg)
	target := root + "/" + workspace + "/" + a.Client.ID + "/" + sessionID
	if err := os.RemoveAll(target); err != nil {
		return false, err
	}
	return true, nil
}

func fakeReq(convID, model, perm, sysPrompt, inputSession string) *proto.AgentRunRequestFrame {
	return &proto.AgentRunRequestFrame{
		RunID:   "run-" + convID,
		AgentID: "stub",
		Cwd:     "/tmp",
		Input: proto.AgentRunInput{
			Prompt:    "hello",
			SessionID: inputSession,
			Metadata:  map[string]any{"conversationId": convID},
		},
		Policy: proto.AgentRunPolicy{
			Model:          model,
			PermissionMode: perm,
			SystemPrompt:   sysPrompt,
		},
	}
}

// testFC returns a minimal FamilyConfig with a temp-dir-backed persistent
// store path, suitable for GetOrCreate calls in hermetic tests.
func testFC(t *testing.T) FamilyConfig {
	return FamilyConfig{Cwd: "/tmp", Cfg: &daemonconfig.Config{StateDir: t.TempDir()}}
}

func TestConversationIDSelection(t *testing.T) {
	cases := []struct {
		name string
		req  *proto.AgentRunRequestFrame
		want string
	}{
		{
			name: "metadata workspaceSessionId wins",
			req: &proto.AgentRunRequestFrame{
				Workspace: &proto.AgentRunWorkspace{Scope: "session", ScopeID: "scope-7"},
				Input: proto.AgentRunInput{
					SessionID: "native-sess",
					Metadata:  map[string]any{"workspaceSessionId": "server-conv-1", "chatId": "chat-9"},
				},
			},
			want: "server-conv-1",
		},
		{
			name: "workspace sessionRoot wins",
			req: &proto.AgentRunRequestFrame{
				Workspace: &proto.AgentRunWorkspace{Scope: "session", ScopeID: "scope-7", SessionRoot: "server-root"},
				Input: proto.AgentRunInput{
					SessionID: "native-sess",
					Metadata:  map[string]any{"workspaceSessionId": "server-conv-1"},
				},
			},
			want: "server-root",
		},
		{
			name: "legacy metadata conversationId",
			req:  fakeReq("conv-1", "m", "p", "", ""),
			want: "conv-1",
		},
		{
			name: "metadata chatId wins",
			req: &proto.AgentRunRequestFrame{
				Input: proto.AgentRunInput{Metadata: map[string]any{"chatId": "chat-9", "conversationId": "ignored"}},
			},
			want: "chat-9",
		},
		{
			name: "workspace scopeID when session scope",
			req: &proto.AgentRunRequestFrame{
				Workspace: &proto.AgentRunWorkspace{Scope: "session", ScopeID: "scope-7", Folder: "fallback-folder"},
			},
			want: "scope-7",
		},
		{
			name: "folder when no server or legacy conversation id",
			req: &proto.AgentRunRequestFrame{
				Workspace: &proto.AgentRunWorkspace{Folder: "folder-x"},
				Input:     proto.AgentRunInput{SessionID: "native-sess"},
			},
			want: "folder-x",
		},
		{
			name: "runID last resort",
			req:  &proto.AgentRunRequestFrame{RunID: "run-x"},
			want: "run-x",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ConversationID(tc.req); got != tc.want {
				t.Fatalf("ConversationID = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestRegistryGetOrCreateFirstTurn(t *testing.T) {
	driver := newRuntimeStubDriver("stub")
	driver.startSessions = []string{"sess-A"}
	reg := NewRegistry(nil, func(*proto.AgentRunRequestFrame) (FamilyDriver, error) { return driver, nil })

	cfg := testFC(t)
	req := fakeReq("conv-1", "model-1", "bypassPermissions", "sys", "")
	inst, created, err := reg.GetOrCreate(context.Background(), req, cfg)
	if err != nil {
		t.Fatalf("GetOrCreate: %v", err)
	}
	if !created {
		t.Fatal("expected new instance on first turn")
	}
	if inst.SessionID != "sess-A" {
		t.Fatalf("instance SessionID = %q, want sess-A", inst.SessionID)
	}
	if driver.startCount.Load() != 1 {
		t.Fatalf("startCount = %d, want 1", driver.startCount.Load())
	}
	rec, ok := reg.Store().LookupByConversation(cfg.Cfg, inst.ConversationID)
	if !ok {
		t.Fatal("expected persisted record after first turn")
	}
	if rec.SessionID != "sess-A" {
		t.Fatalf("persisted SessionID = %q, want sess-A", rec.SessionID)
	}
}

func TestRegistryReusesInstance(t *testing.T) {
	driver := newRuntimeStubDriver("stub")
	driver.startSessions = []string{"sess-A"}
	reg := NewRegistry(nil, func(*proto.AgentRunRequestFrame) (FamilyDriver, error) { return driver, nil })

	cfg := testFC(t)
	req := fakeReq("conv-1", "model-1", "bypassPermissions", "", "")
	inst1, _, err := reg.GetOrCreate(context.Background(), req, cfg)
	if err != nil {
		t.Fatalf("first GetOrCreate: %v", err)
	}
	inst2, created, err := reg.GetOrCreate(context.Background(), req, cfg)
	if err != nil {
		t.Fatalf("second GetOrCreate: %v", err)
	}
	if created {
		t.Fatal("expected reuse on second turn")
	}
	if inst1 != inst2 {
		t.Fatal("expected same instance pointer")
	}
	if driver.startCount.Load() != 1 {
		t.Fatalf("startCount = %d, want 1 (no restart)", driver.startCount.Load())
	}
}

func TestInstanceSendRestartsOnModelChange(t *testing.T) {
	driver := newRuntimeStubDriver("stub")
	driver.startSessions = []string{"sess-original", "sess-restarted"}
	reg := NewRegistry(nil, func(*proto.AgentRunRequestFrame) (FamilyDriver, error) { return driver, nil })

	cfg := testFC(t)
	req1 := fakeReq("conv-2", "model-1", "bypassPermissions", "sys", "")
	inst, _, err := reg.GetOrCreate(context.Background(), req1, cfg)
	if err != nil {
		t.Fatalf("GetOrCreate: %v", err)
	}
	if inst.SessionID != "sess-original" {
		t.Fatalf("initial SessionID = %q, want sess-original", inst.SessionID)
	}

	if _, err := inst.Send(context.Background(), req1, cfg, nil); err != nil {
		t.Fatalf("first Send: %v", err)
	}

	req2 := fakeReq("conv-2", "model-2", "bypassPermissions", "sys", "")
	if _, err := inst.Send(context.Background(), req2, cfg, nil); err != nil {
		t.Fatalf("second Send: %v", err)
	}

	if driver.startCount.Load() != 2 {
		t.Fatalf("startCount = %d, want 2 (restart on model change)", driver.startCount.Load())
	}
	if driver.stopCount.Load() != 1 {
		t.Fatalf("stopCount = %d, want 1 (old process stopped)", driver.stopCount.Load())
	}
	driver.mu.Lock()
	gotResume := driver.receivedResume[1]
	driver.mu.Unlock()
	if gotResume != "sess-original" {
		t.Fatalf("restart ResumeSessionID = %q, want sess-original", gotResume)
	}
	if inst.SessionID != "sess-restarted" {
		t.Fatalf("post-restart SessionID = %q, want sess-restarted", inst.SessionID)
	}
	if inst.Model != "model-2" {
		t.Fatalf("post-restart inst.Model = %q, want model-2", inst.Model)
	}
}

func TestInstanceSendRestartsOnPermissionChange(t *testing.T) {
	driver := newRuntimeStubDriver("stub")
	driver.startSessions = []string{"sess-A", "sess-B"}
	reg := NewRegistry(nil, func(*proto.AgentRunRequestFrame) (FamilyDriver, error) { return driver, nil })

	cfg := testFC(t)
	req1 := fakeReq("conv-3", "model-1", "bypassPermissions", "", "")
	inst, _, err := reg.GetOrCreate(context.Background(), req1, cfg)
	if err != nil {
		t.Fatalf("GetOrCreate: %v", err)
	}
	if _, err := inst.Send(context.Background(), req1, cfg, nil); err != nil {
		t.Fatalf("first Send: %v", err)
	}

	req2 := fakeReq("conv-3", "model-1", "read-only", "", "")
	if _, err := inst.Send(context.Background(), req2, cfg, nil); err != nil {
		t.Fatalf("second Send: %v", err)
	}
	if driver.startCount.Load() != 2 {
		t.Fatalf("startCount = %d, want 2 (restart on permission change)", driver.startCount.Load())
	}
	if inst.PermissionMode != "read-only" {
		t.Fatalf("post-restart PermissionMode = %q, want read-only", inst.PermissionMode)
	}
}

func TestInstanceSendUpdatesPolicyWithoutRestartWhenFamilySupportsIt(t *testing.T) {
	driver := newRuntimeStubDriver("stub")
	driver.updatePolicyLive = true
	driver.startSessions = []string{"sess-A"}
	reg := NewRegistry(nil, func(*proto.AgentRunRequestFrame) (FamilyDriver, error) { return driver, nil })

	cfg := testFC(t)
	req1 := fakeReq("conv-live", "model-1", "bypassPermissions", "sys-1", "")
	inst, _, err := reg.GetOrCreate(context.Background(), req1, cfg)
	if err != nil {
		t.Fatalf("GetOrCreate: %v", err)
	}
	if _, err := inst.Send(context.Background(), req1, cfg, nil); err != nil {
		t.Fatalf("first Send: %v", err)
	}

	req2 := fakeReq("conv-live", "model-2", "read-only", "sys-2", "")
	if _, err := inst.Send(context.Background(), req2, cfg, nil); err != nil {
		t.Fatalf("second Send: %v", err)
	}

	if driver.startCount.Load() != 1 {
		t.Fatalf("startCount = %d, want 1 (policy updated in live process)", driver.startCount.Load())
	}
	if driver.stopCount.Load() != 0 {
		t.Fatalf("stopCount = %d, want 0", driver.stopCount.Load())
	}
	if inst.SessionID != "sess-A" {
		t.Fatalf("SessionID = %q, want sess-A", inst.SessionID)
	}
	if inst.Model != "model-2" || inst.PermissionMode != "read-only" || inst.SystemPrompt != "sys-2" {
		t.Fatalf("policy not updated: model=%q permission=%q system=%q", inst.Model, inst.PermissionMode, inst.SystemPrompt)
	}
}

func TestInstanceSendNoRestartSamePolicy(t *testing.T) {
	driver := newRuntimeStubDriver("stub")
	driver.startSessions = []string{"sess-A"}
	reg := NewRegistry(nil, func(*proto.AgentRunRequestFrame) (FamilyDriver, error) { return driver, nil })

	cfg := testFC(t)
	req := fakeReq("conv-4", "model-1", "bypassPermissions", "sys", "")
	inst, _, err := reg.GetOrCreate(context.Background(), req, cfg)
	if err != nil {
		t.Fatalf("GetOrCreate: %v", err)
	}
	for i := 0; i < 3; i++ {
		if _, err := inst.Send(context.Background(), req, cfg, nil); err != nil {
			t.Fatalf("Send %d: %v", i, err)
		}
	}
	if driver.startCount.Load() != 1 {
		t.Fatalf("startCount = %d, want 1 (no restart on identical policy)", driver.startCount.Load())
	}
	if driver.promptCount.Load() != 3 {
		t.Fatalf("promptCount = %d, want 3", driver.promptCount.Load())
	}
}

func TestInstanceSendClosedAfterStartFailure(t *testing.T) {
	driver := newRuntimeStubDriver("stub")
	driver.startSessions = []string{"sess-A"}
	reg := NewRegistry(nil, func(*proto.AgentRunRequestFrame) (FamilyDriver, error) { return driver, nil })

	cfg := testFC(t)
	req1 := fakeReq("conv-5", "model-1", "bypassPermissions", "", "")
	inst, _, err := reg.GetOrCreate(context.Background(), req1, cfg)
	if err != nil {
		t.Fatalf("GetOrCreate: %v", err)
	}
	if _, err := inst.Send(context.Background(), req1, cfg, nil); err != nil {
		t.Fatalf("first Send: %v", err)
	}

	driver.startErr = errors.New("boom")
	req2 := fakeReq("conv-5", "model-2", "bypassPermissions", "", "")
	if _, err := inst.Send(context.Background(), req2, cfg, nil); err == nil {
		t.Fatal("expected error on restart StartProcess failure")
	}
	if !inst.closed.Load() {
		t.Fatal("expected instance to be closed after StartProcess failure")
	}
}

func TestRegistryReapIdle(t *testing.T) {
	driver := newRuntimeStubDriver("stub")
	driver.startSessions = []string{"sess-A"}
	reg := NewRegistry(nil, func(*proto.AgentRunRequestFrame) (FamilyDriver, error) { return driver, nil })

	cfg := testFC(t)
	req := fakeReq("conv-6", "m", "p", "", "")
	inst, _, err := reg.GetOrCreate(context.Background(), req, cfg)
	if err != nil {
		t.Fatalf("GetOrCreate: %v", err)
	}
	inst.lastUsedAtUnixNano.Store(time.Now().Add(-2 * time.Hour).UnixNano())

	stopped := reg.ReapIdleSince(time.Now().Add(-time.Hour))
	if stopped != 1 {
		t.Fatalf("ReapIdleSince stopped = %d, want 1", stopped)
	}
	if driver.stopCount.Load() != 1 {
		t.Fatalf("stopCount = %d, want 1 after reap", driver.stopCount.Load())
	}
}

func TestPersistentStoreRoundTrip(t *testing.T) {
	tmp := t.TempDir()
	cfg := &daemonconfig.Config{StateDir: tmp}
	store := NewPersistentStore()

	convID := "conv-store-1"
	rec := StoreRecord{ConversationID: convID, AgentClientID: "stub", Cwd: "/tmp", Model: "m1", SessionID: "sess-1"}
	if err := store.Write(cfg, rec); err != nil {
		t.Fatalf("Write: %v", err)
	}
	got, ok := store.LookupByConversation(cfg, convID)
	if !ok {
		t.Fatal("LookupByConversation: not found after Write")
	}
	if got.SessionID != "sess-1" {
		t.Fatalf("SessionID = %q, want sess-1", got.SessionID)
	}
	if got.UpdatedAt == "" {
		t.Fatal("UpdatedAt not stamped")
	}
	if !store.DeleteByConversation(cfg, convID) {
		t.Fatal("DeleteByConversation returned false")
	}
	if _, ok := store.LookupByConversation(cfg, convID); ok {
		t.Fatal("record still present after delete")
	}
}

func TestPersistentStoreWriteRejectsEmpty(t *testing.T) {
	store := NewPersistentStore()
	cfg := &daemonconfig.Config{StateDir: t.TempDir()}
	if err := store.Write(cfg, StoreRecord{ConversationID: "c", SessionID: ""}); err == nil {
		t.Fatal("expected error on empty SessionID")
	}
	if err := store.Write(cfg, StoreRecord{ConversationID: "", SessionID: "s"}); err == nil {
		t.Fatal("expected error on empty ConversationID")
	}
}

func TestDeleteSessionWithACPCleanupUsesSessionIDForWorkspaceScope(t *testing.T) {
	tmp := t.TempDir()
	cfg := &daemonconfig.Config{
		StateDir:     t.TempDir(),
		SessionDir:   tmp + "/session",
		WorkspaceDir: tmp + "/workspace",
	}
	workspace := "demo"
	sessionID := "workspace-session-id"
	agentID := "stub"
	localDir := tmp + "/workspace/" + workspace + "/sessions/" + sessionID
	stableAgentDir := tmp + "/workspace/" + workspace + "/sessions/" + StableAgentWorkspaceScopeID(agentID)
	providerDir := tmp + "/session/" + workspace + "/" + agentID + "/" + sessionID
	if err := os.MkdirAll(localDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(stableAgentDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(providerDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := DefaultPersistentStore().Write(cfg, StoreRecord{ConversationID: sessionID, SessionID: "provider-session"}); err != nil {
		t.Fatalf("Write persistent store: %v", err)
	}

	deleted, err := DeleteSessionWithACPCleanup(&cleanupStubAgent{BaseAgent: BaseAgent{Client: inventory.Info{ID: agentID}}}, context.Background(), cfg, workspace, sessionID, agentID)
	if err != nil {
		t.Fatalf("DeleteSessionWithACPCleanup: %v", err)
	}
	if !deleted {
		t.Fatal("DeleteSessionWithACPCleanup deleted = false")
	}
	if _, err := os.Stat(localDir); !os.IsNotExist(err) {
		t.Fatalf("session scoped dir still exists or stat failed unexpectedly: %v", err)
	}
	if _, err := os.Stat(stableAgentDir); err != nil {
		t.Fatalf("stable agent dir should not be targeted by workspace-session cleanup: %v", err)
	}
	if _, ok := DefaultPersistentStore().LookupByConversation(cfg, sessionID); ok {
		t.Fatal("conversation runtime mapping still exists")
	}
}

func TestInstanceSendDisconnectRetry(t *testing.T) {
	driver := newRuntimeStubDriver("stub")
	driver.startSessions = []string{"sess-A", "sess-B"}
	driver.promptErrs = []error{errors.New("peer disconnected before response"), nil}
	reg := NewRegistry(nil, func(*proto.AgentRunRequestFrame) (FamilyDriver, error) { return driver, nil })

	cfg := testFC(t)
	req := fakeReq("conv-retry", "m1", "bypassPermissions", "", "")
	inst, _, err := reg.GetOrCreate(context.Background(), req, cfg)
	if err != nil {
		t.Fatalf("GetOrCreate: %v", err)
	}

	result, err := inst.Send(context.Background(), req, cfg, nil)
	if err != nil {
		t.Fatalf("Send: %v (expected retry to succeed)", err)
	}
	if !result.OK {
		t.Fatal("expected OK result after retry")
	}
	// 1 start (first) + 1 start (retry) = 2
	if driver.startCount.Load() != 2 {
		t.Fatalf("startCount = %d, want 2 (initial + retry)", driver.startCount.Load())
	}
	// 2 Prompt calls (first that errored + retry)
	if driver.promptCount.Load() != 2 {
		t.Fatalf("promptCount = %d, want 2", driver.promptCount.Load())
	}
	// Retry used inst.SessionID as ResumeSessionID
	driver.mu.Lock()
	resumes := make([]string, len(driver.receivedResume))
	copy(resumes, driver.receivedResume)
	driver.mu.Unlock()
	if len(resumes) < 2 || resumes[1] != "sess-A" {
		t.Fatalf("retry ResumeSessionID = %q, want sess-A", resumes[1])
	}
}

func TestInstanceSendDisconnectRetryThenFresh(t *testing.T) {
	driver := newRuntimeStubDriver("stub")
	driver.startSessions = []string{"sess-A", "sess-B", "sess-C"}
	// promptErrs: transport disconnect, transport disconnect again, then success
	driver.promptErrs = []error{
		errors.New("peer disconnected"),
		errors.New("broken pipe"),
		nil,
	}
	reg := NewRegistry(nil, func(*proto.AgentRunRequestFrame) (FamilyDriver, error) { return driver, nil })

	cfg := testFC(t)
	req := fakeReq("conv-retry2", "m1", "bypassPermissions", "", "")
	inst, _, err := reg.GetOrCreate(context.Background(), req, cfg)
	if err != nil {
		t.Fatalf("GetOrCreate: %v", err)
	}

	result, err := inst.Send(context.Background(), req, cfg, nil)
	if err != nil {
		t.Fatalf("Send: %v (expected retry chain to succeed)", err)
	}
	if !result.OK {
		t.Fatal("expected OK result after retry chain")
	}
	// 3 starts: initial, retry with sess-A, fresh with ResumeSessionID=""
	if driver.startCount.Load() != 3 {
		t.Fatalf("startCount = %d, want 3", driver.startCount.Load())
	}
	// Third StartProcess should have empty ResumeSessionID
	driver.mu.Lock()
	resumes := make([]string, len(driver.receivedResume))
	copy(resumes, driver.receivedResume)
	driver.mu.Unlock()
	if len(resumes) < 3 || resumes[2] != "" {
		t.Fatalf("fresh StartProcess ResumeSessionID = %q, want empty", resumes[2])
	}
}

func TestCreatedNewPropagation(t *testing.T) {
	driver := newRuntimeStubDriver("stub")
	driver.createdNewQueue = []bool{true} // first StartProcess is a fresh session
	reg := NewRegistry(nil, func(*proto.AgentRunRequestFrame) (FamilyDriver, error) { return driver, nil })

	cfg := testFC(t)
	req := fakeReq("conv-cn", "m1", "bypassPermissions", "", "")
	inst, _, err := reg.GetOrCreate(context.Background(), req, cfg)
	if err != nil {
		t.Fatalf("GetOrCreate: %v", err)
	}

	// First prompt: FP.CreatedNew should be true
	_, err = inst.Send(context.Background(), req, cfg, nil)
	if err != nil {
		t.Fatalf("first Send: %v", err)
	}
	driver.mu.Lock()
	if len(driver.lastCreatedNew) < 1 || !driver.lastCreatedNew[0] {
		driver.mu.Unlock()
		t.Fatal("expected CreatedNew=true on first Prompt")
	}
	driver.mu.Unlock()

	// Second turn with same policy: reuse, no new StartProcess, so the same
	// FamilyProcess (CreatedNew=true) is reused and Prompt sees it again.
	_, err = inst.Send(context.Background(), req, cfg, nil)
	if err != nil {
		t.Fatalf("second Send: %v", err)
	}
	driver.mu.Lock()
	if len(driver.lastCreatedNew) != 2 {
		driver.mu.Unlock()
		t.Fatalf("lastCreatedNew count = %d, want 2 (two Prompts)", len(driver.lastCreatedNew))
	}
	if !driver.lastCreatedNew[1] {
		driver.mu.Unlock()
		t.Fatal("second Prompt should still see CreatedNew=true (same FP reused)")
	}
	driver.mu.Unlock()
	// Crucially: no third StartProcess on reuse.
	if driver.startCount.Load() != 1 {
		t.Fatalf("startCount = %d, want 1 (no restart on reuse)", driver.startCount.Load())
	}
}

func TestReplaySuppressDeadline(t *testing.T) {
	if time.Until(agentprotocol.ReplaySuppressDeadline()) > 2*time.Second {
		t.Fatal("ReplaySuppressDeadline should be ~1.5s from now")
	}
}

func TestIsTransportDisconnect(t *testing.T) {
	cases := []struct {
		err  error
		want bool
	}{
		{nil, false},
		{errors.New("ok"), false},
		{io.EOF, true},
		{io.ErrUnexpectedEOF, true},
		{os.ErrClosed, true},
		{errors.New("peer disconnected"), true},
		{errors.New("broken pipe: transport"), true},
		{errors.New("agent ran fine"), false},
	}
	for _, tc := range cases {
		if got := IsTransportDisconnect(tc.err); got != tc.want {
			t.Fatalf("IsTransportDisconnect(%v) = %v, want %v", tc.err, got, tc.want)
		}
	}
}
