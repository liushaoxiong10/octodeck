// Package agentruntime: events.go centralises the small helpers used to
// shape outbound AgentRunEventFrame values before they are forwarded to
// the platform server. Streaming transports (stdio, ACP, custom A2A/HTTP)
// share these helpers so frame fields are populated identically regardless
// of the originating transport.
package agentruntime

import (
	"time"

	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
)

// FillEventDefaults populates RunID/AgentID/Type/At fields on a frame in
// place when a transport produced an event missing the common envelope
// metadata. Used by transports that translate provider-native frames into
// AgentRunEventFrame on the fly.
func FillEventDefaults(event *proto.AgentRunEventFrame, runID, agentID string) {
	if event == nil {
		return
	}
	if event.Type == "" {
		event.Type = proto.TAgentRunEvent
	}
	if event.RunID == "" {
		event.RunID = runID
	}
	if event.AgentID == "" {
		event.AgentID = agentID
	}
	if event.At == "" {
		event.At = FormatTime(time.Now())
	}
}

// NewLogEvent builds a transport-agnostic "log" event for emitting plain
// status text to the run stream (for example: "ACP transport disconnected").
func NewLogEvent(runID, agentID, text string) proto.AgentRunEventFrame {
	return proto.AgentRunEventFrame{
		Type:      proto.TAgentRunEvent,
		RunID:     runID,
		AgentID:   agentID,
		EventType: "log",
		Text:      text,
		At:        FormatTime(time.Now()),
	}
}

// NewTextDeltaEvent builds an "text_delta" frame used for streaming
// assistant text. The chunk is intentionally not trimmed/normalised; the
// transport decides whether to forward it byte-for-byte.
func NewTextDeltaEvent(runID, agentID, chunk string) proto.AgentRunEventFrame {
	return proto.AgentRunEventFrame{
		Type:      proto.TAgentRunEvent,
		RunID:     runID,
		AgentID:   agentID,
		EventType: "text_delta",
		Text:      chunk,
		At:        FormatTime(time.Now()),
	}
}
