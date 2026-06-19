package agentruntime

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	agentprotocol "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentprotocol"
	daemonconfig "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/config"
	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
)

// stubDriver is a no-op FamilyDriver used to exercise the child_runtime →
// conversation Registry → Instance.Send wiring without spawning real agent
// processes. It mirrors the test stub in the conversation runtime package but lives here
// so the integration test can wire a registry through tryConversationRuntimeDispatch and
// verify SessionID exposure plus restart-on-config-change.
type stubDriver struct {
	id            string
	startCount    atomic.Int64
	stopCount     atomic.Int64
	promptCount   atomic.Int64
	startSessions []string
}

func (d *stubDriver) ID() string { return d.id }

func (d *stubDriver) StartProcess(ctx context.Context, cfg agentprotocol.FamilyConfig) (*agentprotocol.FamilyProcess, error) {
	d.startCount.Add(1)
	var sid string
	if len(d.startSessions) > 0 {
		sid = d.startSessions[0]
		d.startSessions = d.startSessions[1:]
	} else {
		sid = "session-default"
	}
	return &agentprotocol.FamilyProcess{SessionID: sid}, nil
}

func (d *stubDriver) Prompt(ctx context.Context, fp *agentprotocol.FamilyProcess, req *proto.AgentRunRequestFrame, emit func(proto.AgentRunEventFrame)) (proto.AgentRunResultFrame, error) {
	d.promptCount.Add(1)
	return proto.AgentRunResultFrame{
		Type:      proto.TAgentRunResult,
		OK:        true,
		Result:    "stub-result",
		SessionID: fp.SessionID,
		AgentID:   req.AgentID,
		RunID:     req.RunID,
	}, nil
}

func (d *stubDriver) Stop(fp *agentprotocol.FamilyProcess) error { d.stopCount.Add(1); return nil }

func (d *stubDriver) ListSessions(ctx context.Context, cfg *daemonconfig.Config, workspace string) ([]proto.AgentSessionInfo, error) {
	return nil, nil
}
func (d *stubDriver) DeleteSession(ctx context.Context, cfg *daemonconfig.Config, workspace, sessionID string) (bool, error) {
	return false, nil
}

// recordingChildServer captures Notify calls for the integration test so we
// can assert the agent.run.event stream reflects driver Prompt output.
type recordingChildServer struct {
	*ChildServer
	notifies []notifyRecord
}

type notifyRecord struct {
	method string
	frame  any
}

func newRecordingChildServer() *recordingChildServer {
	return &recordingChildServer{ChildServer: NewChildServer(ChildHandlers{})}
}

// We cannot easily intercept ChildServer.Notify (it writes to s.out). The
// integration test instead asserts on Registry / Instance side effects: the
// instance is created, persisted, reused, and restarted on config change.

func TestTryConversationRuntimeDispatchFirstTurn(t *testing.T) {
	driver := &stubDriver{id: "stub", startSessions: []string{"sess-X"}}
	resolver := func(*proto.AgentRunRequestFrame) (FamilyDriver, error) { return driver, nil }
	store := NewPersistentStore()
	reg := NewRegistry(store, resolver)

	cfg := &daemonconfig.Config{StateDir: t.TempDir()}
	req := &proto.AgentRunRequestFrame{
		RunID:   "run-1",
		AgentID: "stub",
		Cwd:     "/tmp",
		Input: proto.AgentRunInput{
			Prompt:   "hi",
			Metadata: map[string]any{"conversationId": "conv-A"},
		},
		Policy: proto.AgentRunPolicy{Model: "m1", PermissionMode: "bypassPermissions"},
	}
	server := newRecordingChildServer()

	result, handled, err := tryConversationRuntimeDispatch(context.Background(), cfg, reg, server.ChildServer, req, "/tmp", time.Now())
	if !handled {
		t.Fatal("expected handled=true")
	}
	if err != nil {
		t.Fatalf("dispatch err: %v", err)
	}
	if !result.OK {
		t.Fatal("expected OK result")
	}
	if result.SessionID != "sess-X" {
		t.Fatalf("SessionID = %q, want sess-X", result.SessionID)
	}
	if driver.startCount.Load() != 1 {
		t.Fatalf("startCount = %d, want 1", driver.startCount.Load())
	}
	if driver.promptCount.Load() != 1 {
		t.Fatalf("promptCount = %d, want 1", driver.promptCount.Load())
	}
	rec, ok := store.LookupByConversation(cfg, "conv-A")
	if !ok {
		t.Fatal("expected persisted record after first turn")
	}
	if rec.SessionID != "sess-X" {
		t.Fatalf("persisted SessionID = %q, want sess-X", rec.SessionID)
	}
}

func TestTryConversationRuntimeDispatchRestartOnModelChange(t *testing.T) {
	driver := &stubDriver{id: "stub", startSessions: []string{"sess-1", "sess-1-resumed"}}
	resolver := func(*proto.AgentRunRequestFrame) (FamilyDriver, error) { return driver, nil }
	store := NewPersistentStore()
	reg := NewRegistry(store, resolver)

	cfg := &daemonconfig.Config{StateDir: t.TempDir()}
	server := newRecordingChildServer()

	// Turn 1
	req1 := &proto.AgentRunRequestFrame{
		RunID: "run-1", AgentID: "stub", Cwd: "/tmp",
		Input:  proto.AgentRunInput{Prompt: "hi", Metadata: map[string]any{"conversationId": "conv-B"}},
		Policy: proto.AgentRunPolicy{Model: "m1", PermissionMode: "bypassPermissions"},
	}
	if _, _, err := tryConversationRuntimeDispatch(context.Background(), cfg, reg, server.ChildServer, req1, "/tmp", time.Now()); err != nil {
		t.Fatalf("turn 1: %v", err)
	}

	// Turn 2: model change → must restart with old SessionID as resume.
	req2 := &proto.AgentRunRequestFrame{
		RunID: "run-2", AgentID: "stub", Cwd: "/tmp",
		Input:  proto.AgentRunInput{Prompt: "hi-2", Metadata: map[string]any{"conversationId": "conv-B"}},
		Policy: proto.AgentRunPolicy{Model: "m2", PermissionMode: "bypassPermissions"},
	}
	result, _, err := tryConversationRuntimeDispatch(context.Background(), cfg, reg, server.ChildServer, req2, "/tmp", time.Now())
	if err != nil {
		t.Fatalf("turn 2: %v", err)
	}

	if driver.startCount.Load() != 2 {
		t.Fatalf("startCount = %d, want 2 (restart)", driver.startCount.Load())
	}
	if driver.stopCount.Load() != 1 {
		t.Fatalf("stopCount = %d, want 1 (old process stopped)", driver.stopCount.Load())
	}
	if result.SessionID != "sess-1-resumed" {
		t.Fatalf("post-restart SessionID = %q, want sess-1-resumed", result.SessionID)
	}
}

func TestTryConversationRuntimeDispatchFallsBackOnlyWhenNoFamilyDriver(t *testing.T) {
	reg := NewRegistry(NewPersistentStore(), func(*proto.AgentRunRequestFrame) (FamilyDriver, error) {
		return nil, ErrNoFamilyDriver
	})
	cfg := &daemonconfig.Config{StateDir: t.TempDir()}
	req := &proto.AgentRunRequestFrame{
		RunID:   "run-1",
		AgentID: "custom",
		Cwd:     "/tmp",
		Input: proto.AgentRunInput{
			Prompt:   "hi",
			Metadata: map[string]any{"conversationId": "conv-custom"},
		},
	}
	server := newRecordingChildServer()

	_, handled, err := tryConversationRuntimeDispatch(context.Background(), cfg, reg, server.ChildServer, req, "/tmp", time.Now())
	if err != nil {
		t.Fatalf("dispatch err: %v", err)
	}
	if handled {
		t.Fatal("expected no-family-driver request to fall through to custom transport")
	}
}
