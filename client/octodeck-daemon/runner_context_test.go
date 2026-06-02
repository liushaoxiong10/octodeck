package main

import (
	"context"
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
	r := newRunner(&Config{AllowedBinaries: []string{"/usr/bin/python3"}}, pool, func(frame any) error {
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
	if _, err := os.Stat(filepath.Join(cwd, "README.md")); err != nil {
		t.Fatalf("expected worktree to contain repository files: %v", err)
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
