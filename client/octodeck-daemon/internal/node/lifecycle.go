package node

import (
	"context"
	"fmt"
	"log"
	"time"

	daemonconfig "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/config"
)

// runForever loops connection attempts with exponential backoff. The
// loop ends when ctx is cancelled (typically by SIGINT/SIGTERM).
func runForever(ctx context.Context, cfg *daemonconfig.Config) error {
	rec := newReconnect()

	for {
		if ctx.Err() != nil {
			return nil
		}

		conn, err := connect(ctx, cfg)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			wait := rec.next()
			log.Printf("octodeck-daemon: dial failed (%v); retry in %s", err, wait)
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(wait):
			}
			continue
		}

		rec.reset()
		log.Printf("octodeck-daemon: connected (server=%s)", conn.HelloAckServerVersion())

		runErr := conn.Run(ctx)
		conn.Close(fmt.Sprintf("loop_exit:%v", runErr))
		if ctx.Err() != nil {
			return nil
		}
		log.Printf("octodeck-daemon: connection lost: %v; reconnecting", runErr)
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(1 * time.Second):
		}
	}
}

// connect performs the WebSocket dial + hello handshake and returns a
// fully wired connection ready to Run.
func connect(ctx context.Context, cfg *daemonconfig.Config) (*connection, error) {
	return wireConnection(ctx, cfg)
}
