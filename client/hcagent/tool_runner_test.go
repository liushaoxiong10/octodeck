package main

import (
	"context"
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

func valueOrEmpty(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}
