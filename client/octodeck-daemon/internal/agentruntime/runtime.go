// Package agentruntime hosts shared protocol types and helpers used between
// the daemon's parent process (agentRuntimeSupervisor) and the agent-runtime
// child process (agentRuntimeProcess).
//
// The full supervisor/child split lives in daemonapp because both ends are
// coupled to daemon-side state (run pool, agents map, permission decisions).
// This package focuses on the wire types that are stable enough to live on
// their own — ad-hoc JSON-RPC envelopes, error formatting and restart
// back-off logic.
package agentruntime

import (
	"encoding/json"
	"time"
)

// RPCMessage is the loose JSON-RPC envelope carried over the agent-runtime
// stdio pipe. Some fields are filled only on requests, others on responses;
// the daemonapp callers narrow them by inspection.
type RPCMessage struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      *int64          `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *RPCError       `json:"error,omitempty"`
}

// RPCError mirrors a JSON-RPC error object (code+message+optional data).
type RPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

// FormatRPCErrorString formats a JSON-RPC error into a single readable string
// that includes both the message and any details from the data field.
// This ensures transport-disconnect messages buried in data.error are
// visible to error-detection helpers like acppool.IsTransportDisconnect.
func FormatRPCErrorString(e *RPCError) string {
	if e == nil {
		return ""
	}
	msg := e.Message
	if e.Data != nil {
		if dataMap, ok := e.Data.(map[string]any); ok {
			if inner, ok := dataMap["error"].(string); ok && inner != "" {
				if msg != "" {
					msg = msg + ": " + inner
				} else {
					msg = inner
				}
			}
		}
		if msg == "Internal error" || msg == "" {
			if dataJSON, err := json.Marshal(e.Data); err == nil && len(dataJSON) > 2 {
				if msg != "" {
					msg = msg + " " + string(dataJSON)
				} else {
					msg = string(dataJSON)
				}
			}
		}
	}
	return msg
}

// RestartBackoff returns the exponential restart backoff for the given
// crash count. baseMs is the configured base delay (defaults to 1000ms when
// non-positive). Each crash doubles the delay up to a cap of 32x base.
func RestartBackoff(baseMs int64, crashCount int) time.Duration {
	if baseMs <= 0 {
		baseMs = 1000
	}
	if crashCount < 1 {
		crashCount = 1
	}
	mult := 1 << minInt(crashCount-1, 5)
	return time.Duration(baseMs*int64(mult)) * time.Millisecond
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// DaemonVersion is the version string used when initializing ACP connections.
// daemonapp must call SetDaemonVersion during init() before any ACP code runs.
var DaemonVersion = "octodeck-daemon/0.0.0"

// SetDaemonVersion sets the daemon version string. Called by daemonapp during init().
func SetDaemonVersion(v string) {
	DaemonVersion = v
	setFamilyDaemonVersions(v)
}
