package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

func goos() string   { return runtime.GOOS }
func goarch() string { return runtime.GOARCH }

const daemonVersion = "octodeck-daemon/1.0.8"

var daemonUpdateMu sync.Mutex

func hostname() string {
	h, err := os.Hostname()
	if err != nil {
		return ""
	}
	return h
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "mcp-agent-team" {
		if err := runAgentTeamMCPCommand(os.Args[2:]); err != nil {
			log.Fatalf("octodeck-daemon mcp-agent-team: %v", err)
		}
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "agent-runtime" {
		if err := runAgentRuntimeCommand(os.Args[2:]); err != nil {
			log.Fatalf("octodeck-daemon agent-runtime: %v", err)
		}
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "update" {
		if err := runUpdateCommand(os.Args[2:]); err != nil {
			log.Fatalf("octodeck-daemon update: %v", err)
		}
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "uninstall" {
		if err := runUninstallCommand(os.Args[2:]); err != nil {
			log.Fatalf("octodeck-daemon uninstall: %v", err)
		}
		return
	}
	if len(os.Args) > 1 && (os.Args[1] == "version" || os.Args[1] == "--version" || os.Args[1] == "-version") {
		fmt.Println(daemonVersion)
		return
	}

	var configPath string
	flag.StringVar(&configPath, "config", "", "path to config.json (default ~/.octodeck/daemon/config.json)")
	flag.Parse()

	cfg, err := loadConfig(configPath)
	if err != nil {
		log.Fatalf("octodeck-daemon: %v", err)
	}
	cfg.AgentClients = discoverAgentClientsForConfig(cfg)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Signal handling — graceful shutdown
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		s := <-sigCh
		log.Printf("octodeck-daemon: received %s, shutting down", s)
		cancel()
	}()

	log.Printf("octodeck-daemon: starting, server=%s linkId=%s allowed=%d agentClients=%d max=unlimited",
		cfg.Server, cfg.LinkID, len(cfg.AllowedBinaries), len(cfg.AgentClients))

	if err := runForever(ctx, cfg); err != nil {
		log.Printf("octodeck-daemon: terminated: %v", err)
		os.Exit(1)
	}
}

func runUpdateCommand(args []string) error {
	fs := flag.NewFlagSet("update", flag.ContinueOnError)
	var configPath string
	var targetPath string
	var restart bool
	fs.StringVar(&configPath, "config", "", "path to config.json")
	fs.StringVar(&targetPath, "target", "", "path to octodeck-daemon binary to replace (default current executable)")
	fs.BoolVar(&restart, "restart", true, "restart octodeck-daemon user service after updating")
	if err := fs.Parse(args); err != nil {
		return err
	}
	cfg, err := loadConfig(configPath)
	if err != nil {
		return err
	}
	return updateDaemonBinary(cfg, targetPath, restart)
}

func updateDaemonBinary(cfg *Config, targetPath string, restart bool) error {
	daemonUpdateMu.Lock()
	defer daemonUpdateMu.Unlock()

	var err error
	if targetPath == "" {
		targetPath, err = os.Executable()
		if err != nil {
			return fmt.Errorf("resolve current executable: %w", err)
		}
	}
	targetPath, err = filepath.Abs(targetPath)
	if err != nil {
		return err
	}
	info, err := os.Stat(targetPath)
	mode := os.FileMode(0o755)
	if err == nil {
		mode = info.Mode().Perm()
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("stat target binary: %w", err)
	}
	binURL := strings.TrimRight(cfg.Server, "/") + "/api/daemon/octodeck-daemon-bin"
	tmp := filepath.Join(filepath.Dir(targetPath), fmt.Sprintf(".octodeck-daemon.update.%d", os.Getpid()))
	if err := downloadFile(binURL, tmp, mode); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, targetPath); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("replace target binary: %w", err)
	}
	fmt.Printf("octodeck-daemon: updated %s from %s\n", targetPath, binURL)
	if restart {
		if err := restartDaemonService(); err != nil {
			fmt.Fprintf(os.Stderr, "octodeck-daemon: updated but restart failed: %v\n", err)
			fmt.Fprintln(os.Stderr, "octodeck-daemon: please restart the daemon manually")
			return nil
		}
		fmt.Println("octodeck-daemon: restart requested")
	}
	return nil
}

type daemonVersionResponse struct {
	Version string `json:"version"`
}

func daemonVersionURL(server string) string {
	return strings.TrimRight(server, "/") + "/api/daemon/version"
}

func autoUpdateEnabled(cfg *Config) bool {
	return cfg == nil || cfg.AutoUpdate == nil || *cfg.AutoUpdate
}

func checkDaemonUpdate(ctx context.Context, cfg *Config) (string, bool, error) {
	if cfg == nil {
		return "", false, errors.New("nil config")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, daemonVersionURL(cfg.Server), nil)
	if err != nil {
		return "", false, err
	}
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", false, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", false, fmt.Errorf("daemon version check http %s", resp.Status)
	}
	var body daemonVersionResponse
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return "", false, err
	}
	latest := strings.TrimSpace(body.Version)
	return latest, isNewerDaemonVersion(latest, cfg.Version), nil
}

func runAutoUpdate(ctx context.Context, cfg *Config) error {
	if !autoUpdateEnabled(cfg) {
		return nil
	}
	checkCtx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	latest, available, err := checkDaemonUpdate(checkCtx, cfg)
	if err != nil {
		return fmt.Errorf("check daemon update: %w", err)
	}
	if !available {
		return nil
	}
	log.Printf("octodeck-daemon: auto update available current=%s latest=%s", cfg.Version, latest)
	if err := updateDaemonBinary(cfg, "", true); err != nil {
		return fmt.Errorf("auto update to %s: %w", latest, err)
	}
	return nil
}

func normalizeDaemonVersion(s string) string {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "octodeck-daemon/")
	s = strings.TrimPrefix(s, "v")
	return s
}

func isNewerDaemonVersion(latest string, current string) bool {
	latest = normalizeDaemonVersion(latest)
	current = normalizeDaemonVersion(current)
	if latest == "" || current == "" || latest == current {
		return false
	}
	latestParts, latestOK := parseDaemonSemver(latest)
	currentParts, currentOK := parseDaemonSemver(current)
	if latestOK && currentOK {
		for i := 0; i < len(latestParts); i++ {
			if latestParts[i] != currentParts[i] {
				return latestParts[i] > currentParts[i]
			}
		}
		return false
	}
	return latest != current
}

func parseDaemonSemver(s string) ([3]int, bool) {
	var out [3]int
	base := strings.SplitN(s, "-", 2)[0]
	parts := strings.Split(base, ".")
	if len(parts) == 0 || len(parts) > 3 {
		return out, false
	}
	for i, p := range parts {
		if p == "" {
			return out, false
		}
		n, err := strconv.Atoi(p)
		if err != nil {
			return out, false
		}
		out[i] = n
	}
	return out, true
}

func downloadFile(url string, target string, mode os.FileMode) error {
	client := &http.Client{Timeout: 2 * time.Minute}
	resp, err := client.Get(url)
	if err != nil {
		return fmt.Errorf("download %s: %w", url, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("download %s: http %s", url, resp.Status)
	}
	f, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(f, resp.Body)
	closeErr := f.Close()
	if copyErr != nil {
		return copyErr
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Chmod(target, mode)
}

func restartDaemonService() error {
	if runtime.GOOS == "darwin" {
		plist := filepath.Join(os.Getenv("HOME"), "Library", "LaunchAgents", "com.octodeck.octodeck-daemon.plist")
		if _, err := os.Stat(plist); err == nil {
			return exec.Command("launchctl", "kickstart", "-k", fmt.Sprintf("gui/%d/com.octodeck.octodeck-daemon", os.Getuid())).Run()
		}
	}
	if _, err := exec.LookPath("systemctl"); err == nil {
		service := filepath.Join(os.Getenv("HOME"), ".config", "systemd", "user", "octodeck-daemon.service")
		if _, statErr := os.Stat(service); statErr == nil {
			return exec.Command("systemctl", "--user", "restart", "octodeck-daemon.service").Run()
		}
	}
	return fmt.Errorf("no launchctl/systemd user service found")
}

func runUninstallCommand(args []string) error {
	fs := flag.NewFlagSet("uninstall", flag.ContinueOnError)
	var removeData bool
	var keepConfig bool
	fs.BoolVar(&removeData, "remove-data", false, "also remove workspace/task/repos/session data under ~/.octodeck")
	fs.BoolVar(&keepConfig, "keep-config", false, "keep ~/.octodeck/daemon/config.json")
	if err := fs.Parse(args); err != nil {
		return err
	}
	home, err := octodeckHomeDir()
	if err != nil {
		return err
	}
	daemon, err := defaultDaemonDir()
	if err != nil {
		return err
	}
	stopAndRemoveDaemonService()
	if keepConfig {
		configPath := filepath.Join(daemon, "config.json")
		configData, readErr := os.ReadFile(configPath)
		if readErr != nil && !os.IsNotExist(readErr) {
			return fmt.Errorf("read config before uninstall: %w", readErr)
		}
		if err := os.RemoveAll(daemon); err != nil {
			return fmt.Errorf("remove daemon dir: %w", err)
		}
		if readErr == nil {
			if err := os.MkdirAll(daemon, 0o700); err != nil {
				return err
			}
			if err := os.WriteFile(configPath, configData, 0o600); err != nil {
				return err
			}
		}
	} else if err := os.RemoveAll(daemon); err != nil {
		return fmt.Errorf("remove daemon dir: %w", err)
	}
	if removeData {
		for _, name := range []string{"workspace", "task", "repos", "session"} {
			if err := os.RemoveAll(filepath.Join(home, name)); err != nil {
				return fmt.Errorf("remove %s: %w", name, err)
			}
		}
	}
	fmt.Println("octodeck-daemon: uninstalled")
	if !removeData {
		fmt.Printf("octodeck-daemon: kept workspace data under %s (use --remove-data to delete it)\n", home)
	}
	return nil
}

func stopAndRemoveDaemonService() {
	if runtime.GOOS == "darwin" {
		plist := filepath.Join(os.Getenv("HOME"), "Library", "LaunchAgents", "com.octodeck.octodeck-daemon.plist")
		_ = exec.Command("launchctl", "bootout", fmt.Sprintf("gui/%d/com.octodeck.octodeck-daemon", os.Getuid())).Run()
		_ = exec.Command("launchctl", "bootout", fmt.Sprintf("gui/%d", os.Getuid()), plist).Run()
		_ = os.Remove(plist)
	}
	if _, err := exec.LookPath("systemctl"); err == nil {
		service := filepath.Join(os.Getenv("HOME"), ".config", "systemd", "user", "octodeck-daemon.service")
		_ = exec.Command("systemctl", "--user", "disable", "--now", "octodeck-daemon.service").Run()
		_ = os.Remove(service)
		_ = exec.Command("systemctl", "--user", "daemon-reload").Run()
	}
}

// runForever loops connection attempts with exponential backoff.
func runForever(ctx context.Context, cfg *Config) error {
	backoffSchedule := []time.Duration{
		1 * time.Second,
		2 * time.Second,
		4 * time.Second,
		8 * time.Second,
		15 * time.Second,
		30 * time.Second,
	}
	attempt := 0
	autoUpdateAttempted := false

	for {
		if ctx.Err() != nil {
			return nil
		}

		client, err := dial(ctx, cfg)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			wait := backoffSchedule[min(attempt, len(backoffSchedule)-1)]
			log.Printf("octodeck-daemon: dial failed (%v); retry in %s", err, wait)
			attempt++
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(wait):
			}
			continue
		}

		attempt = 0 // reset backoff on a successful handshake
		log.Printf("octodeck-daemon: connected (server=%s)", client.helloAck.ServerVersion)
		if !autoUpdateAttempted {
			autoUpdateAttempted = true
			go func() {
				if err := runAutoUpdate(ctx, cfg); err != nil {
					log.Printf("octodeck-daemon: auto update skipped: %v", err)
				}
			}()
		}

		runErr := client.run(ctx)
		client.close(fmt.Sprintf("loop_exit:%v", runErr))
		if ctx.Err() != nil {
			return nil
		}
		log.Printf("octodeck-daemon: connection lost: %v; reconnecting", runErr)
		// short fixed delay before next attempt
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(1 * time.Second):
		}
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

type jsonRPCRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      any             `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

func runAgentTeamMCPCommand(args []string) error {
	fs := flag.NewFlagSet("mcp-agent-team", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	var configPath string
	fs.StringVar(&configPath, "config", "", "path to config.json")
	if err := fs.Parse(args); err != nil {
		return err
	}
	cfg, err := loadConfig(configPath)
	if err != nil {
		return err
	}
	reader := bufio.NewReader(os.Stdin)
	for {
		msg, framed, err := readMCPMessage(reader)
		if err != nil {
			if err == io.EOF {
				return nil
			}
			return err
		}
		var req jsonRPCRequest
		if err := json.Unmarshal(msg, &req); err != nil {
			continue
		}
		if req.ID == nil {
			continue
		}
		res := handleAgentTeamMCPRequest(cfg, req)
		if err := writeMCPMessage(os.Stdout, res, framed); err != nil {
			return err
		}
	}
}

func readMCPMessage(r *bufio.Reader) ([]byte, bool, error) {
	contentLength := -1
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return nil, false, err
		}
		line = strings.TrimRight(line, "\r\n")
		trimmed := strings.TrimSpace(line)
		if contentLength < 0 && strings.HasPrefix(trimmed, "{") {
			return []byte(trimmed), false, nil
		}
		if line == "" {
			break
		}
		name, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		if strings.EqualFold(strings.TrimSpace(name), "Content-Length") {
			parsed, err := strconv.Atoi(strings.TrimSpace(value))
			if err != nil {
				return nil, false, err
			}
			contentLength = parsed
		}
	}
	if contentLength < 0 {
		return nil, false, fmt.Errorf("missing Content-Length")
	}
	body := make([]byte, contentLength)
	_, err := io.ReadFull(r, body)
	return body, true, err
}

func writeMCPMessage(w io.Writer, payload any, framed bool) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	if !framed {
		_, err = fmt.Fprintf(w, "%s\n", body)
		return err
	}
	_, err = fmt.Fprintf(w, "Content-Length: %d\r\n\r\n%s", len(body), body)
	return err
}

func handleAgentTeamMCPRequest(cfg *Config, req jsonRPCRequest) map[string]any {
	success := func(result any) map[string]any {
		return map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": result}
	}
	failure := func(code int, message string) map[string]any {
		return map[string]any{"jsonrpc": "2.0", "id": req.ID, "error": map[string]any{"code": code, "message": message}}
	}
	switch req.Method {
	case "initialize":
		return success(map[string]any{
			"protocolVersion": "2024-11-05",
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]any{"name": "octodeck-agent-team", "version": cfg.Version},
		})
	case "tools/list":
		return success(map[string]any{"tools": agentTeamMCPTools()})
	case "tools/call":
		var params struct {
			Name      string         `json:"name"`
			Arguments map[string]any `json:"arguments"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return failure(-32602, "invalid tools/call params")
		}
		result, err := callAgentTeamHTTPTool(cfg, params.Name, params.Arguments)
		if err != nil {
			return success(map[string]any{"content": []map[string]string{{"type": "text", "text": err.Error()}}, "isError": true})
		}
		text, _ := json.MarshalIndent(result, "", "  ")
		return success(map[string]any{"content": []map[string]string{{"type": "text", "text": string(text)}}})
	default:
		return failure(-32601, "method not found")
	}
}

func agentTeamMCPTools() []map[string]any {
	stringProp := func(description string) map[string]any {
		return map[string]any{"type": "string", "description": description}
	}
	numberProp := func(description string, maximum int) map[string]any {
		return map[string]any{"type": "integer", "minimum": 1, "maximum": maximum, "description": description}
	}
	boolProp := func(description string) map[string]any {
		return map[string]any{"type": "boolean", "description": description}
	}
	enumProp := func(description string, values ...string) map[string]any {
		return map[string]any{"type": "string", "enum": values, "description": description}
	}
	return []map[string]any{
		{"name": "repo_knowledge_list", "description": "列出当前用户的仓库及其知识库状态。先用它发现 repo_id，再用 repo_knowledge_search / repo_knowledge_get_chunk。", "inputSchema": map[string]any{"type": "object", "properties": map[string]any{}}},
		{"name": "repo_knowledge_status", "description": "查看某个仓库知识库生成状态、摘要和统计信息。", "inputSchema": map[string]any{"type": "object", "properties": map[string]any{"repo_id": stringProp("Repo ID")}, "required": []string{"repo_id"}}},
		{"name": "repo_knowledge_search", "description": "在仓库知识库中搜索架构、文件、符号、依赖和文档片段。适合先理解代码图谱再动手修改。", "inputSchema": map[string]any{"type": "object", "properties": map[string]any{"query": stringProp("搜索问题或关键词"), "repo_id": stringProp("可选 Repo ID；不传则搜索当前用户全部已生成知识库"), "limit": numberProp("返回条数，默认 20", 50), "kind": enumProp("按 chunk 类型过滤", "overview", "file", "symbol", "dependency", "doc", "graph"), "language": stringProp("按语言过滤，例如 typescript/python/go"), "path_prefix": stringProp("按路径前缀过滤"), "include_related": boolProp("是否返回相关图谱边")}, "required": []string{"query"}}},
		{"name": "repo_knowledge_list_chunks", "description": "列出某个仓库知识库的 chunk，可按文件 path 过滤。", "inputSchema": map[string]any{"type": "object", "properties": map[string]any{"repo_id": stringProp("Repo ID"), "path": stringProp("可选文件路径"), "kind": enumProp("可选 chunk 类型", "overview", "file", "symbol", "dependency", "doc", "graph"), "language": stringProp("可选语言过滤"), "path_prefix": stringProp("可选路径前缀过滤"), "limit": numberProp("返回条数，默认 100", 200)}, "required": []string{"repo_id"}}},
		{"name": "repo_knowledge_get_chunk", "description": "读取知识库搜索结果中的完整 chunk 内容。", "inputSchema": map[string]any{"type": "object", "properties": map[string]any{"chunk_id": stringProp("Chunk ID")}, "required": []string{"chunk_id"}}},
		{"name": "repo_knowledge_graph", "description": "查看仓库知识库图谱边，包括 imports、depends_on、documents、references。", "inputSchema": map[string]any{"type": "object", "properties": map[string]any{"repo_id": stringProp("Repo ID"), "path": stringProp("可选文件路径，返回与该文件相关的边"), "edge_kind": enumProp("边类型过滤", "imports", "imported_by", "depends_on", "exports", "documents", "references"), "limit": numberProp("返回条数，默认 100", 200)}, "required": []string{"repo_id"}}},
		{"name": "repo_knowledge_related", "description": "根据 chunk_id 或 path 获取相关 chunks 和图谱边。", "inputSchema": map[string]any{"type": "object", "properties": map[string]any{"repo_id": stringProp("Repo ID"), "chunk_id": stringProp("可选 chunk ID"), "path": stringProp("可选文件路径"), "limit": numberProp("返回条数，默认 30", 100)}, "required": []string{"repo_id"}}},
		{"name": "repo_knowledge_context", "description": "获取面向改代码的上下文包：命中 chunk、同文件 chunks、相关 chunks、依赖、文档和图谱边。优先用它在修改前聚合上下文。", "inputSchema": map[string]any{"type": "object", "properties": map[string]any{"repo_id": stringProp("Repo ID"), "query": stringProp("可选搜索问题；不传 chunk_id/path 时用它定位 anchor chunk"), "chunk_id": stringProp("可选 chunk ID，精确定位上下文 anchor"), "path": stringProp("可选文件路径，按文件聚合上下文"), "limit": numberProp("每类上下文返回上限，默认 20", 80)}, "required": []string{"repo_id"}}},
		{"name": "repo_knowledge_plugins", "description": "查看 OctoDeck Repo 知识库生成器插件状态，包括 builtin、graphify、codegraph。", "inputSchema": map[string]any{"type": "object", "properties": map[string]any{}}},
		{"name": "repo_knowledge_search_backends", "description": "查看 Repo 知识库搜索后端状态，包括 SQLite、PostgreSQL、MongoDB。", "inputSchema": map[string]any{"type": "object", "properties": map[string]any{}}},
		{"name": "agent_team_list", "description": "列出当前用户可用的 OctoDeck Agent Team。", "inputSchema": map[string]any{"type": "object", "properties": map[string]any{}}},
		{"name": "agent_team_get", "description": "读取指定 OctoDeck Agent Team。", "inputSchema": map[string]any{"type": "object", "properties": map[string]any{"team_id": stringProp("Agent Team ID")}, "required": []string{"team_id"}}},
		{"name": "agent_team_run", "description": "启动一个 OctoDeck Agent Team 运行。", "inputSchema": map[string]any{"type": "object", "properties": map[string]any{"team_id": stringProp("Agent Team ID"), "prompt": stringProp("任务目标"), "runner_agent_id": stringProp("默认 Runner / Agent 后端 ID"), "role_assignments": map[string]any{"type": "object"}, "max_feedback_iterations": map[string]any{"type": "number"}}, "required": []string{"team_id", "prompt"}}},
		{"name": "agent_team_get_run", "description": "读取 Agent Team Run 状态。", "inputSchema": map[string]any{"type": "object", "properties": map[string]any{"run_id": stringProp("Agent Team Run ID")}, "required": []string{"run_id"}}},
		{"name": "agent_team_decide_approval", "description": "批准或拒绝 Agent Team Run 审批。", "inputSchema": map[string]any{"type": "object", "properties": map[string]any{"run_id": stringProp("Agent Team Run ID"), "approval_id": stringProp("Approval ID"), "decision": map[string]any{"type": "string", "enum": []string{"approved", "rejected"}}}, "required": []string{"run_id", "approval_id", "decision"}}},
		{"name": "agent_team_cancel_run", "description": "取消 Agent Team Run。", "inputSchema": map[string]any{"type": "object", "properties": map[string]any{"run_id": stringProp("Agent Team Run ID")}, "required": []string{"run_id"}}},
	}
}

func callAgentTeamHTTPTool(cfg *Config, toolName string, args map[string]any) (map[string]any, error) {
	body := map[string]any{}
	for k, v := range args {
		body[k] = v
	}
	switch toolName {
	case "repo_knowledge_list":
		body["operation"] = "list_repos"
	case "repo_knowledge_status":
		body["operation"] = "status"
		body["repoId"] = body["repo_id"]
	case "repo_knowledge_search":
		body["operation"] = "search"
		body["repoId"] = body["repo_id"]
		body["pathPrefix"] = body["path_prefix"]
		body["includeRelated"] = body["include_related"]
	case "repo_knowledge_list_chunks":
		body["operation"] = "list_chunks"
		body["repoId"] = body["repo_id"]
		body["pathPrefix"] = body["path_prefix"]
	case "repo_knowledge_get_chunk":
		body["operation"] = "get_chunk"
		body["chunkId"] = body["chunk_id"]
	case "repo_knowledge_graph":
		body["operation"] = "graph"
		body["repoId"] = body["repo_id"]
		body["edgeKind"] = body["edge_kind"]
	case "repo_knowledge_related":
		body["operation"] = "related"
		body["repoId"] = body["repo_id"]
		body["chunkId"] = body["chunk_id"]
	case "repo_knowledge_context":
		body["operation"] = "context"
		body["repoId"] = body["repo_id"]
		body["chunkId"] = body["chunk_id"]
	case "repo_knowledge_plugins":
		body["operation"] = "plugins"
	case "repo_knowledge_search_backends":
		body["operation"] = "search_backends"
	case "agent_team_list":
		body["operation"] = "list_teams"
	case "agent_team_get":
		body["operation"] = "get_team"
		body["teamId"] = body["team_id"]
	case "agent_team_run":
		body["operation"] = "run_team"
		body["teamId"] = body["team_id"]
		body["runnerAgentId"] = body["runner_agent_id"]
		body["roleAssignments"] = body["role_assignments"]
		body["maxFeedbackIterations"] = body["max_feedback_iterations"]
	case "agent_team_get_run":
		body["operation"] = "get_run"
		body["runId"] = body["run_id"]
	case "agent_team_decide_approval":
		body["operation"] = "decide_approval"
		body["runId"] = body["run_id"]
		body["approvalId"] = body["approval_id"]
	case "agent_team_cancel_run":
		body["operation"] = "cancel_run"
		body["runId"] = body["run_id"]
	default:
		return nil, fmt.Errorf("unsupported tool: %s", toolName)
	}
	data, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	url := strings.TrimRight(cfg.Server, "/") + "/api/agent-link/agent-team-tool"
	isRepoKnowledgeTool := strings.HasPrefix(toolName, "repo_knowledge_")
	if isRepoKnowledgeTool {
		url = strings.TrimRight(cfg.Server, "/") + "/api/repo-knowledge/tool"
	}
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if isRepoKnowledgeTool {
		secret := strings.TrimSpace(os.Getenv("OCTODECK_AGENT_TOOL_TOKEN"))
		if secret == "" {
			return nil, errors.New("OCTODECK_AGENT_TOOL_TOKEN is required for repo knowledge tools")
		}
		req.Header.Set("Authorization", "Bearer "+secret)
	} else {
		req.Header.Set("X-Link-Token", cfg.Token)
	}
	client := &http.Client{Timeout: 10 * time.Minute}
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	var parsed map[string]any
	if err := json.NewDecoder(res.Body).Decode(&parsed); err != nil {
		return nil, err
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		if msg, ok := parsed["error"].(string); ok && msg != "" {
			return nil, errors.New(msg)
		}
		return nil, fmt.Errorf("octodeck mcp tool http %d", res.StatusCode)
	}
	return parsed, nil
}
