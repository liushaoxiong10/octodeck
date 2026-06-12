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

func TestBuildEnvDoesNotOverrideClaudeConfigDir(t *testing.T) {
	home := t.TempDir()
	oldClaudeConfigDir, hadClaudeConfigDir := os.LookupEnv("CLAUDE_CONFIG_DIR")
	if err := os.Unsetenv("CLAUDE_CONFIG_DIR"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if hadClaudeConfigDir {
			_ = os.Setenv("CLAUDE_CONFIG_DIR", oldClaudeConfigDir)
		} else {
			_ = os.Unsetenv("CLAUDE_CONFIG_DIR")
		}
	})
	t.Setenv("HOME", home)

	env := envSliceToMap(buildEnv(&Config{SessionDir: t.TempDir()}, nil, map[string]any{"group": map[string]any{"folder": "device-claude"}}))
	if got := env["HOME"]; got != home {
		t.Fatalf("expected HOME to be inherited so Claude can load local login state, got %q", got)
	}
	if got, ok := env["CLAUDE_CONFIG_DIR"]; ok {
		t.Fatalf("CLAUDE_CONFIG_DIR must not be session-isolated because it hides local Claude login config, got %q", got)
	}
	if got := env["CODEX_HOME"]; got == "" {
		t.Fatalf("expected non-Claude provider homes to remain session-isolated: %#v", env)
	}
}

func envSliceToMap(env []string) map[string]string {
	out := make(map[string]string, len(env))
	for _, item := range env {
		key, value, ok := strings.Cut(item, "=")
		if !ok {
			continue
		}
		out[key] = value
	}
	return out
}

func TestNormalizeAgentJSONLineCapturesToolEvents(t *testing.T) {
	callLine := `{"type":"assistant","session_id":"sess-1","message":{"content":[{"type":"tool_use","id":"tool-1","name":"Bash","input":{"command":"pwd"}}]}}`
	eventType, text, sessionID, payload := normalizeAgentJSONLine(callLine)
	if eventType != "tool_call" {
		t.Fatalf("expected tool_call, got %s", eventType)
	}
	if text != "" {
		t.Fatalf("expected empty text for tool_call, got %q", text)
	}
	if sessionID != "sess-1" {
		t.Fatalf("expected session sess-1, got %q", sessionID)
	}
	if payload == nil {
		t.Fatal("expected raw payload for tool_call")
	}

	resultLine := `{"type":"user","session_id":"sess-1","message":{"content":[{"type":"tool_result","tool_use_id":"tool-1","content":"/repo"}]}}`
	eventType, text, sessionID, payload = normalizeAgentJSONLine(resultLine)
	if eventType != "tool_result" {
		t.Fatalf("expected tool_result, got %s", eventType)
	}
	if text != "" {
		t.Fatalf("expected empty text for tool_result, got %q", text)
	}
	if sessionID != "sess-1" {
		t.Fatalf("expected session sess-1, got %q", sessionID)
	}
	if payload == nil {
		t.Fatal("expected raw payload for tool_result")
	}

	startLine := `{"type":"tool_use_start","session_id":"sess-1","id":"tool-2","name":"Read","input":{"file_path":"README.md"}}`
	eventType, text, sessionID, payload = normalizeAgentJSONLine(startLine)
	if eventType != "tool_call" || text != "" || sessionID != "sess-1" || payload == nil {
		t.Fatalf("expected direct tool_use_start to normalize as tool_call, got type=%s text=%q session=%q payload=%v", eventType, text, sessionID, payload)
	}

	endLine := `{"type":"tool_use_end","session_id":"sess-1","tool_use_id":"tool-2","content":"ok"}`
	eventType, text, sessionID, payload = normalizeAgentJSONLine(endLine)
	if eventType != "tool_result" || text != "" || sessionID != "sess-1" || payload == nil {
		t.Fatalf("expected direct tool_use_end to normalize as tool_result, got type=%s text=%q session=%q payload=%v", eventType, text, sessionID, payload)
	}
}

func TestNormalizeAgentJSONLineCapturesReasoningEvents(t *testing.T) {
	lines := []string{
		`{"type":"reasoning","session_id":"sess-1","reasoning":"需要先检查文件"}`,
		`{"type":"stream_event","session_id":"sess-1","delta":{"type":"reasoning_delta","reasoning":"然后修改实现"}}`,
		`{"type":"assistant","session_id":"sess-1","message":{"content":[{"type":"reasoning","reasoning":"最后验证"}]}}`,
	}
	for _, line := range lines {
		eventType, text, sessionID, payload := normalizeAgentJSONLine(line)
		if eventType != "thinking_delta" {
			t.Fatalf("expected thinking_delta, got %s for %s", eventType, line)
		}
		if text == "" {
			t.Fatalf("expected reasoning text for %s", line)
		}
		if sessionID != "sess-1" {
			t.Fatalf("expected session sess-1, got %q", sessionID)
		}
		if payload == nil {
			t.Fatal("expected raw payload for reasoning")
		}
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
	if entries[0].Name() != "source" {
		t.Fatalf("expected shared repo cache to use project name source, got %q", entries[0].Name())
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

func TestResolveWorkspaceRepoUsesConfiguredMainBranch(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source")
	mustRun(t, root, "git", "init", source)
	mustRun(t, source, "git", "branch", "-M", "main")
	mustRun(t, source, "git", "config", "user.email", "test@example.com")
	mustRun(t, source, "git", "config", "user.name", "Test")
	if err := os.WriteFile(filepath.Join(source, "README.md"), []byte("main"), 0o644); err != nil {
		t.Fatal(err)
	}
	mustRun(t, source, "git", "add", "README.md")
	mustRun(t, source, "git", "commit", "-m", "main")
	mustRun(t, source, "git", "checkout", "-b", "develop")
	if err := os.WriteFile(filepath.Join(source, "README.md"), []byte("develop"), 0o644); err != nil {
		t.Fatal(err)
	}
	mustRun(t, source, "git", "commit", "-am", "develop")
	mustRun(t, source, "git", "checkout", "main")

	cfg := &Config{WorkspaceDir: filepath.Join(root, "workspace")}
	cwd, err := resolveWorkspaceRepo(context.Background(), cfg, &WorkspaceRepoSpec{Kind: "git", GitURL: source, MainBranch: "develop", GroupFolder: "demo"})
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(cwd, "README.md"))
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "develop" {
		t.Fatalf("expected configured develop branch content, got %q", string(data))
	}
}

func TestResolveWorkspaceRepoCreatesStableGitWorktreeInsideAgentSession(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source")
	mustRun(t, root, "git", "init", source)
	mustRun(t, source, "git", "branch", "-M", "main")
	mustRun(t, source, "git", "config", "user.email", "test@example.com")
	mustRun(t, source, "git", "config", "user.name", "Test")
	if err := os.WriteFile(filepath.Join(source, "README.md"), []byte("session-v1"), 0o644); err != nil {
		t.Fatal(err)
	}
	mustRun(t, source, "git", "add", "README.md")
	mustRun(t, source, "git", "commit", "-m", "v1")

	cfg := &Config{WorkspaceDir: filepath.Join(root, "workspace")}
	spec := &WorkspaceRepoSpec{
		Kind:        "git",
		GitURL:      source,
		GroupFolder: "demo",
		AgentID:     "agent-abc",
		Scope:       "session",
		ScopeID:     "sess-123",
	}
	first, err := resolveWorkspaceRepo(context.Background(), cfg, spec)
	if err != nil {
		t.Fatal(err)
	}
	expected := filepath.Join(cfg.WorkspaceDir, "demo", "sessions", "sess-123", "source")
	if first != expected {
		t.Fatalf("expected session worktree %q, got %q", expected, first)
	}
	data, err := os.ReadFile(filepath.Join(first, "README.md"))
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "session-v1" {
		t.Fatalf("expected initial main content, got %q", string(data))
	}

	second, err := resolveWorkspaceRepo(context.Background(), cfg, spec)
	if err != nil {
		t.Fatal(err)
	}
	if second != first {
		t.Fatalf("expected existing session worktree to be reused, first=%q second=%q", first, second)
	}
}

func TestResolveWorkspaceRepoUsesProvidedRepoNameForSessionWorktree(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "origin-project")
	mustRun(t, root, "git", "init", source)
	mustRun(t, source, "git", "branch", "-M", "main")
	mustRun(t, source, "git", "config", "user.email", "test@example.com")
	mustRun(t, source, "git", "config", "user.name", "Test")
	if err := os.WriteFile(filepath.Join(source, "README.md"), []byte("named"), 0o644); err != nil {
		t.Fatal(err)
	}
	mustRun(t, source, "git", "add", "README.md")
	mustRun(t, source, "git", "commit", "-m", "init")

	cfg := &Config{WorkspaceDir: filepath.Join(root, "workspace")}
	spec := &WorkspaceRepoSpec{
		Kind:        "git",
		Name:        "kunlun",
		GitURL:      source,
		GroupFolder: "demo",
		AgentID:     "agent-abc",
		Scope:       "session",
		ScopeID:     "sess-123",
	}
	cwd, err := resolveWorkspaceRepo(context.Background(), cfg, spec)
	if err != nil {
		t.Fatal(err)
	}
	expected := filepath.Join(cfg.WorkspaceDir, "demo", "sessions", "sess-123", "kunlun")
	if cwd != expected {
		t.Fatalf("expected named session worktree %q, got %q", expected, cwd)
	}
	if _, err := os.Stat(filepath.Join(cwd, "README.md")); err != nil {
		t.Fatalf("expected named worktree to contain repository files: %v", err)
	}
}

func TestAgentRuntimeResolveCwdKeepsSessionRootForSingleRepo(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "origin-project")
	mustRun(t, root, "git", "init", source)
	mustRun(t, source, "git", "branch", "-M", "main")
	mustRun(t, source, "git", "config", "user.email", "test@example.com")
	mustRun(t, source, "git", "config", "user.name", "Test")
	if err := os.WriteFile(filepath.Join(source, "README.md"), []byte("runtime"), 0o644); err != nil {
		t.Fatal(err)
	}
	mustRun(t, source, "git", "add", "README.md")
	mustRun(t, source, "git", "commit", "-m", "init")

	cfg := &Config{WorkspaceDir: filepath.Join(root, "workspace")}
	rt := &agentRuntimeProcess{cfg: cfg}
	req := &AgentRunRequestFrame{
		AgentID: "agent-abc",
		Workspace: &AgentRunWorkspace{
			Folder:  "demo",
			AgentID: "agent-abc",
			Scope:   "session",
			ScopeID: "sess-123",
			Repos: []*WorkspaceRepoSpec{{
				Kind:   "git",
				Name:   "kunlun",
				GitURL: source,
			}},
		},
		Context: map[string]any{"group": map[string]any{"folder": "demo"}},
	}

	cwd, err := rt.resolveCwd(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	expectedCwd := filepath.Join(cfg.WorkspaceDir, "demo", "sessions", "sess-123")
	if cwd != expectedCwd {
		t.Fatalf("expected session root cwd %q, got %q", expectedCwd, cwd)
	}
	if _, err := os.Stat(filepath.Join(cwd, "kunlun", "README.md")); err != nil {
		t.Fatalf("expected repo mounted directly under session root: %v", err)
	}
	expectedShared := filepath.Join(cfg.WorkspaceDir, "demo", "shared")
	if _, err := os.Stat(expectedShared); err != nil {
		t.Fatalf("expected workspace shared dir: %v", err)
	}
	if shared := workspaceSharedDirFromRunContext(req.Context); shared != expectedShared {
		t.Fatalf("expected shared dir in run context %q, got %q", expectedShared, shared)
	}
}

func TestAgentRuntimeResolveCwdUsesTopLevelWorkspaceRepos(t *testing.T) {
	root := t.TempDir()
	makeRepo := func(name string) string {
		source := filepath.Join(root, name)
		mustRun(t, root, "git", "init", source)
		mustRun(t, source, "git", "branch", "-M", "main")
		mustRun(t, source, "git", "config", "user.email", "test@example.com")
		mustRun(t, source, "git", "config", "user.name", "Test")
		if err := os.WriteFile(filepath.Join(source, "README.md"), []byte(name), 0o644); err != nil {
			t.Fatal(err)
		}
		mustRun(t, source, "git", "add", "README.md")
		mustRun(t, source, "git", "commit", "-m", "init")
		return source
	}
	repoA := makeRepo("origin-a")
	repoB := makeRepo("origin-b")

	cfg := &Config{WorkspaceDir: filepath.Join(root, "workspace")}
	rt := &agentRuntimeProcess{cfg: cfg}
	req := &AgentRunRequestFrame{
		AgentID: "agent-abc",
		Workspace: &AgentRunWorkspace{
			Kind:    "workspace",
			Folder:  "demo",
			AgentID: "agent-abc",
			Scope:   "session",
			ScopeID: "sess-123",
		},
		WorkspaceRepos: []*WorkspaceRepoSpec{
			{Kind: "git", Name: "repo-a", GitURL: repoA, GroupFolder: "demo", AgentID: "agent-abc", Scope: "session", ScopeID: "sess-123"},
			{Kind: "git", Name: "repo-b", GitURL: repoB, GroupFolder: "demo", AgentID: "agent-abc", Scope: "session", ScopeID: "sess-123"},
		},
		Context: map[string]any{"group": map[string]any{"folder": "demo"}},
	}

	cwd, err := rt.resolveCwd(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	expectedCwd := filepath.Join(cfg.WorkspaceDir, "demo", "sessions", "sess-123")
	if cwd != expectedCwd {
		t.Fatalf("expected session root cwd %q, got %q", expectedCwd, cwd)
	}
	for _, name := range []string{"repo-a", "repo-b"} {
		if _, err := os.Stat(filepath.Join(cwd, name, "README.md")); err != nil {
			t.Fatalf("expected %s mounted directly under session root: %v", name, err)
		}
	}
}

func TestAgentRuntimeResolveCwdDecouplesWorkspaceScopeFromNativeSession(t *testing.T) {
	root := t.TempDir()
	cfg := &Config{WorkspaceDir: filepath.Join(root, "workspace")}
	rt := &agentRuntimeProcess{cfg: cfg}

	first := &AgentRunRequestFrame{
		AgentID: "traecli-acp",
		Workspace: &AgentRunWorkspace{
			Kind:    "workspace",
			Folder:  "demo",
			AgentID: "traecli-acp",
			Scope:   "session",
			ScopeID: "conversation-001",
		},
		Context: map[string]any{"group": map[string]any{"folder": "demo"}},
	}
	firstCwd, err := rt.resolveCwd(context.Background(), first)
	if err != nil {
		t.Fatal(err)
	}

	second := &AgentRunRequestFrame{
		AgentID: "traecli-acp",
		Workspace: &AgentRunWorkspace{
			Kind:    "workspace",
			Folder:  "demo",
			AgentID: "traecli-acp",
			Scope:   "session",
			ScopeID: "conversation-001",
		},
		Input:   AgentRunInput{SessionID: "native-session-001"},
		Context: map[string]any{"group": map[string]any{"folder": "demo"}},
	}
	secondCwd, err := rt.resolveCwd(context.Background(), second)
	if err != nil {
		t.Fatal(err)
	}

	expected := filepath.Join(cfg.WorkspaceDir, "demo", "sessions", "conversation-001")
	if firstCwd != expected || secondCwd != expected {
		t.Fatalf("expected stable daemon workspace cwd %q, got first=%q second=%q", expected, firstCwd, secondCwd)
	}
	if second.Input.SessionID != "native-session-001" {
		t.Fatalf("native session id should remain available for ACP resume, got %q", second.Input.SessionID)
	}
}

func TestAgentRuntimeResolveCwdUsesWorkspaceIDAndChatID(t *testing.T) {
	root := t.TempDir()
	cfg := &Config{WorkspaceDir: filepath.Join(root, "workspace")}
	rt := &agentRuntimeProcess{cfg: cfg}
	req := &AgentRunRequestFrame{
		AgentID: "traecli-acp",
		Workspace: &AgentRunWorkspace{
			Kind:    "workspace",
			Folder:  "legacy-group-folder",
			AgentID: "traecli-acp",
			Scope:   "session",
			ScopeID: "workspace-scope-from-server",
		},
		Input: AgentRunInput{Metadata: map[string]any{
			"workspaceId": "workspace-alpha",
			"chatId":      "chat-beta",
		}},
		Context: map[string]any{"group": map[string]any{"folder": "legacy-group-folder"}},
	}

	cwd, err := rt.resolveCwd(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	expected := filepath.Join(cfg.WorkspaceDir, "legacy-group-folder", "sessions", "chat-beta")
	if cwd != expected {
		t.Fatalf("expected workspace/chat scoped cwd %q, got %q", expected, cwd)
	}
	if req.Workspace.Folder != "legacy-group-folder" || req.Workspace.ScopeID != "chat-beta" {
		t.Fatalf("expected workspace folder to stay stable and session scope to use chat-id, got folder=%q scopeId=%q", req.Workspace.Folder, req.Workspace.ScopeID)
	}
}

func TestRunRequestWorkspaceScopeDecouplesFromNativeSession(t *testing.T) {
	root := t.TempDir()
	cfg := &Config{WorkspaceDir: filepath.Join(root, "workspace")}

	first := &RunRequestFrame{
		BackendID: "mac-traecli",
		WorkspaceRepo: &WorkspaceRepoSpec{
			Kind:        "workspace",
			GroupFolder: "demo",
			AgentID:     "mac-traecli",
			Scope:       "session",
			ScopeID:     "conversation-001",
		},
	}
	normalizeRunRequestWorkspaceScopes(first)
	firstCwd, err := resolveWorkspaceReposRunCwd(context.Background(), cfg, []*WorkspaceRepoSpec{first.WorkspaceRepo})
	if err != nil {
		t.Fatal(err)
	}

	second := &RunRequestFrame{
		BackendID: "mac-traecli",
		WorkspaceRepo: &WorkspaceRepoSpec{
			Kind:        "workspace",
			GroupFolder: "demo",
			AgentID:     "mac-traecli",
			Scope:       "session",
			ScopeID:     "conversation-001",
		},
	}
	normalizeRunRequestWorkspaceScopes(second)
	secondCwd, err := resolveWorkspaceReposRunCwd(context.Background(), cfg, []*WorkspaceRepoSpec{second.WorkspaceRepo})
	if err != nil {
		t.Fatal(err)
	}

	expected := filepath.Join(cfg.WorkspaceDir, "demo", "sessions", "conversation-001")
	if firstCwd != expected || secondCwd != expected {
		t.Fatalf("expected stable legacy device CLI workspace cwd %q, got first=%q second=%q", expected, firstCwd, secondCwd)
	}
	if second.WorkspaceRepo.ScopeID != "conversation-001" {
		t.Fatalf("expected native session id to be decoupled from workspace scope, got %q", second.WorkspaceRepo.ScopeID)
	}
}

func TestRunRequestWorkspaceScopePreservesConversationScopedID(t *testing.T) {
	root := t.TempDir()
	cfg := &Config{WorkspaceDir: filepath.Join(root, "workspace")}

	req := &RunRequestFrame{
		BackendID: "mac-traecli",
		WorkspaceRepo: &WorkspaceRepoSpec{
			Kind:        "workspace",
			GroupFolder: "demo",
			AgentID:     "mac-traecli",
			Scope:       "session",
			ScopeID:     "33550d69-ed01-42ff-b4e5-23c4b3db1e20",
		},
	}
	normalizeRunRequestWorkspaceScopes(req)
	cwd, err := resolveWorkspaceReposRunCwd(context.Background(), cfg, []*WorkspaceRepoSpec{req.WorkspaceRepo})
	if err != nil {
		t.Fatal(err)
	}

	expected := filepath.Join(cfg.WorkspaceDir, "demo", "sessions", "33550d69-ed01-42ff-b4e5-23c4b3db1e20")
	if cwd != expected {
		t.Fatalf("expected daemon to preserve server conversation-scoped workspace cwd %q, got %q", expected, cwd)
	}
}

func TestResolveWorkspaceReposRunCwdKeepsSessionRootForSingleRepo(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "origin-project")
	mustRun(t, root, "git", "init", source)
	mustRun(t, source, "git", "branch", "-M", "main")
	mustRun(t, source, "git", "config", "user.email", "test@example.com")
	mustRun(t, source, "git", "config", "user.name", "Test")
	if err := os.WriteFile(filepath.Join(source, "README.md"), []byte("legacy-runtime"), 0o644); err != nil {
		t.Fatal(err)
	}
	mustRun(t, source, "git", "add", "README.md")
	mustRun(t, source, "git", "commit", "-m", "init")

	cfg := &Config{WorkspaceDir: filepath.Join(root, "workspace")}
	cwd, err := resolveWorkspaceReposRunCwd(context.Background(), cfg, []*WorkspaceRepoSpec{{
		Kind:        "git",
		Name:        "kunlun",
		GitURL:      source,
		GroupFolder: "demo",
		AgentID:     "agent-abc",
		Scope:       "session",
		ScopeID:     "sess-123",
	}})
	if err != nil {
		t.Fatal(err)
	}
	expectedCwd := filepath.Join(cfg.WorkspaceDir, "demo", "sessions", "sess-123")
	if cwd != expectedCwd {
		t.Fatalf("expected legacy run.request session root cwd %q, got %q", expectedCwd, cwd)
	}
	if _, err := os.Stat(filepath.Join(cwd, "kunlun", "README.md")); err != nil {
		t.Fatalf("expected repo mounted directly under session root: %v", err)
	}
}

func TestResolveWorkspaceReposRunCwdMountsMultipleReposUnderSessionRoot(t *testing.T) {
	root := t.TempDir()
	makeRepo := func(name string) string {
		source := filepath.Join(root, name)
		mustRun(t, root, "git", "init", source)
		mustRun(t, source, "git", "branch", "-M", "main")
		mustRun(t, source, "git", "config", "user.email", "test@example.com")
		mustRun(t, source, "git", "config", "user.name", "Test")
		if err := os.WriteFile(filepath.Join(source, "README.md"), []byte(name), 0o644); err != nil {
			t.Fatal(err)
		}
		mustRun(t, source, "git", "add", "README.md")
		mustRun(t, source, "git", "commit", "-m", "init")
		return source
	}
	repoA := makeRepo("origin-a")
	repoB := makeRepo("origin-b")

	cfg := &Config{WorkspaceDir: filepath.Join(root, "workspace")}
	cwd, err := resolveWorkspaceReposRunCwd(context.Background(), cfg, []*WorkspaceRepoSpec{
		{Kind: "git", Name: "repo-a", GitURL: repoA, GroupFolder: "demo", AgentID: "agent-abc", Scope: "session", ScopeID: "sess-123"},
		{Kind: "git", Name: "repo-b", GitURL: repoB, GroupFolder: "demo", AgentID: "agent-abc", Scope: "session", ScopeID: "sess-123"},
	})
	if err != nil {
		t.Fatal(err)
	}
	expectedCwd := filepath.Join(cfg.WorkspaceDir, "demo", "sessions", "sess-123")
	if cwd != expectedCwd {
		t.Fatalf("expected legacy run.request multi-repo session root cwd %q, got %q", expectedCwd, cwd)
	}
	for _, name := range []string{"repo-a", "repo-b"} {
		if _, err := os.Stat(filepath.Join(cwd, name, "README.md")); err != nil {
			t.Fatalf("expected %s mounted directly under session root: %v", name, err)
		}
	}
}

func TestResolveWorkspaceReposRunCwdUsesSessionRootForWorkspaceOnly(t *testing.T) {
	root := t.TempDir()
	cfg := &Config{WorkspaceDir: filepath.Join(root, "workspace")}
	cwd, err := resolveWorkspaceReposRunCwd(context.Background(), cfg, []*WorkspaceRepoSpec{{
		Kind:        "workspace",
		GroupFolder: "demo",
		AgentID:     "agent-abc",
		Scope:       "session",
		ScopeID:     "sess-123",
	}})
	if err != nil {
		t.Fatal(err)
	}
	expectedCwd := filepath.Join(cfg.WorkspaceDir, "demo", "sessions", "sess-123")
	if cwd != expectedCwd {
		t.Fatalf("expected workspace-only session root cwd %q, got %q", expectedCwd, cwd)
	}
	if _, err := os.Stat(filepath.Join(cwd, "repo")); !os.IsNotExist(err) {
		t.Fatalf("workspace-only run should not create synthetic repo dir, stat err=%v", err)
	}
}

func TestResolveWorkspaceRepoUsesDeviceDirectoryWhenNotGit(t *testing.T) {
	root := t.TempDir()
	dir := t.TempDir()
	cfg := &Config{WorkspaceDir: filepath.Join(root, "workspace")}
	cwd, err := resolveWorkspaceRepo(context.Background(), cfg, &WorkspaceRepoSpec{Kind: "device_path", DevicePath: dir, GroupFolder: "demo"})
	if err != nil {
		t.Fatal(err)
	}
	expected := filepath.Join(cfg.WorkspaceDir, "demo")
	if cwd != expected {
		t.Fatalf("expected managed workspace cwd %q, got %q", expected, cwd)
	}
	link := filepath.Join(cwd, filepath.Base(dir))
	target, err := os.Readlink(link)
	if err != nil {
		t.Fatalf("expected symlink at %s: %v", link, err)
	}
	if target != dir {
		t.Fatalf("expected symlink target %q, got %q", dir, target)
	}
}

func TestResolveWorkspaceRepoSymlinksDeviceDirectoryInsideAgentSession(t *testing.T) {
	root := t.TempDir()
	dir := t.TempDir()
	cfg := &Config{WorkspaceDir: filepath.Join(root, "workspace")}
	cwd, err := resolveWorkspaceRepo(context.Background(), cfg, &WorkspaceRepoSpec{
		Kind:        "device_path",
		DevicePath:  dir,
		GroupFolder: "demo",
		AgentID:     "agent-abc",
		Scope:       "session",
		ScopeID:     "sess-123",
	})
	if err != nil {
		t.Fatal(err)
	}
	expected := filepath.Join(cfg.WorkspaceDir, "demo", "sessions", "sess-123")
	if cwd != expected {
		t.Fatalf("expected agent session cwd %q, got %q", expected, cwd)
	}
	link := filepath.Join(cwd, filepath.Base(dir))
	target, err := os.Readlink(link)
	if err != nil {
		t.Fatalf("expected symlink at %s: %v", link, err)
	}
	if target != dir {
		t.Fatalf("expected symlink target %q, got %q", dir, target)
	}
}

func TestResolveAgentWorkspaceCwdUsesWorkspaceTaskScope(t *testing.T) {
	root := t.TempDir()
	cfg := &Config{WorkspaceDir: filepath.Join(root, "workspace")}
	cwd, err := resolveAgentWorkspaceCwd(cfg, &AgentRunWorkspace{Folder: "flow-demo", AgentID: "agent-abc", Scope: "task", TaskID: "task-001", TaskRunID: "run-001"})
	if err != nil {
		t.Fatal(err)
	}
	expected := filepath.Join(cfg.WorkspaceDir, "flow-demo", "tasks", "task-001", "run-001")
	if cwd != expected {
		t.Fatalf("expected task cwd %q, got %q", expected, cwd)
	}
	if _, err := os.Stat(cwd); err != nil {
		t.Fatalf("expected cwd created: %v", err)
	}
}

func TestResolveAgentWorkspaceCwdUsesGlobalTaskScopeWithoutWorkspace(t *testing.T) {
	root := t.TempDir()
	cfg := &Config{WorkspaceDir: filepath.Join(root, "workspace")}
	cwd, err := resolveAgentWorkspaceCwd(cfg, &AgentRunWorkspace{AgentID: "agent-abc", Scope: "task", TaskID: "task-001", TaskRunID: "run-001"})
	if err != nil {
		t.Fatal(err)
	}
	expected := filepath.Join(root, "tasks", "task-001", "run-001")
	if cwd != expected {
		t.Fatalf("expected global task cwd %q, got %q", expected, cwd)
	}
	if _, err := os.Stat(cwd); err != nil {
		t.Fatalf("expected cwd created: %v", err)
	}
}

func TestResolveAgentWorkspaceCwdUsesDirectSessionRoot(t *testing.T) {
	root := t.TempDir()
	cfg := &Config{WorkspaceDir: filepath.Join(root, "workspace")}
	cwd, err := resolveAgentWorkspaceCwd(cfg, &AgentRunWorkspace{Folder: "flow-demo", AgentID: "agent-abc", Scope: "direct_session", ScopeID: "sess-standalone"})
	if err != nil {
		t.Fatal(err)
	}
	expected := filepath.Join(cfg.WorkspaceDir, "flow-demo", "sessions", "sess-standalone")
	if cwd != expected {
		t.Fatalf("expected direct session cwd %q, got %q", expected, cwd)
	}
	if _, err := os.Stat(cwd); err != nil {
		t.Fatalf("expected cwd created: %v", err)
	}
}

func TestResolveAgentWorkspaceCwdDefaultsEmptySessionScopeToMain(t *testing.T) {
	root := t.TempDir()
	cfg := &Config{WorkspaceDir: filepath.Join(root, "workspace")}
	cwd, err := resolveAgentWorkspaceCwd(cfg, &AgentRunWorkspace{Folder: "flow-demo", AgentID: "traecli-acp", Scope: "session"})
	if err != nil {
		t.Fatal(err)
	}
	expected := filepath.Join(cfg.WorkspaceDir, "flow-demo", "sessions", "main")
	if cwd != expected {
		t.Fatalf("expected main conversation cwd %q, got %q", expected, cwd)
	}
}

func TestAgentRuntimeDirectSessionWithoutScopeIDUsesMain(t *testing.T) {
	root := t.TempDir()
	cfg := &Config{WorkspaceDir: filepath.Join(root, "workspace")}
	rt := &agentRuntimeProcess{cfg: cfg}
	req := &AgentRunRequestFrame{
		AgentID: "traecli-acp",
		Workspace: &AgentRunWorkspace{
			Kind:   "workspace",
			Folder: "flow-demo",
			Scope:  "direct_session",
		},
		Context: map[string]any{"group": map[string]any{"folder": "flow-demo"}},
	}
	cwd, err := rt.resolveCwd(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	expected := filepath.Join(cfg.WorkspaceDir, "flow-demo", "sessions", "main")
	if cwd != expected {
		t.Fatalf("expected main direct-session cwd %q, got %q", expected, cwd)
	}
	if req.Workspace.ScopeID != "main" {
		t.Fatalf("expected normalized scope id main, got %q", req.Workspace.ScopeID)
	}
}

func TestAgentRuntimePreservesExplicitWorkspaceSessionScopeID(t *testing.T) {
	root := t.TempDir()
	cfg := &Config{WorkspaceDir: filepath.Join(root, "workspace")}
	rt := &agentRuntimeProcess{cfg: cfg}
	req := &AgentRunRequestFrame{
		AgentID: "traecli-acp",
		Workspace: &AgentRunWorkspace{
			Kind:    "workspace",
			Folder:  "flow-demo",
			Scope:   "session",
			ScopeID: "ws-session-b",
		},
		Input:   AgentRunInput{Metadata: map[string]any{"chatId": "web:flow-demo", "workspaceSessionId": "ws-session-b"}},
		Context: map[string]any{"group": map[string]any{"folder": "flow-demo"}},
	}
	cwd, err := rt.resolveCwd(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	expected := filepath.Join(cfg.WorkspaceDir, "flow-demo", "sessions", "ws-session-b")
	if cwd != expected {
		t.Fatalf("expected explicit workspace-session cwd %q, got %q", expected, cwd)
	}
	if req.Workspace.ScopeID != "ws-session-b" {
		t.Fatalf("expected explicit scope id preserved, got %q", req.Workspace.ScopeID)
	}
}

func TestDefaultRunCwdUsesOctodeckTaskDir(t *testing.T) {
	root := t.TempDir()
	cwd, err := defaultRunCwd(&Config{WorkspaceDir: filepath.Join(root, "workspace")}, "/server/groups/demo")
	if err != nil {
		t.Fatal(err)
	}
	expectedParent := filepath.Join(root, "tasks")
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

func TestValidateRunRequestAllowsDeviceWorkspaceURI(t *testing.T) {
	req := &RunRequestFrame{
		RunID:          "run-workspace-uri",
		Binary:         "/usr/bin/python3",
		Argv:           []string{"-c", "print('ok')"},
		Cwd:            "octodeck-workspace://flow-demo",
		OutputProtocol: "plain-text",
		TimeoutMs:      int64(5 * time.Second / time.Millisecond),
		MaxOutputBytes: 4096,
	}
	if err := validateRunRequest(&Config{AllowedBinaries: []string{"/usr/bin/python3"}}, req); err != nil {
		t.Fatalf("expected workspace URI cwd to pass validation, got %v", err)
	}
}

func TestDefaultRunCwdRejectsSuspiciousWorkspaceURI(t *testing.T) {
	root := t.TempDir()
	cfg := &Config{WorkspaceDir: filepath.Join(root, "workspace")}
	malicious := "octodeck-workspace://device-traeclicc-aND-5682-sEleCt-5682-FROm-pg_sLEEP-3"
	if _, err := defaultRunCwd(cfg, malicious); err == nil {
		t.Fatalf("expected suspicious workspace URI to be rejected")
	}
	entries, err := os.ReadDir(cfg.WorkspaceDir)
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("expected no workspace directory to be created, got %d entries", len(entries))
	}
}

func TestDefaultRunCwdRejectsWorkspaceURIPathTraversal(t *testing.T) {
	root := t.TempDir()
	cfg := &Config{WorkspaceDir: filepath.Join(root, "workspace")}
	if _, err := defaultRunCwd(cfg, "octodeck-workspace://../escape"); err == nil {
		t.Fatalf("expected traversal workspace URI to be rejected")
	}
	if _, err := os.Stat(filepath.Join(root, "escape")); !os.IsNotExist(err) {
		t.Fatalf("expected escape dir not to exist, stat err=%v", err)
	}
}

func TestDefaultRunCwdUsesManagedTmpURI(t *testing.T) {
	root := t.TempDir()
	cwd, err := defaultRunCwd(&Config{WorkspaceDir: filepath.Join(root, "workspace")}, "octodeck-tmp://skills-install")
	if err != nil {
		t.Fatal(err)
	}
	expected := filepath.Join(root, "tmp", "skills-install")
	if cwd != expected {
		t.Fatalf("expected tmp cwd %q, got %q", expected, cwd)
	}
	if info, err := os.Stat(cwd); err != nil || !info.IsDir() {
		t.Fatalf("expected tmp cwd to be created, info=%v err=%v", info, err)
	}
}

func TestValidateRunRequestAllowsDeviceTmpURI(t *testing.T) {
	req := &RunRequestFrame{
		RunID:          "run-tmp-uri",
		Binary:         "/usr/bin/python3",
		Argv:           []string{"-c", "print('ok')"},
		Cwd:            "octodeck-tmp://skills-install",
		OutputProtocol: "plain-text",
		TimeoutMs:      int64(5 * time.Second / time.Millisecond),
		MaxOutputBytes: 4096,
	}
	if err := validateRunRequest(&Config{AllowedBinaries: []string{"/usr/bin/python3"}}, req); err != nil {
		t.Fatalf("expected tmp URI cwd to pass validation, got %v", err)
	}
}

func TestResolveWorkspaceRepoAllowsDeviceDirectoryOutsideAllowedRoots(t *testing.T) {
	allowed := t.TempDir()
	outside := t.TempDir()
	workspace := filepath.Join(t.TempDir(), "workspace")
	cwd, err := resolveWorkspaceRepo(context.Background(), &Config{AllowedRoots: []string{allowed}, WorkspaceDir: workspace}, &WorkspaceRepoSpec{Kind: "device_path", DevicePath: outside, GroupFolder: "demo"})
	if err != nil {
		t.Fatalf("expected device directory outside allowed roots to be accepted, got %v", err)
	}
	if cwd != filepath.Join(workspace, "demo") {
		t.Fatalf("unexpected cwd: %s", cwd)
	}
}

func TestRunCwdAllowedAllowsManagedSessionDirOutsideAllowedRoots(t *testing.T) {
	root := t.TempDir()
	cfg := &Config{
		AllowedRoots: []string{filepath.Join(root, "allowed")},
		WorkspaceDir: filepath.Join(root, "workspace"),
		SessionDir:   filepath.Join(root, "sessions"),
		TaskDir:      filepath.Join(root, "tasks"),
		TmpDir:       filepath.Join(root, "tmp"),
	}
	cwd := filepath.Join(cfg.SessionDir, "b1d40372-8ca1-4e68-82c2-b56ef1d45b09", "kunlun")
	if !isRunCwdAllowed(cfg, cwd) {
		t.Fatalf("expected managed session cwd outside allowed roots to be accepted: %s", cwd)
	}
}

func TestReplaceArgvPlaceholderUsesResolvedRemoteCwd(t *testing.T) {
	argv := replaceArgvPlaceholder([]string{"exec", "--cwd=__OCTODECK_REMOTE_CWD__"}, "__OCTODECK_REMOTE_CWD__", "/tmp/worktree")
	if got := strings.Join(argv, " "); got != "exec --cwd=/tmp/worktree" {
		t.Fatalf("unexpected argv: %s", got)
	}
}

func TestPrepareAgentTeamMCPConfigWritesClaudeConfigAndReplacesPlaceholder(t *testing.T) {
	root := t.TempDir()
	legacyConfigPath := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(legacyConfigPath, []byte(`{"server":"https://octodeck.example","token":"link-token","linkId":"cl_123"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OCTODECK_DAEMON_CONFIG", legacyConfigPath)
	originalArgs := os.Args
	os.Args = []string{"octodeck-daemon"}
	t.Cleanup(func() { os.Args = originalArgs })

	cfg := &Config{Server: "https://octodeck.example", Token: "link-token", LinkID: "cl_123", WorkspaceDir: filepath.Join(root, "workspace")}
	argv, err := prepareAgentTeamMCPConfig(cfg, []string{"-p", "hello", "--mcp-config", agentTeamMCPConfigPlaceholder}, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(argv) != 4 || argv[3] == agentTeamMCPConfigPlaceholder {
		t.Fatalf("placeholder was not replaced: %#v", argv)
	}
	expectedMCPConfig := filepath.Join(root, "daemon", "agent-team-mcp.json")
	if argv[3] != expectedMCPConfig {
		t.Fatalf("expected MCP config under daemon dir %q, got %q", expectedMCPConfig, argv[3])
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
	expectedCommand := filepath.Join(root, "daemon", "bin", "octodeck-daemon")
	if server.Command != expectedCommand {
		t.Fatalf("expected MCP command %q, got %q in %s", expectedCommand, server.Command, string(data))
	}
	expectedConfigPath := filepath.Join(root, "daemon", "config.json")
	if strings.Join(server.Args, " ") != "mcp-agent-team --config "+expectedConfigPath {
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
	root := t.TempDir()
	legacyConfigPath := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(legacyConfigPath, []byte(`{"server":"https://octodeck.example","token":"link-token","linkId":"cl_123"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OCTODECK_DAEMON_CONFIG", legacyConfigPath)
	originalArgs := os.Args
	os.Args = []string{"octodeck-daemon"}
	t.Cleanup(func() { os.Args = originalArgs })

	cwd := t.TempDir()
	cfg := &Config{Server: "https://octodeck.example", Token: "link-token", LinkID: "cl_123", WorkspaceDir: filepath.Join(root, "workspace")}
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
	expectedCommand := filepath.Join(root, "daemon", "bin", "octodeck-daemon")
	if server.Command != expectedCommand {
		t.Fatalf("expected MCP command %q, got %q", expectedCommand, server.Command)
	}
	expectedConfigPath := filepath.Join(root, "daemon", "config.json")
	if strings.Join(server.Args, " ") != "mcp-agent-team --config "+expectedConfigPath {
		t.Fatalf("unexpected MCP args: %#v", server.Args)
	}
	if server.Timeout != 30 {
		t.Fatalf("unexpected MCP timeout: %d", server.Timeout)
	}
}

func TestPrepareAgentRuntimeMCPConfigWritesTraeProjectConfig(t *testing.T) {
	root := t.TempDir()
	legacyConfigPath := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(legacyConfigPath, []byte(`{"server":"https://octodeck.example","token":"link-token","linkId":"cl_123"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OCTODECK_DAEMON_CONFIG", legacyConfigPath)
	originalArgs := os.Args
	os.Args = []string{"octodeck-daemon"}
	t.Cleanup(func() { os.Args = originalArgs })

	cwd := t.TempDir()
	cfg := &Config{Server: "https://octodeck.example", Token: "link-token", LinkID: "cl_123", WorkspaceDir: filepath.Join(root, "workspace")}
	req := &AgentRunRequestFrame{AgentID: "traecli", Context: map[string]any{"group": map[string]any{"folder": "demo"}}}
	if err := prepareAgentRuntimeMCPConfig(cfg, req, cwd); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(cwd, ".trae", "mcp.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), "octodeck_agent_team") {
		t.Fatalf("missing octodeck MCP server in Trae config: %s", string(data))
	}
}

func TestPrepareAgentRuntimeMCPConfigWritesClaudeAndCodexConfig(t *testing.T) {
	root := t.TempDir()
	legacyConfigPath := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(legacyConfigPath, []byte(`{"server":"https://octodeck.example","token":"link-token","linkId":"cl_123"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OCTODECK_DAEMON_CONFIG", legacyConfigPath)
	originalArgs := os.Args
	os.Args = []string{"octodeck-daemon"}
	t.Cleanup(func() { os.Args = originalArgs })

	cwd := t.TempDir()
	cfg := &Config{Server: "https://octodeck.example", Token: "link-token", LinkID: "cl_123", WorkspaceDir: filepath.Join(root, "workspace"), SessionDir: filepath.Join(root, "session")}
	claudeReq := &AgentRunRequestFrame{AgentID: "claude-code", Context: map[string]any{"group": map[string]any{"folder": "demo"}}}
	if err := prepareAgentRuntimeMCPConfig(cfg, claudeReq, cwd); err != nil {
		t.Fatal(err)
	}
	claudeData, err := os.ReadFile(filepath.Join(root, "daemon", "agent-team-mcp.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(claudeData), "octodeck_agent_team") {
		t.Fatalf("missing octodeck MCP server in Claude config: %s", string(claudeData))
	}

	codexReq := &AgentRunRequestFrame{AgentID: "codex", Context: map[string]any{"group": map[string]any{"folder": "demo"}}}
	if err := prepareAgentRuntimeMCPConfig(cfg, codexReq, cwd); err != nil {
		t.Fatal(err)
	}
	codexData, err := os.ReadFile(filepath.Join(root, "session", "demo", "codex", "config.toml"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(codexData), "[mcp_servers.octodeck_agent_team]") || !strings.Contains(string(codexData), "mcp-agent-team") {
		t.Fatalf("missing octodeck MCP server in Codex config: %s", string(codexData))
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
