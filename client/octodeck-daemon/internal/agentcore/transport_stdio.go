package agentcore

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"sync"
	"sync/atomic"
	"time"

	agentoutput "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/output"
	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
)

type StdioPermissionWaiter func(ctx context.Context, runID, requestID string) (proto.AgentPermissionDecisionFrame, error)

func RunStdio(ctx context.Context, binary string, argv []string, cwd string, env []string, req *proto.AgentRunRequestFrame, started time.Time, outputJSON bool, parser func(string) []proto.AgentRunEventFrame, emit func(proto.AgentRunEventFrame), wait StdioPermissionWaiter) (proto.AgentRunResultFrame, error) {
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
	var finalText, finalResultFallback, sessionID string
	var finalUsage map[string]any
	pumpStdoutDone := make(chan struct{})
	pumpStderrDone := make(chan struct{})

	go func() {
		defer close(pumpStdoutDone)
		agentoutput.PumpStdout(ctx, stdout, req, outputJSON, parser, &sent, func(frame proto.AgentRunEventFrame) {
			if frame.EventType == "final_result" && frame.Text != "" {
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
				if usage := UsageFromPayload(frame.Payload); usage != nil {
					textMu.Lock()
					finalUsage = usage
					textMu.Unlock()
				}
			}
			if frame.EventType == "permission_request" {
				requestID := PermissionRequestID(frame.Payload)
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

	textMu.Lock()
	if finalText == "" && finalResultFallback != "" {
		finalText = finalResultFallback
	}
	textMu.Unlock()

	timedOut := errors.Is(ctx.Err(), context.DeadlineExceeded)
	if waitErr != nil && finalText == "" {
		return proto.AgentRunResultFrame{}, waitErr
	}
	return proto.AgentRunResultFrame{Type: proto.TAgentRunResult, RunID: req.RunID, AgentID: req.AgentID, OK: true, Result: finalText, SessionID: sessionID, Usage: finalUsage, TimedOut: timedOut, DurationMs: time.Since(started).Milliseconds()}, nil
}
