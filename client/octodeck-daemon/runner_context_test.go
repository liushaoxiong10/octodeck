package main

import (
	"context"
	"fmt"
	"os"
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
