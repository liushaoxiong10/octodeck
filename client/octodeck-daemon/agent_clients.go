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
	PermissionModes []string `json:"permissionModes,omitempty"`
	Capabilities    []string `json:"capabilities,omitempty"`
}

type agentClientCandidate struct {
	id          string
	displayName string
	command     string
}

var supportedAgentClients = []agentClientCandidate{
	{id: "claude-code", displayName: "Claude Code", command: "claude"},
	{id: "codex", displayName: "Codex CLI", command: "codex"},
	{id: "traecli", displayName: "TraeCLI", command: "traecli"},
}

var agentClientVersionArgs = map[string][]string{
	"claude-code": {"--version"},
	"codex":       {"--version"},
	"traecli":     {"--version"},
}

var agentClientPermissionModes = map[string][]string{
	"claude-code": {"default", "acceptEdits", "bypassPermissions", "plan"},
	"codex":       {"default", "read-only", "workspace-write", "full-access"},
	"traecli":     {"default", "acceptEdits", "bypassPermissions"},
}

var agentClientCapabilities = map[string][]string{
	"claude-code": {"print", "stream-json", "mcp", "permissions", "tools", "session"},
	"codex":       {"exec", "plain-text", "sandbox", "approval-policy"},
	"traecli":     {"print", "plain-text", "permissions", "tools"},
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
	clients := make([]AgentClientInfo, 0, len(supportedAgentClients))
	dirs := agentClientSearchDirs()
	for _, c := range supportedAgentClients {
		bin := findExecutableInDirs(c.command, dirs)
		if bin == "" {
			continue
		}
		clients = append(clients, AgentClientInfo{
			ID:              c.id,
			DisplayName:     c.displayName,
			Binary:          bin,
			Version:         detectAgentClientVersion(c.id, bin),
			PermissionModes: agentClientPermissionModes[c.id],
			Capabilities:    agentClientCapabilities[c.id],
		})
	}
	return clients
}

func detectAgentClientVersion(id string, binary string) string {
	args, ok := agentClientVersionArgs[id]
	if !ok {
		args = []string{"--version"}
	}
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
