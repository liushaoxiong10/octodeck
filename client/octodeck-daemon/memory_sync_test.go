package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestAgentMemorySourcesIncludeKnownClientMemoryFiles(t *testing.T) {
	home := t.TempDir()
	sources := agentMemorySources(home, []AgentClientInfo{
		{ID: "claude-code", DisplayName: "Claude Code"},
		{ID: "codex", DisplayName: "Codex CLI"},
	})

	want := map[string]string{
		"claude-code": filepath.Join(home, ".claude", "CLAUDE.md"),
		"codex":       filepath.Join(home, ".codex", "AGENTS.md"),
	}
	for _, source := range sources {
		if want[source.AgentID] == source.Path {
			delete(want, source.AgentID)
		}
	}
	if len(want) != 0 {
		t.Fatalf("missing memory sources: %#v (got %#v)", want, sources)
	}
}

func TestMemorySyncPollerSendsChangedFilesOncePerContentHash(t *testing.T) {
	home := t.TempDir()
	memoryPath := filepath.Join(home, ".claude", "CLAUDE.md")
	if err := os.MkdirAll(filepath.Dir(memoryPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(memoryPath, []byte("# first"), 0o644); err != nil {
		t.Fatal(err)
	}

	var sent []MemorySyncFrame
	poller := newMemorySyncPoller("cl_1234567890abcdef", []agentMemorySource{{AgentID: "claude-code", Path: memoryPath}}, func(frame *MemorySyncFrame) error {
		sent = append(sent, *frame)
		return nil
	})

	poller.pollOnce()
	poller.pollOnce()
	if len(sent) != 1 {
		t.Fatalf("expected one initial sync, got %d", len(sent))
	}
	if sent[0].Type != tMemorySync || sent[0].DeviceLinkID != "cl_1234567890abcdef" || sent[0].AgentID != "claude-code" || sent[0].Path != "CLAUDE.md" || sent[0].Content != "# first" || sent[0].ContentHash == "" {
		t.Fatalf("unexpected initial frame: %#v", sent[0])
	}

	if err := os.WriteFile(memoryPath, []byte("# second"), 0o644); err != nil {
		t.Fatal(err)
	}
	poller.pollOnce()
	if len(sent) != 2 {
		t.Fatalf("expected sync after content change, got %d", len(sent))
	}
	if sent[1].Content != "# second" || sent[1].ContentHash == sent[0].ContentHash {
		t.Fatalf("unexpected changed frame: %#v", sent[1])
	}
}

func TestMemorySyncPollerStopsWithContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	calls := 0
	poller := newMemorySyncPoller("cl_1234567890abcdef", nil, func(frame *MemorySyncFrame) error { return nil })
	poller.interval = time.Millisecond
	poller.afterPoll = func() {
		calls++
		cancel()
	}

	poller.run(ctx)
	if calls == 0 {
		t.Fatal("expected poller to run before context cancellation")
	}
}
