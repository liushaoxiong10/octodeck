package codex

import (
	"encoding/json"
	"testing"
)

func TestThreadItemUnmarshalLegacyStringContent(t *testing.T) {
	var item ThreadItem
	if err := json.Unmarshal([]byte(`{"id":"u1","type":"userMessage","content":"hello legacy"}`), &item); err != nil {
		t.Fatalf("unmarshal legacy string content: %v", err)
	}
	if item.ID != "u1" || item.Type != "userMessage" {
		t.Fatalf("metadata mismatch: %+v", item)
	}
	if len(item.Content) != 1 {
		t.Fatalf("content len = %d, want 1: %+v", len(item.Content), item.Content)
	}
	if got := item.Content[0]; got.Type != "text" || got.Text != "hello legacy" {
		t.Fatalf("content[0] = %+v, want text legacy item", got)
	}
}

func TestThreadItemUnmarshalStructuredContent(t *testing.T) {
	var item ThreadItem
	if err := json.Unmarshal([]byte(`{"id":"u1","type":"userMessage","content":[{"type":"text","text":"hello"},{"type":"localImage","path":"/tmp/a.png"}]}`), &item); err != nil {
		t.Fatalf("unmarshal structured content: %v", err)
	}
	if len(item.Content) != 2 {
		t.Fatalf("content len = %d, want 2: %+v", len(item.Content), item.Content)
	}
	if item.Content[0].Type != "text" || item.Content[0].Text != "hello" {
		t.Fatalf("content[0] mismatch: %+v", item.Content[0])
	}
	if item.Content[1].Type != "localImage" || item.Content[1].Path != "/tmp/a.png" {
		t.Fatalf("content[1] mismatch: %+v", item.Content[1])
	}
}

func TestThreadItemUnmarshalNullContent(t *testing.T) {
	var item ThreadItem
	if err := json.Unmarshal([]byte(`{"id":"a1","type":"agentMessage","text":"done","content":null}`), &item); err != nil {
		t.Fatalf("unmarshal null content: %v", err)
	}
	if item.Text != "done" {
		t.Fatalf("text = %q, want done", item.Text)
	}
	if len(item.Content) != 0 {
		t.Fatalf("content len = %d, want 0: %+v", len(item.Content), item.Content)
	}
}
