package uplink

import (
	"fmt"
	"net/url"
	"strings"
)

// BuildURL converts a configured server origin (https?://host[:port][/path])
// into the agent-link websocket endpoint (wss?://host[:port][/path]/api/agent-link/ws).
// It accepts ws/wss/http/https schemes; anything else returns an error.
func BuildURL(server string) (string, error) {
	u, err := url.Parse(server)
	if err != nil {
		return "", err
	}
	switch u.Scheme {
	case "https":
		u.Scheme = "wss"
	case "http":
		u.Scheme = "ws"
	case "wss", "ws":
		// keep
	default:
		return "", fmt.Errorf("unsupported server scheme: %s", u.Scheme)
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/api/agent-link/ws"
	return u.String(), nil
}
