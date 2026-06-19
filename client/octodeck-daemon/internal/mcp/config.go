package mcp

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	daemonconfig "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/config"
	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
	state "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/state"
	workspace "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/workspace"
)

type AgentRunRequestFrame = proto.AgentRunRequestFrame

func ConfigForDaemon(cfg *daemonconfig.Config) (Config, error) {
	configPath, err := daemonconfig.DaemonConfigPath(cfg)
	if err != nil {
		return Config{}, err
	}
	commandPath, err := daemonconfig.DaemonCommandPath(cfg)
	if err != nil {
		return Config{}, err
	}
	return Config{Server: cfg.Server, Token: cfg.Token, DaemonDir: daemonconfig.DaemonDir(cfg), ConfigPath: configPath, CommandPath: commandPath}, nil
}

func PrepareArgvForDaemon(cfg *daemonconfig.Config, argv []string, cwd string, env ...map[string]string) ([]string, error) {
	mcpCfg, err := ConfigForDaemon(cfg)
	if err != nil {
		return nil, err
	}
	return PrepareArgv(mcpCfg, argv, cwd, env...)
}

func WriteGlobalConfigForDaemon(cfg *daemonconfig.Config, env ...map[string]string) (string, error) {
	mcpCfg, err := ConfigForDaemon(cfg)
	if err != nil {
		return "", err
	}
	return WriteGlobalConfig(mcpCfg, env...)
}

func WriteTraeProjectConfigForDaemon(cfg *daemonconfig.Config, cwd string, env ...map[string]string) error {
	mcpCfg, err := ConfigForDaemon(cfg)
	if err != nil {
		return err
	}
	return WriteTraeProjectConfig(mcpCfg, cwd, env...)
}

func WriteCodexConfigForDaemon(cfg *daemonconfig.Config, req *AgentRunRequestFrame, cwd string, subDir string) error {
	mcpCfg, err := ConfigForDaemon(cfg)
	if err != nil {
		return err
	}
	folder := state.GroupFolder(req.Context)
	if folder == "" && req.Workspace != nil {
		folder = req.Workspace.Folder
	}
	if folder == "" {
		folder = filepath.Base(filepath.Clean(cwd))
	}
	return WriteCodexConfig(mcpCfg, daemonconfig.SessionDir(cfg), workspace.SafeGroupFolder(folder), subDir, req.Env)
}

func ConfigJSONForDaemon(cfg *daemonconfig.Config, env ...map[string]string) ([]byte, error) {
	mcpCfg, err := ConfigForDaemon(cfg)
	if err != nil {
		return nil, err
	}
	return ConfigJSON(mcpCfg, env...)
}

func ServerConfigForDaemon(cfg *daemonconfig.Config, env ...map[string]string) (map[string]any, error) {
	mcpCfg, err := ConfigForDaemon(cfg)
	if err != nil {
		return nil, err
	}
	return ServerConfig(mcpCfg, env...)
}

const ConfigPlaceholder = "__OCTODECK_AGENT_TEAM_MCP_CONFIG__"
const ProjectConfigMarker = "__OCTODECK_AGENT_TEAM_MCP_PROJECT_CONFIG__"
const UserServersEnv = "OCTODECK_USER_MCP_SERVERS_JSON"

type Config struct {
	Server      string
	Token       string
	DaemonDir   string
	ConfigPath  string
	CommandPath string
}

func PrepareArgv(cfg Config, argv []string, cwd string, env ...map[string]string) ([]string, error) {
	hasPlaceholder := false
	hasProjectConfigMarker := false
	for _, arg := range argv {
		if strings.Contains(arg, ConfigPlaceholder) {
			hasPlaceholder = true
		}
		if arg == ProjectConfigMarker {
			hasProjectConfigMarker = true
		}
	}
	if !hasPlaceholder && !hasProjectConfigMarker {
		return argv, nil
	}
	out := append([]string(nil), argv...)
	if hasPlaceholder {
		path, err := WriteGlobalConfig(cfg, env...)
		if err != nil {
			return nil, err
		}
		out = replaceArgvPlaceholder(out, ConfigPlaceholder, path)
	}
	if hasProjectConfigMarker {
		if err := WriteTraeProjectConfig(cfg, cwd, env...); err != nil {
			return nil, err
		}
		filtered := make([]string, 0, len(out))
		for _, arg := range out {
			if arg != ProjectConfigMarker {
				filtered = append(filtered, arg)
			}
		}
		out = filtered
	}
	return out, nil
}

func WriteGlobalConfig(cfg Config, env ...map[string]string) (string, error) {
	if err := os.MkdirAll(cfg.DaemonDir, 0o700); err != nil {
		return "", err
	}
	path := filepath.Join(cfg.DaemonDir, "agent-team-mcp.json")
	data, err := ConfigJSON(cfg, env...)
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return "", err
	}
	return path, nil
}

func WriteTraeProjectConfig(cfg Config, cwd string, env ...map[string]string) error {
	if strings.TrimSpace(cwd) == "" {
		return errors.New("cwd is required")
	}
	if !filepath.IsAbs(cwd) {
		return fmt.Errorf("cwd must be absolute: %q", cwd)
	}
	path := filepath.Join(cwd, ".trae", "mcp.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	payload := map[string]any{}
	if data, err := os.ReadFile(path); err == nil && len(strings.TrimSpace(string(data))) > 0 {
		if err := json.Unmarshal(data, &payload); err != nil {
			return fmt.Errorf("parse existing Trae MCP config: %w", err)
		}
	}
	server, err := ServerConfig(cfg, env...)
	if err != nil {
		return err
	}
	mcpServers, ok := payload["mcpServers"].(map[string]any)
	if !ok {
		mcpServers = map[string]any{}
	}
	for name, userServer := range UserServersFromEnv(env...) {
		mcpServers[name] = userServer
	}
	mcpServers["octodeck_agent_team"] = server
	payload["mcpServers"] = mcpServers
	data, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o600)
}

func WriteCodexConfig(cfg Config, sessionDir string, folder string, subDir string, env map[string]string) error {
	if subDir == "" {
		subDir = "codex"
	}
	if folder == "" {
		folder = "workspace"
	}
	codexHome := filepath.Join(sessionDir, safeSegment(folder), subDir)
	if err := os.MkdirAll(codexHome, 0o700); err != nil {
		return err
	}
	server, err := ServerConfig(cfg, env)
	if err != nil {
		return err
	}
	command, _ := server["command"].(string)
	args, _ := server["args"].([]string)
	serverEnv, _ := server["env"].(map[string]string)
	if len(args) == 0 {
		if raw, ok := server["args"].([]any); ok {
			for _, item := range raw {
				if s, ok := item.(string); ok {
					args = append(args, s)
				}
			}
		}
	}
	if serverEnv == nil {
		serverEnv = map[string]string{"OCTODECK_AGENT_TEAM_MCP": "1"}
	}
	blocks := []string{}
	for name, userServer := range UserServersFromEnv(env) {
		if block, ok := codexServerBlockFromAny(name, userServer); ok {
			blocks = append(blocks, block)
		}
	}
	blocks = append(blocks, codexServerBlock("octodeck_agent_team", command, args, serverEnv))
	path := filepath.Join(codexHome, "config.toml")
	existing := ""
	if data, err := os.ReadFile(path); err == nil {
		existing = string(data)
	} else if !os.IsNotExist(err) {
		return err
	}
	next := existing
	for _, block := range blocks {
		if name := managedBlockName(block); name != "" {
			next = replaceManagedBlock(next, name, block)
		}
	}
	return os.WriteFile(path, []byte(next), 0o600)
}

func ConfigJSON(cfg Config, env ...map[string]string) ([]byte, error) {
	server, err := ServerConfig(cfg, env...)
	if err != nil {
		return nil, err
	}
	mcpServers := map[string]any{}
	for name, userServer := range UserServersFromEnv(env...) {
		mcpServers[name] = userServer
	}
	mcpServers["octodeck_agent_team"] = server
	return json.MarshalIndent(map[string]any{"mcpServers": mcpServers}, "", "  ")
}

func ServerConfig(cfg Config, env ...map[string]string) (map[string]any, error) {
	if strings.TrimSpace(cfg.Server) == "" || strings.TrimSpace(cfg.Token) == "" {
		return nil, errors.New("server and token are required")
	}
	if strings.TrimSpace(cfg.ConfigPath) == "" {
		return nil, errors.New("config path is required")
	}
	if strings.TrimSpace(cfg.CommandPath) == "" {
		return nil, errors.New("command path is required")
	}
	serverEnv := map[string]string{"OCTODECK_AGENT_TEAM_MCP": "1"}
	if len(env) > 0 && env[0] != nil {
		if token := strings.TrimSpace(env[0]["OCTODECK_AGENT_TOOL_TOKEN"]); token != "" {
			serverEnv["OCTODECK_AGENT_TOOL_TOKEN"] = token
		}
	}
	if token := strings.TrimSpace(os.Getenv("OCTODECK_AGENT_TOOL_TOKEN")); token != "" && serverEnv["OCTODECK_AGENT_TOOL_TOKEN"] == "" {
		serverEnv["OCTODECK_AGENT_TOOL_TOKEN"] = token
	}
	return map[string]any{"type": "stdio", "command": cfg.CommandPath, "args": []string{"mcp-agent-team", "--config", cfg.ConfigPath}, "env": serverEnv, "timeout": 30}, nil
}

func UserServersFromEnv(env ...map[string]string) map[string]any {
	rawValue := ""
	if len(env) > 0 && env[0] != nil {
		rawValue = env[0][UserServersEnv]
	}
	if rawValue == "" {
		rawValue = os.Getenv(UserServersEnv)
	}
	raw := strings.TrimSpace(rawValue)
	if raw == "" {
		return nil
	}
	var parsed map[string]any
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		return nil
	}
	return parsed
}

func replaceArgvPlaceholder(argv []string, placeholder, cwd string) []string {
	replacer := strings.NewReplacer(placeholder, cwd)
	out := make([]string, len(argv))
	for i, arg := range argv {
		out[i] = replacer.Replace(arg)
	}
	return out
}
func codexServerBlock(name string, command string, args []string, env map[string]string) string {
	var b strings.Builder
	b.WriteString("[mcp_servers.")
	b.WriteString(name)
	b.WriteString("]\ncommand = ")
	b.WriteString(tomlString(command))
	b.WriteString("\nargs = ")
	b.WriteString(tomlStringArray(args))
	b.WriteByte('\n')
	if len(env) > 0 {
		b.WriteString("env = {")
		i := 0
		for k, v := range env {
			if i > 0 {
				b.WriteString(", ")
			}
			b.WriteString(k)
			b.WriteString(" = ")
			b.WriteString(tomlString(v))
			i++
		}
		b.WriteString("}\n")
	}
	b.WriteString("startup_timeout_sec = 30\n")
	return b.String()
}
func managedBlockName(block string) string {
	line, _, _ := strings.Cut(block, "\n")
	line = strings.TrimSpace(line)
	if !strings.HasPrefix(line, "[mcp_servers.") || !strings.HasSuffix(line, "]") {
		return ""
	}
	return strings.TrimSuffix(strings.TrimPrefix(line, "[mcp_servers."), "]")
}
func codexServerBlockFromAny(name string, server any) (string, bool) {
	m, ok := server.(map[string]any)
	if !ok || m["type"] == "http" || m["type"] == "sse" {
		return "", false
	}
	command, _ := m["command"].(string)
	if strings.TrimSpace(command) == "" {
		return "", false
	}
	args := []string{}
	if rawArgs, ok := m["args"].([]any); ok {
		for _, item := range rawArgs {
			if s, ok := item.(string); ok {
				args = append(args, s)
			}
		}
	}
	env := map[string]string{}
	if rawEnv, ok := m["env"].(map[string]any); ok {
		for k, v := range rawEnv {
			if s, ok := v.(string); ok {
				env[k] = s
			}
		}
	}
	return codexServerBlock(name, command, args, env), true
}
func replaceManagedBlock(existing, name, block string) string {
	startMarker := "# BEGIN OCTODECK MANAGED MCP " + name
	endMarker := "# END OCTODECK MANAGED MCP " + name
	managed := startMarker + "\n" + strings.TrimSpace(block) + "\n" + endMarker + "\n"
	start := strings.Index(existing, startMarker)
	if start >= 0 {
		end := strings.Index(existing[start:], endMarker)
		if end >= 0 {
			end += start + len(endMarker)
			for end < len(existing) && (existing[end] == '\n' || existing[end] == '\r') {
				end++
			}
			return strings.TrimRight(existing[:start], "\r\n") + "\n\n" + managed + strings.TrimLeft(existing[end:], "\r\n")
		}
	}
	if strings.TrimSpace(existing) == "" {
		return managed
	}
	return strings.TrimRight(existing, "\r\n") + "\n\n" + managed
}
func tomlString(s string) string            { b, _ := json.Marshal(s); return string(b) }
func tomlStringArray(items []string) string { b, _ := json.Marshal(items); return string(b) }
func safeSegment(s string) string {
	s = strings.Trim(s, ".- ")
	if s == "" {
		return "workspace"
	}
	return s
}
