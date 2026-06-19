package agentruntime

import (
	"errors"
	"io"
	"os"
	"strings"
)

// IsTransportDisconnect reports whether an error returned by a FamilyDriver's
// StartProcess / Prompt was caused by the underlying ACP transport closing
// (peer disconnect, broken pipe, EOF, JSON-RPC -32603 wrapping a transport
// disconnect, etc.). The Instance uses it to decide whether to Stop the
// process and retry once with the same SessionID before giving up.
//
// All builtin families (claudecode / codex / traex) surface transport
// failures through the same acpsdk / codexacp / claudeacp / exec pipe layer,
// so one string/identity matcher covers them. Mirrors the per-family helper
// in /acp_transport.go.
func IsTransportDisconnect(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, io.EOF) || errors.Is(err, os.ErrClosed) {
		return true
	}
	msg := strings.ToLower(err.Error())
	if strings.Contains(msg, "peer disconnected before response") ||
		strings.Contains(msg, "peer disconnected") ||
		strings.Contains(msg, "broken pipe") ||
		strings.Contains(msg, "use of closed") ||
		strings.Contains(msg, "unexpected eof") ||
		strings.Contains(msg, "connection reset") ||
		strings.Contains(msg, "transport error") {
		return true
	}
	if strings.Contains(msg, "-32603") || strings.Contains(msg, `"internal error"`) {
		if strings.Contains(msg, "disconnect") ||
			strings.Contains(msg, "transport") ||
			strings.Contains(msg, "broken pipe") ||
			strings.Contains(msg, "eof") {
			return true
		}
	}
	return false
}
