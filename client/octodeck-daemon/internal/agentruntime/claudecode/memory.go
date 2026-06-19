// Package claudecode — MemorySource implementation.
//
// The Claude CLI persists user-facing memory in `~/.claude/CLAUDE.md`.
// internal/state.Sources used to derive that path via a hard-coded
// switch on inventory.NormalizeFamily; phase C moves the per-family
// knowledge here so the daemon main loop can resolve memory paths via
// a clean type assertion (see agentruntime/capabilities_optional.go).
package claudecode

import (
	"path/filepath"
	"strings"

	agentcore "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentcore"
)

// Compile-time interface assertion: *Agent satisfies the optional
// MemorySource capability defined in agentruntime/capabilities_optional.go.
var _ agentcore.MemorySource = (*Agent)(nil)

// MemoryPath returns the absolute path of the Claude family memory file
// (~/.claude/CLAUDE.md). Returns the empty string when home is empty,
// signalling that this agent should not participate in memory sync for
// the current run.
func (a *Agent) MemoryPath(home string) string {
	if strings.TrimSpace(home) == "" {
		return ""
	}
	return filepath.Join(home, ".claude", "CLAUDE.md")
}
