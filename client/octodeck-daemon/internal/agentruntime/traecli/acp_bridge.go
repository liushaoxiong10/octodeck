package traecli

import (
	"context"
	"crypto/rand"
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
