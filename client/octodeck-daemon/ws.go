package main

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// wsClient owns a single websocket connection to the server. It's responsible
// for:
//   - hello handshake
//   - heartbeat (ping every heartbeatIntervalMs received from hello_ack)
//   - serializing outbound frames behind a mutex (websocket Write is not
//     concurrency-safe)
//   - dispatching inbound frames to the runner
//
// Reconnect logic lives in run() at the top level (main.go).
type wsClient struct {
	cfg      *Config
	conn     *websocket.Conn
	sendMu   sync.Mutex
	runner   *runner
	agents   *agentRuntimeSupervisor
	tools    *toolRunner
	models   *modelDiscoverer
	skills   *skillDiscoverer
	pool     *runnerPool
	hbMs     int
	helloAck *HelloAckFrame
}

func wsURL(server, linkID string) (string, error) {
	u, err := url.Parse(server)
	if err != nil {
		return "", err
	}
	switch u.Scheme {
	case "https":
		u.Scheme = "wss"
	case "http":
		u.Scheme = "ws"
	case "wss", "ws":
		// keep
	default:
		return "", fmt.Errorf("unsupported server scheme: %s", u.Scheme)
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/api/agent-link/ws"
	return u.String(), nil
}

// dial opens a single ws connection and runs through the hello handshake.
func dial(ctx context.Context, cfg *Config) (*wsClient, error) {
	endpoint, err := wsURL(cfg.Server, cfg.LinkID)
	if err != nil {
		return nil, err
	}
	dialCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	opts := &websocket.DialOptions{
		HTTPHeader: map[string][]string{
			"X-Link-Token": {cfg.Token},
		},
	}
	conn, _, err := websocket.Dial(dialCtx, endpoint, opts)
	if err != nil {
		return nil, fmt.Errorf("ws dial: %w", err)
	}
	conn.SetReadLimit(1 << 20) // 1 MiB

	c := &wsClient{cfg: cfg, conn: conn}
	c.pool = newRunnerPool(0)
	c.runner = newRunner(cfg, c.pool, c.send)
	c.agents = newAgentRuntimeSupervisor(cfg, c.pool, c.send)
	c.tools = newToolRunner(cfg, c.send)
	c.models = newModelDiscoverer(c.send)
	c.skills = newSkillDiscoverer(cfg, c.send)

	if err := c.sendHello(ctx); err != nil {
		_ = conn.Close(websocket.StatusNormalClosure, "hello failed")
		return nil, err
	}
	if err := c.awaitHelloAck(ctx); err != nil {
		_ = conn.Close(websocket.StatusNormalClosure, "hello_ack failed")
		return nil, err
	}
	return c, nil
}

func (c *wsClient) sendHello(ctx context.Context) error {
	frame := &HelloFrame{
		Type:                     tHello,
		ID:                       1,
		Version:                  ifEmpty(c.cfg.Version, "octodeck-daemon/0.1.0"),
		ProtocolVersion:          2,
		ProtocolMinVersion:       1,
		OS:                       goos(),
		Arch:                     goarch(),
		Hostname:                 hostname(),
		Capabilities:             []string{"run.host-cli", "run.status", "agent.run", "agent.run.events", "agent.discover", "agent.sessions", "heartbeat.runningRuns", "runtime.status", "tool.remote"},
		AgentClients:             c.cfg.AgentClients,
		AgentRuntimeCapabilities: buildRuntimeCapabilities(c.cfg, c.pool),
		Resources:                collectResourceSnapshot(),
	}
	data, err := encodeFrame(frame)
	if err != nil {
		return err
	}
	return c.conn.Write(ctx, websocket.MessageText, data)
}

func (c *wsClient) awaitHelloAck(ctx context.Context) error {
	readCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	_, data, err := c.conn.Read(readCtx)
	if err != nil {
		return fmt.Errorf("read hello_ack: %w", err)
	}
	frame, err := parseInbound(data)
	if err != nil {
		return fmt.Errorf("parse hello_ack: %w", err)
	}
	switch f := frame.(type) {
	case *HelloAckFrame:
		c.helloAck = f
		c.hbMs = f.HeartbeatIntervalMs
		if c.hbMs <= 0 {
			c.hbMs = 30_000
		}
		return nil
	case *ErrorFrame:
		return fmt.Errorf("server error during hello: %s: %s", f.Code, f.Message)
	default:
		return fmt.Errorf("expected hello_ack, got %T", frame)
	}
}

// send is goroutine-safe.
func (c *wsClient) send(frame any) error {
	if c == nil || c.conn == nil {
		return errors.New("ws not connected")
	}
	data, err := encodeFrame(frame)
	if err != nil {
		return err
	}
	c.sendMu.Lock()
	defer c.sendMu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return c.conn.Write(ctx, websocket.MessageText, data)
}

// run blocks until the connection closes. On return, callers should close()
// the wsClient and reconnect with backoff.
func (c *wsClient) run(ctx context.Context) error {
	hbInterval := time.Duration(c.hbMs) * time.Millisecond
	if hbInterval <= 0 {
		hbInterval = 30 * time.Second
	}

	// Heartbeat goroutine
	hbCtx, hbCancel := context.WithCancel(ctx)
	defer hbCancel()
	go func() {
		t := time.NewTicker(hbInterval)
		defer t.Stop()
		var pingID int64 = 1
		for {
			select {
			case <-hbCtx.Done():
				return
			case <-t.C:
				_ = c.send(c.buildPingFrame(pingID))
				pingID++
			}
		}
	}()

	if home, err := os.UserHomeDir(); err == nil {
		sources := agentMemorySources(home, c.cfg.AgentClients)
		if len(sources) > 0 {
			memoryPoller := newMemorySyncPoller(c.cfg.LinkID, sources, c.sendMemorySync)
			go memoryPoller.run(hbCtx)
		}
	}

	defer c.pool.cancelAll()

	for {
		_, data, err := c.conn.Read(ctx)
		if err != nil {
			return fmt.Errorf("ws read: %w", err)
		}
		frame, perr := parseInbound(data)
		if perr != nil {
			_ = c.send(&ErrorFrame{
				Type:    tError,
				Code:    "protocol_violation",
				Message: perr.Error(),
				Fatal:   false,
			})
			continue
		}
		switch f := frame.(type) {
		case *RunRequestFrame:
			c.runner.handle(ctx, f)
		case *RunCancelFrame:
			c.pool.cancelRun(f.RunID)
		case *AgentRunRequestFrame:
			c.agents.handle(ctx, f)
		case *AgentRunCancelFrame:
			c.agents.cancelRun(f.RunID, f.Reason)
		case *AgentDiscoverRequestFrame:
			c.agents.handleDiscover(ctx, f)
		case *AgentSessionsRequestFrame:
			c.agents.handleSessions(ctx, f)
		case *AgentSessionDeleteRequestFrame:
			c.agents.handleSessionDelete(ctx, f)
		case *WorkspaceCleanupRequestFrame:
			c.handleWorkspaceCleanup(f)
		case *AgentPermissionDecisionFrame:
			c.agents.handlePermissionDecision(ctx, f)
		case *ToolRequestFrame:
			c.tools.handle(ctx, f)
		case *ToolCancelFrame:
			// Tool cancellation is handled by connection context / per-request timeout.
		case *ModelsRequestFrame:
			c.models.handle(ctx, f)
		case *SkillsRequestFrame:
			c.skills.handle(ctx, f)
		case *DaemonUpdateRequestFrame:
			c.handleDaemonUpdate(ctx, f)
		case *ErrorFrame:
			if f.Fatal {
				return fmt.Errorf("server fatal: %s: %s", f.Code, f.Message)
			}
		case *HelloAckFrame:
			// duplicate hello_ack — ignore
		}
	}
}

func (c *wsClient) handleDaemonUpdate(ctx context.Context, req *DaemonUpdateRequestFrame) {
	if req == nil {
		return
	}
	go func() {
		if !autoUpdateEnabled(c.cfg) {
			logDaemonUpdateSkip(req, "auto update disabled")
			return
		}
		latest := strings.TrimSpace(req.LatestVersion)
		if !isNewerDaemonVersion(latest, c.cfg.Version) {
			logDaemonUpdateSkip(req, fmt.Sprintf("current version %s is up to date", c.cfg.Version))
			return
		}
		logDaemonUpdateSkip(req, fmt.Sprintf("server requested update current=%s latest=%s reason=%s", c.cfg.Version, latest, req.Reason))
		if err := updateDaemonBinary(c.cfg, "", true); err != nil {
			_ = c.send(&ErrorFrame{Type: tError, Code: "daemon_update_failed", Message: err.Error(), Fatal: false})
		}
	}()
}

func logDaemonUpdateSkip(req *DaemonUpdateRequestFrame, message string) {
	if strings.Contains(message, "requested update") {
		fmt.Printf("octodeck-daemon: %s\n", message)
		return
	}
	fmt.Printf("octodeck-daemon: server update request ignored latest=%s: %s\n", req.LatestVersion, message)
}

func (c *wsClient) handleWorkspaceCleanup(req *WorkspaceCleanupRequestFrame) {
	if req == nil {
		return
	}
	scope := req.Scope
	if scope == "" {
		scope = "workspace"
	}
	dir, err := cleanupWorkspaceScopeDir(c.cfg, req.Workspace, scope, req.SessionID, req.TaskID, req.TaskRunID)
	if err != nil {
		_ = c.send(&ErrorFrame{Type: tError, Code: "workspace_cleanup_failed", Message: err.Error(), Fatal: false})
		return
	}
	if err := os.RemoveAll(dir); err != nil {
		_ = c.send(&ErrorFrame{Type: tError, Code: "workspace_cleanup_failed", Message: err.Error(), Fatal: false})
	}
}

func (c *wsClient) buildPingFrame(id int64) *PingFrame {
	running := c.pool.snapshot()
	status := "idle"
	if len(running) > 0 {
		status = "busy"
	}
	maxRuns := c.pool.maxConcurrentRuns()
	available := c.pool.availableSlots()
	return &PingFrame{
		Type:              tPing,
		ID:                id,
		Resources:         collectResourceSnapshot(),
		Status:            status,
		RunningRuns:       running,
		MaxConcurrentRuns: maxRuns,
		AvailableSlots:    available,
		Runtimes:          buildRuntimeStatuses(c.cfg.LinkID, c.cfg.AgentClients, running, maxRuns, available),
	}
}

func buildRuntimeStatuses(linkID string, clients []AgentClientInfo, running []RunningRunInfo, maxRuns, available int) []RuntimeStatus {
	out := make([]RuntimeStatus, 0, len(clients))
	status := "idle"
	if len(running) > 0 {
		status = "busy"
	}
	for _, client := range clients {
		out = append(out, RuntimeStatus{
			RuntimeID:         linkID + ":" + client.ID,
			DeviceLinkID:      linkID,
			AgentClientID:     client.ID,
			DisplayName:       client.DisplayName,
			Provider:          ifEmpty(client.Provider, client.ID),
			Transport:         ifEmpty(client.Transport, "stdio"),
			Status:            status,
			MaxConcurrentRuns: maxRuns,
			RunningRuns:       running,
			AvailableSlots:    available,
		})
	}
	return out
}

func (c *wsClient) sendMemorySync(frame *MemorySyncFrame) error {
	return c.send(frame)
}

func (c *wsClient) close(reason string) {
	if c == nil || c.conn == nil {
		return
	}
	_ = c.conn.Close(websocket.StatusNormalClosure, truncate(reason, 120))
}

func ifEmpty(s, fallback string) string {
	if s == "" {
		return fallback
	}
	return s
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
