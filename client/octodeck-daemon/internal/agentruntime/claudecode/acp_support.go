package claudecode

import (
	"strings"
	"sync/atomic"

	acpsdk "github.com/coder/acp-go-sdk"

	daemonconfig "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/config"
	mcp "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/mcp"
)

// DaemonVersion is the version string emitted on ACP Initialize. Set during
// daemon start-up via SetDaemonVersion.
var DaemonVersion = "octodeck-daemon/0.0.0"

// SetDaemonVersion overrides the version string used in ACP Initialize.
func SetDaemonVersion(v string) {
	if strings.TrimSpace(v) != "" {
		DaemonVersion = v
	}
}

func buildACPSDKMCPServers(cfg *daemonconfig.Config, env ...map[string]string) []acpsdk.McpServer {
	server, err := mcp.ServerConfigForDaemon(cfg, env...)
	if err != nil {
		return []acpsdk.McpServer{}
	}
	command, _ := server["command"].(string)
	if command == "" {
		return []acpsdk.McpServer{}
	}
	args := make([]string, 0)
	switch raw := server["args"].(type) {
	case []string:
		args = append(args, raw...)
	case []any:
		for _, item := range raw {
			if s, ok := item.(string); ok {
				args = append(args, s)
			}
		}
	}
	envVars := make([]acpsdk.EnvVariable, 0)
	if rawEnv, ok := server["env"].(map[string]string); ok {
		for name, value := range rawEnv {
			envVars = append(envVars, acpsdk.EnvVariable{Name: name, Value: value})
		}
	} else if rawEnv, ok := server["env"].(map[string]any); ok {
		for name, value := range rawEnv {
			if s, ok := value.(string); ok {
				envVars = append(envVars, acpsdk.EnvVariable{Name: name, Value: s})
			}
		}
	}
	return []acpsdk.McpServer{{Stdio: &acpsdk.McpServerStdio{Name: "octodeck_agent_team", Command: command, Args: args, Env: envVars}}}
}

type atomicString struct{ v atomic.Value }

func (s *atomicString) Append(value string) {
	for {
		current, _ := s.v.Load().(string)
		s.v.Store(current + value)
		return
	}
}

func (s *atomicString) String() string {
	value, _ := s.v.Load().(string)
	return value
}
