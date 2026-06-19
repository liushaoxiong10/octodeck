// Package codex — FamilyDriver implementation for the new conversation runtime layer.
//
// codex runs the ACP server in-process via codexacp.EmbeddedRuntime. The
// driver wraps that with the simplified conversation runtime contract: every StartProcess
// builds a fresh runtime, Initializes it, and resolves a session
// (Load → Resume → New) using cfg.ResumeSessionID. The bound SessionID is
// returned on FamilyProcess so conversation runtime Instance can persist conversation→
// session and reuse it on restart.
package codex

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/beyond5959/acp-adapter/pkg/codexacp"
	acpsdk "github.com/coder/acp-go-sdk"

	agentprotocol "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentprotocol"
	daemonconfig "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/config"
	inventory "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/inventory"
	agentoutput "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/output"
	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
)

// Driver implements agentprotocol.FamilyDriver for the codex family.
type Driver struct {
	client inventory.Info
	entry  *daemonconfig.AgentRegistryEntry
	agent  *Agent // borrowed for embeddedRuntimeConfig / routeEmbeddedUpdates
}

// NewDriver builds a Driver bound to the discovered codex client + optional
// registry entry. agent is the family Agent instance (cheap; just holds
// inventory info), reused so we don't duplicate embeddedRuntimeConfig logic.
func NewDriver(client inventory.Info, entry *daemonconfig.AgentRegistryEntry) *Driver {
	return &Driver{
		client: client,
		entry:  entry,
		agent:  New(client, entry),
	}
}

// ID returns the agent client id this driver serves.
func (d *Driver) ID() string {
	if d == nil {
		return ""
	}
	return d.client.ID
}

// driverProcess is the driver-private handle attached to agentprotocol.FamilyProcess.
type driverProcess struct {
	runtime   *codexacp.EmbeddedRuntime
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

// StartProcess builds a fresh codexacp.EmbeddedRuntime, Initializes it, and
// resolves the session id. Returns FamilyProcess with SessionID set.
func (d *Driver) StartProcess(ctx context.Context, cfg agentprotocol.FamilyConfig) (*agentprotocol.FamilyProcess, error) {
	if d == nil {
		return nil, errors.New("codex driver: nil")
	}

	// Reuse the family Agent's embeddedRuntimeConfig so model/permission/
	// systemPrompt land in the embedded codexacp profile exactly as the
	// pre-conversation runtime path expects.
	syntheticReq := reqFromConfig(cfg)
	runtime := codexacp.NewEmbeddedRuntime(d.agent.embeddedRuntimeConfig(syntheticReq))
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

// resolveSessionID implements Load → Resume → New using cfg.ResumeSessionID.
// Returns the bound session id and createdNew=true when NewSession was used,
// false when LoadSession or ResumeSession succeeded (resumed conversation).
func resolveSessionID(ctx context.Context, cfg agentprotocol.FamilyConfig, runtime *codexacp.EmbeddedRuntime, initResult *acpsdk.InitializeResponse, req *proto.AgentRunRequestFrame) (string, bool, error) {
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
		return "", false, errors.New("codex driver: NewSession returned empty session id")
	}
	return sid, true, nil
}

// Prompt sends one prompt turn through the embedded runtime.
func (d *Driver) Prompt(ctx context.Context, fp *agentprotocol.FamilyProcess, req *proto.AgentRunRequestFrame, emit func(proto.AgentRunEventFrame)) (proto.AgentRunResultFrame, error) {
	proc, ok := fp.Handle().(*driverProcess)
	if !ok || proc == nil {
		return proto.AgentRunResultFrame{}, errors.New("codex driver: invalid process handle")
	}

	convID := agentprotocol.ConversationID(req)
	promptMessageID := newACPMessageID()
	var sent atomic.Int64
	var finalText atomicString
	var finalUsage atomic.Value
	started := time.Now()

	// Suppress historical replay when resuming an existing session.
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

// Stop tears the embedded runtime down.
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

// ListSessions / DeleteSession delegate to the existing family helpers.
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

// routeUpdates forwards codexacp session_update / request_permission RPCs to
// the bridge and onto the per-turn handler the driver installs in Prompt.
//
// The wait helper for permission decisions is currently nil — conversation runtime callers
// that need it (the platform decision waiter) will route through driver in a
// follow-up. Permissions therefore fall through to the auto-approve branch
// when policy permits, otherwise return cancelled.
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
				decision := codexacp.PermissionDecision{Outcome: "cancelled"}
				if resp.Outcome.Selected != nil {
					decision = codexacp.PermissionDecision{SelectedOptionID: string(resp.Outcome.Selected.OptionId)}
				}
				_ = proc.runtime.RespondPermission(ctx, *msg.ID, decision)
			}
		}
	}
}

// embeddedRequest is the package-private helper from transport_acp.go
// repackaged so the driver can call it without going through *Agent.
func embeddedRequest(ctx context.Context, runtime *codexacp.EmbeddedRuntime, method string, params any) (codexacp.RPCMessage, error) {
	raw, err := json.Marshal(params)
	if err != nil {
		return codexacp.RPCMessage{}, err
	}
	id := json.RawMessage(fmt.Sprintf("%d", time.Now().UnixNano()))
	resp, err := runtime.ClientRequest(ctx, codexacp.RPCMessage{JSONRPC: "2.0", ID: &id, Method: method, Params: raw})
	if err != nil {
		return codexacp.RPCMessage{}, err
	}
	if resp.Error != nil {
		return codexacp.RPCMessage{}, fmt.Errorf("ACP %s failed: %s", method, resp.Error.Message)
	}
	return resp, nil
}

// reqFromConfig synthesizes an AgentRunRequestFrame from a FamilyConfig so the
// family's existing helpers (embeddedRuntimeConfig) that expect a *req can run
// during StartProcess (which has no inbound request yet).
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
