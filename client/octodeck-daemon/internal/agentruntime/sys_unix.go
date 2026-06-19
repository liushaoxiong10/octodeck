//go:build unix

package agentruntime

import (
	security "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/security"
)

func envSnapshot() map[string]string { return security.EnvSnapshot() }
