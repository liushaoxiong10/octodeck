// Package traex — FamilyDriver implementation for conversation runtime.
//
// traex runs the acp-adapter Codex runtime in-process over stdio pipes with
// InitialAuthMode="traex_cli". The driver wraps that with the conversation runtime
// contract: StartProcess starts the adapter, Initializes it over the standard
// ACP client connection, resolves a session (Load → Resume → New), and exposes
// the bound SessionID on FamilyProcess.
package traex

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"runtime/debug"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"

	agentprotocol "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentprotocol"
	daemonconfig "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/config"
	inventory "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/inventory"
	agentoutput "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/output"
	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
)

// Driver implements agentprotocol.FamilyDriver for the traex family.
type Driver struct {
	client inventory.Info
	entry  *daemonconfig.AgentRegistryEntry
	agent  *Agent // borrowed for codexacp runtime config
}

// NewDriver builds a Driver for the discovered traex client.
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

// CanUpdateRuntimePolicy reports whether a live TraeX ACP adapter can apply
// model / approval / system prompt changes without restart. The stdio ACP
// boundary gets those values through the adapter runtime profile at startup,
// so conversation runtime should restart and resume the provider session on policy changes.
func (d *Driver) CanUpdateRuntimePolicy(req *proto.AgentRunRequestFrame) bool {
	return false
}

type driverProcess struct {
	client    *acpsdk.ClientSideConnection
	cancel    context.CancelFunc
	sessionID string
	stopOnce  sync.Once

	mu      sync.Mutex
	handler func(*proto.AgentRunEventFrame)
}

func (p *driverProcess) Dispatch(frame *proto.AgentRunEventFrame) {
	defer func() {
		if r := recover(); r != nil {
			eventType := ""
			textBytes := 0
			sessionID := ""
			if frame != nil {
				eventType = frame.EventType
				textBytes = len(frame.Text)
				sessionID = frame.SessionID
			}
			log.Printf("octodeck-daemon: traex dispatch panic eventType=%s textBytes=%d sessionId=%s panic=%v stack=%s", eventType, textBytes, sessionID, r, debug.Stack())
		}
	}()
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

func (p *driverProcess) Stop() {
	if p == nil {
		return
	}
	p.stopOnce.Do(func() {
		if p.cancel != nil {
			p.cancel()
		}
	})
}

// StartProcess starts a fresh acp-adapter runtime (traex_cli auth mode),
// Initializes it through acpsdk, and resolves a session.
func (d *Driver) StartProcess(ctx context.Context, cfg agentprotocol.FamilyConfig) (*agentprotocol.FamilyProcess, error) {
	if d == nil {
		return nil, errors.New("traex driver: nil")
	}

	started := time.Now()
	syntheticReq := reqFromConfig(cfg)
	log.Printf("octodeck-daemon: traex start-process start agent=%s cwd=%s resumeSession=%t timeoutMs=%d model=%s", cfg.AgentClientID, cfg.Cwd, strings.TrimSpace(cfg.ResumeSessionID) != "", cfg.TimeoutMs, cfg.Model)
	runCtx, cancel := context.WithCancel(context.Background())
	serverStdin, clientStdin := io.Pipe()
	clientStdout, serverStdout := io.Pipe()
	stderrReader, stderrWriter := io.Pipe()

	proc := &driverProcess{cancel: cancel}
	bridge := &SDKBridge{Req: syntheticReq, Dispatch: proc.Dispatch}
	conn := acpsdk.NewClientSideConnection(bridge, clientStdin, clientStdout)
	proc.client = conn

	go agentoutput.PumpLog(stderrReader, syntheticReq, &atomic.Int64{}, nil)
	go func() {
		log.Printf("octodeck-daemon: traex adapter goroutine start agent=%s elapsedMs=%d", cfg.AgentClientID, time.Since(started).Milliseconds())
		defer func() {
			if r := recover(); r != nil {
				log.Printf("octodeck-daemon: traex adapter goroutine panic agent=%s elapsedMs=%d panic=%v stack=%s", cfg.AgentClientID, time.Since(started).Milliseconds(), r, debug.Stack())
			}
			_ = serverStdin.Close()
			_ = serverStdout.Close()
			_ = stderrWriter.Close()
		}()
		err := d.agent.Run(runCtx, syntheticReq, serverStdin, serverStdout, stderrWriter)
		log.Printf("octodeck-daemon: traex adapter goroutine exit agent=%s elapsedMs=%d err=%v", cfg.AgentClientID, time.Since(started).Milliseconds(), err)
		cancel()
	}()

	log.Printf("octodeck-daemon: traex initialize start agent=%s elapsedMs=%d", cfg.AgentClientID, time.Since(started).Milliseconds())
	initResult, err := conn.Initialize(ctx, acpsdk.InitializeRequest{
		ProtocolVersion: acpsdk.ProtocolVersionNumber,
		ClientInfo:      &acpsdk.Implementation{Name: "octodeck-daemon", Version: DaemonVersion},
		ClientCapabilities: acpsdk.ClientCapabilities{
			Fs: acpsdk.FileSystemCapabilities{ReadTextFile: false, WriteTextFile: false},
		},
	})
	if err != nil {
		log.Printf("octodeck-daemon: traex initialize failed agent=%s elapsedMs=%d err=%v", cfg.AgentClientID, time.Since(started).Milliseconds(), err)
		proc.Stop()
		return nil, err
	}
	log.Printf("octodeck-daemon: traex initialize completed agent=%s loadSession=%t resumeCap=%t elapsedMs=%d", cfg.AgentClientID, initResult.AgentCapabilities.LoadSession, initResult.AgentCapabilities.SessionCapabilities.Resume != nil, time.Since(started).Milliseconds())

	log.Printf("octodeck-daemon: traex resolve-session start agent=%s resumeSession=%t elapsedMs=%d", cfg.AgentClientID, strings.TrimSpace(cfg.ResumeSessionID) != "", time.Since(started).Milliseconds())
	sessionID, createdNew, err := resolveSessionID(ctx, cfg, conn, &initResult, syntheticReq)
	if err != nil {
		log.Printf("octodeck-daemon: traex resolve-session failed agent=%s elapsedMs=%d err=%v", cfg.AgentClientID, time.Since(started).Milliseconds(), err)
		proc.Stop()
		return nil, err
	}
	proc.sessionID = sessionID
	log.Printf("octodeck-daemon: traex resolve-session completed agent=%s createdNew=%t sessionId=%s elapsedMs=%d", cfg.AgentClientID, createdNew, sessionID, time.Since(started).Milliseconds())

	fp := &agentprotocol.FamilyProcess{SessionID: sessionID, CreatedNew: createdNew}
	fp.SetHandle(proc)
	log.Printf("octodeck-daemon: traex start-process completed agent=%s createdNew=%t elapsedMs=%d", cfg.AgentClientID, createdNew, time.Since(started).Milliseconds())
	return fp, nil
}

// resolveSessionID implements Load → hydrate-and-retry-Load → Resume → New.
func resolveSessionID(ctx context.Context, cfg agentprotocol.FamilyConfig, conn *acpsdk.ClientSideConnection, initResult *acpsdk.InitializeResponse, req *proto.AgentRunRequestFrame) (string, bool, error) {
	started := time.Now()
	mcpServers := buildACPSDKMCPServers(cfg.Cfg, cfg.Env)
	resume := strings.TrimSpace(cfg.ResumeSessionID)
	convID := agentprotocol.ConversationID(req)

	tryLoad := func() error {
		loadStarted := time.Now()
		_, err := conn.LoadSession(ctx, acpsdk.LoadSessionRequest{
			Cwd:        cfg.Cwd,
			SessionId:  acpsdk.SessionId(resume),
			McpServers: mcpServers,
			Meta:       map[string]any{"octodeckConversationId": convID, "policy": req.Policy},
		})
		log.Printf("octodeck-daemon: traex load-session attempt agent=%s ok=%t elapsedMs=%d err=%v", cfg.AgentClientID, err == nil, time.Since(loadStarted).Milliseconds(), err)
		return err
	}

	if resume != "" && initResult != nil && initResult.AgentCapabilities.LoadSession {
		if err := tryLoad(); err == nil {
			log.Printf("octodeck-daemon: traex resolve-session loaded existing agent=%s elapsedMs=%d", cfg.AgentClientID, time.Since(started).Milliseconds())
			return resume, false, nil
		}
		// Hydrate: list sessions to populate the adapter's in-memory cache,
		// then retry Load.
		listStarted := time.Now()
		_, listErr := conn.ListSessions(ctx, acpsdk.ListSessionsRequest{Cwd: &cfg.Cwd})
		log.Printf("octodeck-daemon: traex list-sessions hydration agent=%s ok=%t elapsedMs=%d err=%v", cfg.AgentClientID, listErr == nil, time.Since(listStarted).Milliseconds(), listErr)
		if err := tryLoad(); err == nil {
			log.Printf("octodeck-daemon: traex resolve-session loaded after hydration agent=%s elapsedMs=%d", cfg.AgentClientID, time.Since(started).Milliseconds())
			return resume, false, nil
		}
	}
	if resume != "" && initResult != nil && initResult.AgentCapabilities.SessionCapabilities.Resume != nil {
		resumeStarted := time.Now()
		if _, err := conn.ResumeSession(ctx, acpsdk.ResumeSessionRequest{
			Cwd:        cfg.Cwd,
			SessionId:  acpsdk.SessionId(resume),
			McpServers: mcpServers,
			Meta:       map[string]any{"octodeckConversationId": convID, "policy": req.Policy},
		}); err == nil {
			log.Printf("octodeck-daemon: traex resume-session completed agent=%s elapsedMs=%d totalElapsedMs=%d", cfg.AgentClientID, time.Since(resumeStarted).Milliseconds(), time.Since(started).Milliseconds())
			return resume, false, nil
		} else {
			log.Printf("octodeck-daemon: traex resume-session failed agent=%s elapsedMs=%d err=%v", cfg.AgentClientID, time.Since(resumeStarted).Milliseconds(), err)
		}
	}
	newStarted := time.Now()
	created, err := conn.NewSession(ctx, acpsdk.NewSessionRequest{
		Cwd:        cfg.Cwd,
		McpServers: mcpServers,
		Meta:       map[string]any{"octodeckConversationId": convID, "policy": req.Policy},
	})
	if err != nil {
		log.Printf("octodeck-daemon: traex new-session failed agent=%s elapsedMs=%d totalElapsedMs=%d err=%v", cfg.AgentClientID, time.Since(newStarted).Milliseconds(), time.Since(started).Milliseconds(), err)
		return "", false, err
	}
	sid := strings.TrimSpace(string(created.SessionId))
	if sid == "" {
		log.Printf("octodeck-daemon: traex new-session empty id agent=%s elapsedMs=%d totalElapsedMs=%d", cfg.AgentClientID, time.Since(newStarted).Milliseconds(), time.Since(started).Milliseconds())
		return "", false, errors.New("traex driver: NewSession returned empty session id")
	}
	log.Printf("octodeck-daemon: traex new-session completed agent=%s sessionId=%s elapsedMs=%d totalElapsedMs=%d", cfg.AgentClientID, sid, time.Since(newStarted).Milliseconds(), time.Since(started).Milliseconds())
	return sid, true, nil
}

// Prompt sends one prompt turn through the standard ACP client connection.
func (d *Driver) Prompt(ctx context.Context, fp *agentprotocol.FamilyProcess, req *proto.AgentRunRequestFrame, emit func(proto.AgentRunEventFrame)) (proto.AgentRunResultFrame, error) {
	proc, ok := fp.Handle().(*driverProcess)
	if !ok || proc == nil {
		return proto.AgentRunResultFrame{}, errors.New("traex driver: invalid process handle")
	}

	convID := agentprotocol.ConversationID(req)
	promptMessageID := newACPMessageID()
	var sent atomic.Int64
	var finalText atomicString
	var finalUsage atomic.Value
	started := time.Now()
	firstTurn := fp.CreatedNew
	fp.CreatedNew = false
	promptText := d.promptText(req, firstTurn)
	log.Printf("octodeck-daemon: traex prompt start runId=%s agent=%s sessionId=%s model=%q firstTurn=%t promptBytes=%d elapsedMs=0", req.RunID, req.AgentID, proc.sessionID, strings.TrimSpace(req.Policy.Model), firstTurn, len(promptText))

	suppressReplay := !firstTurn
	suppressReplayUntil := agentprotocol.ReplaySuppressDeadline()
	var firstEventLogged atomic.Bool
	var firstRawEventLogged atomic.Bool
	var firstSuppressedLogged atomic.Bool
	var rawEventCount atomic.Int64
	var emittedEventCount atomic.Int64
	var suppressedEventCount atomic.Int64

	proc.SetHandler(func(frame *proto.AgentRunEventFrame) {
		if frame == nil {
			return
		}
		rawCount := rawEventCount.Add(1)
		if shouldLogDetailedEvent(frame.EventType) {
			log.Printf("octodeck-daemon: traex prompt event detail runId=%s agent=%s eventType=%s sessionId=%s elapsedMs=%d rawEventCount=%d toolName=%q toolUseId=%q status=%q input=%q result=%q payloadKeys=%q", req.RunID, req.AgentID, frame.EventType, frame.SessionID, time.Since(started).Milliseconds(), rawCount, payloadString(frame.Payload, "toolName", "name", "title"), payloadString(frame.Payload, "toolUseId", "id", "tool_call_id"), payloadString(frame.Payload, "status"), summarizePayloadValue(payloadAny(frame.Payload, "input", "rawInput", "arguments", "args")), summarizePayloadValue(payloadAny(frame.Payload, "result", "rawOutput", "output", "content")), strings.Join(payloadKeys(frame.Payload), ","))
		}
		if frame.EventType != "log" && firstRawEventLogged.CompareAndSwap(false, true) {
			log.Printf("octodeck-daemon: traex prompt first raw event runId=%s agent=%s eventType=%s textBytes=%d sessionId=%s elapsedMs=%d rawEventCount=%d", req.RunID, req.AgentID, frame.EventType, len(frame.Text), frame.SessionID, time.Since(started).Milliseconds(), rawCount)
		}
		if suppressReplay {
			matchedPrompt, suppress := agentprotocol.ShouldSuppressReplayFrame(frame, promptText, promptMessageID, suppressReplayUntil)
			if matchedPrompt {
				suppressReplay = false
			}
			if suppress {
				suppressed := suppressedEventCount.Add(1)
				if frame.EventType != "log" && firstSuppressedLogged.CompareAndSwap(false, true) {
					log.Printf("octodeck-daemon: traex prompt first suppressed replay event runId=%s agent=%s eventType=%s textBytes=%d sessionId=%s matchedPrompt=%t elapsedMs=%d suppressedEventCount=%d", req.RunID, req.AgentID, frame.EventType, len(frame.Text), frame.SessionID, matchedPrompt, time.Since(started).Milliseconds(), suppressed)
				}
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
		if frame.EventType != "log" && firstEventLogged.CompareAndSwap(false, true) {
			log.Printf("octodeck-daemon: traex prompt first event runId=%s agent=%s eventType=%s textBytes=%d sessionId=%s elapsedMs=%d", req.RunID, req.AgentID, frame.EventType, len(frame.Text), frame.SessionID, time.Since(started).Milliseconds())
		}
		if emit != nil {
			emittedEventCount.Add(1)
			emit(*frame)
		}
	})
	defer proc.SetHandler(nil)

	log.Printf("octodeck-daemon: traex acp prompt request sending runId=%s agent=%s sessionId=%s messageId=%s elapsedMs=%d", req.RunID, req.AgentID, proc.sessionID, promptMessageID, time.Since(started).Milliseconds())
	promptResp, promptErr := proc.client.Prompt(ctx, acpsdk.PromptRequest{
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
	log.Printf("octodeck-daemon: traex acp prompt returned runId=%s agent=%s sessionId=%s ok=%t elapsedMs=%d rawEventCount=%d emittedEventCount=%d suppressedEventCount=%d err=%v", req.RunID, req.AgentID, proc.sessionID, promptErr == nil, time.Since(started).Milliseconds(), rawEventCount.Load(), emittedEventCount.Load(), suppressedEventCount.Load(), promptErr)
	if promptErr == nil && promptResp.Usage != nil {
		finalUsage.Store(UsageToMap(promptResp.Usage))
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
	log.Printf("octodeck-daemon: traex prompt result built runId=%s agent=%s ok=%t durationMs=%d resultBytes=%d hasUsage=%t", req.RunID, req.AgentID, result.OK, result.DurationMs, len(result.Result), usage != nil)
	return result, promptErr
}

func (d *Driver) promptText(req *proto.AgentRunRequestFrame, createdNewSession bool) string {
	if req == nil {
		return ""
	}
	if createdNewSession && strings.TrimSpace(req.Policy.SystemPrompt) != "" {
		return promptTextWithSystemContext(req)
	}
	return req.Input.Prompt
}

func promptTextWithSystemContext(req *proto.AgentRunRequestFrame) string {
	if req == nil {
		return ""
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

func shouldLogDetailedEvent(eventType string) bool {
	switch eventType {
	case "tool_use_start", "tool_use_end", "tool_call", "tool_result", "permission_request":
		return true
	default:
		return false
	}
}

func payloadString(payload map[string]any, keys ...string) string {
	value := payloadAny(payload, keys...)
	switch v := value.(type) {
	case string:
		return v
	case json.Number:
		return v.String()
	case nil:
		return ""
	default:
		return summarizePayloadValue(v)
	}
}

func payloadAny(payload map[string]any, keys ...string) any {
	if payload == nil {
		return nil
	}
	for _, key := range keys {
		if value, ok := payload[key]; ok && value != nil {
			return value
		}
	}
	return nil
}

func summarizePayloadValue(value any) string {
	if value == nil {
		return ""
	}
	var text string
	switch v := value.(type) {
	case string:
		text = v
	case json.RawMessage:
		text = string(v)
	default:
		data, err := json.Marshal(v)
		if err != nil {
			text = strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(err.Error(), "\n", " "), "\t", " "))
		} else {
			text = string(data)
		}
	}
	text = strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(text, "\n", "\\n"), "\t", "\\t"))
	if len(text) > 500 {
		return text[:500] + "...(truncated)"
	}
	return text
}

func payloadKeys(payload map[string]any) []string {
	if len(payload) == 0 {
		return nil
	}
	keys := make([]string, 0, len(payload))
	for key := range payload {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

type atomicString struct{ v atomic.Value }

func (s *atomicString) Append(value string) {
	for {
		current, _ := s.v.Load().(string)
		s.v.Store(current + value)
		return
	}
}

func (s *atomicString) String() string {
	value, _ := s.v.Load().(string)
	return value
}

// Stop cancels the embedded runtime context.
func (d *Driver) Stop(fp *agentprotocol.FamilyProcess) error {
	if fp == nil {
		return nil
	}
	if proc, ok := fp.Handle().(*driverProcess); ok && proc != nil {
		proc.Stop()
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
