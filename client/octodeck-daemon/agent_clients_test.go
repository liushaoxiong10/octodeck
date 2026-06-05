package main

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDiscoverAgentClientsFindsSupportedClientsOnPath(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"claude", "codex", "traecli"} {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte("#!/bin/sh\necho "+name+" 1.0\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", dir)

	clients := discoverAgentClients()
	ids := map[string]string{}
	for _, c := range clients {
		ids[c.ID] = c.Binary
	}

	if ids["claude-code"] != filepath.Join(dir, "claude") {
		t.Fatalf("missing claude-code discovery: %#v", clients)
	}
	if ids["codex"] != filepath.Join(dir, "codex") {
		t.Fatalf("missing codex discovery: %#v", clients)
	}
	if ids["traecli"] != filepath.Join(dir, "traecli") {
		t.Fatalf("missing traecli discovery: %#v", clients)
	}
}

func TestDiscoverAgentClientsCollectsVersion(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "codex")
	if err := os.WriteFile(p, []byte("#!/bin/sh\necho 'codex-cli 1.2.3'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	t.Setenv("OCTODECK_DAEMON_EXTRA_PATH", "")

	clients := discoverAgentClients()
	for _, c := range clients {
		if c.ID == "codex" {
			if c.Version != "codex-cli 1.2.3" {
				t.Fatalf("unexpected codex version %q in %#v", c.Version, clients)
			}
			return
		}
	}
	t.Fatalf("missing codex discovery: %#v", clients)
}

func TestDiscoverAgentClientsFindsHomeLocalBinWhenPathIsMinimal(t *testing.T) {
	home := t.TempDir()
	binDir := filepath.Join(home, ".local", "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"claude", "codex", "traecli"} {
		p := filepath.Join(binDir, name)
		if err := os.WriteFile(p, []byte("#!/bin/sh\necho "+name+" 1.0\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("HOME", home)
	t.Setenv("PATH", "/usr/bin:/bin")
	t.Setenv("OCTODECK_DAEMON_EXTRA_PATH", "")

	clients := discoverAgentClients()
	ids := map[string]string{}
	for _, c := range clients {
		ids[c.ID] = c.Binary
	}

	if ids["claude-code"] != filepath.Join(binDir, "claude") {
		t.Fatalf("missing claude-code from home local bin: %#v", clients)
	}
	if ids["codex"] != filepath.Join(binDir, "codex") {
		t.Fatalf("missing codex from home local bin: %#v", clients)
	}
	if ids["traecli"] != filepath.Join(binDir, "traecli") {
		t.Fatalf("missing traecli from home local bin: %#v", clients)
	}
}

func TestDiscoverAgentClientsFindsExtraPathWhenPathIsMinimal(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "codex")
	if err := os.WriteFile(p, []byte("#!/bin/sh\necho codex 1.0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", "/usr/bin:/bin")
	t.Setenv("OCTODECK_DAEMON_EXTRA_PATH", dir)

	clients := discoverAgentClients()
	for _, c := range clients {
		if c.ID == "codex" && c.Binary == p {
			return
		}
	}
	t.Fatalf("missing codex from OCTODECK_DAEMON_EXTRA_PATH: %#v", clients)
}

func TestDiscoverAgentClientsFindsACPClientsWhenBinaryAdvertisesACP(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "claude")
	script := `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo 'claude 1.0'
  exit 0
fi
if [ "$1" = "acp" ] && [ "$2" = "--help" ]; then
  echo 'Agent Client Protocol server'
  exit 0
fi
echo 'claude help'
`
	if err := os.WriteFile(p, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	t.Setenv("OCTODECK_DAEMON_EXTRA_PATH", "")

	clients := discoverAgentClients()
	ids := map[string]AgentClientInfo{}
	for _, c := range clients {
		ids[c.ID] = c
	}
	client, ok := ids["claude-acp"]
	if !ok {
		t.Fatalf("missing claude-acp discovery: %#v", clients)
	}
	if client.Binary != p || client.Transport != "acp" || client.Provider != "claude-code" || strings.Join(client.Args, " ") != "acp" {
		t.Fatalf("unexpected claude-acp client: %#v", client)
	}
}

func TestRegistryAgentClientsSupportsACPTransport(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "agent-acp")
	if err := os.WriteFile(p, []byte("#!/bin/sh\necho agent-acp 1.0\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	clients := registryAgentClients(&Config{AgentRegistry: []AgentRegistryEntry{{
		ID:          "custom-acp",
		DisplayName: "Custom ACP",
		Transport:   "acp",
		Binary:      p,
		Args:        []string{"acp", "serve"},
	}}})
	ids := map[string]AgentClientInfo{}
	for _, c := range clients {
		ids[c.ID] = c
	}
	client, ok := ids["custom-acp"]
	if !ok {
		t.Fatalf("missing custom acp registry client: %#v", clients)
	}
	if client.Binary != p || client.Transport != "acp" {
		t.Fatalf("unexpected acp client: %#v", client)
	}
}

func TestACPAdapterRunDirectUsesJSONRPCStdio(t *testing.T) {
	entry := AgentRegistryEntry{
		ID:        "custom-acp",
		Transport: "acp",
		Binary:    os.Args[0],
		Args:      []string{"-test.run=TestACPHelperProcess"},
		Env:       map[string]string{"GO_WANT_ACP_HELPER_PROCESS": "1"},
	}
	cfg := &Config{
		AgentRegistry: []AgentRegistryEntry{entry},
		SessionDir:    t.TempDir(),
	}
	adapter := &acpAdapter{
		baseAgentAdapter: baseAgentAdapter{client: AgentClientInfo{ID: entry.ID, Binary: entry.Binary, Transport: entry.Transport}},
		entry:            &entry,
	}
	req := &AgentRunRequestFrame{
		RunID:          "run-acp",
		AgentID:        entry.ID,
		Cwd:            t.TempDir(),
		MaxOutputBytes: 1024,
		Input:          AgentRunInput{Prompt: "hello"},
		Context:        map[string]any{"group": map[string]any{"folder": "demo"}},
	}
	var events []AgentRunEventFrame
	result, err := adapter.RunDirect(context.Background(), cfg, req, func(event AgentRunEventFrame) {
		events = append(events, event)
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.OK {
		t.Fatalf("expected ok result: %#v", result)
	}
	if result.SessionID != "sess-jsonrpc" {
		t.Fatalf("expected ACP session id, got %#v", result)
	}
	if !strings.Contains(result.Result, "assistant reply") {
		t.Fatalf("expected assistant text in result, got %q", result.Result)
	}
	if !hasAgentRunEvent(events, "text_delta", "assistant reply") {
		t.Fatalf("expected text_delta event, got %#v", events)
	}
	if !hasAgentRunEvent(events, "thinking_delta", "thinking about it") {
		t.Fatalf("expected thinking_delta event, got %#v", events)
	}
	if !hasAgentRunEvent(events, "tool_use_start", "") || !hasAgentRunEvent(events, "tool_use_end", "") {
		t.Fatalf("expected tool events, got %#v", events)
	}
	if result.Usage == nil || result.Usage["input_tokens"] == nil {
		t.Fatalf("expected usage in result, got %#v", result.Usage)
	}
}

func hasAgentRunEvent(events []AgentRunEventFrame, eventType, text string) bool {
	for _, event := range events {
		if event.EventType != eventType {
			continue
		}
		if text == "" || event.Text == text {
			return true
		}
	}
	return false
}

func TestACPAdapterRunDirectUsesDiscoveredClientArgs(t *testing.T) {
	cfg := &Config{SessionDir: t.TempDir()}
	client := AgentClientInfo{
		ID:        "claude-acp",
		Binary:    os.Args[0],
		Transport: "acp",
		Args:      []string{"-test.run=TestACPHelperProcess"},
	}
	adapter := &acpAdapter{baseAgentAdapter: baseAgentAdapter{client: client}}
	req := &AgentRunRequestFrame{
		RunID:          "run-acp-auto",
		AgentID:        client.ID,
		Cwd:            t.TempDir(),
		Env:            map[string]string{"GO_WANT_ACP_HELPER_PROCESS": "1"},
		MaxOutputBytes: 1024,
		Input:          AgentRunInput{Prompt: "hello"},
		Context:        map[string]any{"group": map[string]any{"folder": "demo"}},
	}
	result, err := adapter.RunDirect(context.Background(), cfg, req, func(AgentRunEventFrame) {})
	if err != nil {
		t.Fatal(err)
	}
	if !result.OK || result.SessionID != "sess-jsonrpc" || !strings.Contains(result.Result, "assistant reply") {
		t.Fatalf("unexpected ACP auto result: %#v", result)
	}
}

func TestACPHelperProcess(t *testing.T) {
	if os.Getenv("GO_WANT_ACP_HELPER_PROCESS") != "1" {
		return
	}
	scanner := bufio.NewScanner(os.Stdin)
	enc := json.NewEncoder(os.Stdout)
	for scanner.Scan() {
		var msg runtimeRPCMessage
		if err := json.Unmarshal(scanner.Bytes(), &msg); err != nil {
			os.Exit(2)
		}
		switch msg.Method {
		case "initialize":
			writeACPHelperMessage(enc, runtimeRPCMessage{JSONRPC: "2.0", ID: msg.ID, Result: rawACPHelperJSON(`{"protocolVersion":1}`)})
		case "session/new":
			writeACPHelperMessage(enc, runtimeRPCMessage{JSONRPC: "2.0", ID: msg.ID, Result: rawACPHelperJSON(`{"sessionId":"sess-jsonrpc"}`)})
		case "session/prompt":
			writeACPHelperMessage(enc, runtimeRPCMessage{JSONRPC: "2.0", Method: "session/update", Params: rawACPHelperJSON(`{"sessionId":"sess-jsonrpc","reasoning":"thinking about it"}`)})
			writeACPHelperMessage(enc, runtimeRPCMessage{JSONRPC: "2.0", Method: "session/update", Params: rawACPHelperJSON(`{"sessionId":"sess-jsonrpc","type":"tool_call","id":"tool-1","name":"Read","input":{"file":"README.md"}}`)})
			writeACPHelperMessage(enc, runtimeRPCMessage{JSONRPC: "2.0", Method: "session/update", Params: rawACPHelperJSON(`{"sessionId":"sess-jsonrpc","type":"tool_result","tool_use_id":"tool-1","content":"ok"}`)})
			writeACPHelperMessage(enc, runtimeRPCMessage{JSONRPC: "2.0", Method: "session/update", Params: rawACPHelperJSON(`{"sessionId":"sess-jsonrpc","usage":{"input_tokens":12,"output_tokens":3}}`)})
			writeACPHelperMessage(enc, runtimeRPCMessage{JSONRPC: "2.0", Method: "session/update", Params: rawACPHelperJSON(`{"sessionId":"sess-jsonrpc","text":"assistant reply"}`)})
			time.Sleep(20 * time.Millisecond)
			writeACPHelperMessage(enc, runtimeRPCMessage{JSONRPC: "2.0", ID: msg.ID, Result: rawACPHelperJSON(`{"content":"assistant reply","usage":{"input_tokens":12,"output_tokens":3}}`)})
			os.Exit(0)
		default:
			writeACPHelperMessage(enc, runtimeRPCMessage{JSONRPC: "2.0", ID: msg.ID, Error: &runtimeRPCError{Code: -32601, Message: "method not found"}})
		}
	}
	os.Exit(0)
}

func rawACPHelperJSON(s string) json.RawMessage {
	return json.RawMessage(s)
}

func writeACPHelperMessage(enc *json.Encoder, msg runtimeRPCMessage) {
	if err := enc.Encode(msg); err != nil {
		os.Exit(2)
	}
}
