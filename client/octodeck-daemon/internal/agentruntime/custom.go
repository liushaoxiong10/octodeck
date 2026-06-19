package agentruntime

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os/exec"
	"strings"
	"sync/atomic"
	"time"

	agentprotocol "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentprotocol"
	daemonconfig "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/config"
	mcp "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/mcp"
	agentoutput "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/output"
	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
)

// PlainAgent is the fallback agent that simply passes the prompt as an
// argument to the binary.
type PlainAgent struct{ BaseAgent }

// CustomStdioAgent is a custom agent that runs via stdio transport with
// configurable argument templates.
type CustomStdioAgent struct {
	BaseAgent
	Entry daemonconfig.AgentRegistryEntry
}

// CustomA2AAgent is a custom agent that runs via the A2A JSON-RPC protocol.
type CustomA2AAgent struct {
	BaseAgent
	Entry *daemonconfig.AgentRegistryEntry
}

// CustomHTTPAgent is a custom agent that runs via HTTP POST to a configured URL.
type CustomHTTPAgent struct {
	BaseAgent
	Entry daemonconfig.AgentRegistryEntry
}

// BuildRunCommand builds the argv for a plain agent.
func (a *PlainAgent) BuildRunCommand(_ *daemonconfig.Config, req *proto.AgentRunRequestFrame) ([]string, bool, error) {
	return []string{PromptWithSystemContext(req, req.Input.SessionID == "")}, false, nil
}

// RunPrompt runs the plain agent via stdio.
func (a *PlainAgent) RunPrompt(ctx context.Context, run *agentprotocol.RunContext) (proto.AgentRunResultFrame, error) {
	argv, outputJSON, err := a.BuildRunCommand(run.Cfg, run.Req)
	if err != nil {
		return proto.AgentRunResultFrame{}, err
	}
	return RunStdioAgentPrompt(ctx, run, argv, outputJSON)
}

// BuildRunCommand builds the argv for a custom stdio agent using template
// replacement.
func (a *CustomStdioAgent) BuildRunCommand(_ *daemonconfig.Config, req *proto.AgentRunRequestFrame) ([]string, bool, error) {
	args := append([]string(nil), a.Entry.Args...)
	if len(args) == 0 {
		args = []string{"{{prompt}}"}
	}
	prompt := PromptWithSystemContext(req, req.Input.SessionID == "")
	replacer := strings.NewReplacer(
		"{{prompt}}", prompt,
		"{{sessionId}}", req.Input.SessionID,
		"{{cwd}}", req.Cwd,
		"{{model}}", req.Policy.Model,
	)
	for i := range args {
		args[i] = replacer.Replace(args[i])
	}
	return args, ContainsString(a.Client.Capabilities, "stream-json"), nil
}

// RunPrompt runs the custom stdio agent.
func (a *CustomStdioAgent) RunPrompt(ctx context.Context, run *agentprotocol.RunContext) (proto.AgentRunResultFrame, error) {
	argv, outputJSON, err := a.BuildRunCommand(run.Cfg, run.Req)
	if err != nil {
		return proto.AgentRunResultFrame{}, err
	}
	return RunStdioAgentPrompt(ctx, run, argv, outputJSON)
}

// BuildRunCommand is not used for A2A agents.
func (a *CustomA2AAgent) BuildRunCommand(_ *daemonconfig.Config, req *proto.AgentRunRequestFrame) ([]string, bool, error) {
	return nil, false, fmt.Errorf("a2a agent adapter %s runs via protocol transport", a.Client.ID)
}

// RunPrompt runs the A2A agent via direct transport.
func (a *CustomA2AAgent) RunPrompt(ctx context.Context, run *agentprotocol.RunContext) (proto.AgentRunResultFrame, error) {
	return RunDirectAgentPrompt(ctx, run, a)
}

// RunDirect executes the A2A agent by spawning the binary and communicating
// via JSON-RPC over stdio.
func (a *CustomA2AAgent) RunDirect(ctx context.Context, cfg *daemonconfig.Config, req *proto.AgentRunRequestFrame, emit func(proto.AgentRunEventFrame)) (proto.AgentRunResultFrame, error) {
	started := time.Now()
	args := []string{}
	if a.Entry != nil {
		args = append(args, a.Entry.Args...)
	}
	cmd := exec.CommandContext(ctx, a.Client.Binary, args...)
	cmd.Dir = req.Cwd
	cmd.Env = BuildAgentEnv(cfg, req.AgentID, req.Env, req.Context)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return proto.AgentRunResultFrame{}, err
	}
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
	var logDone = make(chan struct{})
	go func() {
		defer close(logDone)
		agentoutput.PumpLog(stderr, req, &sent, emit)
	}()

	params := map[string]any{
		"runId":     req.RunID,
		"agentId":   req.AgentID,
		"workspace": req.Workspace,
		"input":     req.Input,
		"policy":    req.Policy,
		"context":   req.Context,
		"cwd":       req.Cwd,
	}
	if server, err := mcp.ServerConfigForDaemon(cfg, req.Env); err == nil {
		params["mcpServers"] = map[string]any{"octodeck_agent_team": server}
	}
	paramsJSON, _ := json.Marshal(params)
	id := int64(1)
	call := RPCMessage{JSONRPC: "2.0", ID: &id, Method: "agent.run", Params: paramsJSON}
	callJSON, err := json.Marshal(call)
	if err != nil {
		_ = stdin.Close()
		return proto.AgentRunResultFrame{}, err
	}
	if _, err := stdin.Write(append(callJSON, '\n')); err != nil {
		_ = stdin.Close()
		return proto.AgentRunResultFrame{}, err
	}
	_ = stdin.Close()

	result, readErr := readA2AAgentResult(ctx, stdout, req, &sent, emit)
	waitErr := cmd.Wait()
	<-logDone
	if readErr != nil {
		return proto.AgentRunResultFrame{}, readErr
	}
	if waitErr != nil && result.Result == "" && result.Error == nil && result.ErrorInfo == nil {
		return proto.AgentRunResultFrame{}, waitErr
	}
	if result.Error == nil && result.ErrorInfo != nil {
		msg := result.ErrorInfo.Message
		result.Error = &msg
	}
	result.TimedOut = errors.Is(ctx.Err(), context.DeadlineExceeded)
	if result.DurationMs == 0 {
		result.DurationMs = time.Since(started).Milliseconds()
	}
	if result.RunID == "" {
		result.RunID = req.RunID
	}
	if result.AgentID == "" {
		result.AgentID = req.AgentID
	}
	return result, nil
}

// BuildRunCommand is not used for HTTP agents.
func (a *CustomHTTPAgent) BuildRunCommand(_ *daemonconfig.Config, req *proto.AgentRunRequestFrame) ([]string, bool, error) {
	return nil, false, fmt.Errorf("http agent adapter %s runs via direct transport", a.Entry.ID)
}

// RunPrompt runs the HTTP agent via direct transport.
func (a *CustomHTTPAgent) RunPrompt(ctx context.Context, run *agentprotocol.RunContext) (proto.AgentRunResultFrame, error) {
	return RunDirectAgentPrompt(ctx, run, a)
}

// customHTTPRunResponse is the expected response format from an HTTP agent.
type customHTTPRunResponse struct {
	OK        bool                       `json:"ok"`
	Result    string                     `json:"result,omitempty"`
	Error     *string                    `json:"error"`
	ErrorInfo *proto.AgentRunError       `json:"errorInfo,omitempty"`
	SessionID string                     `json:"sessionId,omitempty"`
	Usage     map[string]any             `json:"usage,omitempty"`
	Events    []proto.AgentRunEventFrame `json:"events,omitempty"`
}

// RunDirect executes the HTTP agent by POSTing to the configured URL.
func (a *CustomHTTPAgent) RunDirect(ctx context.Context, _ *daemonconfig.Config, req *proto.AgentRunRequestFrame, emit func(proto.AgentRunEventFrame)) (proto.AgentRunResultFrame, error) {
	started := time.Now()
	payload := map[string]any{
		"runId":     req.RunID,
		"agentId":   req.AgentID,
		"workspace": req.Workspace,
		"input":     req.Input,
		"policy":    req.Policy,
		"context":   req.Context,
		"cwd":       req.Cwd,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return proto.AgentRunResultFrame{}, err
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, a.Entry.URL, bytes.NewReader(body))
	if err != nil {
		return proto.AgentRunResultFrame{}, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	client := &http.Client{}
	resp, err := client.Do(httpReq)
	if err != nil {
		return proto.AgentRunResultFrame{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return proto.AgentRunResultFrame{}, fmt.Errorf("http agent %s returned %s: %s", a.Entry.ID, resp.Status, strings.TrimSpace(string(data)))
	}
	var parsed customHTTPRunResponse
	if err := json.NewDecoder(io.LimitReader(resp.Body, 16*1024*1024)).Decode(&parsed); err != nil {
		return proto.AgentRunResultFrame{}, err
	}
	for _, event := range parsed.Events {
		if event.RunID == "" {
			event.RunID = req.RunID
		}
		if event.AgentID == "" {
			event.AgentID = req.AgentID
		}
		if event.Type == "" {
			event.Type = proto.TAgentRunEvent
		}
		if event.At == "" {
			event.At = FormatTime(time.Now())
		}
		emit(event)
	}
	if !parsed.OK && parsed.Error == nil && parsed.ErrorInfo == nil {
		msg := "http agent reported failure"
		parsed.Error = &msg
	}
	return proto.AgentRunResultFrame{OK: parsed.OK, Result: parsed.Result, Error: parsed.Error, ErrorInfo: parsed.ErrorInfo, SessionID: parsed.SessionID, Usage: parsed.Usage, TimedOut: errors.Is(ctx.Err(), context.DeadlineExceeded), DurationMs: time.Since(started).Milliseconds()}, nil
}

// readA2AAgentResult reads JSON-RPC messages from an A2A agent's stdout and
// accumulates the final result.
func readA2AAgentResult(ctx context.Context, r io.Reader, req *proto.AgentRunRequestFrame, sent *atomic.Int64, emit func(proto.AgentRunEventFrame)) (proto.AgentRunResultFrame, error) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	var final proto.AgentRunResultFrame
	var text strings.Builder
	for scanner.Scan() {
		if ctx.Err() != nil {
			break
		}
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var msg RPCMessage
		if err := json.Unmarshal([]byte(line), &msg); err != nil {
			if agentoutput.AllowBytes(sent, int64(len(line)), req.MaxOutputBytes) {
				chunk := line + "\n"
				text.WriteString(chunk)
				emit(proto.AgentRunEventFrame{Type: proto.TAgentRunEvent, RunID: req.RunID, AgentID: req.AgentID, EventType: "text_delta", Text: chunk, At: FormatTime(time.Now())})
			}
			continue
		}
		if msg.Method != "" {
			switch msg.Method {
			case "agent.run.event":
				var event proto.AgentRunEventFrame
				if json.Unmarshal(msg.Params, &event) == nil {
					if event.Type == "" {
						event.Type = proto.TAgentRunEvent
					}
					if event.RunID == "" {
						event.RunID = req.RunID
					}
					if event.AgentID == "" {
						event.AgentID = req.AgentID
					}
					if event.At == "" {
						event.At = FormatTime(time.Now())
					}
					if event.Text != "" && agentoutput.AllowBytes(sent, int64(len(event.Text)), req.MaxOutputBytes) {
						text.WriteString(event.Text)
					}
					emit(event)
				}
			case "agent.run.result":
				_ = json.Unmarshal(msg.Params, &final)
			}
			continue
		}
		if msg.ID != nil {
			if msg.Error != nil {
				m := FormatRPCErrorString(msg.Error)
				return proto.AgentRunResultFrame{OK: false, Error: &m, ErrorInfo: &proto.AgentRunError{Code: "a2a_error", Message: m}}, nil
			}
			var direct proto.AgentRunResultFrame
			if len(msg.Result) > 0 && json.Unmarshal(msg.Result, &direct) == nil && (direct.Result != "" || direct.Error != nil || direct.ErrorInfo != nil || direct.SessionID != "") {
				final = direct
				continue
			}
			var wrapped customHTTPRunResponse
			if len(msg.Result) > 0 && json.Unmarshal(msg.Result, &wrapped) == nil {
				for _, event := range wrapped.Events {
					if event.Type == "" {
						event.Type = proto.TAgentRunEvent
					}
					if event.RunID == "" {
						event.RunID = req.RunID
					}
					if event.AgentID == "" {
						event.AgentID = req.AgentID
					}
					emit(event)
				}
				final = proto.AgentRunResultFrame{OK: wrapped.OK, Result: wrapped.Result, Error: wrapped.Error, ErrorInfo: wrapped.ErrorInfo, SessionID: wrapped.SessionID, Usage: wrapped.Usage}
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return final, err
	}
	if final.Result == "" && text.Len() > 0 {
		final.Result = text.String()
	}
	if final.Error == nil && final.ErrorInfo != nil {
		msg := final.ErrorInfo.Message
		final.Error = &msg
	}
	if final.Error == nil && !final.OK {
		if final.Result != "" {
			final.OK = true
		}
	}
	return final, nil
}
