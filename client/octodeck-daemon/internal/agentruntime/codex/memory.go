// Package codex — memory source (MemorySource implementation).
//
// The Codex CLI persists user-level long-term memory to
// ~/.codex/AGENTS.md. The daemon's memory-sync poller (state.Poller)
// watches that file and broadcasts updates upstream as MemorySyncFrame
// events. The C-stage migration moves the family literal out of
// state.memoryPathForClient so the daemon can drive memory discovery
// purely through the agentruntime.MemorySource type assertion.
package codex

import (
	"path/filepath"
	"strings"

	agentcore "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentcore"
)

// MemoryPath implements agentruntime.MemorySource for the Codex family.
//
// home is the user's home directory (absolute). The function returns
// the absolute path to ~/.codex/AGENTS.md, or an empty string when
// home is empty (which signals "this agent does not participate in
// memory sync this run").
func (a *Agent) MemoryPath(home string) string {
	home = strings.TrimSpace(home)
	if home == "" {
		return ""
	}
	return filepath.Join(home, ".codex", "AGENTS.md")
}

// Compile-time interface assertion.
var _ agentcore.MemorySource = (*Agent)(nil)
