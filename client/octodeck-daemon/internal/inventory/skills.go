package inventory

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"

	agentclient "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentclient"
)

// SkillsConfig / SkillsResult 已迁移到 internal/agentclient，这里通过
// alias 让 inventory 旧调用方维持不变。阶段 E2 会把 alias 全部移除。
type SkillsConfig = agentclient.SkillsConfig
type SkillsResult = agentclient.SkillsResult

type skillsManifest struct {
	Skills map[string]struct {
		PackageName string `json:"packageName"`
		InstalledAt string `json:"installedAt"`
		Source      string `json:"source"`
	} `json:"skills"`
}

type skillScanContext struct {
	Source         string
	SourceProvider string
}

// SkillInfo 已在 models.go 中直接定义，这里不再做 alias。

const maxSkillContentBytes = 200_000

func dedupePaths(paths []string) []string {
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

func scanSkillDirectories(roots []string, scanCtx skillScanContext) []SkillInfo {
	merged := make([]SkillInfo, 0)
	seen := map[string]struct{}{}
	for _, root := range roots {
		for _, skill := range ScanSkillDirectoryWithContext(root, scanCtx) {
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

// ScanSkillDirectory 扫描指定目录下的 skill 包。
func ScanSkillDirectory(root string, source string) []SkillInfo {
	return ScanSkillDirectoryWithContext(root, skillScanContext{Source: source})
}

// ScanSkillDirectoryWithContext 在 ScanSkillDirectory 的基础上额外携带 source provider。
func ScanSkillDirectoryWithContext(root string, scanCtx skillScanContext) []SkillInfo {
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	manifest := readSkillsManifest(root)
	skills := make([]SkillInfo, 0, len(entries))
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
		skills = append(skills, SkillInfo{
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

func readSkillsManifest(root string) skillsManifest {
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

func safePathSegment(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	var b strings.Builder
	lastDash := false
	for _, r := range s {
		ok := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '.' || r == '_' || r == '-'
		if ok {
			b.WriteRune(r)
			lastDash = false
		} else if !lastDash {
			b.WriteByte('-')
			lastDash = true
		}
	}
	out := strings.Trim(b.String(), "-.")
	if out == "" {
		return "item"
	}
	return out
}
