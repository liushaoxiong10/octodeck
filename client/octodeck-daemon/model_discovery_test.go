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
