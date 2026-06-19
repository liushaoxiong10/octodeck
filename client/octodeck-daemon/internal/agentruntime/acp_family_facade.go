package agentruntime

import (
	claudecode "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentruntime/claudecode"
	codex "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentruntime/codex"
	traecli "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentruntime/traecli"
	traex "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentruntime/traex"
)

func setFamilyDaemonVersions(version string) {
	claudecode.SetDaemonVersion(version)
	codex.SetDaemonVersion(version)
	traecli.SetDaemonVersion(version)
	traex.SetDaemonVersion(version)
}
