// Package codex — skill discovery (SkillProvider implementation).
//
// Codex doesn't run a formal CLI skill catalogue today, but the daemon
// has historically exposed any SKILL.md trees the user drops under
//
//	<cwd>/skills, <cwd>/.codex/skills, <cwd>/.octodeck/agents/<id>/skills
//	~/.codex/skills, ~/.claude/skills (shared)
//	<DaemonDir>/agents/<id>/skills, <SessionDir>/agents/<id>/skills
//
// alongside Claude's own skill dirs. The C-stage migration moves the
// scan + glue code out of internal/inventory/skills.go so the daemon
// can drive skill discovery purely through the optional
// agentruntime.SkillProvider interface.
package codex

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"

	agentclient "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentclient"
	agentcore "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentcore"
	daemonconfig "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/config"
	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
	workspaceutil "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/workspace"
)

// HasAllowedTools reports whether the request policy carries an explicit
// AllowedTools list. Kept exported for legacy call sites that historically
// inspected the policy directly.
func HasAllowedTools(req *proto.AgentRunRequestFrame) bool {
	return req != nil && len(req.Policy.AllowedTools) > 0
}

// codexSkillSourceProvider is the canonical "sourceProvider" string the
// daemon reports for skill entries discovered for the Codex family.
const codexSkillSourceProvider = "codex"

// codexSkillDirName is the directory segment used when computing
// per-family skill roots (e.g. ".codex/skills").
const codexSkillDirName = "codex"

// maxCodexSkillContentBytes mirrors inventory.maxSkillContentBytes — the
// cap on individual SKILL.md payloads inlined into the SkillsResult.
const maxCodexSkillContentBytes = 200_000

// ListSkills implements agentruntime.SkillProvider for the Codex family.
//
// Workspace skills come from <cwd>/skills, <cwd>/.codex/skills,
// <cwd>/.claude/skills (shared) and the per-agent override under
// <cwd>/.octodeck/agents/<id>/skills. CLI skills come from
// ~/.codex/skills, ~/.claude/skills and the daemon-managed skill stores.
//
// daemon-managed dirs are pulled from daemonconfig.DaemonDir / SessionDir
// rather than from the SkillsConfig DTO (the daemon main loop no longer
// has to plumb that DTO down to the family).
func (a *Agent) ListSkills(ctx context.Context, cwd string) (agentclient.SkillsResult, error) {
	if err := ctx.Err(); err != nil {
		return agentclient.SkillsResult{}, err
	}
	if strings.TrimSpace(cwd) == "" {
		if wd, err := os.Getwd(); err == nil {
			cwd = wd
		}
	}
	workspaceRoots, cliRoots := codexSkillSearchRoots(a.Client, cwd)
	return agentclient.SkillsResult{
		WorkspaceSkills: scanCodexSkillDirectories(workspaceRoots, codexSkillScanContext{Source: "workspace", SourceProvider: codexSkillSourceProvider}),
		CLISkills:       scanCodexSkillDirectories(cliRoots, codexSkillScanContext{Source: "cli", SourceProvider: codexSkillSourceProvider}),
	}, nil
}

// codexSkillSearchRoots computes the workspace + cli skill root candidate
// lists for a given Codex client + cwd. It mirrors the inventory layer's
// behaviour for the Codex family but stays family-private.
func codexSkillSearchRoots(client agentclient.Info, cwd string) ([]string, []string) {
	home, _ := os.UserHomeDir()
	agentID := safeCodexPathSegment(codexIfEmpty(client.ID, client.Provider))

	workspaceRoots := make([]string, 0, 4)
	cliRoots := make([]string, 0, 6)

	if strings.TrimSpace(cwd) != "" {
		workspaceRoots = append(workspaceRoots,
			filepath.Join(cwd, "skills"),
			filepath.Join(cwd, ".claude", "skills"),
			filepath.Join(cwd, "."+codexSkillDirName, "skills"),
		)
		if agentID != "" {
			workspaceRoots = append(workspaceRoots, filepath.Join(cwd, ".octodeck", "agents", agentID, "skills"))
		}
	}
	if home != "" {
		cliRoots = append(cliRoots,
			filepath.Join(home, ".claude", "skills"),
			filepath.Join(home, "."+codexSkillDirName, "skills"),
		)
	}
	if agentID != "" {
		// Pull daemon-managed skill stores from the canonical config helpers.
		daemonDir := daemonconfig.DaemonDir(nil)
		sessionDir := daemonconfig.SessionDir(nil)
		cliRoots = append(cliRoots,
			filepath.Join(daemonDir, "agents", agentID, "skills"),
			filepath.Join(sessionDir, "agents", agentID, "skills"),
		)
	}

	return dedupeCodexPaths(workspaceRoots), dedupeCodexPaths(cliRoots)
}

// codexSkillScanContext is the source/provider tuple attached to every
// SkillInfo discovered during a single scan.
type codexSkillScanContext struct {
	Source         string
	SourceProvider string
}

// codexSkillsManifest models the on-disk .skills-manifest.json layout —
// a copy of inventory.skillsManifest kept private to this package.
type codexSkillsManifest struct {
	Skills map[string]struct {
		PackageName string `json:"packageName"`
		InstalledAt string `json:"installedAt"`
		Source      string `json:"source"`
	} `json:"skills"`
}

func (m codexSkillsManifest) packageNameFor(skillID string) string {
	if m.Skills == nil {
		return ""
	}
	return m.Skills[skillID].PackageName
}

func (m codexSkillsManifest) packageSourceFor(skillID string) string {
	if m.Skills == nil {
		return ""
	}
	return m.Skills[skillID].Source
}

func (m codexSkillsManifest) installedAtFor(skillID string) string {
	if m.Skills == nil {
		return ""
	}
	return m.Skills[skillID].InstalledAt
}

func scanCodexSkillDirectories(roots []string, scanCtx codexSkillScanContext) []agentclient.SkillInfo {
	merged := make([]agentclient.SkillInfo, 0)
	seen := map[string]struct{}{}
	for _, root := range roots {
		for _, skill := range scanCodexSkillDirectory(root, scanCtx) {
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

func scanCodexSkillDirectory(root string, scanCtx codexSkillScanContext) []agentclient.SkillInfo {
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	manifest := readCodexSkillsManifest(root)
	skills := make([]agentclient.SkillInfo, 0, len(entries))
	for _, entry := range entries {
		if !isSafeCodexSkillID(entry.Name()) {
			continue
		}
		skillDir := filepath.Join(root, entry.Name())
		if !isCodexSkillDirectory(entry, skillDir) {
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
		content = truncateCodexSkillContent(content)
		name, description := parseCodexSkillFrontmatter(string(content))
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

func truncateCodexSkillContent(content []byte) []byte {
	if len(content) <= maxCodexSkillContentBytes {
		return content
	}
	return content[:maxCodexSkillContentBytes]
}

func readCodexSkillsManifest(root string) codexSkillsManifest {
	data, err := os.ReadFile(filepath.Join(root, ".skills-manifest.json"))
	if err != nil {
		return codexSkillsManifest{}
	}
	var manifest codexSkillsManifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return codexSkillsManifest{}
	}
	return manifest
}

func isCodexSkillDirectory(entry os.DirEntry, path string) bool {
	if entry.IsDir() {
		return true
	}
	if entry.Type()&os.ModeSymlink == 0 {
		return false
	}
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

func isSafeCodexSkillID(id string) bool {
	if id == "" || id == "." || id == ".." {
		return false
	}
	return !strings.ContainsAny(id, `/\\`)
}

func parseCodexSkillFrontmatter(content string) (string, string) {
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
			if folded, ok := parseCodexBlockScalarHeader(value); ok {
				block, next := collectCodexFrontmatterBlock(lines, i+1, folded)
				description = block
				i = next - 1
				continue
			}
			description = value
		}
	}
	return name, description
}

func parseCodexBlockScalarHeader(value string) (bool, bool) {
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

func collectCodexFrontmatterBlock(lines []string, start int, folded bool) (string, int) {
	block := make([]string, 0)
	for i := start; i < len(lines); i++ {
		line := lines[i]
		if strings.TrimSpace(line) == "" {
			block = append(block, "")
			continue
		}
		if !strings.HasPrefix(line, " ") && !strings.HasPrefix(line, "\t") {
			return strings.TrimSpace(joinCodexFrontmatterBlock(block, folded)), i
		}
		block = append(block, strings.TrimSpace(line))
	}
	return strings.TrimSpace(joinCodexFrontmatterBlock(block, folded)), len(lines)
}

func joinCodexFrontmatterBlock(lines []string, folded bool) string {
	if folded {
		return strings.Join(lines, " ")
	}
	return strings.Join(lines, "\n")
}

func dedupeCodexPaths(paths []string) []string {
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

func codexIfEmpty(s, fallback string) string {
	if strings.TrimSpace(s) != "" {
		return s
	}
	return fallback
}

// safeCodexPathSegment is a copy of inventory.safePathSegment but kept
// in the codex sub-package so we don't have to import inventory just for
// skill scanning. Falls back to workspaceutil.SafePathSegment when the
// caller-supplied input is already a relatively conservative slug.
func safeCodexPathSegment(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	if cleaned := workspaceutil.SafePathSegment(s); cleaned != "" {
		return cleaned
	}
	return ""
}

// Compile-time interface assertion.
var _ agentcore.SkillProvider = (*Agent)(nil)
