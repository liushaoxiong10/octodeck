package agentruntime

import (
	"context"
	"errors"
	"io"
	"log"
	"time"

	agentprotocol "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentprotocol"
	daemonconfig "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/config"
	inventory "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/inventory"
	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
)

// NewRuntimeChildServer wires the generic JSON-RPC child server to the daemon
// agent facade. The child owns concrete agent execution; the parent only
// supervises and forwards protocol frames.
func NewRuntimeChildServer(cfg *daemonconfig.Config) *ChildServer {
	if cfg != nil && cfg.AgentClients == nil {
		cfg.AgentClients = DiscoverAgentClients(cfg)
	}
	// Build the conversation-indexed AgentRuntime registry once per child
	// process. Builtin ACP families must run through this path; custom agents
	// without a family driver continue through their direct transport path.
	registry := BuildConversationRuntimeRegistry(cfg)
	return NewChildServer(ChildHandlers{
		OnDiscover: func(ctx context.Context, server *ChildServer, req *proto.AgentDiscoverRequestFrame) {
			handleChildDiscover(ctx, cfg, server, req)
		},
		OnSessionsList: func(ctx context.Context, server *ChildServer, req *proto.AgentSessionsRequestFrame) {
			handleChildSessionsList(ctx, cfg, BuildAgents(cfg), server, req)
		},
		OnSessionDelete: func(ctx context.Context, server *ChildServer, req *proto.AgentSessionDeleteRequestFrame) {
			handleChildSessionDelete(ctx, cfg, BuildAgents(cfg), server, req)
		},
		OnRun: func(ctx context.Context, server *ChildServer, req *proto.AgentRunRequestFrame) {
			handleChildRun(ctx, cfg, BuildAgents(cfg), registry, server, req)
		},
	})
}

// DiscoverAgentClients keeps agent discovery behind the agentruntime facade so
// cmd/node/debug callers do not need to know registry plumbing details.
func DiscoverAgentClients(cfg *daemonconfig.Config) []inventory.Info {
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

func handleChildDiscover(_ context.Context, cfg *daemonconfig.Config, server *ChildServer, req *proto.AgentDiscoverRequestFrame) {
	started := time.Now()
	agents := DiscoverAgentClients(cfg)
	if cfg != nil {
		cfg.AgentClients = agents
	}
	server.Notify("agent.discover.result", &proto.AgentDiscoverResultFrame{
		Type:                proto.TAgentDiscoverResult,
		RequestID:           req.RequestID,
		OK:                  true,
		Agents:              agents,
		RuntimeCapabilities: BuildRuntimeCapabilities(cfg, nil),
		DurationMs:          time.Since(started).Milliseconds(),
	})
}

func handleChildSessionsList(ctx context.Context, cfg *daemonconfig.Config, agents map[string]Agent, server *ChildServer, req *proto.AgentSessionsRequestFrame) {
	started := time.Now()
	sessions, err := childListSessions(ctx, cfg, agents, req.AgentID, req.Workspace)
	server.Notify("agent.sessions.result", &proto.AgentSessionsResultFrame{
		Type:       proto.TAgentSessionsResult,
		RequestID:  req.RequestID,
		OK:         err == nil,
		Sessions:   sessions,
		Error:      errorStringPtr(err),
		DurationMs: time.Since(started).Milliseconds(),
	})
}

func childListSessions(ctx context.Context, cfg *daemonconfig.Config, agents map[string]Agent, agentID, workspace string) ([]proto.AgentSessionInfo, error) {
	if agentID != "" {
		agent := agents[agentID]
		if agent == nil {
			return nil, AgentNotFoundError(agentID)
		}
		return agent.ListSessions(ctx, cfg, workspace)
	}
	out := []proto.AgentSessionInfo{}
	if cfg == nil {
		return out, nil
	}
	for _, client := range cfg.AgentClients {
		agent := agents[client.ID]
		if agent == nil {
			continue
		}
		sessions, err := agent.ListSessions(ctx, cfg, workspace)
		if err != nil {
			return out, err
		}
		out = append(out, sessions...)
	}
	return out, nil
}

func handleChildSessionDelete(ctx context.Context, cfg *daemonconfig.Config, agents map[string]Agent, server *ChildServer, req *proto.AgentSessionDeleteRequestFrame) {
	started := time.Now()
	deleted, err := childDeleteSession(ctx, cfg, agents, req.AgentID, req.Workspace, req.SessionID)
	server.Notify("agent.session.delete.result", &proto.AgentSessionDeleteResultFrame{
		Type:       proto.TAgentSessionDeleteResult,
		RequestID:  req.RequestID,
		OK:         err == nil,
		Deleted:    deleted,
		Error:      errorStringPtr(err),
		DurationMs: time.Since(started).Milliseconds(),
	})
}

func childDeleteSession(ctx context.Context, cfg *daemonconfig.Config, agents map[string]Agent, agentID, workspace, sessionID string) (bool, error) {
	agent := agents[agentID]
	if agent == nil {
		return false, AgentNotFoundError(agentID)
	}
	return DeleteSessionWithACPCleanup(agent, ctx, cfg, workspace, sessionID, agentID)
}

func handleChildRun(parentCtx context.Context, cfg *daemonconfig.Config, agents map[string]Agent, registry *Registry, server *ChildServer, req *proto.AgentRunRequestFrame) {
	started := time.Now()
	log.Printf("octodeck-daemon: child agent.run received runId=%s agent=%s cwd=%s timeoutMs=%d promptBytes=%d sessionId=%s", req.RunID, req.AgentID, req.Cwd, req.TimeoutMs, len(req.Input.Prompt), req.Input.SessionID)
	ctx := parentCtx
	cancel := func() {}
	if req.TimeoutMs > 0 {
		ctx, cancel = context.WithTimeout(parentCtx, time.Duration(req.TimeoutMs)*time.Millisecond)
	} else {
		ctx, cancel = context.WithCancel(parentCtx)
	}
	server.RegisterCancel(req.RunID, cancel)
	defer func() {
		server.UnregisterCancel(req.RunID)
		cancel()
	}()

	result, err := childRun(ctx, cfg, agents, registry, server, req, started)
	if err != nil {
		log.Printf("octodeck-daemon: child agent.run failed runId=%s agent=%s elapsedMs=%d err=%v", req.RunID, req.AgentID, time.Since(started).Milliseconds(), err)
		result = childRunErrorResult(req, err, errors.Is(ctx.Err(), context.DeadlineExceeded), started)
	}
	if result.Type == "" {
		result.Type = proto.TAgentRunResult
	}
	if result.RunID == "" {
		result.RunID = req.RunID
	}
	if result.AgentID == "" {
		result.AgentID = req.AgentID
	}
	if result.DurationMs == 0 {
		result.DurationMs = time.Since(started).Milliseconds()
	}
	log.Printf("octodeck-daemon: child agent.run result notifying runId=%s agent=%s ok=%t timedOut=%t durationMs=%d elapsedMs=%d", result.RunID, result.AgentID, result.OK, result.TimedOut, result.DurationMs, time.Since(started).Milliseconds())
	server.Notify("agent.run.result", &result)
}

// tryConversationRuntimeDispatch attempts to route the request through the conversation-
// indexed AgentRuntime path. Returns (result, true, nil) on success,
// (zero, true, err) on a dispatch error that should be returned to the client,
// or (zero, false, nil) when the agent client has no family driver.
func tryConversationRuntimeDispatch(ctx context.Context, cfg *daemonconfig.Config, registry *Registry, server *ChildServer, req *proto.AgentRunRequestFrame, cwd string, started time.Time) (proto.AgentRunResultFrame, bool, error) {
	baseCfg := FamilyConfig{
		Cwd:            cwd,
		Cfg:            cfg,
		MaxOutputBytes: req.MaxOutputBytes,
		TimeoutMs:      req.TimeoutMs,
	}
	log.Printf("octodeck-daemon: child conversation runtime get-or-create start runId=%s agent=%s elapsedMs=%d", req.RunID, req.AgentID, time.Since(started).Milliseconds())
	inst, created, err := registry.GetOrCreate(ctx, req, baseCfg)
	if err != nil {
		if errors.Is(err, ErrNoFamilyDriver) || errors.Is(err, ErrNoFamilyResolver) {
			log.Printf("octodeck-daemon: child conversation runtime unavailable runId=%s agent=%s elapsedMs=%d err=%v", req.RunID, req.AgentID, time.Since(started).Milliseconds(), err)
			return proto.AgentRunResultFrame{}, false, nil
		}
		log.Printf("octodeck-daemon: child conversation runtime get-or-create failed runId=%s agent=%s elapsedMs=%d err=%v", req.RunID, req.AgentID, time.Since(started).Milliseconds(), err)
		return proto.AgentRunResultFrame{}, true, err
	}
	log.Printf("octodeck-daemon: child conversation runtime ready runId=%s agent=%s created=%t sessionId=%s elapsedMs=%d", req.RunID, req.AgentID, created, inst.SessionID, time.Since(started).Milliseconds())

	emit := func(event proto.AgentRunEventFrame) {
		FillEventDefaults(&event, req.RunID, req.AgentID)
		server.Notify("agent.run.event", &event)
	}

	log.Printf("octodeck-daemon: child conversation runtime send start runId=%s agent=%s elapsedMs=%d", req.RunID, req.AgentID, time.Since(started).Milliseconds())
	result, err := inst.Send(ctx, req, baseCfg, emit)
	if err != nil {
		log.Printf("octodeck-daemon: child conversation runtime send failed runId=%s agent=%s elapsedMs=%d err=%v", req.RunID, req.AgentID, time.Since(started).Milliseconds(), err)
		return proto.AgentRunResultFrame{}, true, err
	}
	log.Printf("octodeck-daemon: child conversation runtime send completed runId=%s agent=%s ok=%t durationMs=%d elapsedMs=%d", req.RunID, req.AgentID, result.OK, result.DurationMs, time.Since(started).Milliseconds())
	// Persist any session id update the family surfaced during Prompt (some
	// providers reassign session ids on resume).
	registry.PersistSession(cfg, inst)
	return result, true, nil
}

func childRun(ctx context.Context, cfg *daemonconfig.Config, agents map[string]Agent, registry *Registry, server *ChildServer, req *proto.AgentRunRequestFrame, started time.Time) (proto.AgentRunResultFrame, error) {
	agent := agents[req.AgentID]
	if agent == nil {
		return proto.AgentRunResultFrame{}, AgentNotFoundError(req.AgentID)
	}
	cwd, err := ResolveRunCwd(ctx, cfg, req)
	if err != nil {
		return proto.AgentRunResultFrame{}, err
	}
	log.Printf("octodeck-daemon: child agent.run cwd resolved runId=%s agent=%s cwd=%s elapsedMs=%d", req.RunID, req.AgentID, cwd, time.Since(started).Milliseconds())
	server.Notify("agent.run.status", &proto.AgentRunStatusFrame{Type: proto.TAgentRunStatus, RunID: req.RunID, AgentID: req.AgentID, Status: "running", Cwd: cwd, StartedAt: FormatTime(started)})
	log.Printf("octodeck-daemon: child agent.run running status sent runId=%s agent=%s elapsedMs=%d", req.RunID, req.AgentID, time.Since(started).Milliseconds())

	// Builtin ACP families route through the conversation-indexed Registry /
	// Instance.Send path. SessionID and model/permission/systemPrompt
	// comparisons live in conversation runtime Instance. Custom agents without a compatible
	// family driver fall through to their direct transport path.
	if registry != nil {
		if result, ok, err := tryConversationRuntimeDispatch(ctx, cfg, registry, server, req, cwd, started); ok {
			return result, err
		}
	}

	var parser func(string) []proto.AgentRunEventFrame
	if outputParser, ok := agent.(OutputParser); ok {
		parser = outputParser.ParseLine
	}
	run := &agentprotocol.RunContext{
		Runtime: server,
		Out:     io.Discard,
		Cfg:     cfg,
		Client:  agent.Discover(ctx),
		Req:     req,
		Cwd:     cwd,
		Started: started,
		Emit: func(event proto.AgentRunEventFrame) {
			FillEventDefaults(&event, req.RunID, req.AgentID)
			server.Notify("agent.run.event", &event)
		},
		ParseLine: parser,
	}
	if err := agent.Connect(ctx, run); err != nil {
		return proto.AgentRunResultFrame{}, err
	}
	log.Printf("octodeck-daemon: child direct agent connected runId=%s agent=%s elapsedMs=%d", req.RunID, req.AgentID, time.Since(started).Milliseconds())
	if err := agent.CreateSession(ctx, run); err != nil {
		return proto.AgentRunResultFrame{}, err
	}
	log.Printf("octodeck-daemon: child direct agent session ready runId=%s agent=%s elapsedMs=%d", req.RunID, req.AgentID, time.Since(started).Milliseconds())
	result, err := agent.RunPrompt(ctx, run)
	if err != nil {
		return proto.AgentRunResultFrame{}, err
	}
	result.Type = proto.TAgentRunResult
	result.RunID = req.RunID
	result.AgentID = req.AgentID
	result.DurationMs = time.Since(started).Milliseconds()
	return result, nil
}

func childRunErrorResult(req *proto.AgentRunRequestFrame, err error, timedOut bool, started time.Time) proto.AgentRunResultFrame {
	runtimeErr := WrapRunError(err, timedOut)
	msg := err.Error()
	return proto.AgentRunResultFrame{
		Type:       proto.TAgentRunResult,
		RunID:      req.RunID,
		AgentID:    req.AgentID,
		OK:         false,
		Error:      &msg,
		ErrorInfo:  runtimeErr.AsAgentRunError(),
		TimedOut:   timedOut,
		DurationMs: time.Since(started).Milliseconds(),
	}
}

func errorStringPtr(err error) *string {
	if err == nil {
		return nil
	}
	msg := err.Error()
	return &msg
}
