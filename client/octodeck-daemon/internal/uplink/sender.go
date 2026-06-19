package uplink

import (
	"context"
	"errors"
	"time"

	"github.com/coder/websocket"

	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
)

// Send encodes frame and writes it to the underlying connection. Multiple
// goroutines may call Send concurrently; writes are serialised with a mutex.
func (c *Client) Send(frame any) error {
	if c == nil || c.conn == nil {
		return errors.New("ws not connected")
	}
	data, err := proto.EncodeFrame(frame)
	if err != nil {
		return err
	}
	c.sendMu.Lock()
	defer c.sendMu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return c.conn.Write(ctx, websocket.MessageText, data)
}

// runHeartbeat is the outbound write loop dedicated to heartbeat frames. It
// fires opts.BuildPing on the cadence returned in hello_ack until the context
// is cancelled.
func (c *Client) runHeartbeat(ctx context.Context, buildPing func(id int64) *proto.PingFrame) {
	if buildPing == nil {
		return
	}
	hbInterval := time.Duration(c.heartbeat.IntervalMs) * time.Millisecond
	if hbInterval <= 0 {
		hbInterval = 30 * time.Second
	}
	t := time.NewTicker(hbInterval)
	defer t.Stop()
	var pingID int64 = 1
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			_ = c.Send(buildPing(pingID))
			pingID++
		}
	}
}
