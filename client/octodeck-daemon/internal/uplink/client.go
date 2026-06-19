// Package uplink owns the WebSocket connection between octodeck-daemon and the
// platform server. It is responsible for:
//   - building the ws:// / wss:// URL from a configured server origin
//   - performing the hello / hello_ack handshake
//   - serializing outbound frames behind a mutex (the underlying websocket
//     library's Write is not concurrency-safe)
//   - reading inbound frames and routing them to caller-supplied Handlers
//   - emitting heartbeats on the cadence the server returned in hello_ack
//
// The package is intentionally agnostic to the daemon's business logic:
// callers wire run/agent/tool dispatch by populating Handlers.
package uplink

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/coder/websocket"

	inventory "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/inventory"
	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
)

// DefaultMaxFrameBytes mirrors the cap used in src/agent-link/protocol.ts. 1MiB
// is too small for AgentLink because memory.sync frames can carry ~1MB markdown
// files (JSON escaping pushes wire payloads above 1MiB) and agent.run.result
// can include up to ~100MiB of agent output plus framing overhead.
const DefaultMaxFrameBytes = 256 * 1024 * 1024

// DialOptions captures everything needed to open a single ws connection and
// run through the hello handshake. Most fields are forwarded verbatim into the
// outgoing HelloFrame; the rest configure transport-level behaviour.
type DialOptions struct {
	// Transport
	Server        string
	LinkID        string
	Token         string
	MaxFrameBytes int           // 0 → DefaultMaxFrameBytes
	DialTimeout   time.Duration // 0 → 15s
	HelloTimeout  time.Duration // 0 → 10s

	// HelloFrame fields
	Version                  string
	OS                       string
	Arch                     string
	Hostname                 string
	Capabilities             []string
	AgentClients             []inventory.Info
	AgentRuntimeCapabilities []proto.RuntimeCapability
	InitialResources         inventory.Snapshot
}

// HeartbeatInfo describes the heartbeat cadence the server returned. Callers
// use it to drive their own ping ticker (PingFrame contents typically depend
// on caller-side run pool state, so we hand the cadence back rather than
// owning the ticker here).
type HeartbeatInfo struct {
	IntervalMs int
}

// Client owns a single websocket connection and serialises outbound writes.
// Use Dial to construct one; call Run to block on the read loop and Close
// once the loop returns.
type Client struct {
	conn          *websocket.Conn
	sendMu        sync.Mutex
	helloAck      *proto.HelloAckFrame
	heartbeat     HeartbeatInfo
	maxFrameBytes int
}

// HelloAck returns the server's hello_ack frame captured during Dial.
func (c *Client) HelloAck() *proto.HelloAckFrame { return c.helloAck }

// Heartbeat returns the heartbeat cadence the server requested.
func (c *Client) Heartbeat() HeartbeatInfo { return c.heartbeat }

// Dial opens a single ws connection to opts.Server, performs the hello
// handshake and returns a connected Client. On any failure the underlying
// connection is closed before returning.
func Dial(ctx context.Context, opts DialOptions) (*Client, error) {
	endpoint, err := BuildURL(opts.Server)
	if err != nil {
		return nil, err
	}
	dialTimeout := opts.DialTimeout
	if dialTimeout <= 0 {
		dialTimeout = 15 * time.Second
	}
	helloTimeout := opts.HelloTimeout
	if helloTimeout <= 0 {
		helloTimeout = 10 * time.Second
	}
	maxFrame := opts.MaxFrameBytes
	if maxFrame <= 0 {
		maxFrame = DefaultMaxFrameBytes
	}

	dialCtx, cancel := context.WithTimeout(ctx, dialTimeout)
	defer cancel()

	dopts := &websocket.DialOptions{
		HTTPHeader: map[string][]string{
			"X-Link-Token": {opts.Token},
		},
	}
	conn, _, err := websocket.Dial(dialCtx, endpoint, dopts)
	if err != nil {
		return nil, fmt.Errorf("ws dial: %w", err)
	}
	conn.SetReadLimit(int64(maxFrame))

	c := &Client{conn: conn, maxFrameBytes: maxFrame}
	if err := c.sendHello(ctx, &opts); err != nil {
		_ = conn.Close(websocket.StatusNormalClosure, "hello failed")
		return nil, err
	}
	if err := c.awaitHelloAck(ctx, helloTimeout); err != nil {
		_ = conn.Close(websocket.StatusNormalClosure, "hello_ack failed")
		return nil, err
	}
	return c, nil
}

// Close closes the underlying websocket. The reason is truncated to fit the
// websocket close frame's status reason length budget.
func (c *Client) Close(reason string) {
	if c == nil || c.conn == nil {
		return
	}
	_ = c.conn.Close(websocket.StatusNormalClosure, truncate(reason, 120))
}

func ifEmpty(s, fallback string) string {
	if s == "" {
		return fallback
	}
	return s
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
