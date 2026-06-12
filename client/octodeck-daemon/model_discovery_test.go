package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestDiscoverProviderModelsUsesTraeCliModelsJSON(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "traecli")
	script := `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "coco version test"
  exit 0
fi
if [ "$1" = "models" ] && [ "$2" = "--json" ]; then
  cat <<'JSON'
[
  {"name":"Seed-Dogfooding-2.0","real_name":"Seed-Dogfooding-2.0","description":"Context window: 184k"},
  {"name":"GPT-5.5","real_name":"GPT-5.5","description":"Context window: 240k"}
]
JSON
  exit 0
fi
echo "unexpected args: $*" >&2
exit 2
`
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+"/usr/bin:/bin")
	t.Setenv("OCTODECK_DAEMON_EXTRA_PATH", "")
	// 隔离开发机上真实存在的 ~/.trae/cli/models_cache.json，否则
	// readCliModelsCache 会优先命中真实缓存。
	t.Setenv("HOME", dir)

	models, err := discoverProviderModels(context.Background(), "traecli")
	if err != nil {
		t.Fatalf("discoverProviderModels returned error: %v", err)
	}
	if len(models) != 2 {
		t.Fatalf("expected 2 models, got %#v", models)
	}
	if models[0].ID != "Seed-Dogfooding-2.0" || models[0].DisplayName != "Seed-Dogfooding-2.0" {
		t.Fatalf("unexpected first model: %#v", models[0])
	}
	if models[1].ID != "GPT-5.5" || models[1].DisplayName != "GPT-5.5" {
		t.Fatalf("unexpected second model: %#v", models[1])
	}
}

func TestDiscoverProviderModelsFallsBackWhenTraeCliModelsJSONFails(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "traecli")
	script := `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "coco version test"
  exit 0
fi
if [ "$1" = "models" ] && [ "$2" = "--json" ]; then
  echo "not logged in" >&2
  exit 1
fi
echo "unexpected args: $*" >&2
exit 2
`
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+"/usr/bin:/bin")
	t.Setenv("OCTODECK_DAEMON_EXTRA_PATH", "")
	t.Setenv("HOME", dir)

	models, err := discoverProviderModels(context.Background(), "traecli")
	if err != nil {
		t.Fatalf("discoverProviderModels should fall back instead of returning error: %v", err)
	}
	if len(models) != 1 || models[0].ID != "default" {
		t.Fatalf("expected default fallback model, got %#v", models)
	}
}

func TestDiscoverProviderModelsReadsCodexModelsCache(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "codex")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\necho 'codex 0.0.0'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+"/usr/bin:/bin")
	t.Setenv("OCTODECK_DAEMON_EXTRA_PATH", "")
	t.Setenv("HOME", dir)
	cache := filepath.Join(dir, ".codex")
	if err := os.MkdirAll(cache, 0o755); err != nil {
		t.Fatal(err)
	}
	cachePayload := []byte(`{"fetched_at":"now","models":[
		{"slug":"gpt-5.4-mini","display_name":"GPT-5.4-Mini","visibility":"list","supported_in_api":true},
		{"slug":"codex-auto-review","display_name":"Codex Auto Review","visibility":"hide","supported_in_api":true},
		{"slug":"gpt-5.5","display_name":"GPT-5.5","visibility":"list","supported_in_api":true}
	]}`)
	if err := os.WriteFile(filepath.Join(cache, "models_cache.json"), cachePayload, 0o644); err != nil {
		t.Fatal(err)
	}

	models, err := discoverProviderModels(context.Background(), "codex")
	if err != nil {
		t.Fatalf("discoverProviderModels returned error: %v", err)
	}
	// hidden 条目必须被过滤掉，list 条目必须按缓存顺序保留。
	if len(models) != 2 || models[0].ID != "gpt-5.4-mini" || models[1].ID != "gpt-5.5" {
		t.Fatalf("unexpected codex models: %#v", models)
	}
	if models[0].DisplayName != "GPT-5.4-Mini" || models[1].DisplayName != "GPT-5.5" {
		t.Fatalf("unexpected display names: %#v", models)
	}

	// codex-acp 与 codex 共享 ~/.codex/models_cache.json
	models, err = discoverProviderModels(context.Background(), "codex-acp")
	if err == nil && len(models) != 2 {
		t.Fatalf("codex-acp should reuse codex cache, got %#v err=%v", models, err)
	}
}


func TestReadClaudeSettingsModelsParsesEnvVars(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir := filepath.Join(home, ".claude")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	payload := []byte(`{
  "env": {
    "ANTHROPIC_MODEL": "xmtp/mimo-v2.5-pro",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "ark/GLM-5.1",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "coco/Kimi-K2.6",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "ark/MiniMax-M2.7"
  }
}`)
	if err := os.WriteFile(filepath.Join(dir, "settings.json"), payload, 0o644); err != nil {
		t.Fatal(err)
	}
	models := readClaudeSettingsModels()
	if len(models) != 4 {
		t.Fatalf("expected 4 models, got %d: %#v", len(models), models)
	}
	ids := []string{models[0].ID, models[1].ID, models[2].ID, models[3].ID}
	want := []string{"xmtp/mimo-v2.5-pro", "ark/GLM-5.1", "coco/Kimi-K2.6", "ark/MiniMax-M2.7"}
	for i, id := range want {
		if ids[i] != id {
			t.Fatalf("models[%d].ID = %q, want %q", i, ids[i], id)
		}
	}
	if models[0].DisplayName == "" {
		t.Fatalf("expected DisplayName populated, got %#v", models[0])
	}
}

func TestReadClaudeSettingsModelsDeduplicatesAndSkipsEmpty(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir := filepath.Join(home, ".claude")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	payload := []byte(`{
  "env": {
    "ANTHROPIC_MODEL": "shared-model",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "shared-model",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "  ",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "opus-only"
  }
}`)
	if err := os.WriteFile(filepath.Join(dir, "settings.json"), payload, 0o644); err != nil {
		t.Fatal(err)
	}
	models := readClaudeSettingsModels()
	if len(models) != 2 {
		t.Fatalf("expected dedup to 2 models, got %d: %#v", len(models), models)
	}
	if models[0].ID != "shared-model" || models[1].ID != "opus-only" {
		t.Fatalf("unexpected order: %#v", models)
	}
}

func TestReadClaudeSettingsModelsReturnsNilWhenMissing(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if got := readClaudeSettingsModels(); got != nil {
		t.Fatalf("expected nil for missing settings.json, got %#v", got)
	}
}

func TestDiscoverProviderModelsPrefersClaudeSettings(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	binDir := filepath.Join(home, "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(binDir, "claude")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\necho claude 1.0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+"/usr/bin:/bin")
	t.Setenv("OCTODECK_DAEMON_EXTRA_PATH", "")

	claudeDir := filepath.Join(home, ".claude")
	if err := os.MkdirAll(claudeDir, 0o755); err != nil {
		t.Fatal(err)
	}
	payload := []byte(`{"env":{"ANTHROPIC_MODEL":"company/proxy-model"}}`)
	if err := os.WriteFile(filepath.Join(claudeDir, "settings.json"), payload, 0o644); err != nil {
		t.Fatal(err)
	}

	models, err := discoverProviderModels(context.Background(), "claude-acp")
	if err != nil {
		t.Fatalf("discover failed: %v", err)
	}
	if len(models) == 0 || models[0].ID != "company/proxy-model" {
		t.Fatalf("expected claude settings model first, got %#v", models)
	}
}
