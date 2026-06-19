package traex

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"

	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
)

// SDKBridge implements the acpsdk.Client interface that the daemon hands
// to acpsdk.NewClientSideConnection. It translates session_update / request_permission
// JSON-RPC notifications into AgentRunEventFrame instances and dispatches them
// through the user-supplied callback.
//
// Permission requests use the OctoDeck permission policy: when the policy says
// "auto-approve" we synthesize an Allow outcome locally so the agent process
// can proceed without round-tripping through the platform server.
type SDKBridge struct {
	Req      *proto.AgentRunRequestFrame
	Dispatch func(*proto.AgentRunEventFrame)
	Wait     PermissionWaiter
}

func (b *SDKBridge) emit(frame proto.AgentRunEventFrame) {
	if b != nil && b.Dispatch != nil {
		b.Dispatch(&frame)
	}
}

// SessionUpdate translates incoming acpsdk session updates into AgentRunEventFrames.
func (b *SDKBridge) SessionUpdate(_ context.Context, params acpsdk.SessionNotification) error {
	if b == nil || b.Req == nil {
		return nil
	}
	sessionID := string(params.SessionId)
	base := proto.AgentRunEventFrame{
		Type:      proto.TAgentRunEvent,
		RunID:     b.Req.RunID,
		AgentID:   b.Req.AgentID,
		SessionID: sessionID,
		At:        time.Now().UTC().Format(time.RFC3339Nano),
	}
	u := params.Update
	switch {
	case u.UserMessageChunk != nil:
		base.EventType = "log"
		um := u.UserMessageChunk
		payload := SDKPayloadVariant(um)
		payload["role"] = "user"
		payload["text"] = SDKContentBlockText(um.Content, false)
		if um.MessageId != nil {
			payload["messageId"] = *um.MessageId
		}
		base.Payload = payload
	case u.AgentMessageChunk != nil:
		base.EventType = "text_delta"
		base.Text = SDKContentBlockText(u.AgentMessageChunk.Content, false)
		base.Payload = SDKPayloadVariant(u.AgentMessageChunk)
	case u.AgentThoughtChunk != nil:
		base.EventType = "thinking_delta"
		base.Text = SDKContentBlockText(u.AgentThoughtChunk.Content, true)
		base.Payload = SDKPayloadVariant(u.AgentThoughtChunk)
	case u.ToolCall != nil:
		base.EventType = "tool_use_start"
		tc := u.ToolCall
		payload := SDKPayloadVariant(tc)
		payload["toolUseId"] = string(tc.ToolCallId)
		payload["id"] = string(tc.ToolCallId)
		payload["toolName"] = tc.Title
		payload["name"] = tc.Title
		payload["title"] = tc.Title
		if tc.RawInput != nil {
			payload["input"] = tc.RawInput
			payload["rawInput"] = tc.RawInput
		}
		if tc.Status != "" {
			payload["status"] = string(tc.Status)
		}
		payload["content"] = tc.Content
		base.Payload = payload
	case u.ToolCallUpdate != nil:
		tcu := u.ToolCallUpdate
		base.EventType = "tool_use_end"
		if tcu.Status != nil && (*tcu.Status == acpsdk.ToolCallStatusPending || *tcu.Status == acpsdk.ToolCallStatusInProgress) {
			base.EventType = "tool_use_start"
		}
		payload := SDKPayloadVariant(tcu)
		payload["toolUseId"] = string(tcu.ToolCallId)
		payload["id"] = string(tcu.ToolCallId)
		if tcu.Title != nil {
			payload["toolName"] = *tcu.Title
			payload["name"] = *tcu.Title
			payload["title"] = *tcu.Title
		}
		if tcu.RawInput != nil {
			payload["input"] = tcu.RawInput
			payload["rawInput"] = tcu.RawInput
		}
		if tcu.RawOutput != nil {
			payload["result"] = tcu.RawOutput
			payload["content"] = tcu.RawOutput
		}
		if tcu.Status != nil {
			payload["status"] = string(*tcu.Status)
		}
		payload["toolCallContent"] = tcu.Content
		base.Payload = payload
	case u.UsageUpdate != nil:
		base.EventType = "usage"
		base.Payload = SDKPayloadVariant(u.UsageUpdate)
	case u.SessionInfoUpdate != nil:
		base.EventType = "session"
		base.Payload = SDKPayloadVariant(u.SessionInfoUpdate)
	default:
		base.EventType = "log"
		base.Payload = SDKPayload(params)
	}
	b.emit(base)
	return nil
}

// SessionUpdateRaw accepts the codex/traex app-server ACP superset. The
// adapter emits both the standard ACP update envelope and legacy flat fields
// such as type=reasoning/tool_call_update; parsing the raw payload preserves
// reasoning and tool-call events even when the generated ACP SDK cannot bind a
// newer or non-standard variant.
func (b *SDKBridge) SessionUpdateRaw(ctx context.Context, raw json.RawMessage) error {
	if len(raw) == 0 {
		return nil
	}
	if rawSessionUpdateHasFlatType(raw) {
		return b.sessionUpdateRawMap(raw)
	}
	var params acpsdk.SessionNotification
	if err := json.Unmarshal(raw, &params); err == nil && hasDecodedSessionUpdate(params.Update) {
		return b.SessionUpdate(ctx, params)
	}
	return b.sessionUpdateRawMap(raw)
}

func rawSessionUpdateHasFlatType(raw json.RawMessage) bool {
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil || payload == nil {
		return false
	}
	switch strings.ToLower(strings.TrimSpace(FirstString(payload, "type"))) {
	case "reasoning", "thinking", "reasoning_delta",
		"agent_reasoning", "agent_reasoning_delta",
		"agent_reasoning_raw_content", "agent_reasoning_raw_content_delta",
		"reasoning_content_delta", "reasoning_raw_content_delta",
		"tool_call", "tool_use", "tool_use_start",
		"tool_call_update", "tool_result", "tool_use_end":
		return true
	default:
		return false
	}
}

func hasDecodedSessionUpdate(update acpsdk.SessionUpdate) bool {
	return update.UserMessageChunk != nil ||
		update.AgentMessageChunk != nil ||
		update.AgentThoughtChunk != nil ||
		update.ToolCall != nil ||
		update.ToolCallUpdate != nil ||
		update.Plan != nil ||
		update.PlanUpdate != nil ||
		update.PlanRemoved != nil ||
		update.AvailableCommandsUpdate != nil ||
		update.CurrentModeUpdate != nil ||
		update.ConfigOptionUpdate != nil ||
		update.SessionInfoUpdate != nil ||
		update.UsageUpdate != nil
}

func (b *SDKBridge) sessionUpdateRawMap(raw json.RawMessage) error {
	if b == nil || b.Req == nil {
		return nil
	}
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil || payload == nil {
		return nil
	}
	sessionID := FirstString(payload, "sessionId", "session_id")
	base := proto.AgentRunEventFrame{
		Type:      proto.TAgentRunEvent,
		RunID:     b.Req.RunID,
		AgentID:   b.Req.AgentID,
		SessionID: sessionID,
		At:        time.Now().UTC().Format(time.RFC3339Nano),
		Payload:   payload,
	}

	update, _ := payload["update"].(map[string]any)
	source := payload
	usingUpdate := false
	if update != nil && FirstString(update, "sessionUpdate", "type") != "" {
		source = update
		usingUpdate = true
	}
	kind := strings.ToLower(strings.TrimSpace(FirstString(source, "sessionUpdate", "type")))
	flatType := strings.ToLower(strings.TrimSpace(FirstString(payload, "type")))
	if kind == "" {
		kind = flatType
	}

	switch kind {
	case "user_message_chunk":
		base.EventType = "log"
		payload["role"] = "user"
		payload["text"] = contentTextFromPayload(source)
	case "agent_message_chunk", "message":
		role := strings.ToLower(strings.TrimSpace(FirstString(payload, "role")))
		if role == "user" {
			base.EventType = "log"
			payload["role"] = "user"
			payload["text"] = contentTextFromPayload(source)
		} else {
			base.EventType = "text_delta"
			base.Text = contentTextFromPayload(source)
		}
	case "agent_thought_chunk", "reasoning", "thinking", "reasoning_delta",
		"agent_reasoning", "agent_reasoning_delta",
		"agent_reasoning_raw_content", "agent_reasoning_raw_content_delta",
		"reasoning_content_delta", "reasoning_raw_content_delta":
		base.EventType = "thinking_delta"
		base.Text = reasoningTextFromPayload(source)
		if base.Text == "" && usingUpdate {
			base.Text = reasoningTextFromPayload(payload)
		}
		if base.Text == "" {
			return nil
		}
	case "tool_call", "tool_use", "tool_use_start":
		base.EventType = "tool_use_start"
		mergeRawUpdatePayload(payload, update)
		EnrichToolPayload(payload)
	case "tool_call_update", "tool_result", "tool_use_end":
		mergeRawUpdatePayload(payload, update)
		EnrichToolPayload(payload)
		status := strings.ToLower(strings.TrimSpace(FirstString(payload, "status")))
		if status == "pending" || status == "in_progress" || status == "in-progress" || status == "running" {
			base.EventType = "tool_use_start"
		} else {
			base.EventType = "tool_use_end"
		}
	case "usage_update", "usage":
		base.EventType = "usage"
	default:
		text := contentTextFromPayload(source)
		if text == "" && usingUpdate {
			text = contentTextFromPayload(payload)
		}
		if text == "" {
			text = FirstString(payload, "message", "status", "type")
		}
		base.EventType = "log"
		base.Text = text
	}
	b.emit(base)
	return nil
}

func mergeRawUpdatePayload(payload map[string]any, update map[string]any) {
	if payload == nil || update == nil {
		return
	}
	for _, key := range []string{"toolCallId", "toolUseId", "id", "title", "name", "toolName", "rawInput", "input", "rawOutput", "result", "content", "toolCallContent", "status"} {
		if payload[key] == nil && update[key] != nil {
			payload[key] = update[key]
		}
	}
	if payload["toolUseId"] == nil && payload["toolCallId"] != nil {
		payload["toolUseId"] = payload["toolCallId"]
	}
	if payload["id"] == nil && payload["toolCallId"] != nil {
		payload["id"] = payload["toolCallId"]
	}
	if payload["toolName"] == nil {
		if name := FirstString(payload, "title", "name", "message"); name != "" {
			payload["toolName"] = name
		}
	}
}

func contentTextFromPayload(payload map[string]any) string {
	if payload == nil {
		return ""
	}
	if text := ContentText(payload["content"], true); text != "" {
		return text
	}
	if text := FirstStringDeep(payload["content"], "text", "content", "thinking", "reasoning", "reason"); text != "" {
		return text
	}
	return FirstString(payload, "delta", "text", "message", "reasoning", "thinking", "reason", "status")
}

func reasoningTextFromPayload(payload map[string]any) string {
	if payload == nil {
		return ""
	}
	if text := ContentText(payload["content"], true); text != "" {
		return text
	}
	if text := FirstStringDeep(payload["content"], "text", "content", "thinking", "reasoning", "reason"); text != "" {
		return text
	}
	if text := FirstString(payload, "delta", "text", "reasoning", "thinking", "reason"); text != "" && !isTraexLifecycleMarker(text) {
		return text
	}
	return ""
}

func isTraexLifecycleMarker(text string) bool {
	switch strings.ToLower(strings.TrimSpace(text)) {
	case "turn_started", "turn_completed", "turn_cancelled", "turn_error",
		"item_started", "item_completed",
		"started", "completed", "cancelled", "error":
		return true
	default:
		return false
	}
}

func newACPMessageID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("00000000-0000-4000-8000-%012x", time.Now().UnixNano()&0xffffffffffff)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func replaySuppressDeadline() time.Time {
	return time.Now().Add(1500 * time.Millisecond)
}

func shouldSuppressReplayFrame(frame *proto.AgentRunEventFrame, prompt, messageID string, deadline time.Time) (matchedPrompt bool, suppress bool) {
	if frame == nil {
		return false, true
	}
	if isCurrentPromptEcho(frame, prompt, messageID) {
		return true, true
	}
	if !deadline.IsZero() && time.Now().After(deadline) {
		return false, false
	}
	return false, true
}

func isCurrentPromptEcho(frame *proto.AgentRunEventFrame, prompt, messageID string) bool {
	if frame == nil || frame.EventType != "log" || frame.Payload == nil {
		return false
	}
	role, _ := frame.Payload["role"].(string)
	if !strings.EqualFold(role, "user") {
		return false
	}
	if messageID != "" {
		if got, _ := frame.Payload["messageId"].(string); got == messageID {
			return true
		}
	}
	if prompt != "" {
		if text, _ := frame.Payload["text"].(string); strings.TrimSpace(text) == strings.TrimSpace(prompt) {
			return true
		}
	}
	return false
}

// PermissionWaiter blocks until the platform resolves an ACP permission request.
type PermissionWaiter func(ctx context.Context, runID, requestID string) (proto.AgentPermissionDecisionFrame, error)

// RequestPermission auto-approves when the run policy permits; otherwise it
// emits a permission_request event and waits for the platform decision when a
// waiter is available.
func (b *SDKBridge) RequestPermission(ctx context.Context, params acpsdk.RequestPermissionRequest) (acpsdk.RequestPermissionResponse, error) {
	if b != nil && b.Req != nil && ShouldAutoApprovePermissionMode(b.Req.Policy.PermissionMode) {
		if optionID, ok := SelectPermissionApprovalOption(params.Options); ok {
			return acpsdk.RequestPermissionResponse{Outcome: acpsdk.NewRequestPermissionOutcomeSelected(optionID)}, nil
		}
	}
	payload := SDKPayload(params)
	requestID := PermissionRequestID(payload)
	if requestID == "" {
		requestID = fmt.Sprintf("%s-%d", b.Req.RunID, time.Now().UnixNano())
		payload["requestId"] = requestID
	}
	b.emit(proto.AgentRunEventFrame{
		Type:      proto.TAgentRunEvent,
		RunID:     b.Req.RunID,
		AgentID:   b.Req.AgentID,
		EventType: "permission_request",
		Payload:   payload,
		At:        time.Now().UTC().Format(time.RFC3339Nano),
	})
	if b != nil && b.Wait != nil && b.Req != nil {
		decision, err := b.Wait(ctx, b.Req.RunID, requestID)
		if err == nil && strings.EqualFold(strings.TrimSpace(decision.Decision), "approve") {
			if optionID, ok := SelectPermissionApprovalOption(params.Options); ok {
				return acpsdk.RequestPermissionResponse{Outcome: acpsdk.NewRequestPermissionOutcomeSelected(optionID)}, nil
			}
		}
	}
	return acpsdk.RequestPermissionResponse{Outcome: acpsdk.NewRequestPermissionOutcomeCancelled()}, nil
}

// The remaining client-side capabilities (filesystem, terminal) are stubbed
// out: octodeck-daemon does not expose those bridge surfaces, so each method
// returns an explicit error so an agent that tries to use them gets a clear
// signal instead of an unbounded wait.

func (b *SDKBridge) ReadTextFile(context.Context, acpsdk.ReadTextFileRequest) (acpsdk.ReadTextFileResponse, error) {
	return acpsdk.ReadTextFileResponse{}, errors.New("octodeck ACP bridge does not expose client fs.readTextFile")
}

func (b *SDKBridge) WriteTextFile(context.Context, acpsdk.WriteTextFileRequest) (acpsdk.WriteTextFileResponse, error) {
	return acpsdk.WriteTextFileResponse{}, errors.New("octodeck ACP bridge does not expose client fs.writeTextFile")
}

func (b *SDKBridge) CreateTerminal(context.Context, acpsdk.CreateTerminalRequest) (acpsdk.CreateTerminalResponse, error) {
	return acpsdk.CreateTerminalResponse{}, errors.New("octodeck ACP bridge does not expose client terminal/create")
}

func (b *SDKBridge) KillTerminal(context.Context, acpsdk.KillTerminalRequest) (acpsdk.KillTerminalResponse, error) {
	return acpsdk.KillTerminalResponse{}, nil
}

func (b *SDKBridge) TerminalOutput(context.Context, acpsdk.TerminalOutputRequest) (acpsdk.TerminalOutputResponse, error) {
	return acpsdk.TerminalOutputResponse{}, nil
}

func (b *SDKBridge) ReleaseTerminal(context.Context, acpsdk.ReleaseTerminalRequest) (acpsdk.ReleaseTerminalResponse, error) {
	return acpsdk.ReleaseTerminalResponse{}, nil
}

func (b *SDKBridge) WaitForTerminalExit(context.Context, acpsdk.WaitForTerminalExitRequest) (acpsdk.WaitForTerminalExitResponse, error) {
	return acpsdk.WaitForTerminalExitResponse{}, nil
}
