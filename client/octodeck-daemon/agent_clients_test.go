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
		// fake 二进制对任意参数都返回相同输出，且不包含 ACP marker
		// （"agent client protocol" / "acp"）。这样 ACP 探测会失败，discover
		// 自动 fallback 到非 ACP 候选（claude-code / codex / traecli）。
		if err := os.WriteFile(p, []byte("#!/bin/sh\necho "+name+" 1.0\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", dir)
	t.Setenv("OCTODECK_DAEMON_EXTRA_PATH", "")

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
	// 同一个 binary 只注册一种 client（非 ACP fallback 命中后，*-acp 不应同时
	// 出现）。这是 ACP-优先策略的关键不变量。
	if _, ok := ids["claude-acp"]; ok {
		t.Fatalf("claude-acp must not coexist with claude-code: %#v", clients)
	}
	if _, ok := ids["codex-acp"]; ok {
		t.Fatalf("codex-acp must not coexist with codex: %#v", clients)
	}
	if _, ok := ids["traecli-acp"]; ok {
		t.Fatalf("traecli-acp must not coexist with traecli: %#v", clients)
	}
}

func TestDiscoverAgentClientsDoesNotProbeVersion(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "codex")
	// fake 二进制每次被调用都把第 1 个参数追加到 log。
	// discover 阶段允许通过 `acp --help` 探测 ACP 支持（这是 ACP-优先策略
	// 的核心：必须实际跑一下才能判断），但严禁额外调 `--version`（版本
	// 探测应当延迟到第一次真正使用 client 时再做，避免每次 discover 都
	// 让所有 CLI 启动一次）。
	script := "#!/bin/sh\n" +
		"echo \"$1\" >> \"$CLI_STARTED_LOG\"\n" +
		"echo 'codex-cli 1.2.3'\n"
	if err := os.WriteFile(p, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	logPath := filepath.Join(dir, "started.log")
	t.Setenv("PATH", dir)
	t.Setenv("OCTODECK_DAEMON_EXTRA_PATH", "")
	t.Setenv("CLI_STARTED_LOG", logPath)

	clients := discoverAgentClients()
	for _, c := range clients {
		if c.Provider != "codex" && c.ID != "codex" && c.ID != "codex-acp" {
			continue
		}
		if c.Version != "" {
			t.Fatalf("expected no startup-time version probe, got %q in %#v", c.Version, clients)
		}
	}
	// 允许 ACP 探测调用（`acp --help`），但不能出现 `--version`。
	logBytes, err := os.ReadFile(logPath)
	if err != nil && !os.IsNotExist(err) {
		t.Fatalf("read started log: %v", err)
	}
	logContent := string(logBytes)
	if strings.Contains(logContent, "--version") {
		t.Fatalf("discover must not probe --version, got log:\n%s", logContent)
	}
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
	t.Setenv("OCTODECK_DAEMON_PROBE_AGENT_CLIENTS", "1")

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

func TestNormalizeAgentJSONLineFramesPreservesMixedContentBlocks(t *testing.T) {
	line := `{"type":"assistant","session_id":"sess-mixed","message":{"content":[{"type":"thinking","thinking":"先分析"},{"type":"text","text":"准备读文件"},{"type":"tool_use","id":"tool-1","name":"Read","input":{"file_path":"README.md"}},{"type":"text","text":"继续回答"}]}}`
	frames := normalizeAgentJSONLineFrames(line)
	if len(frames) != 4 {
		t.Fatalf("expected 4 frames, got %d: %#v", len(frames), frames)
	}
	expect := []struct {
		eventType string
		text      string
	}{
		{"thinking_delta", "先分析"},
		{"text_delta", "准备读文件"},
		{"tool_call", ""},
		{"text_delta", "继续回答"},
	}
	for i, want := range expect {
		if frames[i].EventType != want.eventType || frames[i].Text != want.text || frames[i].SessionID != "sess-mixed" {
			t.Fatalf("frame %d mismatch: got %#v want type=%s text=%q", i, frames[i], want.eventType, want.text)
		}
	}
	if frames[2].Payload["name"] != "Read" || frames[2].Payload["id"] != "tool-1" {
		t.Fatalf("tool payload was not preserved: %#v", frames[2].Payload)
	}
}

func TestNormalizeAgentJSONLineFramesPreservesToolResultBlock(t *testing.T) {
	line := `{"type":"user","session_id":"sess-mixed","message":{"content":[{"type":"tool_result","tool_use_id":"tool-1","content":"file contents"}]}}`
	frames := normalizeAgentJSONLineFrames(line)
	if len(frames) != 1 {
		t.Fatalf("expected 1 frame, got %d: %#v", len(frames), frames)
	}
	if frames[0].EventType != "tool_result" || frames[0].SessionID != "sess-mixed" {
		t.Fatalf("unexpected frame: %#v", frames[0])
	}
	if frames[0].Payload["tool_use_id"] != "tool-1" || frames[0].Payload["content"] != "file contents" {
		t.Fatalf("tool result payload was not preserved: %#v", frames[0].Payload)
	}
}

func TestNormalizeAgentJSONLineFramesSuppressesUserAndSystemText(t *testing.T) {
	userLine := `{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"who are u"},{"type":"tool_result","tool_use_id":"tool-1","content":"ok"}]}}`
	frames := normalizeAgentJSONLineFrames(userLine)
	if len(frames) != 1 {
		t.Fatalf("expected only tool_result frame for user turn, got %d: %#v", len(frames), frames)
	}
	if frames[0].EventType != "tool_result" {
		t.Fatalf("expected tool_result, got %s text=%q", frames[0].EventType, frames[0].Text)
	}
	systemLine := `{"type":"system","message":{"content":"Treat yourself as an autonomous senior pair-programmer"}}`
	sframes := normalizeAgentJSONLineFrames(systemLine)
	for _, f := range sframes {
		if f.EventType == "text_delta" || f.EventType == "thinking_delta" {
			t.Fatalf("system prompt leaked into stream as %s: %q", f.EventType, f.Text)
		}
	}
	userStrLine := `{"type":"user","message":{"role":"user","content":"hello world"}}`
	strframes := normalizeAgentJSONLineFrames(userStrLine)
	for _, f := range strframes {
		if f.EventType == "text_delta" && f.Text != "" {
			t.Fatalf("user text leaked into stream as text_delta: %q", f.Text)
		}
	}
}

func TestNormalizeAgentJSONLineFramesRoutesContentBlockDeltaByType(t *testing.T) {
	textLine := `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"assistant says hi"}}`
	frames := normalizeAgentJSONLineFrames(textLine)
	if len(frames) != 1 || frames[0].EventType != "text_delta" || frames[0].Text != "assistant says hi" {
		t.Fatalf("content_block_delta text_delta misrouted: %#v", frames)
	}
	thinkingLine := `{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"let me think"}}`
	tframes := normalizeAgentJSONLineFrames(thinkingLine)
	if len(tframes) != 1 || tframes[0].EventType != "thinking_delta" || tframes[0].Text != "let me think" {
		t.Fatalf("content_block_delta thinking_delta misrouted: %#v", tframes)
	}
	toolLine := `{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"pwd"}}}`
	toolf := normalizeAgentJSONLineFrames(toolLine)
	if len(toolf) != 1 || toolf[0].EventType != "tool_call" {
		t.Fatalf("content_block_start tool_use misrouted: %#v", toolf)
	}
	if toolf[0].Payload["name"] != "Bash" || toolf[0].Payload["id"] != "toolu_1" {
		t.Fatalf("content_block_start tool_use payload missing fields: %#v", toolf[0].Payload)
	}
}

func TestNormalizeAgentJSONLineFramesDropsStreamingWrappersWithoutSessionSpam(t *testing.T) {
	// Streaming wrapper frames (content_block_stop, message_delta, message_stop) are
	// produced by every streaming-json CLI turn. They carry no event content. When the
	// CLI tags every line with a session_id, the old promotion logic turned each of
	// them into a spurious "session" trace event, flooding the UI.
	wrappers := []struct {
		name string
		line string
	}{
		{"content_block_stop", `{"type":"content_block_stop","index":0,"session_id":"sess-wrapping"}`},
		{"message_delta", `{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":null,"session_id":"sess-wrapping"}`},
		{"message_stop", `{"type":"message_stop","session_id":"sess-wrapping"}`},
		{"message_start_empty", `{"type":"message_start","message":{"id":"msg_1","role":"assistant","content":[]},"session_id":"sess-wrapping"}`},
	}
	for _, tc := range wrappers {
		t.Run(tc.name, func(t *testing.T) {
			frames := normalizeAgentJSONLineFrames(tc.line)
			for _, f := range frames {
				if f.EventType == "session" {
					t.Fatalf("%s frame leaked as eventType=session: %#v", tc.name, f)
				}
				if f.EventType == "text_delta" || f.EventType == "thinking_delta" {
					t.Fatalf("%s frame leaked as text/thinking delta: %#v", tc.name, f)
				}
			}
		})
	}
}

func TestLooksLikeSessionNotificationClassifiesCorrectly(t *testing.T) {
	shouldMatch := []map[string]any{
		{"type": "session_created", "sessionId": "s1"},
		{"type": "session_resumed", "sessionId": "s1"},
		{"type": "session", "sessionId": "s1"},
		{"event": "new_session", "id": "s1"},
		{"action": "create_session", "id": "s1"},
	}
	for _, p := range shouldMatch {
		if !looksLikeSessionNotification(p) {
			t.Fatalf("expected payload to look like session notification: %#v", p)
		}
	}
	shouldNotMatch := []map[string]any{
		{"type": "message_start", "session_id": "s1"},
		{"type": "content_block_stop", "session_id": "s1"},
		{"type": "message_delta", "session_id": "s1", "stop_reason": "end_turn"},
		{"type": "tool_use_start", "session_id": "s1", "name": "Bash"},
		{"type": "text_delta", "session_id": "s1", "text": "hi"},
		{},
	}
	for _, p := range shouldNotMatch {
		if looksLikeSessionNotification(p) {
			t.Fatalf("expected payload NOT to look like session notification: %#v", p)
		}
	}
}

// aggregateTextFromFrames runs all provided lines through
// normalizeAgentJSONLineFrames and returns the concatenated text_delta payloads
// plus the count of text_delta frames. This mirrors how pumpAgentStdout in
// agent_runtime.go assembles finalText.
func aggregateTextFromFrames(lines []string) (string, int) {
	var sb strings.Builder
	count := 0
	for _, line := range lines {
		frames := normalizeAgentJSONLineFrames(line)
		for _, f := range frames {
			if f.EventType == "text_delta" && f.Text != "" {
				sb.WriteString(f.Text)
				count++
			}
		}
	}
	return sb.String(), count
}

func TestTraecliStreamJsonWithoutPartialMessagesProducesExactlyOneCopy(t *testing.T) {
	// Simulates a minimal traecli stream-json reply for "你好，世界" using
	// three content_block_delta chunks, followed by message_stop.
	// With --include-partial-messages removed from the traecli argv, the CLI
	// should no longer emit intermediate {"type":"assistant"} snapshots, so
	// the aggregated text must equal exactly the concatenated chunks.
	lines := []string{
		`{"type":"message_start","message":{"id":"msg_1","role":"assistant","content":[]},"session_id":"s1"}`,
		`{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""},"session_id":"s1"}`,
		`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好，"},"session_id":"s1"}`,
		`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"世"},"session_id":"s1"}`,
		`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"界"},"session_id":"s1"}`,
		`{"type":"content_block_stop","index":0,"session_id":"s1"}`,
		`{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":null,"session_id":"s1"}`,
		`{"type":"message_stop","usage":{"input_tokens":10,"output_tokens":3},"session_id":"s1"}`,
	}
	got, count := aggregateTextFromFrames(lines)
	want := "你好，世界"
	if got != want {
		t.Fatalf("expected aggregated text to be %q (1 copy), got %q (chunks=%d)", want, got, count)
	}
	if count != 3 {
		t.Fatalf("expected exactly 3 text_delta frames (one per chunk), got %d: %q", count, got)
	}
}

func TestTraecliStreamJsonPlusFinalResultDoesNotDoubleText(t *testing.T) {
	// Full streaming-json turn simulating what traecli emits without
	// --include-partial-messages: incremental chunks + a trailing result
	// payload. Only the chunks should count towards the streamed text; the
	// trailing result is marked final_result so it only fills in when zero
	// chunks were seen.
	lines := []string{
		`{"type":"message_start","message":{"id":"msg_1","role":"assistant","content":[]},"session_id":"s-full"}`,
		`{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""},"session_id":"s-full"}`,
		`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Alpha"},"session_id":"s-full"}`,
		`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" beta"},"session_id":"s-full"}`,
		`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" gamma"},"session_id":"s-full"}`,
		`{"type":"content_block_stop","index":0,"session_id":"s-full"}`,
		`{"type":"message_delta","delta":{"stop_reason":"end_turn"},"session_id":"s-full"}`,
		`{"type":"message_stop","usage":{},"session_id":"s-full"}`,
		`{"type":"result","result":"Alpha beta gamma"}`,
	}
	var streamedText strings.Builder
	var fallbackText string
	streamedCount := 0
	for _, line := range lines {
		for _, f := range normalizeAgentJSONLineFrames(line) {
			if f.EventType == "text_delta" && f.Text != "" {
				streamedText.WriteString(f.Text)
				streamedCount++
			}
			if f.EventType == "final_result" && f.Text != "" {
				fallbackText = f.Text
			}
		}
	}
	if streamedText.String() != "Alpha beta gamma" {
		t.Fatalf("streamed text delta concatenation wrong: got %q count=%d", streamedText.String(), streamedCount)
	}
	if fallbackText != "Alpha beta gamma" {
		t.Fatalf("final_result fallback should carry the complete answer, got %q", fallbackText)
	}
	if streamedCount != 3 {
		t.Fatalf("expected exactly 3 streamed text_delta frames, got %d", streamedCount)
	}
	// Simulate the pumpAgentStdout caller: only use fallback when streamed
	// text is empty. Here streamed text is present so fallback must NOT be
	// concatenated on top.
	effective := streamedText.String()
	if effective == "" {
		effective = fallbackText
	}
	if effective != "Alpha beta gamma" {
		t.Fatalf("effective final text should be a single copy, got %q", effective)
	}
}

func TestSingleShotResultOnlyUsesFinalResultFallback(t *testing.T) {
	// Non-streaming CLI emits only one {"type":"result","result":"done"}
	// frame (no content_block_delta, no assistant snapshot). Since there are
	// zero text_delta frames, final_result must be promoted to the effective
	// answer by the caller.
	lines := []string{
		`{"type":"result","result":"42"}`,
	}
	var streamedText strings.Builder
	var fallbackText string
	for _, line := range lines {
		for _, f := range normalizeAgentJSONLineFrames(line) {
			if f.EventType == "text_delta" && f.Text != "" {
				streamedText.WriteString(f.Text)
			}
			if f.EventType == "final_result" && f.Text != "" {
				fallbackText = f.Text
			}
		}
	}
	if streamedText.Len() != 0 {
		t.Fatalf("single-shot result should NOT emit text_delta, got %q", streamedText.String())
	}
	if fallbackText != "42" {
		t.Fatalf("single-shot result should produce final_result fallback, got %q", fallbackText)
	}
	effective := streamedText.String()
	if effective == "" {
		effective = fallbackText
	}
	if effective != "42" {
		t.Fatalf("effective final text missing for single-shot CLI: got %q", effective)
	}
}

func TestStandaloneAssistantSnapshotStillProducesTextDelta(t *testing.T) {
	// Non-streaming CLIs (and older flow formats) that only emit a single
	// {"type":"assistant", ...} frame with the full reply must still produce
	// exactly one text_delta event.
	lines := []string{
		`{"type":"assistant","session_id":"s2","message":{"content":"独立快照的回复"}}`,
	}
	got, count := aggregateTextFromFrames(lines)
	if got != "独立快照的回复" || count != 1 {
		t.Fatalf("standalone assistant frame should produce exactly 1 text_delta, got count=%d text=%q", count, got)
	}
}

func TestACPConversationIDPrefersChatIDOverWorkspaceScope(t *testing.T) {
	req := &AgentRunRequestFrame{
		RunID:   "run-1",
		AgentID: "custom-acp",
		Cwd:     t.TempDir(),
		Input: AgentRunInput{
			Prompt:   "hello",
			Metadata: map[string]any{"chatId": "chat-alpha", "workspaceId": "workspace-1"},
		},
		Workspace: &AgentRunWorkspace{Folder: "workspace-1", AgentID: "custom-acp", Scope: "session", ScopeID: "workspace-scope"},
	}
	if got := acpConversationID(req); got != "chat-alpha" {
		t.Fatalf("expected chat id to drive ACP conversation mapping, got %q", got)
	}

	otherChat := *req
	otherInput := req.Input
	otherInput.Metadata = map[string]any{"chatId": "chat-beta", "workspaceId": "workspace-1"}
	otherChat.Input = otherInput
	if acpSessionProcessKey(req) == acpSessionProcessKey(&otherChat) {
		t.Fatalf("expected different chats in the same workspace to use different ACP process keys")
	}
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

func TestACPAdapterPrefersLoadSessionForExistingSession(t *testing.T) {
	methodLog := filepath.Join(t.TempDir(), "methods.log")
	entry := AgentRegistryEntry{
		ID:        "custom-acp",
		Transport: "acp",
		Binary:    os.Args[0],
		Args:      []string{"-test.run=TestACPHelperProcess"},
		Env: map[string]string{
			"GO_WANT_ACP_HELPER_PROCESS":   "1",
			"ACP_HELPER_METHOD_LOG":        methodLog,
			"ACP_HELPER_INITIALIZE_RESULT": `{"protocolVersion":1,"agentCapabilities":{"loadSession":true,"sessionCapabilities":{"resume":{}}}}`,
			"ACP_HELPER_ALLOW_LOAD":        "1",
		},
	}
	cfg := &Config{AgentRegistry: []AgentRegistryEntry{entry}, SessionDir: t.TempDir()}
	adapter := &acpAdapter{
		baseAgentAdapter: baseAgentAdapter{client: AgentClientInfo{ID: entry.ID, Binary: entry.Binary, Transport: entry.Transport}},
		entry:            &entry,
	}
	req := &AgentRunRequestFrame{
		RunID:          "run-acp-load",
		AgentID:        entry.ID,
		Cwd:            t.TempDir(),
		MaxOutputBytes: 1024,
		Input:          AgentRunInput{Prompt: "hello again", SessionID: "sess-existing"},
		Context:        map[string]any{"group": map[string]any{"folder": "demo"}},
	}
	result, err := adapter.RunDirect(context.Background(), cfg, req, func(AgentRunEventFrame) {})
	if err != nil {
		t.Fatal(err)
	}
	if !result.OK || result.SessionID != "sess-existing" {
		t.Fatalf("expected loaded existing ACP session, got %#v", result)
	}
	data, err := os.ReadFile(methodLog)
	if err != nil {
		t.Fatal(err)
	}
	methods := strings.Split(strings.TrimSpace(string(data)), "\n")
	want := []string{"initialize", "session/load", "session/prompt"}
	if strings.Join(methods, ",") != strings.Join(want, ",") {
		t.Fatalf("expected ACP methods %v, got %v", want, methods)
	}
}

func TestACPAdapterReusesLiveSessionProcessForConversation(t *testing.T) {
	methodLog := filepath.Join(t.TempDir(), "methods.log")
	entry := AgentRegistryEntry{
		ID:        "custom-acp-live",
		Transport: "acp",
		Binary:    os.Args[0],
		Args:      []string{"-test.run=TestACPHelperProcess"},
		Env: map[string]string{
			"GO_WANT_ACP_HELPER_PROCESS": "1",
			"ACP_HELPER_METHOD_LOG":      methodLog,
			"ACP_HELPER_KEEP_RUNNING":    "1",
			"ACP_HELPER_NEW_SESSION_ID":  "sess-live",
		},
	}
	cfg := &Config{AgentRegistry: []AgentRegistryEntry{entry}, SessionDir: t.TempDir(), StateDir: t.TempDir()}
	adapter := &acpAdapter{baseAgentAdapter: baseAgentAdapter{client: AgentClientInfo{ID: entry.ID, Binary: entry.Binary, Transport: entry.Transport}}, entry: &entry}
	cwd := t.TempDir()
	baseReq := func(runID, prompt string) *AgentRunRequestFrame {
		return &AgentRunRequestFrame{
			RunID:          runID,
			AgentID:        entry.ID,
			Cwd:            cwd,
			MaxOutputBytes: 1024,
			Input:          AgentRunInput{Prompt: prompt},
			Workspace:      &AgentRunWorkspace{Folder: "demo", AgentID: entry.ID, Scope: "session", ScopeID: "aaa"},
			Context:        map[string]any{"group": map[string]any{"folder": "demo"}},
		}
	}
	defer func() {
		key := acpSessionProcessKey(baseReq("cleanup", ""))
		acpProcessesMu.Lock()
		proc := acpProcesses[key]
		delete(acpProcesses, key)
		acpProcessesMu.Unlock()
		if proc != nil {
			proc.stop()
		}
	}()
	first, err := adapter.RunDirect(context.Background(), cfg, baseReq("run-live-1", "hello"), func(AgentRunEventFrame) {})
	if err != nil || !first.OK || first.SessionID != "sess-live" {
		t.Fatalf("unexpected first result: %#v err=%v", first, err)
	}
	second, err := adapter.RunDirect(context.Background(), cfg, baseReq("run-live-2", "again"), func(AgentRunEventFrame) {})
	if err != nil || !second.OK || second.SessionID != "sess-live" {
		t.Fatalf("unexpected second result: %#v err=%v", second, err)
	}
	data, err := os.ReadFile(methodLog)
	if err != nil {
		t.Fatal(err)
	}
	methods := strings.Split(strings.TrimSpace(string(data)), "\n")
	want := []string{"initialize", "session/new", "session/prompt", "session/prompt"}
	if strings.Join(methods, ",") != strings.Join(want, ",") {
		t.Fatalf("expected ACP methods %v, got %v", want, methods)
	}
}

func TestACPAdapterResumesMappedSessionAfterProcessExit(t *testing.T) {
	methodLog := filepath.Join(t.TempDir(), "methods.log")
	entry := AgentRegistryEntry{
		ID:        "custom-acp-resume",
		Transport: "acp",
		Binary:    os.Args[0],
		Args:      []string{"-test.run=TestACPHelperProcess"},
		Env: map[string]string{
			"GO_WANT_ACP_HELPER_PROCESS":   "1",
			"ACP_HELPER_METHOD_LOG":        methodLog,
			"ACP_HELPER_INITIALIZE_RESULT": `{"protocolVersion":1,"agentCapabilities":{"loadSession":true,"sessionCapabilities":{"resume":{}}}}`,
			"ACP_HELPER_ALLOW_LOAD":        "1",
			"ACP_HELPER_NEW_SESSION_ID":    "sess-persisted",
		},
	}
	cfg := &Config{AgentRegistry: []AgentRegistryEntry{entry}, SessionDir: t.TempDir(), StateDir: t.TempDir()}
	adapter := &acpAdapter{baseAgentAdapter: baseAgentAdapter{client: AgentClientInfo{ID: entry.ID, Binary: entry.Binary, Transport: entry.Transport}}, entry: &entry}
	cwd := t.TempDir()
	baseReq := func(runID, prompt string) *AgentRunRequestFrame {
		return &AgentRunRequestFrame{
			RunID:          runID,
			AgentID:        entry.ID,
			Cwd:            cwd,
			MaxOutputBytes: 1024,
			Input:          AgentRunInput{Prompt: prompt},
			Workspace:      &AgentRunWorkspace{Folder: "demo", AgentID: entry.ID, Scope: "session", ScopeID: "aaa"},
			Context:        map[string]any{"group": map[string]any{"folder": "demo"}},
		}
	}
	first, err := adapter.RunDirect(context.Background(), cfg, baseReq("run-resume-1", "hello"), func(AgentRunEventFrame) {})
	if err != nil || !first.OK || first.SessionID != "sess-persisted" {
		t.Fatalf("unexpected first result: %#v err=%v", first, err)
	}
	time.Sleep(100 * time.Millisecond)
	second, err := adapter.RunDirect(context.Background(), cfg, baseReq("run-resume-2", "again"), func(AgentRunEventFrame) {})
	if err != nil || !second.OK || second.SessionID != "sess-persisted" {
		t.Fatalf("unexpected second result: %#v err=%v", second, err)
	}
	data, err := os.ReadFile(methodLog)
	if err != nil {
		t.Fatal(err)
	}
	methods := strings.Split(strings.TrimSpace(string(data)), "\n")
	want := []string{"initialize", "session/new", "session/prompt", "initialize", "session/load", "session/prompt"}
	if strings.Join(methods, ",") != strings.Join(want, ",") {
		t.Fatalf("expected ACP methods %v, got %v", want, methods)
	}
}

func TestDeleteACPSessionRecordsRemovesLocalMapping(t *testing.T) {
	cfg := &Config{StateDir: t.TempDir()}
	rec := acpSessionMapRecord{
		Key:            "custom-acp:abc",
		ConversationID: "chat-1",
		AgentID:        "custom-acp",
		CLIName:        "Custom ACP",
		Provider:       "claude-code",
		Transport:      "acp",
		Model:          "sonnet",
		Cwd:            t.TempDir(),
		SessionID:      "sess-delete",
	}
	if err := writeACPSessionRecord(cfg, rec); err != nil {
		t.Fatal(err)
	}
	if _, ok := lookupACPSessionRecord(cfg, rec.Key); !ok {
		t.Fatalf("expected session mapping to be persisted")
	}
	if deleted := deleteACPSessionRecords(cfg, rec.AgentID, rec.SessionID); deleted != 1 {
		t.Fatalf("expected one deleted mapping, got %d", deleted)
	}
	if _, ok := lookupACPSessionRecord(cfg, rec.Key); ok {
		t.Fatalf("expected local session mapping to be removed")
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
		if p := os.Getenv("ACP_HELPER_METHOD_LOG"); p != "" {
			f, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
			if err == nil {
				_, _ = f.WriteString(msg.Method + "\n")
				_ = f.Close()
			}
		}
		switch msg.Method {
		case "initialize":
			result := os.Getenv("ACP_HELPER_INITIALIZE_RESULT")
			if result == "" {
				result = `{"protocolVersion":1}`
			}
			writeACPHelperMessage(enc, runtimeRPCMessage{JSONRPC: "2.0", ID: msg.ID, Result: rawACPHelperJSON(result)})
		case "session/load":
			if os.Getenv("ACP_HELPER_ALLOW_LOAD") == "1" {
				writeACPHelperMessage(enc, runtimeRPCMessage{JSONRPC: "2.0", ID: msg.ID, Result: rawACPHelperJSON(`null`)})
			} else {
				writeACPHelperMessage(enc, runtimeRPCMessage{JSONRPC: "2.0", ID: msg.ID, Error: &runtimeRPCError{Code: -32601, Message: "method not found"}})
			}
		case "session/resume":
			writeACPHelperMessage(enc, runtimeRPCMessage{JSONRPC: "2.0", ID: msg.ID, Result: rawACPHelperJSON(`{}`)})
		case "session/new":
			sessionID := os.Getenv("ACP_HELPER_NEW_SESSION_ID")
			if sessionID == "" {
				sessionID = "sess-jsonrpc"
			}
			writeACPHelperMessage(enc, runtimeRPCMessage{JSONRPC: "2.0", ID: msg.ID, Result: rawACPHelperJSON(`{"sessionId":"` + sessionID + `"}`)})
		case "session/prompt":
			sessionID := acpHelperSessionIDFromParams(msg.Params)
			writeACPHelperMessage(enc, runtimeRPCMessage{JSONRPC: "2.0", Method: "session/update", Params: rawACPHelperJSON(`{"sessionId":"` + sessionID + `","update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"thinking about it"}}}`)})
			writeACPHelperMessage(enc, runtimeRPCMessage{JSONRPC: "2.0", Method: "session/update", Params: rawACPHelperJSON(`{"sessionId":"` + sessionID + `","update":{"sessionUpdate":"tool_call","toolCallId":"tool-1","title":"Read","status":"pending","rawInput":{"file":"README.md"}}}`)})
			writeACPHelperMessage(enc, runtimeRPCMessage{JSONRPC: "2.0", Method: "session/update", Params: rawACPHelperJSON(`{"sessionId":"` + sessionID + `","update":{"sessionUpdate":"tool_call_update","toolCallId":"tool-1","status":"completed","rawOutput":"ok"}}`)})
			writeACPHelperMessage(enc, runtimeRPCMessage{JSONRPC: "2.0", Method: "session/update", Params: rawACPHelperJSON(`{"sessionId":"` + sessionID + `","update":{"sessionUpdate":"usage_update","size":15,"used":15}}`)})
			writeACPHelperMessage(enc, runtimeRPCMessage{JSONRPC: "2.0", Method: "session/update", Params: rawACPHelperJSON(`{"sessionId":"` + sessionID + `","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"assistant reply"}}}`)})
			time.Sleep(20 * time.Millisecond)
			writeACPHelperMessage(enc, runtimeRPCMessage{JSONRPC: "2.0", ID: msg.ID, Result: rawACPHelperJSON(`{"stopReason":"end_turn","usage":{"inputTokens":12,"outputTokens":3,"totalTokens":15}}`)})
			if os.Getenv("ACP_HELPER_KEEP_RUNNING") != "1" {
				os.Exit(0)
			}
		default:
			writeACPHelperMessage(enc, runtimeRPCMessage{JSONRPC: "2.0", ID: msg.ID, Error: &runtimeRPCError{Code: -32601, Message: "method not found"}})
		}
	}
	os.Exit(0)
}

func acpHelperSessionIDFromParams(raw json.RawMessage) string {
	var params map[string]any
	if len(raw) > 0 && json.Unmarshal(raw, &params) == nil {
		if id, _ := params["sessionId"].(string); id != "" {
			return id
		}
	}
	return "sess-jsonrpc"
}

func rawACPHelperJSON(s string) json.RawMessage {
	return json.RawMessage(s)
}

func writeACPHelperMessage(enc *json.Encoder, msg runtimeRPCMessage) {
	if err := enc.Encode(msg); err != nil {
		os.Exit(2)
	}
}
