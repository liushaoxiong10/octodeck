// Package agentruntime: errors.go hosts the runtime error types and codes
// that the supervisor / child server use when reporting a failed run. Each
// concrete error eventually flows back to the platform server inside
// AgentRunResultFrame.ErrorInfo.
package agentruntime

import (
	"errors"
	"fmt"

	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
)

// Standard error codes used by RunErrorCode and other helpers when
// classifying a failed run.
const (
	RunErrorCodeTimeout      = "timeout"
	RunErrorCodeRunFailed    = "run_failed"
	RunErrorCodePolicyDenied = "policy_denied"
	RunErrorCodeRuntime      = "runtime_error"
	RunErrorCodeA2A          = "a2a_error"
)

// RuntimeError is a typed wrapper around a low-level error carrying the
// error code that the platform server uses for retry / surface decisions.
// It implements `error` and unwrap so existing callers that only want a
// message can keep using err.Error()/errors.Is().
type RuntimeError struct {
	Code      string
	Message   string
	Retryable bool
	Cause     error
}

// Error implements the error interface.
func (e *RuntimeError) Error() string {
	if e == nil {
		return ""
	}
	if e.Message != "" {
		return e.Message
	}
	if e.Cause != nil {
		return e.Cause.Error()
	}
	return e.Code
}

// Unwrap allows errors.Is/errors.As to traverse the chain.
func (e *RuntimeError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Cause
}

// AsAgentRunError converts a RuntimeError into the wire-format
// AgentRunError carried by the result frame. Returns nil when e is nil.
func (e *RuntimeError) AsAgentRunError() *proto.AgentRunError {
	if e == nil {
		return nil
	}
	return &proto.AgentRunError{Code: e.Code, Message: e.Error(), Retryable: e.Retryable}
}

// NewTimeoutError builds a "timeout" RuntimeError; convenience for
// transports that only know context.DeadlineExceeded fired.
func NewTimeoutError(cause error) *RuntimeError {
	return &RuntimeError{Code: RunErrorCodeTimeout, Message: "agent run timed out", Retryable: true, Cause: cause}
}

// WrapRunError converts a free-form error + timed-out flag into a
// RuntimeError, mirroring the classification done by RunErrorCode.
func WrapRunError(err error, timedOut bool) *RuntimeError {
	if err == nil {
		return nil
	}
	code := RunErrorCode(err, timedOut)
	return &RuntimeError{Code: code, Message: err.Error(), Retryable: timedOut, Cause: err}
}

// ErrAgentNotFound is returned when an agent runs against an agentID that
// does not match any of the discovered agent clients.
var ErrAgentNotFound = errors.New("agent client not discovered")

// AgentNotFoundError wraps ErrAgentNotFound with the offending id so the
// platform sees a more informative message.
func AgentNotFoundError(agentID string) error {
	return fmt.Errorf("%w: %s", ErrAgentNotFound, agentID)
}
