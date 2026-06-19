package node

import (
	"context"
	"strings"

	agentruntime "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentruntime"
	daemonconfig "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/config"
	inventory "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/inventory"
	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
	state "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/state"
	daemonupdate "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/update"
)

// buildPingFrame assembles the periodic heartbeat ping. It samples the
// run pool, the host resource snapshot, and the per-agent runtime
// status table.
func buildPingFrame(cfg *daemonconfig.Config, pool *state.RunPool, id int64) *proto.PingFrame {
	running := pool.Snapshot()
	status := "idle"
	if pool.IsDraining() {
		status = "draining"
	} else if len(running) > 0 {
		status = "busy"
	}
	return &proto.PingFrame{
		Type:              proto.TPing,
		ID:                id,
		Resources:         inventory.CollectSnapshot(),
		Status:            status,
		RunningRuns:       running,
		MaxConcurrentRuns: pool.MaxConcurrentRuns(),
		AvailableSlots:    pool.AvailableSlots(),
		Runtimes: agentruntime.BuildRuntimeStatuses(
			cfg.LinkID, cfg.AgentClients, running,
			pool.MaxConcurrentRuns(), pool.AvailableSlots(), status,
		),
	}
}

// handleDaemonUpdate processes a daemon.update.request from the
// server. The actual binary swap is delegated to internal/update; the
// node only ensures the request is honoured asynchronously and that
// errors are reported as non-fatal frames.
func handleDaemonUpdate(ctx context.Context, cfg *daemonconfig.Config, pool *state.RunPool, send func(any) error, req *proto.DaemonUpdateRequestFrame) {
	if req == nil {
		return
	}
	go func() {
		if !daemonupdate.AutoUpdateEnabled(cfg) {
			return
		}
		latest := strings.TrimSpace(req.LatestVersion)
		if !daemonupdate.IsNewerVersion(latest, cfg.Version) {
			return
		}
		if err := daemonupdate.UpdateBinaryGracefully(ctx, cfg, pool, "", true); err != nil {
			_ = send(&proto.ErrorFrame{Type: proto.TError, Code: "daemon_update_failed", Message: err.Error(), Fatal: false})
		}
	}()
}
