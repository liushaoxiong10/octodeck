package traex

import (
	"context"
	"encoding/json"
	"strings"
	"sync/atomic"
	"testing"

	agentprotocol "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentprotocol"
	"github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/inventory"
	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
)

func TestTraexMemoryPathUsesSharedTraeHome(t *testing.T) {
	agent := &Agent{}
	if got, want := agent.MemoryPath("/home/tester"), "/home/tester/.trae/AGENTS.md"; got != want {
		t.Fatalf("MemoryPath() = %q, want %q", got, want)
	}
}

func TestDriverStopCancelsAdapterRuntime(t *testing.T) {
	var stopped atomic.Bool
	proc := &driverProcess{
		cancel: func() {
			stopped.Store(true)
		},
	}
	fp := &agentprotocol.FamilyProcess{SessionID: "sess-1"}
	fp.SetHandle(proc)

	driver := &Driver{}
	if err := driver.Stop(fp); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if !stopped.Load() {
		t.Fatal("expected Stop to cancel the embedded runtime context")
	}
	if err := driver.Stop(fp); err != nil {
		t.Fatalf("second Stop: %v", err)
	}
}

func TestSessionUpdateRawMapsTraexReasoningAndToolCalls(t *testing.T) {
	req := &proto.AgentRunRequestFrame{RunID: "run-1", AgentID: "traex-acp"}
	var frames []proto.AgentRunEventFrame
	bridge := &SDKBridge{Req: req, Dispatch: func(frame *proto.AgentRunEventFrame) {
		frames = append(frames, *frame)
	}}

	inputs := []string{
		`{"sessionId":"sess-1","type":"reasoning","delta":"thinking","update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"thinking"}}}`,
		`{"sessionId":"sess-1","type":"tool_call_update","toolCallId":"tool-1","message":"Read file","status":"pending","update":{"sessionUpdate":"tool_call_update","toolCallId":"tool-1","title":"Read file","status":"pending","rawInput":{"path":"README.md"}}}`,
		`{"sessionId":"sess-1","type":"tool_call_update","toolCallId":"tool-1","status":"completed","update":{"sessionUpdate":"tool_call_update","toolCallId":"tool-1","status":"completed","rawOutput":{"ok":true}}}`,
	}
	for _, input := range inputs {
		if err := bridge.SessionUpdateRaw(context.Background(), json.RawMessage(input)); err != nil {
			t.Fatalf("SessionUpdateRaw(%s): %v", input, err)
		}
	}
	if len(frames) != 3 {
		t.Fatalf("frames len = %d, want 3: %#v", len(frames), frames)
	}
	if frames[0].EventType != "thinking_delta" || frames[0].Text != "thinking" {
		t.Fatalf("reasoning frame = %#v", frames[0])
	}
	if frames[1].EventType != "tool_use_start" || frames[1].Payload["toolUseId"] != "tool-1" || frames[1].Payload["toolName"] != "Read file" {
		t.Fatalf("tool start frame = %#v", frames[1])
	}
	if frames[2].EventType != "tool_use_end" || frames[2].Payload["toolUseId"] != "tool-1" {
		t.Fatalf("tool end frame = %#v", frames[2])
	}
}

func TestSessionUpdateRawKeepsFlatTraexSupersetFields(t *testing.T) {
	req := &proto.AgentRunRequestFrame{RunID: "run-1", AgentID: "traex-acp"}
	var frames []proto.AgentRunEventFrame
	bridge := &SDKBridge{Req: req, Dispatch: func(frame *proto.AgentRunEventFrame) {
		frames = append(frames, *frame)
	}}

	inputs := []string{
		`{"sessionId":"sess-1","type":"reasoning","message":"flat thought","update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"standard thought"}}}`,
		`{"sessionId":"sess-1","type":"tool_call_update","toolCallId":"tool-1","message":"Shell","status":"in_progress","update":{"sessionUpdate":"tool_call_update","toolCallId":"tool-1","status":"in_progress","rawInput":{"cmd":"go test"}}}`,
	}
	for _, input := range inputs {
		if err := bridge.SessionUpdateRaw(context.Background(), json.RawMessage(input)); err != nil {
			t.Fatalf("SessionUpdateRaw(%s): %v", input, err)
		}
	}
	if len(frames) != 2 {
		t.Fatalf("frames len = %d, want 2: %#v", len(frames), frames)
	}
	if frames[0].EventType != "thinking_delta" || frames[0].Text != "standard thought" {
		t.Fatalf("reasoning frame = %#v", frames[0])
	}
	if frames[0].Payload["type"] != "reasoning" || frames[0].Payload["message"] != "flat thought" {
		t.Fatalf("reasoning flat fields not preserved: %#v", frames[0].Payload)
	}
	if frames[1].EventType != "tool_use_start" || frames[1].Payload["toolUseId"] != "tool-1" || frames[1].Payload["toolName"] != "Shell" {
		t.Fatalf("tool frame = %#v", frames[1])
	}
	if rawInput, ok := frames[1].Payload["rawInput"].(map[string]any); !ok || rawInput["cmd"] != "go test" {
		t.Fatalf("tool rawInput not preserved: %#v", frames[1].Payload)
	}
}

func TestSessionUpdateRawDoesNotTreatLifecycleStatusAsReasoning(t *testing.T) {
	req := &proto.AgentRunRequestFrame{RunID: "run-1", AgentID: "traex-acp"}
	var frames []proto.AgentRunEventFrame
	bridge := &SDKBridge{Req: req, Dispatch: func(frame *proto.AgentRunEventFrame) {
		frames = append(frames, *frame)
	}}

	inputs := []string{
		`{"sessionId":"sess-1","type":"status","status":"turn_started"}`,
		`{"sessionId":"sess-1","type":"status","status":"item_started"}`,
		`{"sessionId":"sess-1","type":"status","status":"item_completed"}`,
		`{"sessionId":"sess-1","type":"reasoning","status":"turn_started"}`,
	}
	for _, input := range inputs {
		if err := bridge.SessionUpdateRaw(context.Background(), json.RawMessage(input)); err != nil {
			t.Fatalf("SessionUpdateRaw(%s): %v", input, err)
		}
	}
	for _, frame := range frames {
		if frame.EventType == "thinking_delta" {
			t.Fatalf("lifecycle status emitted thinking_delta: %#v", frame)
		}
	}
}

func TestSessionUpdateRawDoesNotTreatSDKStatusUpdateAsReasoning(t *testing.T) {
	req := &proto.AgentRunRequestFrame{RunID: "run-1", AgentID: "traex-acp"}
	var frames []proto.AgentRunEventFrame
	bridge := &SDKBridge{Req: req, Dispatch: func(frame *proto.AgentRunEventFrame) {
		frames = append(frames, *frame)
	}}

	input := `{"sessionId":"sess-1","update":{"sessionUpdate":"status","status":"item_started","itemType":"reasoning"}}`
	if err := bridge.SessionUpdateRaw(context.Background(), json.RawMessage(input)); err != nil {
		t.Fatalf("SessionUpdateRaw(%s): %v", input, err)
	}
	if len(frames) != 1 {
		t.Fatalf("frames len = %d, want 1: %#v", len(frames), frames)
	}
	if frames[0].EventType == "thinking_delta" {
		t.Fatalf("status update emitted thinking_delta: %#v", frames[0])
	}
	if frames[0].EventType != "session" && frames[0].EventType != "log" {
		t.Fatalf("status update EventType = %q, want session/log", frames[0].EventType)
	}
}

func TestSessionUpdateRawMapsTraexReasoningContentDelta(t *testing.T) {
	req := &proto.AgentRunRequestFrame{RunID: "run-1", AgentID: "traex-acp"}
	var frames []proto.AgentRunEventFrame
	bridge := &SDKBridge{Req: req, Dispatch: func(frame *proto.AgentRunEventFrame) {
		frames = append(frames, *frame)
	}}

	inputs := []string{
		`{"sessionId":"sess-1","type":"reasoning_content_delta","delta":"real thought"}`,
		`{"sessionId":"sess-1","type":"agent_reasoning_delta","delta":" summary"}`,
	}
	for _, input := range inputs {
		if err := bridge.SessionUpdateRaw(context.Background(), json.RawMessage(input)); err != nil {
			t.Fatalf("SessionUpdateRaw(%s): %v", input, err)
		}
	}
	if len(frames) != 2 {
		t.Fatalf("frames len = %d, want 2: %#v", len(frames), frames)
	}
	if frames[0].EventType != "thinking_delta" || frames[0].Text != "real thought" {
		t.Fatalf("reasoning_content_delta frame = %#v", frames[0])
	}
	if frames[1].EventType != "thinking_delta" || frames[1].Text != " summary" {
		t.Fatalf("agent_reasoning_delta frame = %#v", frames[1])
	}
}

func TestUsageFromPayloadAcceptsAdapterPromptResultUsageSnapshot(t *testing.T) {
	usage := UsageFromPayload(map[string]any{
		"stopReason": "end_turn",
		"used":       321,
		"size":       128000,
		"cost":       map[string]any{"amount": 0.0123, "currency": "USD"},
		"usage": map[string]any{
			"inputTokens":      321,
			"outputTokens":     45,
			"totalTokens":      366,
			"cachedReadTokens": 12,
			"thoughtTokens":    7,
		},
	})
	if usage == nil {
		t.Fatal("expected adapter prompt result usage snapshot to be detected")
	}
	if usage["inputTokens"] != 321 {
		t.Fatalf("usage inputTokens = %#v, want 321", usage["inputTokens"])
	}
	if usage["outputTokens"] != 45 {
		t.Fatalf("usage outputTokens = %#v, want 45", usage["outputTokens"])
	}
}

func TestMergeUsageMapsKeepsOutputTokensFromEarlierSnapshot(t *testing.T) {
	got := MergeUsageMaps(
		map[string]any{
			"inputTokens":      321,
			"outputTokens":     45,
			"totalTokens":      366,
			"cachedReadTokens": 12,
		},
		map[string]any{
			"inputTokens":  400,
			"outputTokens": 0,
			"totalTokens":  400,
		},
	)

	if got["inputTokens"] != 400 {
		t.Fatalf("inputTokens = %#v, want 400", got["inputTokens"])
	}
	if got["outputTokens"] != 45 {
		t.Fatalf("outputTokens = %#v, want 45", got["outputTokens"])
	}
	if got["totalTokens"] != 400 {
		t.Fatalf("totalTokens = %#v, want 400", got["totalTokens"])
	}
}

func TestMergeUsageMapsKeepsSnakeCaseOutputTokensFromEarlierSnapshot(t *testing.T) {
	got := MergeUsageMaps(
		map[string]any{
			"input_tokens":  321,
			"output_tokens": 45,
			"total_tokens":  366,
		},
		map[string]any{
			"input_tokens":  400,
			"output_tokens": 0,
			"total_tokens":  400,
		},
	)

	if got["input_tokens"] != 400 {
		t.Fatalf("input_tokens = %#v, want 400", got["input_tokens"])
	}
	if got["output_tokens"] != 45 {
		t.Fatalf("output_tokens = %#v, want 45", got["output_tokens"])
	}
}

func TestSessionUpdateRawPrefersRawEnvelopeForExtendedFields(t *testing.T) {
	req := &proto.AgentRunRequestFrame{RunID: "run-1", AgentID: "traex-acp"}
	var frames []proto.AgentRunEventFrame
	bridge := &SDKBridge{Req: req, Dispatch: func(frame *proto.AgentRunEventFrame) {
		frames = append(frames, *frame)
	}}

	raw := json.RawMessage(`{"sessionId":"sess-1","update":{"sessionUpdate":"tool_call_update","toolCallId":"tool-1","title":"Shell","status":"completed","rawOutput":{"ok":true}}}`)
	if err := bridge.SessionUpdateRaw(context.Background(), raw); err != nil {
		t.Fatalf("SessionUpdateRaw: %v", err)
	}
	if len(frames) != 1 {
		t.Fatalf("frames len = %d, want 1", len(frames))
	}
	if frames[0].EventType != "tool_use_end" || frames[0].Payload["toolUseId"] != "tool-1" || frames[0].Payload["toolName"] != "Shell" {
		t.Fatalf("frame = %#v", frames[0])
	}
	if _, ok := frames[0].Payload["result"].(map[string]any); !ok {
		t.Fatalf("raw output not preserved: %#v", frames[0].Payload)
	}
}

func TestAdapterRuntimeConfigDoesNotInjectStartupModel(t *testing.T) {
	agent := New(inventoryForTest(), nil)
	got := agent.embeddedRuntimeConfig(&proto.AgentRunRequestFrame{
		Policy: proto.AgentRunPolicy{
			Model:          "gpt-5.5",
			PermissionMode: "bypassPermissions",
		},
	}).AppServerArgs
	for i, arg := range got {
		if arg == "-m" || arg == "--model" || strings.HasPrefix(arg, "--model=") {
			t.Fatalf("AppServerArgs[%d] unexpectedly selects model: %#v", i, got)
		}
	}
}

func TestConversationRuntimeConversationIDUsesServerConversationBeforeProviderSession(t *testing.T) {
	req := &proto.AgentRunRequestFrame{
		RunID:   "run-x",
		AgentID: "traex-acp",
		Workspace: &proto.AgentRunWorkspace{
			Scope:       "session",
			ScopeID:     "scope-id",
			SessionRoot: "server-conv",
		},
		Input: proto.AgentRunInput{
			SessionID: "provider-session",
			Metadata: map[string]any{
				"workspaceSessionId":   "workspace-session",
				"serverConversationId": "metadata-server-conv",
				"chatId":               "chat-id",
			},
		},
	}
	if got := agentprotocol.ConversationID(req); got != "server-conv" {
		t.Fatalf("ConversationID = %q, want server-conv", got)
	}
}

func TestDriverPromptTextInjectsSystemContextOnlyForNewSession(t *testing.T) {
	driver := &Driver{}
	req := &proto.AgentRunRequestFrame{
		Input: proto.AgentRunInput{Prompt: "user prompt"},
		Policy: proto.AgentRunPolicy{
			SystemPrompt: "OctoDeck system prompt",
		},
	}
	first := driver.promptText(req, true)
	if !strings.Contains(first, "<octodeck-system-context>\nOctoDeck system prompt\n</octodeck-system-context>") {
		t.Fatalf("first driver prompt missing system context: %q", first)
	}
	if !strings.Contains(first, "<user-prompt>\nuser prompt\n</user-prompt>") {
		t.Fatalf("first driver prompt missing user prompt wrapper: %q", first)
	}
	if resumed := driver.promptText(req, false); resumed != "user prompt" {
		t.Fatalf("resumed driver prompt = %q, want raw user prompt", resumed)
	}
}

func inventoryForTest() inventory.Info {
	return inventory.Info{ID: "traex-acp", DisplayName: "TraeX", Provider: "traex", Transport: "acp"}
}
