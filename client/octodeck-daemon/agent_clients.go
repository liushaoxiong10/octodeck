package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

type AgentClientInfo struct {
	ID              string   `json:"id"`
	DisplayName     string   `json:"displayName"`
	Binary          string   `json:"binary"`
	Version         string   `json:"version,omitempty"`
	Provider        string   `json:"provider,omitempty"`
	Transport       string   `json:"transport,omitempty"`
	PermissionModes []string `json:"permissionModes,omitempty"`
	Capabilities    []string `json:"capabilities,omitempty"`
}

type agentClientCandidate struct {
	id          string
	displayName string
	command     string
	transport   string
}

var supportedAgentClients = []agentClientCandidate{
	{id: "claude-code", displayName: "Claude Code", command: "claude"},
	{id: "codex", displayName: "Codex CLI", command: "codex"},
	{id: "traecli", displayName: "TraeCLI", command: "traecli"},
	{id: "seed", displayName: "Seed CLI", command: "seed", transport: "a2a"},
}

var agentClientVersionArgs = map[string][]string{
	"claude-code": {"--version"},
	"codex":       {"--version"},
	"traecli":     {"--version"},
	"seed":        {"--version"},
}

var agentClientPermissionModes = map[string][]string{
	"claude-code": {"default", "acceptEdits", "bypassPermissions", "plan"},
	"codex":       {"default", "read-only", "workspace-write", "full-access"},
	"traecli":     {"default", "acceptEdits", "bypassPermissions"},
	"seed":        {"default", "ask", "auto"},
}

var agentClientCapabilities = map[string][]string{
	"claude-code": {"print", "stream-json", "mcp", "permissions", "tools", "session", "skills"},
	"codex":       {"exec", "jsonl", "tools", "sandbox", "approval-policy"},
	"traecli":     {"print", "plain-text", "permissions", "tools"},
	"seed":        {"a2a", "jsonrpc", "events", "permissions", "tools", "session"},
}

func agentClientSearchDirs() []string {
	dirs := make([]string, 0)
	seen := map[string]struct{}{}
	add := func(dir string) {
		dir = strings.TrimSpace(dir)
		if dir == "" {
			return
		}
		if expanded, err := filepath.Abs(dir); err == nil {
			dir = expanded
		}
		if _, ok := seen[dir]; ok {
			return
		}
		seen[dir] = struct{}{}
		dirs = append(dirs, dir)
	}

	for _, dir := range filepath.SplitList(os.Getenv("PATH")) {
		add(dir)
	}
	for _, dir := range filepath.SplitList(os.Getenv("OCTODECK_DAEMON_EXTRA_PATH")) {
		add(dir)
	}

	home, _ := os.UserHomeDir()
	if home != "" {
		for _, rel := range []string{
			".local/bin",
			"bin",
			".bun/bin",
			".npm-global/bin",
			".volta/bin",
			".yarn/bin",
		} {
			add(filepath.Join(home, rel))
		}
		for _, pattern := range []string{
			filepath.Join(home, ".nvm", "versions", "node", "*", "bin"),
			filepath.Join(home, ".fnm", "node-versions", "*", "installation", "bin"),
		} {
			matches, _ := filepath.Glob(pattern)
			for _, dir := range matches {
				add(dir)
			}
		}
	}

	for _, dir := range []string{
		"/opt/homebrew/bin",
		"/usr/local/bin",
		"/usr/bin",
		"/bin",
		"/usr/sbin",
		"/sbin",
	} {
		add(dir)
	}
	if runtime.GOOS == "darwin" {
		for _, dir := range []string{
			"/Applications/cmux.app/Contents/Resources/bin",
			"/Applications/Trae.app/Contents/Resources/app/bin",
			"/Applications/TRAE CN.app/Contents/Resources/app/bin",
			"/Applications/TRAE SOLO CN.app/Contents/Resources/app/bin",
		} {
			add(dir)
		}
	}

	return dirs
}

func findExecutableInDirs(command string, dirs []string) string {
	if filepath.IsAbs(command) && isExecutable(command) {
		return command
	}
	for _, dir := range dirs {
		p := filepath.Join(dir, command)
		if isExecutable(p) {
			return p
		}
	}
	return ""
}

func isExecutable(path string) bool {
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return false
	}
	return info.Mode()&0o111 != 0
}

func discoverAgentClients() []AgentClientInfo {
	return discoverAgentClientsForConfig(nil)
}

func discoverAgentClientsForConfig(cfg *Config) []AgentClientInfo {
	if cfg != nil && cfg.RuntimePolicy.DisableAutoDiscover {
		return registryAgentClients(cfg)
	}
	clients := make([]AgentClientInfo, 0, len(supportedAgentClients))
	dirs := agentClientSearchDirs()
	for _, c := range supportedAgentClients {
		bin := findExecutableInDirs(c.command, dirs)
		if bin == "" {
			continue
		}
		transport := c.transport
		if transport == "" {
			transport = "stdio"
		}
		clients = append(clients, AgentClientInfo{
			ID:              c.id,
			DisplayName:     c.displayName,
			Binary:          bin,
			Version:         detectAgentClientVersion(c.id, bin),
			Provider:        c.id,
			Transport:       transport,
			PermissionModes: agentClientPermissionModes[c.id],
			Capabilities:    agentClientCapabilities[c.id],
		})
	}
	return mergeAgentClients(clients, registryAgentClients(cfg))
}

func registryAgentClients(cfg *Config) []AgentClientInfo {
	if cfg == nil || len(cfg.AgentRegistry) == 0 {
		return nil
	}
	out := make([]AgentClientInfo, 0, len(cfg.AgentRegistry))
	for _, entry := range cfg.AgentRegistry {
		transport := entry.Transport
		if transport == "" {
			transport = "stdio"
		}
		provider := entry.Provider
		if provider == "" {
			provider = entry.ID
		}
		version := ""
		if entry.Binary != "" && transport == "stdio" {
			args := entry.VersionCommand
			if len(args) == 0 {
				args = []string{"--version"}
			}
			version = detectAgentClientVersionWithArgs(entry.Binary, args)
		}
		out = append(out, AgentClientInfo{
			ID:              entry.ID,
			DisplayName:     ifEmpty(entry.DisplayName, entry.ID),
			Binary:          entry.Binary,
			Version:         version,
			Provider:        provider,
			Transport:       transport,
			PermissionModes: entry.PermissionModes,
			Capabilities:    append([]string(nil), entry.Capabilities...),
		})
	}
	return out
}

func mergeAgentClients(auto []AgentClientInfo, registry []AgentClientInfo) []AgentClientInfo {
	if len(registry) == 0 {
		return auto
	}
	seen := make(map[string]int, len(auto)+len(registry))
	out := make([]AgentClientInfo, 0, len(auto)+len(registry))
	for _, c := range auto {
		seen[c.ID] = len(out)
		out = append(out, c)
	}
	for _, c := range registry {
		if idx, ok := seen[c.ID]; ok {
			out[idx] = c
			continue
		}
		seen[c.ID] = len(out)
		out = append(out, c)
	}
	return out
}

func detectAgentClientVersion(id string, binary string) string {
	args, ok := agentClientVersionArgs[id]
	if !ok {
		args = []string{"--version"}
	}
	return detectAgentClientVersionWithArgs(binary, args)
}

func detectAgentClientVersionWithArgs(binary string, args []string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, binary, args...)
	cmd.Env = os.Environ()
	out, err := cmd.CombinedOutput()
	if err != nil || ctx.Err() != nil {
		return ""
	}
	return normalizeVersionOutput(string(out))
}

func normalizeVersionOutput(s string) string {
	for _, line := range strings.Split(s, "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			if len(line) > 128 {
				return line[:128]
			}
			return line
		}
	}
	return ""
}
