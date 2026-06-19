package uplink

import (
	"context"
	"fmt"

	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
)

// RunOptions configures the read/heartbeat loop driven by Run.
type RunOptions struct {
	Handlers    Handlers
	BuildPing   func(id int64) *proto.PingFrame // optional; when nil, no heartbeat
	OnLoopStart func(ctx context.Context)       // optional; invoked once before the read loop starts
	OnLoopExit  func()                          // optional; invoked when Run returns
}

// Run blocks reading frames off the connection until the connection closes or
// the context is cancelled. Inbound frames are dispatched through opts.Handlers.
// A heartbeat goroutine writes opts.BuildPing(...) on the cadence returned in
// hello_ack. Callers should Close the client after Run returns and reconnect
// with their own backoff policy.
func (c *Client) Run(ctx context.Context, opts RunOptions) error {
	hbCtx, hbCancel := context.WithCancel(ctx)
	defer hbCancel()

	if opts.BuildPing != nil {
		go c.runHeartbeat(hbCtx, opts.BuildPing)
	}

	if opts.OnLoopStart != nil {
		opts.OnLoopStart(hbCtx)
	}
	if opts.OnLoopExit != nil {
		defer opts.OnLoopExit()
	}

	return c.readLoop(ctx, &opts.Handlers)
}

// readLoop reads frames off the underlying websocket connection, parses each
// frame and forwards it to the dispatcher. It returns once the connection
// errors out or the context is cancelled. Protocol parse errors are reported
// to the server as a non-fatal error frame and the loop continues.
func (c *Client) readLoop(ctx context.Context, handlers *Handlers) error {
	for {
		_, data, err := c.conn.Read(ctx)
		if err != nil {
			return fmt.Errorf("ws read: %w", err)
		}
		frame, perr := proto.ParseInbound(data)
		if perr != nil {
			_ = c.Send(&proto.ErrorFrame{
				Type:    proto.TError,
				Code:    "protocol_violation",
				Message: perr.Error(),
				Fatal:   false,
			})
			continue
		}
		if err := handlers.dispatch(ctx, frame); err != nil {
			return err
		}
	}
}
