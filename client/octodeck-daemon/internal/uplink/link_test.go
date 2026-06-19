package uplink

import (
	"context"
	"testing"

	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
)

func TestBuildURLPromotesScheme(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"https://example.com", "wss://example.com/api/agent-link/ws"},
		{"http://example.com", "ws://example.com/api/agent-link/ws"},
		{"wss://example.com/", "wss://example.com/api/agent-link/ws"},
		{"ws://example.com:8080/base", "ws://example.com:8080/base/api/agent-link/ws"},
	}
	for _, tc := range cases {
		got, err := BuildURL(tc.in)
		if err != nil {
			t.Fatalf("BuildURL(%q): %v", tc.in, err)
		}
		if got != tc.want {
			t.Fatalf("BuildURL(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestBuildURLRejectsUnsupportedScheme(t *testing.T) {
	if _, err := BuildURL("ftp://example.com"); err == nil {
		t.Fatalf("expected error for ftp:// scheme")
	}
}

func TestHandlersDispatchRoutesEachFrameType(t *testing.T) {
	called := map[string]bool{}
	h := Handlers{
		OnRunRequest:       func(_ context.Context, _ *proto.RunRequestFrame) { called["run.request"] = true },
		OnRunCancel:        func(_ *proto.RunCancelFrame) { called["run.cancel"] = true },
		OnAgentRunRequest:  func(_ context.Context, _ *proto.AgentRunRequestFrame) { called["agent.run.request"] = true },
		OnAgentRunCancel:   func(_ *proto.AgentRunCancelFrame) { called["agent.run.cancel"] = true },
		OnAgentDiscover:    func(_ context.Context, _ *proto.AgentDiscoverRequestFrame) { called["agent.discover"] = true },
		OnAgentSessions:    func(_ context.Context, _ *proto.AgentSessionsRequestFrame) { called["agent.sessions"] = true },
		OnAgentSessionDel:  func(_ context.Context, _ *proto.AgentSessionDeleteRequestFrame) { called["agent.session.delete"] = true },
		OnAgentPermission:  func(_ context.Context, _ *proto.AgentPermissionDecisionFrame) { called["agent.permission"] = true },
		OnWorkspaceCleanup: func(_ *proto.WorkspaceCleanupRequestFrame) { called["workspace.cleanup"] = true },
		OnToolRequest:      func(_ context.Context, _ *proto.ToolRequestFrame) { called["tool.request"] = true },
		OnToolCancel:       func(_ *proto.ToolCancelFrame) { called["tool.cancel"] = true },
		OnModelsRequest:    func(_ context.Context, _ *proto.ModelsRequestFrame) { called["models.request"] = true },
		OnSkillsRequest:    func(_ context.Context, _ *proto.SkillsRequestFrame) { called["skills.request"] = true },
		OnDaemonUpdate:     func(_ context.Context, _ *proto.DaemonUpdateRequestFrame) { called["daemon.update"] = true },
	}
	frames := []any{
		&proto.RunRequestFrame{},
		&proto.RunCancelFrame{},
		&proto.AgentRunRequestFrame{},
		&proto.AgentRunCancelFrame{},
		&proto.AgentDiscoverRequestFrame{},
		&proto.AgentSessionsRequestFrame{},
		&proto.AgentSessionDeleteRequestFrame{},
		&proto.AgentPermissionDecisionFrame{},
		&proto.WorkspaceCleanupRequestFrame{},
		&proto.ToolRequestFrame{},
		&proto.ToolCancelFrame{},
		&proto.ModelsRequestFrame{},
		&proto.SkillsRequestFrame{},
		&proto.DaemonUpdateRequestFrame{},
	}
	for _, frame := range frames {
		if err := h.dispatch(context.Background(), frame); err != nil {
			t.Fatalf("dispatch(%T): unexpected error %v", frame, err)
		}
	}
	wantKeys := []string{
		"run.request", "run.cancel",
		"agent.run.request", "agent.run.cancel",
		"agent.discover", "agent.sessions", "agent.session.delete", "agent.permission",
		"workspace.cleanup",
		"tool.request", "tool.cancel",
		"models.request", "skills.request",
		"daemon.update",
	}
	for _, key := range wantKeys {
		if !called[key] {
			t.Fatalf("handler %q was not invoked", key)
		}
	}
}

func TestHandlersDispatchFatalErrorReturnsErr(t *testing.T) {
	h := Handlers{
		OnFatalError: func(f *proto.ErrorFrame) error {
			return ctxErrSentinel{code: f.Code}
		},
	}
	err := h.dispatch(context.Background(), &proto.ErrorFrame{Fatal: true, Code: "boom"})
	if err == nil {
		t.Fatalf("expected fatal error to propagate")
	}
	if err.(ctxErrSentinel).code != "boom" {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestHandlersDispatchNonFatalErrorIsIgnored(t *testing.T) {
	h := Handlers{}
	if err := h.dispatch(context.Background(), &proto.ErrorFrame{Fatal: false, Code: "warn"}); err != nil {
		t.Fatalf("non-fatal error must not surface: %v", err)
	}
}

type ctxErrSentinel struct{ code string }

func (e ctxErrSentinel) Error() string { return "fatal:" + e.code }
