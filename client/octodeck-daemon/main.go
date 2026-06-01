package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"runtime"
	"syscall"
	"time"
)

func goos() string   { return runtime.GOOS }
func goarch() string { return runtime.GOARCH }

func hostname() string {
	h, err := os.Hostname()
	if err != nil {
		return ""
	}
	return h
}

func main() {
	var configPath string
	flag.StringVar(&configPath, "config", "", "path to config.json (default ~/.octodeck-daemon/config.json)")
	flag.Parse()

	cfg, err := loadConfig(configPath)
	if err != nil {
		log.Fatalf("octodeck-daemon: %v", err)
	}
	cfg.AgentClients = discoverAgentClients()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Signal handling — graceful shutdown
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		s := <-sigCh
		log.Printf("octodeck-daemon: received %s, shutting down", s)
		cancel()
	}()

	log.Printf("octodeck-daemon: starting, server=%s linkId=%s allowed=%d agentClients=%d max=%d",
		cfg.Server, cfg.LinkID, len(cfg.AllowedBinaries), len(cfg.AgentClients), cfg.MaxConcurrentRuns)

	if err := runForever(ctx, cfg); err != nil {
		log.Printf("octodeck-daemon: terminated: %v", err)
		os.Exit(1)
	}
}

// runForever loops connection attempts with exponential backoff.
func runForever(ctx context.Context, cfg *Config) error {
	backoffSchedule := []time.Duration{
		1 * time.Second,
		2 * time.Second,
		4 * time.Second,
		8 * time.Second,
		15 * time.Second,
		30 * time.Second,
	}
	attempt := 0

	for {
		if ctx.Err() != nil {
			return nil
		}

		client, err := dial(ctx, cfg)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			wait := backoffSchedule[min(attempt, len(backoffSchedule)-1)]
			log.Printf("octodeck-daemon: dial failed (%v); retry in %s", err, wait)
			attempt++
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(wait):
			}
			continue
		}

		attempt = 0 // reset backoff on a successful handshake
		log.Printf("octodeck-daemon: connected (server=%s)", client.helloAck.ServerVersion)

		runErr := client.run(ctx)
		client.close(fmt.Sprintf("loop_exit:%v", runErr))
		if ctx.Err() != nil {
			return nil
		}
		log.Printf("octodeck-daemon: connection lost: %v; reconnecting", runErr)
		// short fixed delay before next attempt
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(1 * time.Second):
		}
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
