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
	t.Setenv("HCAGENT_EXTRA_PATH", "")

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
