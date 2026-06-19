package agentruntime

import (
	claudecode "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentruntime/claudecode"
	codex "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentruntime/codex"
	traex "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentruntime/traex"
)

func setFamilyDaemonVersions(version string) {
	claudecode.SetDaemonVersion(version)
	codex.SetDaemonVersion(version)
	traex.SetDaemonVersion(version)
}
