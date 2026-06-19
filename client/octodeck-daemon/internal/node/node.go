// Package node is the main daemon orchestration layer.
//
// It initializes configuration, state, uplink, inventory, executors,
// and session manager. It owns the reconnect strategy, OS signal
// handling, graceful shutdown, and heartbeat aggregation.
//
// This package replaces the orchestration role previously held by
// daemonapp.Main/runForever/wsClient.
package node

import (
	"context"
	"fmt"
	"log"

	daemonconfig "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/config"
)

// Options configures the node startup.
type Options struct {
	ConfigPath string
	// Version is the daemon binary version to advertise to the server.
	// Config files can outlive an in-place binary update, so the runtime
	// should prefer the embedded binary version over config.version when
	// deciding whether the daemon is outdated.
	Version string
}

// Start is the main entry point for the daemon node. It loads config,
// installs signal handling, and runs the connect/run/reconnect loop.
func Start(opts Options) error {
	cfg, err := daemonconfig.Load(opts.ConfigPath)
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}
	if opts.Version != "" {
		cfg.Version = opts.Version
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	installSignalHandlers(cancel)

	log.Printf("octodeck-daemon: starting, server=%s linkId=%s allowed=%d agentClients=%d",
		cfg.Server, cfg.LinkID, len(cfg.AllowedBinaries), len(cfg.AgentClients))

	return runForever(ctx, cfg)
}
