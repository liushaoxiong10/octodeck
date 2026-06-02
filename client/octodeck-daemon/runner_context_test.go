package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRunnerInjectsContextEnvAndStdin(t *testing.T) {
	dir := t.TempDir()
	script := filepath.Join(dir, "capture.py")
	out := filepath.Join(dir, "out.txt")
	if err := os.WriteFile(script, []byte("import os, sys\nopen(sys.argv[1], 'w').write(os.environ.get('OCTODECK_RUN_CONTEXT_JSON', '') + '\\n' + sys.stdin.read())\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	frames := make([]any, 0)
	pool := newRunnerPool(1)
	r := newRunner(&Config{AllowedBinaries: []string{"/usr/bin/python3"}, TaskDir: filepath.Join(dir, "task")}, pool, func(frame any) error {
		frames = append(frames, frame)
		return nil
	})
	if !pool.reserve("run-1") {
		t.Fatal("failed to reserve run")
	}
	r.spawn(context.Background(), &RunRequestFrame{
		RunID:          "run-1",
		Binary:         "/usr/bin/python3",
		Argv:           []string{script, out},
		Cwd:            dir,
		OutputProtocol: "plain-text",
		TimeoutMs:      int64(5 * time.Second / time.Millisecond),
		MaxOutputBytes: 4096,
		Context:        map[string]any{"backendId": "coco", "input": map[string]any{"prompt": "hello"}},
		StdinJSON:      "{\"prompt\":\"hello\"}",
	})

	data, err := os.ReadFile(out)
	if err != nil {
		t.Fatalf("%v; frames=%s", err, stringifyFrames(frames))
	}
	text := string(data)
	if !strings.Contains(text, "\"backendId\":\"coco\"") {
		t.Fatalf("context env missing: %s", text)
	}
	if !strings.Contains(text, "\"prompt\":\"hello\"") {
		t.Fatalf("stdin json missing: %s", text)
	}
}

func TestRunnerReplacesRemoteCwdPlaceholderInRepoContextEnv(t *testing.T) {
	dir := t.TempDir()
	script := filepath.Join(dir, "capture_repo.py")
	out := filepath.Join(dir, "out.txt")
	if err := os.WriteFile(script, []byte("import os, sys\nopen(sys.argv[1], 'w').write(os.environ.get('OCTODECK_RUN_CONTEXT_JSON', '') + '\\n' + os.environ.get('OCTODECK_REPO_CONTEXT_JSON', ''))\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	frames := make([]any, 0)
	pool := newRunnerPool(1)
	taskDir := filepath.Join(dir, "task")
	r := newRunner(&Config{AllowedBinaries: []string{"/usr/bin/python3"}, TaskDir: taskDir}, pool, func(frame any) error {
		frames = append(frames, frame)
		return nil
	})
	if !pool.reserve("run-repo-env") {
		t.Fatal("failed to reserve run")
	}
	r.spawn(context.Background(), &RunRequestFrame{
		RunID:                "run-repo-env",
		Binary:               "/usr/bin/python3",
		Argv:                 []string{script, out},
		Cwd:                  "/server/groups/repo-demo",
		OutputProtocol:       "plain-text",
		TimeoutMs:            int64(5 * time.Second / time.Millisecond),
		MaxOutputBytes:       4096,
		RemoteCwdPlaceholder: "__OCTODECK_REMOTE_CWD__",
		Context: map[string]any{
			"cwd": "__OCTODECK_REMOTE_CWD__",
			"repo": map[string]any{
				"kind":   "git",
				"gitUrl": "https://github.com/acme/project.git",
				"cwd":    "__OCTODECK_REMOTE_CWD__",
			},
		},
	})

	data, err := os.ReadFile(out)
	if err != nil {
		t.Fatalf("%v; frames=%s", err, stringifyFrames(frames))
	}
	parts := strings.SplitN(string(data), "\n", 2)
	if len(parts) != 2 {
		t.Fatalf("expected two env json lines, got %q", string(data))
	}
	var runCtx struct {
		Cwd  string `json:"cwd"`
		Repo struct {
			Kind   string `json:"kind"`
			GitURL string `json:"gitUrl"`
			Cwd    string `json:"cwd"`
		} `json:"repo"`
	}
	if err := json.Unmarshal([]byte(parts[0]), &runCtx); err != nil {
		t.Fatal(err)
	}
	var repoCtx struct {
		Kind   string `json:"kind"`
		GitURL string `json:"gitUrl"`
		Cwd    string `json:"cwd"`
	}
	if err := json.Unmarshal([]byte(parts[1]), &repoCtx); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(runCtx.Cwd, taskDir) || runCtx.Repo.Cwd != runCtx.Cwd || repoCtx.Cwd != runCtx.Cwd {
		t.Fatalf("expected placeholders replaced with task cwd, run=%#v repo=%#v", runCtx, repoCtx)
	}
	if runCtx.Repo.GitURL != "https://github.com/acme/project.git" || repoCtx.GitURL != runCtx.Repo.GitURL {
		t.Fatalf("repo metadata missing: run=%#v repo=%#v", runCtx, repoCtx)
	}
}

func TestResolveWorkspaceRepoUsesWorktreeForGitDirectory(t *testing.T) {
	root := t.TempDir()
	repo := filepath.Join(root, "source")
	mustRun(t, root, "git", "init", repo)
	mustRun(t, repo, "git", "config", "user.email", "test@example.com")
	mustRun(t, repo, "git", "config", "user.name", "Test")
	if err := os.WriteFile(filepath.Join(repo, "README.md"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	mustRun(t, repo, "git", "add", "README.md")
	mustRun(t, repo, "git", "commit", "-m", "init")

	cfg := &Config{WorkspaceDir: filepath.Join(root, "workspace")}
	cwd, err := resolveWorkspaceRepo(context.Background(), cfg, &WorkspaceRepoSpec{Kind: "device_path", DevicePath: repo, GroupFolder: "demo"})
	if err != nil {
		t.Fatal(err)
	}
	if cwd == repo {
		t.Fatalf("expected git directory to use an isolated worktree, got source repo: %s", cwd)
	}
	if filepath.Dir(cwd) != cfg.WorkspaceDir {
		t.Fatalf("expected worktree under workspace root %q, got %s", cfg.WorkspaceDir, cwd)
	}
	if _, err := os.Stat(filepath.Join(cwd, "README.md")); err != nil {
		t.Fatalf("expected worktree to contain repository files: %v", err)
	}
}

func TestResolveWorkspaceRepoUsesSharedReposAndFreshWorkspace(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source")
	mustRun(t, root, "git", "init", source)
	mustRun(t, source, "git", "branch", "-M", "main")
	mustRun(t, source, "git", "config", "user.email", "test@example.com")
	mustRun(t, source, "git", "config", "user.name", "Test")
	if err := os.WriteFile(filepath.Join(source, "README.md"), []byte("v1"), 0o644); err != nil {
		t.Fatal(err)
	}
	mustRun(t, source, "git", "add", "README.md")
	mustRun(t, source, "git", "commit", "-m", "v1")

	cfg := &Config{WorkspaceDir: filepath.Join(root, "workspace")}
	first, err := resolveWorkspaceRepo(context.Background(), cfg, &WorkspaceRepoSpec{Kind: "git", GitURL: source, GroupFolder: "demo"})
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Dir(first) != cfg.WorkspaceDir {
		t.Fatalf("expected worktree under workspace root %q, got %s", cfg.WorkspaceDir, first)
	}
	reposRoot := filepath.Join(root, "repos")
	entries, err := os.ReadDir(reposRoot)
	if err != nil || len(entries) != 1 {
		t.Fatalf("expected one shared repo under %s, entries=%v err=%v", reposRoot, entries, err)
	}

	if err := os.WriteFile(filepath.Join(source, "README.md"), []byte("v2"), 0o644); err != nil {
		t.Fatal(err)
	}
	mustRun(t, source, "git", "commit", "-am", "v2")
	second, err := resolveWorkspaceRepo(context.Background(), cfg, &WorkspaceRepoSpec{Kind: "git", GitURL: source, GroupFolder: "demo"})
	if err != nil {
		t.Fatal(err)
	}
	if second == first {
		t.Fatalf("expected a fresh random workspace, got reused path %s", second)
	}
	data, err := os.ReadFile(filepath.Join(second, "README.md"))
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "v2" {
		t.Fatalf("expected synced main content v2, got %q", string(data))
	}
}

func TestResolveWorkspaceRepoUsesDeviceDirectoryWhenNotGit(t *testing.T) {
	dir := t.TempDir()
	realDir, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatal(err)
	}
	cwd, err := resolveWorkspaceRepo(context.Background(), &Config{}, &WorkspaceRepoSpec{Kind: "device_path", DevicePath: dir, GroupFolder: "demo"})
	if err != nil {
		t.Fatal(err)
	}
	if cwd != realDir {
		t.Fatalf("expected non-git device directory to be used directly, got %s", cwd)
	}
}

func TestDefaultRunCwdUsesOctodeckTaskDir(t *testing.T) {
	root := t.TempDir()
	cwd, err := defaultRunCwd(&Config{WorkspaceDir: filepath.Join(root, "workspace")}, "/server/groups/demo")
	if err != nil {
		t.Fatal(err)
	}
	expectedParent := filepath.Join(root, "task")
	if filepath.Dir(cwd) != expectedParent {
		t.Fatalf("expected default cwd under %q, got %q", expectedParent, cwd)
	}
	if !strings.HasPrefix(filepath.Base(cwd), "demo-") {
		t.Fatalf("expected random task directory to keep safe prefix demo-, got %q", filepath.Base(cwd))
	}
	if _, err := os.Stat(cwd); err != nil {
		t.Fatalf("expected default cwd to be created: %v", err)
	}
}

func TestResolveWorkspaceRepoRejectsDeviceDirectoryOutsideAllowedRoots(t *testing.T) {
	allowed := t.TempDir()
	outside := t.TempDir()
	_, err := resolveWorkspaceRepo(context.Background(), &Config{AllowedRoots: []string{allowed}}, &WorkspaceRepoSpec{Kind: "device_path", DevicePath: outside, GroupFolder: "demo"})
	if err == nil || !strings.Contains(err.Error(), "outside allowed roots") {
		t.Fatalf("expected outside allowed roots error, got %v", err)
	}
}

func TestReplaceArgvPlaceholderUsesResolvedRemoteCwd(t *testing.T) {
	argv := replaceArgvPlaceholder([]string{"exec", "--cwd=__OCTODECK_REMOTE_CWD__"}, "__OCTODECK_REMOTE_CWD__", "/tmp/worktree")
	if got := strings.Join(argv, " "); got != "exec --cwd=/tmp/worktree" {
		t.Fatalf("unexpected argv: %s", got)
	}
}

func TestPrepareAgentTeamMCPConfigWritesClaudeConfigAndReplacesPlaceholder(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(configPath, []byte(`{"server":"https://octodeck.example","token":"link-token","linkId":"cl_123"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OCTODECK_DAEMON_CONFIG", configPath)
	originalArgs := os.Args
	os.Args = []string{"octodeck-daemon"}
	t.Cleanup(func() { os.Args = originalArgs })

	cfg := &Config{Server: "https://octodeck.example", Token: "link-token", LinkID: "cl_123"}
	argv, err := prepareAgentTeamMCPConfig(cfg, []string{"-p", "hello", "--mcp-config", agentTeamMCPConfigPlaceholder}, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(argv) != 4 || argv[3] == agentTeamMCPConfigPlaceholder {
		t.Fatalf("placeholder was not replaced: %#v", argv)
	}

	data, err := os.ReadFile(argv[3])
	if err != nil {
		t.Fatal(err)
	}
	var parsed struct {
		MCPServers map[string]struct {
			Type    string            `json:"type"`
			Command string            `json:"command"`
			Args    []string          `json:"args"`
			Env     map[string]string `json:"env"`
			Timeout int               `json:"timeout"`
		} `json:"mcpServers"`
	}
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("invalid mcp config json: %v\n%s", err, string(data))
	}
	server := parsed.MCPServers["octodeck_agent_team"]
	if server.Type != "stdio" {
		t.Fatalf("unexpected MCP transport type: %q", server.Type)
	}
	if !filepath.IsAbs(server.Command) {
		t.Fatalf("MCP server command must be absolute so Claude can spawn it reliably, got %q in %s", server.Command, string(data))
	}
	if strings.Join(server.Args, " ") != "mcp-agent-team --config "+configPath {
		t.Fatalf("unexpected MCP args: %#v", server.Args)
	}
	if server.Env["OCTODECK_AGENT_TEAM_MCP"] != "1" {
		t.Fatalf("missing MCP env marker: %#v", server.Env)
	}
	if server.Timeout != 30 {
		t.Fatalf("unexpected MCP timeout: %d", server.Timeout)
	}
}

func TestPrepareAgentTeamMCPConfigWritesTraeProjectConfigAndRemovesMarker(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(configPath, []byte(`{"server":"https://octodeck.example","token":"link-token","linkId":"cl_123"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OCTODECK_DAEMON_CONFIG", configPath)
	originalArgs := os.Args
	os.Args = []string{"octodeck-daemon"}
	t.Cleanup(func() { os.Args = originalArgs })

	cwd := t.TempDir()
	cfg := &Config{Server: "https://octodeck.example", Token: "link-token", LinkID: "cl_123"}
	argv, err := prepareAgentTeamMCPConfig(cfg, []string{"-p", "hello", agentTeamMCPProjectConfigMarker}, cwd)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(strings.Join(argv, " "), agentTeamMCPProjectConfigMarker) {
		t.Fatalf("marker was not removed: %#v", argv)
	}

	data, err := os.ReadFile(filepath.Join(cwd, ".trae", "mcp.json"))
	if err != nil {
		t.Fatal(err)
	}
	var parsed struct {
		MCPServers map[string]struct {
			Type    string            `json:"type"`
			Command string            `json:"command"`
			Args    []string          `json:"args"`
			Env     map[string]string `json:"env"`
			Timeout int               `json:"timeout"`
		} `json:"mcpServers"`
	}
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("invalid Trae MCP config json: %v\n%s", err, string(data))
	}
	server := parsed.MCPServers["octodeck_agent_team"]
	if server.Type != "stdio" {
		t.Fatalf("unexpected MCP transport type: %q", server.Type)
	}
	if strings.Join(server.Args, " ") != "mcp-agent-team --config "+configPath {
		t.Fatalf("unexpected MCP args: %#v", server.Args)
	}
	if server.Timeout != 30 {
		t.Fatalf("unexpected MCP timeout: %d", server.Timeout)
	}
}

func TestReadAndWriteMCPMessageSupportsNDJSON(t *testing.T) {
	input := `{"jsonrpc":"2.0","id":1,"method":"initialize"}` + "\n"
	body, framed, err := readMCPMessage(bufio.NewReader(strings.NewReader(input)))
	if err != nil {
		t.Fatal(err)
	}
	if framed {
		t.Fatal("expected newline-delimited JSON transport")
	}
	if !bytes.Equal(body, []byte(`{"jsonrpc":"2.0","id":1,"method":"initialize"}`)) {
		t.Fatalf("unexpected body: %s", body)
	}

	var out bytes.Buffer
	if err := writeMCPMessage(&out, map[string]any{"jsonrpc": "2.0", "id": 1, "result": map[string]any{}}, framed); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out.String(), "Content-Length") || !strings.HasSuffix(out.String(), "\n") {
		t.Fatalf("expected NDJSON response, got %q", out.String())
	}
}

func TestReadAndWriteMCPMessageSupportsContentLengthFrames(t *testing.T) {
	input := "Content-Length: 46\r\n\r\n" + `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`
	body, framed, err := readMCPMessage(bufio.NewReader(strings.NewReader(input)))
	if err != nil {
		t.Fatal(err)
	}
	if !framed {
		t.Fatal("expected Content-Length framed transport")
	}
	if !bytes.Equal(body, []byte(`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`)) {
		t.Fatalf("unexpected body: %s", body)
	}

	var out bytes.Buffer
	if err := writeMCPMessage(&out, map[string]any{"jsonrpc": "2.0", "id": 2, "result": map[string]any{}}, framed); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(out.String(), "Content-Length: ") || !strings.Contains(out.String(), "\r\n\r\n") {
		t.Fatalf("expected Content-Length response, got %q", out.String())
	}
}

func stringifyFrames(frames []any) string {
	parts := make([]string, 0, len(frames))
	for _, frame := range frames {
		switch f := frame.(type) {
		case *RunResultFrame:
			parts = append(parts, "RunResult exit="+itoaPtr(f.ExitCode))
		case *RunEventFrame:
			parts = append(parts, "RunEvent "+f.Stream+":"+f.Data)
		case *ErrorFrame:
			parts = append(parts, "Error "+f.Code+":"+f.Message)
		default:
			parts = append(parts, "unknown")
		}
	}
	return strings.Join(parts, ";")
}

func itoaPtr(p *int) string {
	if p == nil {
		return "nil"
	}
	return fmt.Sprintf("%d", *p)
}

func mustRun(t *testing.T, cwd string, name string, args ...string) {
	t.Helper()
	cmd := exec.Command(name, args...)
	cmd.Dir = cwd
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("%s %v failed: %v\n%s", name, args, err, string(out))
	}
}
