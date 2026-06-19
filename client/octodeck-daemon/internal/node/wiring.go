package node

import (
	"context"
	"errors"
	"fmt"
	"os"
	"runtime"
	"strings"
	"time"

	agentruntime "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentruntime"
	daemonconfig "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/config"
	executor "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/executor"
	inventory "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/inventory"
	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
	security "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/security"
	state "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/state"
	link "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/uplink"
	workspace "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/workspace"
)

// connection wraps a uplink Client and the executor bundle that
// services its inbound traffic. wiring.go owns construction; lifecycle
// owns running/closing.
type connection struct {
	cfg       *daemonconfig.Config
	link      *link.Client
	pool      *state.RunPool
	executors *executor.Executors
	helloAck  *proto.HelloAckFrame
}

// wireConnection assembles all per-connection state: pool, executors,
// inventory snapshot, then dials the uplink and performs the hello
// handshake. It returns a connection ready for Run.
func wireConnection(ctx context.Context, cfg *daemonconfig.Config) (*connection, error) {
	if cfg.AgentClients == nil {
		cfg.AgentClients = inventoryDiscover(cfg)
	}

	c := &connection{cfg: cfg}
	c.pool = state.NewRunPool(0)
	c.executors = executor.New(executor.Deps{
		Cfg:         cfg,
		Pool:        c.pool,
		Send:        c.send,
		EnvSnapshot: security.EnvSnapshot,
	})

	conn, err := link.Dial(ctx, link.DialOptions{
		Server:                   cfg.Server,
		LinkID:                   cfg.LinkID,
		Token:                    cfg.Token,
		Version:                  ifEmpty(cfg.Version, "octodeck-daemon/0.1.0"),
		OS:                       runtime.GOOS,
		Arch:                     runtime.GOARCH,
		Hostname:                 hostname(),
		Capabilities:             defaultCapabilities(),
		AgentClients:             cfg.AgentClients,
		AgentRuntimeCapabilities: agentruntime.BuildRuntimeCapabilities(cfg, c.pool),
		InitialResources:         inventory.CollectSnapshot(),
	})
	if err != nil {
		return nil, err
	}
	c.link = conn
	c.helloAck = conn.HelloAck()
	return c, nil
}

// Run blocks until the connection terminates (link error, ctx cancel
// or fatal frame).
func (c *connection) Run(ctx context.Context) error {
	models := newModelDiscoverer(c.cfg, c.send)
	skills := newSkillDiscoverer(c.cfg, c.send)

	return c.link.Run(ctx, link.RunOptions{
		Handlers: link.Handlers{
			OnRunRequest:      func(ctx context.Context, f *proto.RunRequestFrame) { c.executors.Command.Handle(ctx, f) },
			OnRunCancel:       func(f *proto.RunCancelFrame) { c.pool.CancelRun(f.RunID) },
			OnAgentRunRequest: func(ctx context.Context, f *proto.AgentRunRequestFrame) { c.executors.Agent.Handle(ctx, f) },
			OnAgentRunCancel:  func(f *proto.AgentRunCancelFrame) { c.executors.Agent.CancelRun(f.RunID, f.Reason) },
			OnAgentDiscover: func(ctx context.Context, f *proto.AgentDiscoverRequestFrame) {
				c.executors.Agent.HandleDiscover(ctx, f)
			},
			OnAgentSessions: func(ctx context.Context, f *proto.AgentSessionsRequestFrame) {
				c.executors.Agent.HandleSessions(ctx, f)
			},
			OnAgentSessionDel: func(ctx context.Context, f *proto.AgentSessionDeleteRequestFrame) {
				c.executors.Agent.HandleSessionDelete(ctx, f)
			},
			OnAgentPermission: func(ctx context.Context, f *proto.AgentPermissionDecisionFrame) {
				c.executors.Agent.HandlePermissionDecision(ctx, f)
			},
			OnWorkspaceCleanup: func(f *proto.WorkspaceCleanupRequestFrame) { c.executors.Maintenance.HandleWorkspaceCleanup(f) },
			OnToolRequest:      func(ctx context.Context, f *proto.ToolRequestFrame) { c.executors.Tool.Handle(ctx, f) },
			OnToolCancel:       nil,
			OnModelsRequest:    func(ctx context.Context, f *proto.ModelsRequestFrame) { models.Handle(ctx, f) },
			OnSkillsRequest:    func(ctx context.Context, f *proto.SkillsRequestFrame) { skills.Handle(ctx, f) },
			OnDaemonUpdate: func(ctx context.Context, f *proto.DaemonUpdateRequestFrame) {
				handleDaemonUpdate(ctx, c.cfg, c.pool, c.send, f)
			},
			OnFatalError: func(f *proto.ErrorFrame) error { return fmt.Errorf("server fatal: %s: %s", f.Code, f.Message) },
		},
		BuildPing:   func(id int64) *proto.PingFrame { return buildPingFrame(c.cfg, c.pool, id) },
		OnLoopStart: func(loopCtx context.Context) { c.startMemorySync(loopCtx) },
		OnLoopExit: func() {
			c.pool.CancelAll()
			c.executors.Agent.Close()
		},
	})
}

// startMemorySync launches the agent memory sync poller for any agent
// clients that expose memory roots. Runs only while the connection is
// alive (loopCtx is the link Run context).
func (c *connection) startMemorySync(loopCtx context.Context) {
	home, err := os.UserHomeDir()
	if err != nil {
		return
	}
	sources := state.Sources(home, c.cfg.AgentClients, c.memoryPathForClient)
	if len(sources) == 0 {
		return
	}
	poller := state.NewPoller(c.cfg.LinkID, sources, func(f *proto.MemorySyncFrame) error { return c.send(f) })
	go poller.Run(loopCtx)
}

func (c *connection) memoryPathForClient(home string, client inventory.Info) string {
	agent := agentruntime.NewAgent(client, agentRegistryEntryForClient(c.cfg, client.ID))
	if source, ok := agent.(agentruntime.MemorySource); ok {
		return source.MemoryPath(home)
	}
	return ""
}

// send is the outbound send pipe shared by executors / discoverers /
// memory sync. Returns an error if the underlying link has been torn
// down.
func (c *connection) send(frame any) error {
	if c == nil || c.link == nil {
		return fmt.Errorf("ws not connected")
	}
	return c.link.Send(frame)
}

// Close tears down the underlying ws link with a reason string for the
// server log.
func (c *connection) Close(reason string) {
	if c == nil || c.link == nil {
		return
	}
	c.link.Close(reason)
}

// HelloAckServerVersion returns the server version captured during the
// initial handshake; used in startup log lines.
func (c *connection) HelloAckServerVersion() string {
	if c == nil || c.helloAck == nil {
		return ""
	}
	return c.helloAck.ServerVersion
}

// inventoryDiscover wraps inventory.DiscoverForConfig with the daemon
// config -> registry plumbing (replaces
// daemonapp.discoverAgentClientsForConfig).
func inventoryDiscover(cfg *daemonconfig.Config) []inventory.Info {
	if cfg == nil {
		return inventory.DiscoverForConfig(inventory.Config{})
	}
	return inventory.DiscoverForConfig(inventory.Config{
		DisableAutoDiscover: cfg.RuntimePolicy.DisableAutoDiscover,
		Registry:            registryEntriesFromConfig(cfg.AgentRegistry),
	})
}

func registryEntriesFromConfig(entries []daemonconfig.AgentRegistryEntry) []inventory.RegistryEntry {
	if len(entries) == 0 {
		return nil
	}
	out := make([]inventory.RegistryEntry, 0, len(entries))
	for _, e := range entries {
		out = append(out, inventory.RegistryEntry{
			ID:              e.ID,
			DisplayName:     e.DisplayName,
			Provider:        e.Provider,
			Transport:       e.Transport,
			Binary:          e.Binary,
			Args:            append([]string(nil), e.Args...),
			PermissionModes: append([]string(nil), e.PermissionModes...),
			Capabilities:    append([]string(nil), e.Capabilities...),
		})
	}
	return out
}

func defaultCapabilities() []string {
	return []string{
		"run.host-cli", "run.status",
		"agent.run", "agent.run.events",
		"agent.discover", "agent.sessions",
		"heartbeat.runningRuns", "runtime.status",
		"tool.remote",
	}
}

func hostname() string {
	h, _ := os.Hostname()
	return h
}

func ifEmpty(s, fallback string) string {
	if s == "" {
		return fallback
	}
	return s
}

// modelDiscoverer answers a models.request frame by using the selected
// agent's model capability and emitting a models.result via send.
type modelDiscoverer struct {
	cfg  *daemonconfig.Config
	send func(any) error
}

func newModelDiscoverer(cfg *daemonconfig.Config, send func(any) error) *modelDiscoverer {
	return &modelDiscoverer{cfg: cfg, send: send}
}

func (d *modelDiscoverer) Handle(ctx context.Context, req *proto.ModelsRequestFrame) {
	if d == nil || d.send == nil || req == nil {
		return
	}
	go func() {
		started := time.Now()
		models, err := d.discover(ctx, req.ProviderID)
		var errPtr *string
		if err != nil {
			msg := err.Error()
			errPtr = &msg
		}
		_ = d.send(&proto.ModelsResultFrame{
			Type:       proto.TModelsResult,
			RequestID:  req.RequestID,
			OK:         err == nil,
			Models:     models,
			Error:      errPtr,
			DurationMs: time.Since(started).Milliseconds(),
		})
	}()
}

func (d *modelDiscoverer) discover(ctx context.Context, providerID string) ([]inventory.ModelInfo, error) {
	client, entry, err := resolveAgentClient(d.cfg, providerID)
	if err != nil {
		return nil, err
	}
	agent := agentruntime.NewAgent(client, entry)
	provider, ok := agent.(agentruntime.ModelProvider)
	if !ok {
		return nil, fmt.Errorf("agent client does not provide models: %s", providerID)
	}
	return provider.ListModels(ctx)
}

// skillDiscoverer answers a skills.request frame by using the selected
// agent's skill capability and emitting a skills.result via send.
type skillDiscoverer struct {
	cfg  *daemonconfig.Config
	send func(any) error
}

func newSkillDiscoverer(cfg *daemonconfig.Config, send func(any) error) *skillDiscoverer {
	return &skillDiscoverer{cfg: cfg, send: send}
}

func (d *skillDiscoverer) Handle(ctx context.Context, req *proto.SkillsRequestFrame) {
	if d == nil || d.send == nil || req == nil {
		return
	}
	go func() {
		started := time.Now()
		result, err := d.discover(ctx, req.ProviderID, req.Cwd)
		var errPtr *string
		if err != nil {
			msg := err.Error()
			errPtr = &msg
		}
		_ = d.send(&proto.SkillsResultFrame{
			Type:            proto.TSkillsResult,
			RequestID:       req.RequestID,
			OK:              err == nil,
			WorkspaceSkills: result.WorkspaceSkills,
			CLISkills:       result.CLISkills,
			Error:           errPtr,
			DurationMs:      time.Since(started).Milliseconds(),
		})
	}()
}

func (d *skillDiscoverer) discover(ctx context.Context, providerID, cwd string) (inventory.SkillsResult, error) {
	resolved, err := resolveSkillCwd(d.cfg, cwd)
	if err != nil {
		return inventory.SkillsResult{}, err
	}
	client, entry, err := resolveAgentClient(d.cfg, providerID)
	if err != nil {
		return inventory.SkillsResult{}, err
	}
	agent := agentruntime.NewAgent(client, entry)
	provider, ok := agent.(agentruntime.SkillProvider)
	if !ok {
		return inventory.SkillsResult{}, fmt.Errorf("agent client does not provide skills: %s", providerID)
	}
	return provider.ListSkills(ctx, resolved)
}

func resolveSkillCwd(cfg *daemonconfig.Config, cwd string) (string, error) {
	if strings.TrimSpace(cwd) == "" {
		return cwd, nil
	}
	if strings.HasPrefix(cwd, workspace.DeviceWorkspaceURIPrefix) {
		folder := strings.TrimPrefix(cwd, workspace.DeviceWorkspaceURIPrefix)
		return workspace.EnsureNamedWorkspaceDir(cfg, folder)
	}
	if strings.HasPrefix(cwd, workspace.DeviceTmpURIPrefix) {
		folder := strings.TrimPrefix(cwd, workspace.DeviceTmpURIPrefix)
		return workspace.EnsureNamedTmpDir(cfg, folder)
	}
	return cwd, nil
}

func resolveAgentClient(cfg *daemonconfig.Config, providerID string) (inventory.Info, *daemonconfig.AgentRegistryEntry, error) {
	providerID = strings.TrimSpace(providerID)
	if providerID == "" {
		return inventory.Info{}, nil, errors.New("providerId required")
	}
	clients := []inventory.Info(nil)
	if cfg != nil {
		clients = cfg.AgentClients
	}
	if len(clients) == 0 {
		clients = inventoryDiscover(cfg)
	}
	for _, client := range clients {
		if client.ID == providerID || client.Provider == providerID {
			return client, agentRegistryEntryForClient(cfg, client.ID), nil
		}
	}
	return inventory.Info{}, nil, fmt.Errorf("provider not found on device: %s", providerID)
}

func agentRegistryEntryForClient(cfg *daemonconfig.Config, clientID string) *daemonconfig.AgentRegistryEntry {
	if cfg == nil {
		return nil
	}
	return agentruntime.FindAgentRegistryEntry(cfg, clientID)
}
