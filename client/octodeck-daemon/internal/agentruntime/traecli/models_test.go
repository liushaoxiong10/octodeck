package traecli

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	agentclient "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentclient"
	agentcore "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentcore"
)

func TestListModelsPrefersLiveCliOverCache(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)

	cacheDir := filepath.Join(tmp, ".trae", "cli")
	if err := os.MkdirAll(cacheDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cacheDir, "models_cache.json"), []byte(`{
  "models": [
    {"slug":"GLM-5","config_name":"glm-5","visibility":"list","supported_in_api":true}
  ]
}`), 0o644); err != nil {
		t.Fatal(err)
	}

	binary := filepath.Join(tmp, "traecli")
	if err := os.WriteFile(binary, []byte("#!/bin/sh\nprintf '%s\n' '[{\"name\":\"GPT-5.2\",\"real_name\":\"GPT-5.2\"}]'\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	agent := &Agent{BaseAgent: agentcore.BaseAgent{Client: agentclient.Info{Binary: binary}}}
	models, err := agent.ListModels(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	if len(models) != 1 || models[0].ID != "GPT-5.2" {
		t.Fatalf("expected live CLI models, got %#v", models)
	}
}

func TestParseTraeCliModelsCacheUsesConfigNameAsID(t *testing.T) {
	models := parseTraeCliModelsCache([]byte(`{
  "models": [
    {"slug":"GLM-5","config_name":"glm-5","visibility":"list","supported_in_api":true}
  ]
}`))

	if len(models) != 1 {
		t.Fatalf("expected one model, got %#v", models)
	}
	if models[0].ID != "glm-5" || models[0].DisplayName != "GLM-5" {
		t.Fatalf("expected config_name id with slug display name, got %#v", models[0])
	}
}
