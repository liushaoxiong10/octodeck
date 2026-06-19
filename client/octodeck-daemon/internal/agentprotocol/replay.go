package agentprotocol

import (
	"strings"
	"time"

	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
)

// ReplaySuppressDeadline is the default cutoff for suppressing historical
// session_update replay after LoadSession/ResumeSession. After this point any
// remaining replay frames are released to the caller. 1.5s matches the legacy
// per-family helper; the value is empirical from the codexacp/claudeacp/
// traecli adapters and balances "wait long enough for the prompt echo to
// arrive" against "do not stall a fast-replying agent".
func ReplaySuppressDeadline() time.Time {
	return time.Now().Add(1500 * time.Millisecond)
}

// ShouldSuppressReplayFrame implements the replay-suppression decision used
// by every family driver after a non-fresh session is bound (LoadSession /
// ResumeSession): suppress every replay frame until either the current prompt
// echo arrives (matchedPrompt=true → flip suppression off) or the deadline
// expires (suppress=false → release subsequent frames).
//
// Returns:
//
//	matchedPrompt — true when frame is the user-message echo of the current
//	                turn's prompt. Caller turns suppression off after this.
//	suppress      — true when the frame should be dropped (still in replay
//	                window and not the prompt echo). false to forward.
//
// Identical semantics to traecli/acp_bridge.go's per-family helper; lifted
// here so claudecode/codex/traex/traecli drivers share one implementation.
func ShouldSuppressReplayFrame(frame *proto.AgentRunEventFrame, prompt, messageID string, deadline time.Time) (matchedPrompt bool, suppress bool) {
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

// isCurrentPromptEcho reports whether frame is the user-message echo of the
// current turn's prompt — matched first by messageID (preferred, exact) and
// secondarily by trimmed prompt text (fallback for providers that drop the
// id). Same matcher as the legacy traecli helper.
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
