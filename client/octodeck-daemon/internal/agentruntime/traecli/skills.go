// Package traecli — skill discovery (SkillProvider implementation).
//
// This file owns the Trae CLI family's skill discovery logic end-to-end.
//
// Search roots:
//
//   - workspace: <cwd>/skills, <cwd>/.claude/skills, <cwd>/.trae/skills
//   - cli:       ~/.claude/skills, ~/.trae/skills
//
// (The .claude/skills roots are intentional: trae CLI honours both its
// native ~/.trae/skills directory and the cross-family ~/.claude/skills
// pool, mirroring the historical inventory behaviour.)
//
// All scanning helpers below are private to this package. The C-stage
// migration pulled the relevant logic out of internal/inventory/skills.go
// so that the daemon main loop can satisfy proto-level skill listing
// through the agentruntime.SkillProvider type assertion alone.
package traecli

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"

	agentclient "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentclient"
	agentcore "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentcore"
	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
)

// HasAllowedTools reports whether the request policy carries an explicit
// AllowedTools list.
func HasAllowedTools(req *proto.AgentRunRequestFrame) bool {
	return req != nil && len(req.Policy.AllowedTools) > 0
}

// ListSkills implements agentruntime.SkillProvider for the Trae CLI family.
//
// Returns workspace-side and cli-side skills as separate slices. Errors
// from missing roots are silently ignored (the directory simply contributes
// zero skills).
func (a *Agent) ListSkills(ctx context.Context, cwd string) (agentclient.SkillsResult, error) {
	if err := ctx.Err(); err != nil {
		return agentclient.SkillsResult{}, err
	}

	if strings.TrimSpace(cwd) == "" {
		if wd, err := os.Getwd(); err == nil {
			cwd = wd
		}
	}

	workspaceRoots, cliRoots := traeCliSkillSearchRoots(cwd)
	provider := "traecli"
	return agentclient.SkillsResult{
		WorkspaceSkills: scanTraeCliSkillDirectories(workspaceRoots, skillScanContext{Source: "workspace", SourceProvider: provider}),
		CLISkills:       scanTraeCliSkillDirectories(cliRoots, skillScanContext{Source: "cli", SourceProvider: provider}),
	}, nil
}

// traeCliSkillSearchRoots returns the workspace and cli search roots for
// the trae CLI family. Mirrors the relevant rows of inventory.skillSearchRoots.
func traeCliSkillSearchRoots(cwd string) ([]string, []string) {
	home, _ := os.UserHomeDir()

	workspaceRoots := make([]string, 0, 3)
	cliRoots := make([]string, 0, 2)
	if strings.TrimSpace(cwd) != "" {
		workspaceRoots = append(workspaceRoots,
			filepath.Join(cwd, "skills"),
			filepath.Join(cwd, ".claude", "skills"),
			filepath.Join(cwd, ".trae", "skills"),
		)
	}
	if home != "" {
		cliRoots = append(cliRoots,
			filepath.Join(home, ".claude", "skills"),
			filepath.Join(home, ".trae", "skills"),
		)
	}
	return dedupeSkillPaths(workspaceRoots), dedupeSkillPaths(cliRoots)
}

// --- private skill scanning helpers (copied from inventory.skills) ---

const maxSkillContentBytes = 200_000

type skillScanContext struct {
	Source         string
	SourceProvider string
}

type skillsManifest struct {
	Skills map[string]struct {
		PackageName string `json:"packageName"`
		InstalledAt string `json:"installedAt"`
		Source      string `json:"source"`
	} `json:"skills"`
}

func dedupeSkillPaths(paths []string) []string {
	out := make([]string, 0, len(paths))
	seen := map[string]struct{}{}
	for _, p := range paths {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		cleaned := filepath.Clean(p)
		if _, ok := seen[cleaned]; ok {
			continue
		}
		seen[cleaned] = struct{}{}
		out = append(out, cleaned)
	}
	return out
}

func scanTraeCliSkillDirectories(roots []string, scanCtx skillScanContext) []agentclient.SkillInfo {
	merged := make([]agentclient.SkillInfo, 0)
	seen := map[string]struct{}{}
	for _, root := range roots {
		for _, skill := range scanTraeCliSkillDirectory(root, scanCtx) {
			if _, ok := seen[skill.ID]; ok {
				continue
			}
			seen[skill.ID] = struct{}{}
			merged = append(merged, skill)
		}
	}
	sort.Slice(merged, func(i, j int) bool { return merged[i].ID < merged[j].ID })
	return merged
}

func scanTraeCliSkillDirectory(root string, scanCtx skillScanContext) []agentclient.SkillInfo {
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	manifest := readTraeCliSkillsManifest(root)
	skills := make([]agentclient.SkillInfo, 0, len(entries))
	for _, entry := range entries {
		if !isSafeSkillID(entry.Name()) {
			continue
		}
		skillDir := filepath.Join(root, entry.Name())
		if !isSkillDirectory(entry, skillDir) {
			continue
		}
		enabledPath := filepath.Join(skillDir, "SKILL.md")
		disabledPath := filepath.Join(skillDir, "SKILL.md.disabled")
		path := enabledPath
		enabled := true
		if _, err := os.Stat(enabledPath); err != nil {
			if _, derr := os.Stat(disabledPath); derr != nil {
				continue
			}
			path = disabledPath
			enabled = false
		}
		content, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		content = truncateSkillContent(content)
		name, description := parseSkillFrontmatter(string(content))
		if name == "" {
			name = entry.Name()
		}
		packageName := manifest.packageNameFor(entry.Name())
		level := "skill"
		levelKey := entry.Name()
		if packageName != "" {
			level = "package"
			levelKey = packageName
		}
		skills = append(skills, agentclient.SkillInfo{
			ID:             entry.Name(),
			Name:           name,
			Description:    description,
			Source:         scanCtx.Source,
			SourceProvider: scanCtx.SourceProvider,
			Level:          level,
			LevelKey:       levelKey,
			Enabled:        enabled,
			PackageName:    packageName,
			PackageSource:  manifest.packageSourceFor(entry.Name()),
			InstalledAt:    manifest.installedAtFor(entry.Name()),
			Content:        string(content),
		})
	}
	sort.Slice(skills, func(i, j int) bool { return skills[i].ID < skills[j].ID })
	return skills
}

func truncateSkillContent(content []byte) []byte {
	if len(content) <= maxSkillContentBytes {
		return content
	}
	return content[:maxSkillContentBytes]
}

func readTraeCliSkillsManifest(root string) skillsManifest {
	data, err := os.ReadFile(filepath.Join(root, ".skills-manifest.json"))
	if err != nil {
		return skillsManifest{}
	}
	var manifest skillsManifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return skillsManifest{}
	}
	return manifest
}

func (m skillsManifest) packageNameFor(skillID string) string {
	if m.Skills == nil {
		return ""
	}
	return m.Skills[skillID].PackageName
}

func (m skillsManifest) packageSourceFor(skillID string) string {
	if m.Skills == nil {
		return ""
	}
	return m.Skills[skillID].Source
}

func (m skillsManifest) installedAtFor(skillID string) string {
	if m.Skills == nil {
		return ""
	}
	return m.Skills[skillID].InstalledAt
}

func isSkillDirectory(entry os.DirEntry, path string) bool {
	if entry.IsDir() {
		return true
	}
	if entry.Type()&os.ModeSymlink == 0 {
		return false
	}
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

func isSafeSkillID(id string) bool {
	if id == "" || id == "." || id == ".." {
		return false
	}
	return !strings.ContainsAny(id, `/\\`)
}

func parseSkillFrontmatter(content string) (string, string) {
	content = strings.ReplaceAll(content, "\r\n", "\n")
	if !strings.HasPrefix(content, "---\n") {
		return "", ""
	}
	rest := strings.TrimPrefix(content, "---\n")
	end := strings.Index(rest, "\n---")
	if end < 0 {
		return "", ""
	}
	var name string
	var description string
	lines := strings.Split(rest[:end], "\n")
	for i := 0; i < len(lines); i++ {
		line := lines[i]
		key, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		value = strings.Trim(strings.TrimSpace(value), `"'`)
		switch strings.TrimSpace(key) {
		case "name":
			name = value
		case "description":
			if folded, ok := parseBlockScalarHeader(value); ok {
				block, next := collectFrontmatterBlock(lines, i+1, folded)
				description = block
				i = next - 1
				continue
			}
			description = value
		}
	}
	return name, description
}

func parseBlockScalarHeader(value string) (bool, bool) {
	if value == "" {
		return false, false
	}
	switch value[0] {
	case '|', '>':
		for _, r := range value[1:] {
			if r != '-' && r != '+' && (r < '0' || r > '9') {
				return false, false
			}
		}
		return value[0] == '>', true
	default:
		return false, false
	}
}

func collectFrontmatterBlock(lines []string, start int, folded bool) (string, int) {
	block := make([]string, 0)
	for i := start; i < len(lines); i++ {
		line := lines[i]
		if strings.TrimSpace(line) == "" {
			block = append(block, "")
			continue
		}
		if !strings.HasPrefix(line, " ") && !strings.HasPrefix(line, "\t") {
			return strings.TrimSpace(joinFrontmatterBlock(block, folded)), i
		}
		block = append(block, strings.TrimSpace(line))
	}
	return strings.TrimSpace(joinFrontmatterBlock(block, folded)), len(lines)
}

func joinFrontmatterBlock(lines []string, folded bool) string {
	if folded {
		return strings.Join(lines, " ")
	}
	return strings.Join(lines, "\n")
}

// Compile-time assertion that *Agent implements agentruntime.SkillProvider.
var _ agentcore.SkillProvider = (*Agent)(nil)
