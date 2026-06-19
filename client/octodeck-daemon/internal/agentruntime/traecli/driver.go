// Package traecli — FamilyDriver implementation for the new conversation runtime layer.
//
// conversation runtime Instance owns conversation-indexed lifecycle, compares
// model/permissionMode/systemPrompt, and restarts the process on change. This
// driver is the thin family adapter conversation runtime calls into: it owns nothing
// stateful itself — each StartProcess spawns a fresh `traecli acp serve`
// child, Initialize's it, resolves a session (Load→Resume→New), and exposes
// the bound SessionID on the returned FamilyProcess.
package traecli

import (
	"context"
	"errors"
	"io"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"

	agentcore "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentcore"
	agentprotocol "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentprotocol"
	daemonconfig "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/config"
	inventory "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/inventory"
	agentoutput "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/output"
	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
)

// Driver implements agentprotocol.FamilyDriver for the Trae CLI family. It holds no
// mutable state — every StartProcess spawns a new child process — so a single
// shared instance can serve all conversations.
type Driver struct {
	client inventory.Info
	entry  *daemonconfig.AgentRegistryEntry
}

// NewDriver builds a Driver bound to the discovered traecli client + optional
// registry entry.
func NewDriver(client inventory.Info, entry *daemonconfig.AgentRegistryEntry) *Driver {
	return &Driver{client: client, entry: entry}
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
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	client *acpsdk.ClientSideConnection
	done   chan error

	agentID    string
	cwd        string
	sessionID  string
	convID     string
	model      string
	permMode   string
	createdNew bool

	mu      sync.Mutex
	handler func(*proto.AgentRunEventFrame)

	cancel context.CancelFunc
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

func (p *driverProcess) stop() {
	if p == nil {
		return
	}
	if p.cancel != nil {
		p.cancel()
	}
	if p.stdin != nil {
		_ = p.stdin.Close()
	}
	if p.cmd != nil && p.cmd.Process != nil {
		_ = p.cmd.Process.Kill()
	}
}

// StartProcess spawns `traecli acp serve`, initializes the ACP connection, and
// resolves a session. Session resolution order (matches the historic Connection):
//
//  1. LoadSession(cfg.ResumeSessionID) when the provider advertises it
//  2. ResumeSession(cfg.ResumeSessionID) when Load is unavailable / fails
//  3. NewSession (fresh)
//
// The bound session id is written to FamilyProcess.SessionID so conversation runtime can
// persist conversation→session and reuse it on restart.
func (d *Driver) StartProcess(ctx context.Context, cfg agentprotocol.FamilyConfig) (*agentprotocol.FamilyProcess, error) {
	if d == nil || d.client.Binary == "" {
		return nil, errors.New("traecli driver: no binary configured")
	}

	// Build the server argv with family-specific normalization (acp serve,
	// model.name, --yolo).
	args := append([]string(nil), d.client.Args...)
	if d.entry != nil && len(d.entry.Args) > 0 {
		args = append([]string(nil), d.entry.Args...)
	}
	policy := proto.AgentRunPolicy{
		Model:           cfg.Model,
		PermissionMode:  cfg.PermissionMode,
		SystemPrompt:    cfg.SystemPrompt,
		AllowedTools:    cfg.AllowedTools,
		DisallowedTools: cfg.DisallowedTools,
		ToolPolicy:      cfg.ToolPolicy,
	}
	args = normalizeACPServerArgs(d.client.Binary, args, policy)

	env := cfg.Env
	if d.entry != nil {
		env = mergeStringMaps(d.entry.Env, cfg.Env)
	}

	cmd := exec.Command(d.client.Binary, args...)
	cmd.Dir = cfg.Cwd
	cmd.Env = agentcore.BuildAgentEnv(cfg.Cfg, cfg.AgentClientID, env, nil)

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}

	runCtx, cancel := context.WithCancel(ctx)
	convID := agentprotocol.ConversationID(reqFromConfig(cfg))

	proc := &driverProcess{
		cmd:      cmd,
		stdin:    stdin,
		done:     make(chan error, 1),
		agentID:  cfg.AgentClientID,
		cwd:      cfg.Cwd,
		convID:   convID,
		model:    cfg.Model,
		permMode: mapPermissionModeToTraecliModeID(cfg.PermissionMode),
		cancel:   cancel,
	}

	bridge := &SDKBridge{Req: reqFromConfig(cfg), Dispatch: proc.Dispatch}
	conn := acpsdk.NewClientSideConnection(bridge, stdin, stdout)
	proc.client = conn

	if err := cmd.Start(); err != nil {
		cancel()
		return nil, err
	}

	// Pump stderr to the run log. emit is nil at StartProcess time — the
	// per-turn handler is wired in Prompt; stderr pump just discards events.
	go agentoutput.PumpLog(stderr, reqFromConfig(cfg), &atomic.Int64{}, nil)
	go func() {
		err := cmd.Wait()
		proc.done <- err
		close(proc.done)
		cancel()
	}()

	initResult, err := conn.Initialize(runCtx, acpsdk.InitializeRequest{
		ProtocolVersion: acpsdk.ProtocolVersionNumber,
		ClientInfo:      &acpsdk.Implementation{Name: "octodeck-daemon", Version: DaemonVersion},
		ClientCapabilities: acpsdk.ClientCapabilities{
			Fs: acpsdk.FileSystemCapabilities{ReadTextFile: false, WriteTextFile: false},
		},
	})
	if err != nil {
		proc.stop()
		return nil, err
	}

	sessionID, created, err := d.resolveSession(runCtx, cfg, conn, &initResult, proc)
	if err != nil {
		proc.stop()
		return nil, err
	}
	proc.sessionID = sessionID
	proc.createdNew = created

	fp := &agentprotocol.FamilyProcess{SessionID: sessionID, CreatedNew: created}
	fp.SetHandle(proc)
	return fp, nil
}

// resolveSession implements the Load→Resume→New decision. Returns the bound
// session id and whether a new session was created (fresh sessions get the
// OctoDeck system-context prefix on the first prompt).
func (d *Driver) resolveSession(ctx context.Context, cfg agentprotocol.FamilyConfig, conn *acpsdk.ClientSideConnection, initResult *acpsdk.InitializeResponse, proc *driverProcess) (string, bool, error) {
	mcpServers := buildACPSDKMCPServers(cfg.Cfg, cfg.Env)
	resume := strings.TrimSpace(cfg.ResumeSessionID)

	if resume != "" {
		if initResult != nil && initResult.AgentCapabilities.LoadSession {
			if _, err := conn.LoadSession(ctx, acpsdk.LoadSessionRequest{
				Cwd:        cfg.Cwd,
				SessionId:  acpsdk.SessionId(resume),
				McpServers: mcpServers,
				Meta: map[string]any{
					"runId":                  "",
					"octodeckConversationId": proc.convID,
					"policy":                 policyOf(cfg),
				},
			}); err == nil {
				return resume, false, nil
			}
		}
		if initResult != nil && initResult.AgentCapabilities.SessionCapabilities.Resume != nil {
			if _, err := conn.ResumeSession(ctx, acpsdk.ResumeSessionRequest{
				Cwd:        cfg.Cwd,
				SessionId:  acpsdk.SessionId(resume),
				McpServers: mcpServers,
				Meta: map[string]any{
					"runId":                  "",
					"octodeckConversationId": proc.convID,
					"policy":                 policyOf(cfg),
				},
			}); err == nil {
				return resume, false, nil
			}
		}
	}

	created, err := conn.NewSession(ctx, acpsdk.NewSessionRequest{
		Cwd:        cfg.Cwd,
		McpServers: mcpServers,
		Meta: map[string]any{
			"octodeckSessionId":      resume,
			"octodeckConversationId": proc.convID,
			"runId":                  "",
			"policy":                 policyOf(cfg),
		},
	})
	if err != nil {
		return "", false, err
	}
	sid := strings.TrimSpace(string(created.SessionId))
	if sid == "" {
		return "", false, errors.New("traecli driver: NewSession returned empty session id")
	}
	return sid, true, nil
}

// Prompt sends one prompt turn on an already-started process. It wires the
// per-turn event handler onto the process so streaming session_update frames
// flow through emit, then calls the ACP session/prompt method.
func (d *Driver) Prompt(ctx context.Context, fp *agentprotocol.FamilyProcess, req *proto.AgentRunRequestFrame, emit func(proto.AgentRunEventFrame)) (proto.AgentRunResultFrame, error) {
	proc, ok := fp.Handle().(*driverProcess)
	if !ok || proc == nil {
		return proto.AgentRunResultFrame{}, errors.New("traecli driver: invalid process handle")
	}

	// Rebind the bridge to this request so session_update / RequestPermission
	// carry the right RunID/AgentID. The connection itself persists across
	// turns; only the SDKBridge payload changes.
	convID := agentprotocol.ConversationID(req)
	promptMessageID := newACPMessageID()
	started := time.Now()
	var sent atomic.Int64
	var finalMu sync.Mutex
	var finalText strings.Builder
	var finalUsage map[string]any
	createdNewSession := fp.CreatedNew

	// Suppress historical session_update replay when resuming an existing
	// session (LoadSession/ResumeSession): the provider re-emits prior turns
	// on bind, which would flood the client. Release frames once the current
	// prompt echo arrives or the deadline expires.
	suppressReplay := !createdNewSession
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
			finalMu.Lock()
			finalText.WriteString(frame.Text)
			finalMu.Unlock()
		}
		if frame.EventType == "usage" {
			if usage := UsageFromPayload(frame.Payload); usage != nil {
				finalMu.Lock()
				finalUsage = usage
				finalMu.Unlock()
			}
		}
		if frame.SessionID != "" {
			finalMu.Lock()
			if strings.TrimSpace(proc.sessionID) == "" {
				proc.sessionID = frame.SessionID
			}
			finalMu.Unlock()
		}
		if emit != nil {
			emit(*frame)
		}
	})

	promptText := d.promptText(req, createdNewSession)
	promptResult, promptErr := proc.client.Prompt(ctx, acpsdk.PromptRequest{
		SessionId: acpsdk.SessionId(proc.sessionID),
		MessageId: &promptMessageID,
		Prompt:    []acpsdk.ContentBlock{acpsdk.TextBlock(promptText)},
		Meta: map[string]any{
			"policy":                 req.Policy,
			"context":                req.Context,
			"octodeckConversationId": convID,
			"runId":                  req.RunID,
			"messageId":              promptMessageID,
		},
	})

	finalMu.Lock()
	resultText := finalText.String()
	resultUsage := finalUsage
	finalMu.Unlock()

	result := proto.AgentRunResultFrame{
		RunID:      req.RunID,
		AgentID:    req.AgentID,
		OK:         promptErr == nil,
		Result:     resultText,
		SessionID:  proc.sessionID,
		Usage:      resultUsage,
		DurationMs: time.Since(started).Milliseconds(),
	}
	if promptErr != nil {
		msg := promptErr.Error()
		result.Error = &msg
		if IsTransportDisconnect(promptErr) {
			return result, promptErr
		}
	}
	if promptErr == nil && promptResult.Usage != nil {
		result.Usage = UsageToMap(promptResult.Usage)
	}
	return result, nil
}

// Stop tears the underlying process down.
func (d *Driver) Stop(fp *agentprotocol.FamilyProcess) error {
	if fp == nil {
		return nil
	}
	if proc, ok := fp.Handle().(*driverProcess); ok {
		proc.stop()
	}
	return nil
}

// ListSessions / DeleteSession delegate to the existing family helpers so the
// provider session directory layout stays identical.
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

// promptText mirrors the historic Connection.promptText: on a fresh session
// (no system-prompt support in traecli), prepend the OctoDeck system context.
func (d *Driver) promptText(req *proto.AgentRunRequestFrame, createdNewSession bool) string {
	includeSystemContext := createdNewSession && !supportsNativeSystemPromptFamily()
	if req == nil {
		return ""
	}
	if !includeSystemContext || strings.TrimSpace(req.Policy.SystemPrompt) == "" {
		return req.Input.Prompt
	}
	return strings.Join([]string{
		"<octodeck-system-context>",
		req.Policy.SystemPrompt,
		"</octodeck-system-context>",
		"",
		"<user-prompt>",
		req.Input.Prompt,
		"</user-prompt>",
	}, "\n")
}

func supportsNativeSystemPromptFamily() bool { return false }

// policyOf builds an AgentRunPolicy from a FamilyConfig for ACP session meta.
func policyOf(cfg agentprotocol.FamilyConfig) proto.AgentRunPolicy {
	return proto.AgentRunPolicy{
		Model:           cfg.Model,
		PermissionMode:  cfg.PermissionMode,
		SystemPrompt:    cfg.SystemPrompt,
		AllowedTools:    cfg.AllowedTools,
		DisallowedTools: cfg.DisallowedTools,
		ToolPolicy:      cfg.ToolPolicy,
	}
}

// reqFromConfig synthesizes an AgentRunRequestFrame from a FamilyConfig so the
// family's existing helpers (SDKBridge, PumpLog, mcp) that expect a *req can
// run during StartProcess (which has no inbound request yet).
func reqFromConfig(cfg agentprotocol.FamilyConfig) *proto.AgentRunRequestFrame {
	return &proto.AgentRunRequestFrame{
		AgentID:   cfg.AgentClientID,
		Cwd:       cfg.Cwd,
		Workspace: cfg.Workspace,
		Env:       cfg.Env,
		Input: proto.AgentRunInput{
			SessionID: cfg.ResumeSessionID,
		},
		Policy:         policyOf(cfg),
		MaxOutputBytes: cfg.MaxOutputBytes,
	}
}
