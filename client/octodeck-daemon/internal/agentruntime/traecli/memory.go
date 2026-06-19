// Package traecli — memory source (MemorySource implementation).
//
// The trae CLI stores its long-form memory file at ~/.trae/AGENTS.md.
// daemon's memory sync subsystem reads / writes that path through the
// agentruntime.MemorySource interface; this is the family-private
// implementation.
package traecli

import (
	"path/filepath"
	"strings"

	agentcore "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentcore"
)

// MemoryPath implements agentruntime.MemorySource for the Trae CLI family.
//
// Returns ~/.trae/AGENTS.md when home is set; the empty string when home
// is empty (the daemon main loop interprets that as "this agent does not
// participate in memory sync this turn").
func (a *Agent) MemoryPath(home string) string {
	home = strings.TrimSpace(home)
	if home == "" {
		return ""
	}
	return filepath.Join(home, ".trae", "AGENTS.md")
}

// Compile-time assertion that *Agent implements agentruntime.MemorySource.
var _ agentcore.MemorySource = (*Agent)(nil)
