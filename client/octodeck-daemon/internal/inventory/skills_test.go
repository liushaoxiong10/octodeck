package inventory

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestScanSkillDirectoryIncludesSymlinkedSkillDirectories(t *testing.T) {
	root := t.TempDir()
	skillsRoot := filepath.Join(root, "skills")
	realSkillDir := filepath.Join(root, "store", "linked-skill")
	writeSkill(t, filepath.Join(realSkillDir, "SKILL.md"), `---
name: Linked Skill
description: Installed by skills CLI through a symlink
---
# Linked Skill
`)
	if err := os.MkdirAll(skillsRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(realSkillDir, filepath.Join(skillsRoot, "linked-skill")); err != nil {
		t.Fatal(err)
	}

	skills := ScanSkillDirectory(skillsRoot, "cli")
	if len(skills) != 1 {
		t.Fatalf("expected symlinked skill directory to be discovered, got %#v", skills)
	}
	if got := skills[0]; got.ID != "linked-skill" || got.Name != "Linked Skill" || got.Source != "cli" || !got.Enabled {
		t.Fatalf("unexpected symlinked skill: %#v", got)
	}
}

func TestScanSkillDirectoryIncludesPackageNameAndContent(t *testing.T) {
	root := t.TempDir()
	skillsRoot := filepath.Join(root, "skills")
	skillContent := `---
name: Packaged Skill
description: Installed from a package
---
# Packaged Skill

Full instructions for the packaged skill.
`
	writeSkill(t, filepath.Join(skillsRoot, "packaged-skill", "SKILL.md"), skillContent)
	writeSkill(t, filepath.Join(skillsRoot, "local-skill", "SKILL.md"), `---
name: Local Skill
description: No package metadata
---
# Local Skill
`)
	manifest := `{"skills":{"packaged-skill":{"packageName":"owner/repo@packaged-skill","installedAt":"2026-05-31T00:00:00.000Z","source":"skills.sh"}}}`
	if err := os.WriteFile(filepath.Join(skillsRoot, ".skills-manifest.json"), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}

	skills := ScanSkillDirectory(skillsRoot, "cli")
	if len(skills) != 2 {
		t.Fatalf("expected two skills, got %#v", skills)
	}

	byID := map[string]SkillInfo{}
	for _, skill := range skills {
		byID[skill.ID] = skill
	}
	packaged := byID["packaged-skill"]
	if packaged.PackageName != "owner/repo@packaged-skill" {
		t.Fatalf("unexpected package name: %#v", packaged)
	}
	if packaged.Content != skillContent {
		t.Fatalf("unexpected content: %q", packaged.Content)
	}
	local := byID["local-skill"]
	if local.PackageName != "" {
		t.Fatalf("local skill should have empty package name, got %#v", local)
	}
	if local.Content == "" {
		t.Fatalf("local skill should include content: %#v", local)
	}
}

func TestScanSkillDirectoryTruncatesLargeSkillContent(t *testing.T) {
	root := t.TempDir()
	skillsRoot := filepath.Join(root, "skills")
	largeBody := strings.Repeat("a", maxSkillContentBytes+1024)
	writeSkill(t, filepath.Join(skillsRoot, "large-skill", "SKILL.md"), `---
name: Large Skill
description: Large content
---
`+largeBody)

	skills := ScanSkillDirectory(skillsRoot, "cli")
	if len(skills) != 1 {
		t.Fatalf("expected one skill, got %#v", skills)
	}
	if len(skills[0].Content) != maxSkillContentBytes {
		t.Fatalf("expected content to be truncated to %d bytes, got %d", maxSkillContentBytes, len(skills[0].Content))
	}
}

func TestScanSkillDirectorySkipsUnsafeAndNonDirectoryEntries(t *testing.T) {
	root := t.TempDir()
	skillsRoot := filepath.Join(root, "skills")
	writeSkill(t, filepath.Join(skillsRoot, "valid-skill", "SKILL.md"), `---
name: Valid Skill
description: Safe skill
---
# Valid Skill
`)
	if err := os.WriteFile(filepath.Join(skillsRoot, "regular-file"), []byte("not a skill"), 0o644); err != nil {
		t.Fatal(err)
	}
	regularTarget := filepath.Join(root, "not-a-directory")
	if err := os.WriteFile(regularTarget, []byte("not a directory"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(regularTarget, filepath.Join(skillsRoot, "linked-file")); err != nil {
		t.Fatal(err)
	}
	writeSkill(t, filepath.Join(skillsRoot, `unsafe\skill`, "SKILL.md"), `---
name: Unsafe Skill
description: Should be skipped
---
# Unsafe Skill
`)

	skills := ScanSkillDirectory(skillsRoot, "cli")
	if len(skills) != 1 {
		t.Fatalf("expected only one safe skill directory, got %#v", skills)
	}
	if got := skills[0]; got.ID != "valid-skill" || got.Name != "Valid Skill" {
		t.Fatalf("unexpected skill: %#v", got)
	}
}

func TestParseSkillFrontmatterSupportsBlockDescription(t *testing.T) {
	name, description := parseSkillFrontmatter(`---
name: block-skill
description: |
  First line of description.
  Second line of description.
---
# Block Skill
`)

	if name != "block-skill" {
		t.Fatalf("unexpected name: %q", name)
	}
	if description != "First line of description.\nSecond line of description." {
		t.Fatalf("unexpected block description: %q", description)
	}
}

func TestParseSkillFrontmatterSupportsBlockDescriptionIndicators(t *testing.T) {
	name, description := parseSkillFrontmatter(`---
name: folded-skill
description: >-
  First line of description.
  Second line of description.
---
# Folded Skill
`)

	if name != "folded-skill" {
		t.Fatalf("unexpected name: %q", name)
	}
	if description != "First line of description. Second line of description." {
		t.Fatalf("unexpected folded description: %q", description)
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
