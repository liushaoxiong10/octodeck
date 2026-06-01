package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestDiscoverProviderSkillsScansWorkspaceAndCliSkills(t *testing.T) {
	root := t.TempDir()
	workspace := filepath.Join(root, "workspace")
	home := filepath.Join(root, "home")
	binDir := filepath.Join(root, "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	claudeBin := filepath.Join(binDir, "claude")
	if err := os.WriteFile(claudeBin, []byte("#!/bin/sh\necho claude test\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	writeSkill(t, filepath.Join(workspace, ".claude", "skills", "workspace-skill", "SKILL.md"), `---
name: Workspace Skill
description: Helps inside this workspace
---
# Workspace Skill
`)
	writeSkill(t, filepath.Join(home, ".claude", "skills", "cli-skill", "SKILL.md.disabled"), `---
name: CLI Skill
description: Installed in CLI home
---
# CLI Skill
`)

	t.Setenv("PATH", binDir+string(os.PathListSeparator)+"/usr/bin:/bin")
	t.Setenv("HCAGENT_EXTRA_PATH", "")
	t.Setenv("HOME", home)

	result, err := discoverProviderSkills(context.Background(), "claude-code", workspace)
	if err != nil {
		t.Fatalf("discoverProviderSkills returned error: %v", err)
	}
	if len(result.WorkspaceSkills) != 1 {
		t.Fatalf("expected 1 workspace skill, got %#v", result.WorkspaceSkills)
	}
	if got := result.WorkspaceSkills[0]; got.ID != "workspace-skill" || got.Name != "Workspace Skill" || got.Description != "Helps inside this workspace" || got.Source != "workspace" || !got.Enabled {
		t.Fatalf("unexpected workspace skill: %#v", got)
	}
	if len(result.CLISkills) != 1 {
		t.Fatalf("expected 1 cli skill, got %#v", result.CLISkills)
	}
	if got := result.CLISkills[0]; got.ID != "cli-skill" || got.Name != "CLI Skill" || got.Description != "Installed in CLI home" || got.Source != "cli" || got.Enabled {
		t.Fatalf("unexpected cli skill: %#v", got)
	}
}

func writeSkill(t *testing.T, path string, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}
