// Package traecli — provider session metadata helper.
//
// Session enumeration / deletion is currently implemented on
// agentcore.BaseAgent (via state.ListProvider / state.DeleteProvider).
// To prepare for the eventual removal of family-aware logic from
// BaseAgent (see daemon-agent-runtime-decoupling-plan §5.6), this file
// hosts the family-private helpers and lets *Agent override the
// BaseAgent implementations directly. The helpers expose the family's
// provider-directory layout (`ProviderDir`) without leaking it back to
// the shared profile registry.
package traecli

import (
	"context"

	daemonconfig "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/config"
	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
	state "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/state"
	workspaceutil "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/workspace"
)

// ProviderDir is the on-disk directory name used by the Trae CLI to
// persist its native sessions. The daemon mirrors the same directory
// name when materialising metadata under <sessions>/<workspace>/<provider>.
const ProviderDir = "traecli"

// ListSessions enumerates persisted Trae CLI sessions for a given agent
// client (traecli or traecli-acp) under the requested workspace. An
// empty workspace string scans every workspace.
//
// agentClientID is the daemon-level agent ID (e.g. "traecli") and is
// used to resolve metadata located under the agent-id sub-directory in
// addition to the family-shared provider directory.
func ListSessions(ctx context.Context, cfg *daemonconfig.Config, agentClientID, workspace string) ([]proto.AgentSessionInfo, error) {
	return state.ListProvider(ctx, cfg, agentClientID, ProviderDir, workspace)
}

// DeleteSession removes a single Trae CLI provider session. It first
// tries the family provider directory and, if nothing was deleted, falls
// back to the agent-id sub-directory that BaseAgent historically
// maintained for ID-scoped metadata.
func DeleteSession(ctx context.Context, cfg *daemonconfig.Config, agentClientID, workspace, sessionID string) (bool, error) {
	deleted, err := state.DeleteProvider(ctx, cfg, ProviderDir, workspace, sessionID)
	if err != nil || deleted || agentClientID == ProviderDir {
		return deleted, err
	}
	return state.DeleteProvider(ctx, cfg, workspaceutil.SafePathSegment(agentClientID), workspace, sessionID)
}
