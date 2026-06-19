// Package claudecode — FamilyDriver implementation for conversation runtime.
//
// claudecode runs ACP in-process via claudeacp.EmbeddedRuntime. The driver
// wraps that with the conversation runtime contract: StartProcess builds a runtime,
// Initializes it, resolves a session (Load → Resume → New), and exposes
// the bound SessionID on FamilyProcess.
package claudecode

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/beyond5959/acp-adapter/pkg/claudeacp"
	acpsdk "github.com/coder/acp-go-sdk"

	agentprotocol "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentprotocol"
	daemonconfig "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/config"
	inventory "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/inventory"
	agentoutput "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/output"
	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
)

// Driver implements agentprotocol.FamilyDriver for the claude family.
type Driver struct {
	client inventory.Info
	entry  *daemonconfig.AgentRegistryEntry
	agent  *Agent // borrowed for embeddedRuntimeConfig / routeUpdates
}

// NewDriver builds a Driver for the discovered claude client.
func NewDriver(client inventory.Info, entry *daemonconfig.AgentRegistryEntry) *Driver {
	return &Driver{
		client: client,
		entry:  entry,
		agent:  New(client, entry),
	}
}

// ID returns the agent client id.
func (d *Driver) ID() string {
	if d == nil {
		return ""
	}
	return d.client.ID
}

type driverProcess struct {
	runtime   *claudeacp.EmbeddedRuntime
	cancel    context.CancelFunc
	sessionID string

	mu      sync.Mutex
	handler func(*proto.AgentRunEventFrame)
}

func (p *driverProcess) Dispatch(frame *proto.AgentRunEventFrame) {
	p.mu.Lock()
	h := p.handler
	p.mu.Unlock()
	if h != nil && frame != nil {
		h(frame)
	}
}

func (p *driverProcess) SetHandler(h func(*proto.AgentRunEventFrame)) {
	p.mu.Lock()
	p.handler = h
	p.mu.Unlock()
}

// StartProcess builds a fresh claudeacp runtime, Initializes it, and resolves a session.
func (d *Driver) StartProcess(ctx context.Context, cfg agentprotocol.FamilyConfig) (*agentprotocol.FamilyProcess, error) {
	if d == nil {
		return nil, errors.New("claude driver: nil")
	}

	syntheticReq := reqFromConfig(cfg)
	runtime := claudeacp.NewEmbeddedRuntime(d.agent.embeddedRuntimeConfig(syntheticReq))
	runCtx, cancel := context.WithCancel(context.Background())

	proc := &driverProcess{runtime: runtime, cancel: cancel}

	if err := runtime.Start(runCtx); err != nil {
		cancel()
		return nil, err
	}
	go d.routeUpdates(runCtx, proc, syntheticReq)

	initResp, err := embeddedRequest(ctx, runtime, acpsdk.AgentMethodInitialize, acpsdk.InitializeRequest{
		ProtocolVersion: acpsdk.ProtocolVersionNumber,
		ClientInfo:      &acpsdk.Implementation{Name: "octodeck-daemon", Version: DaemonVersion},
		ClientCapabilities: acpsdk.ClientCapabilities{
			Fs: acpsdk.FileSystemCapabilities{ReadTextFile: false, WriteTextFile: false},
		},
	})
	if err != nil {
		cancel()
		return nil, err
	}
	var initResult acpsdk.InitializeResponse
	if err := json.Unmarshal(initResp.Result, &initResult); err != nil {
		cancel()
		return nil, err
	}

	sessionID, createdNew, err := resolveSessionID(ctx, cfg, runtime, &initResult, syntheticReq)
	if err != nil {
		cancel()
		return nil, err
	}
	proc.sessionID = sessionID

	fp := &agentprotocol.FamilyProcess{SessionID: sessionID, CreatedNew: createdNew}
	fp.SetHandle(proc)
	return fp, nil
}

func resolveSessionID(ctx context.Context, cfg agentprotocol.FamilyConfig, runtime *claudeacp.EmbeddedRuntime, initResult *acpsdk.InitializeResponse, req *proto.AgentRunRequestFrame) (string, bool, error) {
	mcpServers := buildACPSDKMCPServers(cfg.Cfg, cfg.Env)
	resume := strings.TrimSpace(cfg.ResumeSessionID)
	convID := agentprotocol.ConversationID(req)

	if resume != "" {
		if initResult != nil && initResult.AgentCapabilities.LoadSession {
			if _, err := embeddedRequest(ctx, runtime, acpsdk.AgentMethodSessionLoad, acpsdk.LoadSessionRequest{
				Cwd:        cfg.Cwd,
				SessionId:  acpsdk.SessionId(resume),
				McpServers: mcpServers,
				Meta:       map[string]any{"octodeckConversationId": convID, "policy": req.Policy},
			}); err == nil {
				return resume, false, nil
			}
		}
		if initResult != nil && initResult.AgentCapabilities.SessionCapabilities.Resume != nil {
			if _, err := embeddedRequest(ctx, runtime, acpsdk.AgentMethodSessionResume, acpsdk.ResumeSessionRequest{
				Cwd:        cfg.Cwd,
				SessionId:  acpsdk.SessionId(resume),
				McpServers: mcpServers,
				Meta:       map[string]any{"octodeckConversationId": convID, "policy": req.Policy},
			}); err == nil {
				return resume, false, nil
			}
		}
	}
	created, err := embeddedRequest(ctx, runtime, acpsdk.AgentMethodSessionNew, acpsdk.NewSessionRequest{
		Cwd:        cfg.Cwd,
		McpServers: mcpServers,
		Meta:       map[string]any{"octodeckConversationId": convID, "policy": req.Policy},
	})
	if err != nil {
		return "", false, err
	}
	var resp acpsdk.NewSessionResponse
	if err := json.Unmarshal(created.Result, &resp); err != nil {
		return "", false, err
	}
	sid := strings.TrimSpace(string(resp.SessionId))
	if sid == "" {
		return "", false, errors.New("claude driver: NewSession returned empty session id")
	}
	return sid, true, nil
}

// Prompt sends one prompt turn through the embedded runtime.
func (d *Driver) Prompt(ctx context.Context, fp *agentprotocol.FamilyProcess, req *proto.AgentRunRequestFrame, emit func(proto.AgentRunEventFrame)) (proto.AgentRunResultFrame, error) {
	proc, ok := fp.Handle().(*driverProcess)
	if !ok || proc == nil {
		return proto.AgentRunResultFrame{}, errors.New("claude driver: invalid process handle")
	}

	convID := agentprotocol.ConversationID(req)
	promptMessageID := newACPMessageID()
	var sent atomic.Int64
	var finalText atomicString
	var finalUsage atomic.Value
	started := time.Now()

	suppressReplay := !fp.CreatedNew
	suppressReplayUntil := agentprotocol.ReplaySuppressDeadline()

	proc.SetHandler(func(frame *proto.AgentRunEventFrame) {
		if frame == nil {
			return
		}
		if suppressReplay {
			matchedPrompt, suppress := agentprotocol.ShouldSuppressReplayFrame(frame, req.Input.Prompt, promptMessageID, suppressReplayUntil)
			if matchedPrompt {
				suppressReplay = false
			}
			if suppress {
				return
			}
			suppressReplay = false
		}
		if frame.Text != "" && !agentoutput.AllowBytes(&sent, int64(len(frame.Text)), req.MaxOutputBytes) {
			return
		}
		if frame.EventType == "text_delta" && frame.Text != "" {
			finalText.Append(frame.Text)
		}
		if frame.EventType == "usage" {
			if usage := UsageFromPayload(frame.Payload); usage != nil {
				finalUsage.Store(usage)
			}
		}
		if emit != nil {
			emit(*frame)
		}
	})
	defer proc.SetHandler(nil)

	promptResp, promptErr := embeddedRequest(ctx, proc.runtime, acpsdk.AgentMethodSessionPrompt, acpsdk.PromptRequest{
		SessionId: acpsdk.SessionId(proc.sessionID),
		MessageId: &promptMessageID,
		Prompt:    []acpsdk.ContentBlock{acpsdk.TextBlock(req.Input.Prompt)},
		Meta: map[string]any{
			"policy":                 req.Policy,
			"context":                req.Context,
			"octodeckConversationId": convID,
			"runId":                  req.RunID,
			"messageId":              promptMessageID,
		},
	})
	if promptErr == nil {
		var resp acpsdk.PromptResponse
		if err := json.Unmarshal(promptResp.Result, &resp); err == nil && resp.Usage != nil {
			finalUsage.Store(UsageToMap(resp.Usage))
		}
	}

	usage, _ := finalUsage.Load().(map[string]any)
	result := proto.AgentRunResultFrame{
		Type:       proto.TAgentRunResult,
		RunID:      req.RunID,
		AgentID:    req.AgentID,
		OK:         promptErr == nil,
		Result:     finalText.String(),
		SessionID:  proc.sessionID,
		Usage:      usage,
		TimedOut:   ctx.Err() == context.DeadlineExceeded,
		DurationMs: time.Since(started).Milliseconds(),
	}
	if promptErr != nil {
		msg := promptErr.Error()
		result.Error = &msg
	}
	return result, promptErr
}

// Stop cancels the embedded runtime context.
func (d *Driver) Stop(fp *agentprotocol.FamilyProcess) error {
	if fp == nil {
		return nil
	}
	if proc, ok := fp.Handle().(*driverProcess); ok && proc != nil {
		if proc.cancel != nil {
			proc.cancel()
		}
	}
	return nil
}

func (d *Driver) ListSessions(ctx context.Context, cfg *daemonconfig.Config, workspace string) ([]proto.AgentSessionInfo, error) {
	clientID := ""
	if d != nil {
		clientID = d.client.ID
	}
	return ListSessions(ctx, cfg, clientID, workspace)
}

func (d *Driver) DeleteSession(ctx context.Context, cfg *daemonconfig.Config, workspace, sessionID string) (bool, error) {
	clientID := ""
	if d != nil {
		clientID = d.client.ID
	}
	return DeleteSession(ctx, cfg, clientID, workspace, sessionID)
}

func (d *Driver) routeUpdates(ctx context.Context, proc *driverProcess, req *proto.AgentRunRequestFrame) {
	updates, unsubscribe := proc.runtime.SubscribeUpdates(64)
	defer unsubscribe()
	bridge := &SDKBridge{Req: req, Dispatch: proc.Dispatch}
	for {
		select {
		case <-ctx.Done():
			return
		case msg, ok := <-updates:
			if !ok {
				return
			}
			if msg.Method == acpsdk.ClientMethodSessionUpdate {
				var params acpsdk.SessionNotification
				if err := json.Unmarshal(msg.Params, &params); err == nil {
					_ = bridge.SessionUpdate(ctx, params)
				}
				continue
			}
			if msg.Method == acpsdk.ClientMethodSessionRequestPermission && msg.ID != nil {
				var params acpsdk.RequestPermissionRequest
				if err := json.Unmarshal(msg.Params, &params); err != nil {
					continue
				}
				resp, _ := bridge.RequestPermission(ctx, params)
				decision := claudeacp.PermissionDecision{Outcome: "cancelled"}
				if resp.Outcome.Selected != nil {
					decision = claudeacp.PermissionDecision{SelectedOptionID: string(resp.Outcome.Selected.OptionId)}
				}
				_ = proc.runtime.RespondPermission(ctx, *msg.ID, decision)
			}
		}
	}
}

func embeddedRequest(ctx context.Context, runtime *claudeacp.EmbeddedRuntime, method string, params any) (claudeacp.RPCMessage, error) {
	raw, err := json.Marshal(params)
	if err != nil {
		return claudeacp.RPCMessage{}, err
	}
	id := json.RawMessage(fmt.Sprintf("%d", time.Now().UnixNano()))
	resp, err := runtime.ClientRequest(ctx, claudeacp.RPCMessage{JSONRPC: "2.0", ID: &id, Method: method, Params: raw})
	if err != nil {
		return claudeacp.RPCMessage{}, err
	}
	if resp.Error != nil {
		return claudeacp.RPCMessage{}, fmt.Errorf("ACP %s failed: %s", method, resp.Error.Message)
	}
	return resp, nil
}

func reqFromConfig(cfg agentprotocol.FamilyConfig) *proto.AgentRunRequestFrame {
	return &proto.AgentRunRequestFrame{
		AgentID:   cfg.AgentClientID,
		Cwd:       cfg.Cwd,
		Workspace: cfg.Workspace,
		Env:       cfg.Env,
		Input: proto.AgentRunInput{
			SessionID: cfg.ResumeSessionID,
		},
		Policy: proto.AgentRunPolicy{
			Model:           cfg.Model,
			PermissionMode:  cfg.PermissionMode,
			SystemPrompt:    cfg.SystemPrompt,
			AllowedTools:    cfg.AllowedTools,
			DisallowedTools: cfg.DisallowedTools,
			ToolPolicy:      cfg.ToolPolicy,
		},
		MaxOutputBytes: cfg.MaxOutputBytes,
	}
}
