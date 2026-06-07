package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestToolRunnerReadAndWrite(t *testing.T) {
	dir := t.TempDir()
	tr := newToolRunner(&Config{AllowedRoots: []string{dir}}, nil)

	write := &ToolRequestFrame{
		RequestID:      "tool-1",
		ToolName:       "Write",
		Cwd:            dir,
		Input:          map[string]any{"file_path": filepath.Join(dir, "a.txt"), "content": "hello"},
		TimeoutMs:      1000,
		MaxOutputBytes: 4096,
	}
	res := tr.execute(context.Background(), write)
	if !res.OK {
		t.Fatalf("write failed: %s", valueOrEmpty(res.Error))
	}

	read := &ToolRequestFrame{
		RequestID:      "tool-2",
		ToolName:       "Read",
		Cwd:            dir,
		Input:          map[string]any{"file_path": filepath.Join(dir, "a.txt")},
		TimeoutMs:      1000,
		MaxOutputBytes: 4096,
	}
	res = tr.execute(context.Background(), read)
	if !res.OK {
		t.Fatalf("read failed: %s", valueOrEmpty(res.Error))
	}
	if !strings.Contains(res.Result.(map[string]any)["content"].(string), "hello") {
		t.Fatalf("expected read content to contain hello, got %#v", res.Result)
	}
}

func TestToolRunnerRejectsPathOutsideAllowedRoot(t *testing.T) {
	dir := t.TempDir()
	outside := filepath.Join(t.TempDir(), "secret.txt")
	if err := os.WriteFile(outside, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	tr := newToolRunner(&Config{AllowedRoots: []string{dir}}, nil)

	res := tr.execute(context.Background(), &ToolRequestFrame{
		RequestID:      "tool-1",
		ToolName:       "Read",
		Cwd:            dir,
		Input:          map[string]any{"file_path": outside},
		TimeoutMs:      1000,
		MaxOutputBytes: 4096,
	})
	if res.OK {
		t.Fatalf("expected outside read to fail")
	}
}

func TestToolRunnerDefaultsToOctodeckAllowedRoot(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	octoHome := filepath.Join(home, ".octodeck")
	if err := os.MkdirAll(octoHome, 0o755); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(home, "outside")
	if err := os.MkdirAll(outside, 0o755); err != nil {
		t.Fatal(err)
	}
	cfg, err := loadConfig(writeTestConfig(t, filepath.Join(t.TempDir(), "config.json")))
	if err != nil {
		t.Fatal(err)
	}
	tr := newToolRunner(cfg, nil)

	allowedRes := tr.execute(context.Background(), &ToolRequestFrame{
		RequestID:      "tool-allowed",
		ToolName:       "LS",
		Cwd:            octoHome,
		Input:          map[string]any{"path": octoHome},
		TimeoutMs:      1000,
		MaxOutputBytes: 4096,
	})
	if !allowedRes.OK {
		t.Fatalf("expected ~/.octodeck path to be allowed: %s", valueOrEmpty(allowedRes.Error))
	}

	outsideRes := tr.execute(context.Background(), &ToolRequestFrame{
		RequestID:      "tool-outside",
		ToolName:       "LS",
		Cwd:            outside,
		Input:          map[string]any{"path": outside},
		TimeoutMs:      1000,
		MaxOutputBytes: 4096,
	})
	if outsideRes.OK {
		t.Fatalf("expected path outside ~/.octodeck to be rejected")
	}
}

func TestToolRunnerListDirectoriesForDevicePathPicker(t *testing.T) {
	dir := t.TempDir()
	project := filepath.Join(dir, "project")
	nested := filepath.Join(project, "nested")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(project, ".hidden"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(project, "file.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	tr := newToolRunner(&Config{AllowedRoots: []string{dir}}, nil)
	realProject, err := filepath.EvalSymlinks(project)
	if err != nil {
		t.Fatal(err)
	}
	realNested, err := filepath.EvalSymlinks(nested)
	if err != nil {
		t.Fatal(err)
	}

	res := tr.execute(context.Background(), &ToolRequestFrame{
		RequestID:      "tool-list",
		ToolName:       "ListDirectories",
		Cwd:            "/",
		Input:          map[string]any{"path": project},
		TimeoutMs:      1000,
		MaxOutputBytes: 4096,
	})
	if !res.OK {
		t.Fatalf("list directories failed: %s", valueOrEmpty(res.Error))
	}
	payload := res.Result.(map[string]any)
	if payload["currentPath"].(string) != realProject {
		t.Fatalf("expected currentPath %q, got %#v", realProject, payload["currentPath"])
	}
	dirs := payload["directories"].([]map[string]any)
	if len(dirs) != 1 {
		t.Fatalf("expected only visible subdirectory, got %#v", dirs)
	}
	if dirs[0]["name"] != "nested" || dirs[0]["path"] != realNested {
		t.Fatalf("unexpected directory entry: %#v", dirs[0])
	}
}

func TestToolRunnerListDirectoriesAllowsDevicePathOutsideAllowedRoots(t *testing.T) {
	allowed := t.TempDir()
	outside := t.TempDir()
	project := filepath.Join(outside, "project")
	if err := os.MkdirAll(project, 0o755); err != nil {
		t.Fatal(err)
	}
	realProject, err := filepath.EvalSymlinks(project)
	if err != nil {
		t.Fatal(err)
	}

	tr := newToolRunner(&Config{AllowedRoots: []string{allowed}}, nil)
	res := tr.execute(context.Background(), &ToolRequestFrame{
		RequestID:      "tool-list-outside",
		ToolName:       "ListDirectories",
		Cwd:            "/",
		Input:          map[string]any{"path": project},
		TimeoutMs:      1000,
		MaxOutputBytes: 4096,
	})
	if !res.OK {
		t.Fatalf("expected device directory outside allowed roots to be listed: %s", valueOrEmpty(res.Error))
	}
	payload := res.Result.(map[string]any)
	if payload["currentPath"].(string) != realProject {
		t.Fatalf("expected currentPath %q, got %#v", realProject, payload["currentPath"])
	}
	if payload["hasAllowlist"].(bool) {
		t.Fatalf("expected device directory picker to ignore allowed roots")
	}
}

func valueOrEmpty(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func writeTestConfig(t *testing.T, path string) string {
	t.Helper()
	if err := os.WriteFile(path, []byte(`{"server":"https://octodeck.example","token":"link-token","linkId":"cl_123"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestDaemonVersionComparison(t *testing.T) {
	if !isNewerDaemonVersion("octodeck-daemon/1.0.2", "octodeck-daemon/1.0.1") {
		t.Fatal("expected 1.0.2 to be newer than 1.0.1")
	}
	if isNewerDaemonVersion("octodeck-daemon/1.0.1", "octodeck-daemon/1.0.2") {
		t.Fatal("expected downgrade to not be considered newer")
	}
	if !isNewerDaemonVersion("v1.1.0", "octodeck-daemon/1.0.9") {
		t.Fatal("expected v1.1.0 to be newer than 1.0.9")
	}
	if isNewerDaemonVersion("octodeck-daemon/1.0.2", "octodeck-daemon/1.0.2") {
		t.Fatal("expected equal versions to not require update")
	}
}

func TestCheckDaemonUpdateUsesServerVersionEndpoint(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/daemon/version" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("content-type", "application/json")
		fmt.Fprint(w, `{"version":"octodeck-daemon/1.0.5"}`)
	}))
	defer server.Close()

	latest, available, err := checkDaemonUpdate(context.Background(), &Config{
		Server:  server.URL,
		Version: "octodeck-daemon/1.0.2",
	})
	if err != nil {
		t.Fatal(err)
	}
	if latest != "octodeck-daemon/1.0.5" || !available {
		t.Fatalf("unexpected update check result latest=%q available=%v", latest, available)
	}
}

func TestAutoUpdateDefaultsEnabledAndCanBeDisabled(t *testing.T) {
	if !autoUpdateEnabled(&Config{}) {
		t.Fatal("expected auto update enabled by default")
	}
	disabled := false
	if autoUpdateEnabled(&Config{AutoUpdate: &disabled}) {
		t.Fatal("expected explicit autoUpdate=false to disable auto updates")
	}
}
