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
	Args            []string `json:"-"`
	PermissionModes []string `json:"permissionModes,omitempty"`
	Capabilities    []string `json:"capabilities,omitempty"`
}

type agentClientCandidate struct {
	id          string
	displayName string
	command     string
	provider    string
	transport   string
	args        []string
	probeArgs   [][]string
	markers     []string
}

var supportedAgentClients = []agentClientCandidate{
	{id: "claude-acp", displayName: "Claude Code (ACP)", command: "claude", provider: "claude-code", transport: "acp", args: []string{"acp"}, probeArgs: [][]string{{"acp", "--help"}, {"--help"}}},
	{id: "claude-code", displayName: "Claude Code", command: "claude"},
	{id: "codex-acp", displayName: "Codex CLI (ACP)", command: "codex", provider: "codex", transport: "acp", args: []string{"acp"}, probeArgs: [][]string{{"acp", "--help"}, {"--help"}}},
	{id: "codex", displayName: "Codex CLI", command: "codex"},
	{id: "traecli-acp", displayName: "TraeCLI (ACP)", command: "traecli", provider: "traecli", transport: "acp", args: []string{"acp"}, probeArgs: [][]string{{"acp", "--help"}, {"--help"}}},
	{id: "traecli", displayName: "TraeCLI", command: "traecli"},
	// traex: 本地的另一个 agent CLI 二进制，调用约定与 codex 一致（exec --json）。
	// 优先尝试 ACP，失败 fallback 到 codex 风格 stream-json。
	{id: "traex-acp", displayName: "Traex (ACP)", command: "traex", provider: "traex", transport: "acp", args: []string{"acp"}, probeArgs: [][]string{{"acp", "--help"}, {"--help"}}},
	{id: "traex", displayName: "Traex", command: "traex", provider: "traex"},
}

var agentClientVersionArgs = map[string][]string{
	"claude-code": {"--version"},
	"claude-acp":  {"--version"},
	"codex":       {"--version"},
	"codex-acp":   {"--version"},
	"traecli":     {"--version"},
	"traecli-acp": {"--version"},
	"traex":       {"--version"},
	"traex-acp":   {"--version"},
}

var agentClientPermissionModes = map[string][]string{
	"claude-code": {"default", "acceptEdits", "bypassPermissions", "plan"},
	"claude-acp":  {"default", "acceptEdits", "bypassPermissions", "plan"},
	"codex":       {"default", "read-only", "workspace-write", "full-access"},
	"codex-acp":   {"default", "read-only", "workspace-write", "full-access"},
	"traecli":     {"default", "acceptEdits", "bypassPermissions"},
	"traecli-acp": {"default", "acceptEdits", "bypassPermissions"},
	// traex 接受 OctoDeck 的 bypassPermissions 别名，并在实际启动时
	// 转成 TraeX 自己的免审批全局参数。
	"traex":     {"default", "read-only", "workspace-write", "full-access", "bypassPermissions"},
	"traex-acp": {"default", "read-only", "workspace-write", "full-access", "bypassPermissions"},
}

var agentClientCapabilities = map[string][]string{
	"claude-code": {"print", "stream-json", "mcp", "permissions", "tools", "session", "skills", "system-prompt"},
	"claude-acp":  {"acp", "jsonrpc", "mcp", "permissions", "tools", "session", "skills", "system-prompt"},
	"codex":       {"exec", "jsonl", "tools", "sandbox", "approval-policy"},
	"codex-acp":   {"acp", "jsonrpc", "mcp", "tools", "sandbox", "approval-policy", "session", "system-prompt"},
	"traecli":     {"print", "plain-text", "permissions", "tools"},
	"traecli-acp": {"acp", "jsonrpc", "mcp", "permissions", "tools", "session"},
	"traex":       {"exec", "jsonl", "tools", "sandbox", "approval-policy"},
	"traex-acp":   {"acp", "jsonrpc", "mcp", "tools", "sandbox", "approval-policy", "session"},
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
	// 同一 binary（claude / codex / traecli）只发布一种 client：
	//   1. 优先尝试 ACP（结构化 jsonrpc，能拿到完整 tool_call / thinking /
	//      permission 通知，链路稳定）
	//   2. ACP 探测失败时再 fallback 到非 ACP（print/stream-json/jsonl）
	//   3. 两者都不行则该 binary 不发布
	// 这样 server 端 runtimes 列表清爽，避免用户误选导致拿不到中间执行轨迹。
	dirs := agentClientSearchDirs()
	clients := make([]AgentClientInfo, 0, len(supportedAgentClients))
	usedCommand := make(map[string]struct{})
	for _, c := range supportedAgentClients {
		if _, taken := usedCommand[c.command]; taken {
			continue
		}
		bin := findExecutableInDirs(c.command, dirs)
		if bin == "" {
			continue
		}
		if !supportsAgentClientCandidate(c, bin) {
			continue
		}
		transport := c.transport
		if transport == "" {
			transport = "stdio"
		}
		provider := c.provider
		if provider == "" {
			provider = c.id
		}
		clients = append(clients, AgentClientInfo{
			ID:              c.id,
			DisplayName:     c.displayName,
			Binary:          bin,
			Version:         "",
			Provider:        provider,
			Transport:       transport,
			Args:            append([]string(nil), c.args...),
			PermissionModes: agentClientPermissionModes[c.id],
			Capabilities:    agentClientCapabilities[c.id],
		})
		usedCommand[c.command] = struct{}{}
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
		out = append(out, AgentClientInfo{
			ID:              entry.ID,
			DisplayName:     ifEmpty(entry.DisplayName, entry.ID),
			Binary:          entry.Binary,
			Version:         "",
			Provider:        provider,
			Transport:       transport,
			Args:            append([]string(nil), entry.Args...),
			PermissionModes: entry.PermissionModes,
			Capabilities:    append([]string(nil), entry.Capabilities...),
		})
	}
	return out
}

func supportsAgentClientCandidate(c agentClientCandidate, binary string) bool {
	if c.transport != "acp" {
		return true
	}
	// ACP 候选默认探测 `<binary> acp --help`，确保只有真正支持 ACP 子命令的
	// 二进制才会被注册成 *-acp。这样可以避免老版本（不带 acp 子命令）被错误
	// 标成 ACP，又因 jsonrpc 握手失败导致中间过程拿不到。
	// 通过设置 OCTODECK_DAEMON_PROBE_AGENT_CLIENTS=0 可以临时跳过探测（仅用于
	// 测试 / 离线机器）。
	if os.Getenv("OCTODECK_DAEMON_PROBE_AGENT_CLIENTS") == "0" {
		return true
	}
	probes := c.probeArgs
	if len(probes) == 0 {
		probes = [][]string{{"acp", "--help"}, {"--help"}}
	}
	markers := c.markers
	if len(markers) == 0 {
		markers = []string{"agent client protocol", "acp"}
	}
	for _, args := range probes {
		out, ok := detectAgentClientOutputWithArgs(binary, args)
		if !ok {
			continue
		}
		lower := strings.ToLower(out)
		for _, marker := range markers {
			if marker != "" && strings.Contains(lower, strings.ToLower(marker)) {
				return true
			}
		}
	}
	if supportsEmbeddedACPClientCandidate(c) {
		return true
	}
	return false
}

func supportsEmbeddedACPClientCandidate(c agentClientCandidate) bool {
	switch c.id {
	case "claude-acp", "codex-acp":
		return true
	default:
		return false
	}
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
	out, ok := detectAgentClientOutputWithArgs(binary, args)
	if !ok {
		return ""
	}
	return normalizeVersionOutput(out)
}

func detectAgentClientOutputWithArgs(binary string, args []string) (string, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, binary, args...)
	cmd.Env = os.Environ()
	out, err := cmd.CombinedOutput()
	if err != nil || ctx.Err() != nil {
		return "", false
	}
	return string(out), true
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
