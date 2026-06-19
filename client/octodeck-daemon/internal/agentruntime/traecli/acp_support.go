package traecli

import (
	"path/filepath"
	"strings"

	acpsdk "github.com/coder/acp-go-sdk"

	daemonconfig "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/config"
	mcp "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/mcp"
	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
)

// DaemonVersion is the version string emitted on ACP Initialize. Set during
// daemon start-up via SetDaemonVersion.
var DaemonVersion = "octodeck-daemon/0.0.0"

// TransportACP is the literal transport string used by the built-in TraeCLI
// descriptor. Execution for this transport is handled by conversation runtime.
const TransportACP = "acp"

// SetDaemonVersion overrides the version string used in ACP Initialize.
func SetDaemonVersion(v string) {
	if strings.TrimSpace(v) != "" {
		DaemonVersion = v
	}
}

// normalizeACPServerArgs adapts traecli's argv so it actually starts an ACP
// server with the policy-required flags.
func normalizeACPServerArgs(binary string, args []string, policy proto.AgentRunPolicy) []string {
	normalized := append([]string(nil), args...)
	name := filepath.Base(binary)
	if !applies(name) {
		return normalized
	}
	if len(normalized) == 1 && normalized[0] == "acp" {
		normalized = append(normalized, "serve")
	} else if len(normalized) >= 2 && normalized[0] == "acp" && normalized[1] == "server" {
		normalized[1] = "serve"
	}
	normalized = injectModel(normalized, policy)
	if !shouldAutoApprove(policy.PermissionMode) {
		return normalized
	}
	return injectYolo(normalized)
}

func applies(name string) bool {
	switch name {
	case "coco", "traecli":
		return true
	}
	return false
}

func injectModel(args []string, policy proto.AgentRunPolicy) []string {
	model := strings.TrimSpace(policy.Model)
	if model == "" || hasConfigOverride(args, "model.name") {
		return args
	}
	return append([]string{"-c", "model.name=" + model}, args...)
}

func injectYolo(args []string) []string {
	for _, v := range args {
		if v == "-y" || v == "--yolo" {
			return args
		}
	}
	return append([]string{"--yolo"}, args...)
}

func hasConfigOverride(args []string, key string) bool {
	prefix := key + "="
	for i, v := range args {
		if v == "-c" || v == "--config" {
			if i+1 < len(args) && strings.HasPrefix(args[i+1], prefix) {
				return true
			}
		}
		if strings.HasPrefix(v, "-c=") && strings.HasPrefix(v[3:], prefix) {
			return true
		}
		if strings.HasPrefix(v, "--config=") && strings.HasPrefix(v[len("--config="):], prefix) {
			return true
		}
	}
	return false
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

func mergeStringMaps(a, b map[string]string) map[string]string {
	if len(a) == 0 {
		return b
	}
	if len(b) == 0 {
		return a
	}
	out := make(map[string]string, len(a)+len(b))
	for k, v := range a {
		out[k] = v
	}
	for k, v := range b {
		out[k] = v
	}
	return out
}
