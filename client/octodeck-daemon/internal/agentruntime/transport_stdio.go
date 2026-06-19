// Stdio transport (formerly internal/agenttransport/stdiotransport).
//
// This file hosts the lowest-level builder block of the daemon's agent run
// pipeline: it spawns an agent CLI as a stdio child process and translates
// its line-delimited output into AgentRunEventFrame stream events.
//
// promptrunner.go composes this with permission decisions, per-agent argv
// builders, and CWD resolution.
package agentruntime

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"sync"
	"sync/atomic"
	"time"

	agentcore "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentcore"
	agentoutput "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/output"
	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
)

// StdioPermissionWaiter is invoked when the agent's stdio output declares a
// permission_request event. It blocks until the user (or a policy default)
// resolves the request, returning either Decision="approve"/"reject" or an
// error if the wait fails. When error is non-nil or Decision == "reject" the
// caller will kill the agent process.
type StdioPermissionWaiter func(ctx context.Context, runID, requestID string) (proto.AgentPermissionDecisionFrame, error)

// RunStdio spawns binary with argv and pumps both stdout and stderr through
// agentoutput. It collects the final assistant text, native session id and
// token usage into an AgentRunResultFrame. Errors from cmd.Wait that happen
// after the agent emitted text are swallowed (so a graceful exit keyword
// during a streaming reply does not erase the user-visible answer).
func RunStdio(
	ctx context.Context,
	binary string,
	argv []string,
	cwd string,
	env []string,
	req *proto.AgentRunRequestFrame,
	started time.Time,
	outputJSON bool,
	parser func(string) []proto.AgentRunEventFrame,
	emit func(proto.AgentRunEventFrame),
	wait StdioPermissionWaiter,
) (proto.AgentRunResultFrame, error) {
	cmd := exec.CommandContext(ctx, binary, argv...)
	cmd.Dir = cwd
	cmd.Env = env
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return proto.AgentRunResultFrame{}, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return proto.AgentRunResultFrame{}, err
	}
	if err := cmd.Start(); err != nil {
		return proto.AgentRunResultFrame{}, err
	}

	var sent atomic.Int64
	var textMu sync.Mutex
	var finalText string
	var finalResultFallback string
	var sessionID string
	var finalUsage map[string]any
	pumpStdoutDone := make(chan struct{})
	pumpStderrDone := make(chan struct{})

	go func() {
		defer close(pumpStdoutDone)
		agentoutput.PumpStdout(ctx, stdout, req, outputJSON, parser, &sent, func(frame proto.AgentRunEventFrame) {
			if frame.EventType == "final_result" && frame.Text != "" {
				// Fallback result for single-shot CLIs that only emit a
				// complete answer (no streaming chunks). Accumulated lazily
				// only when no streaming text was seen so streaming CLIs
				// that append the full answer as a trailing result frame
				// don't get their output doubled.
				textMu.Lock()
				finalResultFallback = frame.Text
				textMu.Unlock()
				return
			}
			if frame.EventType == "text_delta" && frame.Text != "" {
				textMu.Lock()
				finalText += frame.Text
				textMu.Unlock()
			}
			if frame.SessionID != "" {
				sessionID = frame.SessionID
			}
			if frame.EventType == "usage" {
				if usage := agentcore.UsageFromPayload(frame.Payload); usage != nil {
					textMu.Lock()
					finalUsage = usage
					textMu.Unlock()
				}
			}
			if frame.EventType == "permission_request" {
				requestID := agentcore.PermissionRequestID(frame.Payload)
				if requestID == "" {
					requestID = fmt.Sprintf("%s-%d", req.RunID, time.Now().UnixNano())
					if frame.Payload == nil {
						frame.Payload = map[string]any{}
					}
					frame.Payload["requestId"] = requestID
				}
				emit(frame)
				if wait == nil {
					if cmd.Process != nil {
						_ = cmd.Process.Kill()
					}
					return
				}
				decision, decisionErr := wait(ctx, req.RunID, requestID)
				if decisionErr != nil || decision.Decision == "reject" {
					if cmd.Process != nil {
						_ = cmd.Process.Kill()
					}
				}
				return
			}
			emit(frame)
		})
	}()
	go func() {
		defer close(pumpStderrDone)
		agentoutput.PumpLog(stderr, req, &sent, emit)
	}()

	waitErr := cmd.Wait()
	<-pumpStdoutDone
	<-pumpStderrDone

	// Fallback to the trailing result-event payload for single-shot CLIs that
	// don't emit streaming text_delta chunks. When both streaming chunks and
	// a trailing result event exist, the
	// streaming text already represents the complete answer so we keep only
	// the streaming copy to avoid duplication.
	textMu.Lock()
	if finalText == "" && finalResultFallback != "" {
		finalText = finalResultFallback
	}
	textMu.Unlock()

	timedOut := errors.Is(ctx.Err(), context.DeadlineExceeded)
	if waitErr != nil && finalText == "" {
		return proto.AgentRunResultFrame{}, waitErr
	}
	errPtr := (*string)(nil)
	return proto.AgentRunResultFrame{
		Type:       proto.TAgentRunResult,
		RunID:      req.RunID,
		AgentID:    req.AgentID,
		OK:         true,
		Result:     finalText,
		Error:      errPtr,
		SessionID:  sessionID,
		Usage:      finalUsage,
		TimedOut:   timedOut,
		DurationMs: time.Since(started).Milliseconds(),
	}, nil
}
