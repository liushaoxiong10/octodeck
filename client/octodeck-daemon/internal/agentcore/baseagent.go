package agentcore

import (
	"context"
	"errors"
	"fmt"
	"strings"

	agentprotocol "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentprotocol"
	daemonconfig "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/config"
	inventory "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/inventory"
	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
	state "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/state"
	workspaceutil "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/workspace"
)

type BaseAgent struct {
	Client inventory.Info
	Entry  *daemonconfig.AgentRegistryEntry
}

func (a *BaseAgent) Discover(context.Context) inventory.Info { return a.Client }

func (a *BaseAgent) Transport() string {
	if a.Entry != nil && strings.TrimSpace(a.Entry.Transport) != "" {
		return strings.TrimSpace(a.Entry.Transport)
	}
	if strings.TrimSpace(a.Client.Transport) != "" {
		return strings.TrimSpace(a.Client.Transport)
	}
	return "stdio"
}

func (a *BaseAgent) Connect(_ context.Context, run *agentprotocol.RunContext) error {
	if run == nil || run.Req == nil {
		return errors.New("agent run is required")
	}
	return nil
}

func (a *BaseAgent) CreateSession(context.Context, *agentprotocol.RunContext) error { return nil }

func (a *BaseAgent) RunPrompt(_ context.Context, _ *agentprotocol.RunContext) (proto.AgentRunResultFrame, error) {
	return proto.AgentRunResultFrame{}, fmt.Errorf("agent %s does not implement RunPrompt", a.Client.ID)
}

func (a *BaseAgent) ProviderDirName() string {
	if id := workspaceutil.SafePathSegment(a.Client.ID); id != "" {
		return id
	}
	return "agent"
}

func (a *BaseAgent) ListSessions(ctx context.Context, cfg *daemonconfig.Config, workspace string) ([]proto.AgentSessionInfo, error) {
	return state.ListProvider(ctx, cfg, a.Client.ID, a.ProviderDirName(), workspace)
}

func (a *BaseAgent) DeleteSession(ctx context.Context, cfg *daemonconfig.Config, workspace, sessionID string) (bool, error) {
	providerDir := a.ProviderDirName()
	deleted, err := state.DeleteProvider(ctx, cfg, providerDir, workspace, sessionID)
	if err != nil || deleted || providerDir == a.Client.ID {
		return deleted, err
	}
	return state.DeleteProvider(ctx, cfg, workspaceutil.SafePathSegment(a.Client.ID), workspace, sessionID)
}
