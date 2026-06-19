package uplink

import (
	"context"
	"fmt"
	"time"

	"github.com/coder/websocket"

	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
)

// sendHello writes the initial hello frame describing this daemon's identity
// and capabilities to the server.
func (c *Client) sendHello(ctx context.Context, opts *DialOptions) error {
	frame := &proto.HelloFrame{
		Type:                     proto.THello,
		ID:                       1,
		Version:                  ifEmpty(opts.Version, "octodeck-daemon/0.1.0"),
		ProtocolVersion:          2,
		ProtocolMinVersion:       1,
		OS:                       opts.OS,
		Arch:                     opts.Arch,
		Hostname:                 opts.Hostname,
		Capabilities:             opts.Capabilities,
		AgentClients:             opts.AgentClients,
		AgentRuntimeCapabilities: opts.AgentRuntimeCapabilities,
		Resources:                opts.InitialResources,
	}
	data, err := proto.EncodeFrame(frame)
	if err != nil {
		return err
	}
	return c.conn.Write(ctx, websocket.MessageText, data)
}

// awaitHelloAck blocks until the server responds with a hello_ack frame or the
// timeout elapses. It also captures the heartbeat cadence the server suggests.
func (c *Client) awaitHelloAck(ctx context.Context, timeout time.Duration) error {
	readCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	_, data, err := c.conn.Read(readCtx)
	if err != nil {
		return fmt.Errorf("read hello_ack: %w", err)
	}
	frame, err := proto.ParseInbound(data)
	if err != nil {
		return fmt.Errorf("parse hello_ack: %w", err)
	}
	switch f := frame.(type) {
	case *proto.HelloAckFrame:
		c.helloAck = f
		c.heartbeat = HeartbeatInfo{IntervalMs: f.HeartbeatIntervalMs}
		if c.heartbeat.IntervalMs <= 0 {
			c.heartbeat.IntervalMs = 30_000
		}
		return nil
	case *proto.ErrorFrame:
		return fmt.Errorf("server error during hello: %s: %s", f.Code, f.Message)
	default:
		return fmt.Errorf("expected hello_ack, got %T", frame)
	}
}
