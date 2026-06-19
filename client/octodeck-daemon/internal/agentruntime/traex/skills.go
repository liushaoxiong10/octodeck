// Package traex — skill discovery helper.
//
// 阶段 C: traex family 自家的 skill 扫描从 internal/inventory 下沉到本子
// 包。本文件定义两个东西：
//
//  1. HasAllowedTools：旧的 policy 辅助函数（保留向后兼容）。
//  2. ListSkills：实现 agentruntime.SkillProvider，按 traex 自家约定扫
//     描 workspace + cli 两侧的 skill 目录，与 inventory 实现保持等价。
//
// traex 的 skill 目录约定（参考 inventory.profileSkillDir/Provider）:
//
//	workspace 侧（cwd-scoped）:
//	  <cwd>/skills
//	  <cwd>/.claude/skills        // 历史兼容：claude 是 ecosystem default
//	  <cwd>/.traex/skills
//	  <cwd>/.octodeck/agents/<id>/skills
//
//	cli 侧（home-scoped）:
//	  ~/.claude/skills
//	  ~/.traex/skills
//
// SourceProvider 字段固定填 "traex"，与 inventory 的 profileSkillProvider
// 行为一致。
package traex

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

// providerSkillDir 是 traex family 的 skill 目录基名（不带前导点）。
const providerSkillDir = "traex"

// providerSkillProvider 是 traex skill 的 SourceProvider 字段值。
const providerSkillProvider = "traex"

// maxSkillContentBytes 与 inventory.maxSkillContentBytes 保持一致。
const maxSkillContentBytes = 200_000

// HasAllowedTools reports whether the request policy carries an explicit
// AllowedTools list.
func HasAllowedTools(req *proto.AgentRunRequestFrame) bool {
	return req != nil && len(req.Policy.AllowedTools) > 0
}

// ListSkills 实现 agentruntime.SkillProvider。
//
// cwd 由 daemon 主流程传入；调用方若没传，则尝试 os.Getwd() 兜底。返回
// 值与历史 inventory.DiscoverProviderSkills(traex) 等价，即同时填充
// WorkspaceSkills 与 CLISkills 两侧。
func (a *Agent) ListSkills(ctx context.Context, cwd string) (agentclient.SkillsResult, error) {
	if err := ctx.Err(); err != nil {
		return agentclient.SkillsResult{}, err
	}
	if strings.TrimSpace(cwd) == "" {
		if wd, err := os.Getwd(); err == nil {
			cwd = wd
		}
	}
	home, _ := os.UserHomeDir()
	agentID := workspaceutil.SafePathSegment(agentcore.FirstNonEmpty(strings.TrimSpace(a.Client.ID), strings.TrimSpace(a.Client.Provider)))

	workspaceRoots := make([]string, 0, 4)
	cliRoots := make([]string, 0, 4)
	if strings.TrimSpace(cwd) != "" {
		workspaceRoots = append(workspaceRoots, filepath.Join(cwd, "skills"))
		// 历史兼容：很多团队把 skill 放在 .claude/skills 下，daemon 在
		// 跨 family 时也把这条路径作为 ecosystem default 扫描。
		workspaceRoots = append(workspaceRoots, filepath.Join(cwd, ".claude", "skills"))
		workspaceRoots = append(workspaceRoots, filepath.Join(cwd, "."+providerSkillDir, "skills"))
		if agentID != "" {
			workspaceRoots = append(workspaceRoots, filepath.Join(cwd, ".octodeck", "agents", agentID, "skills"))
		}
	}
	if home != "" {
		cliRoots = append(cliRoots, filepath.Join(home, ".claude", "skills"))
		cliRoots = append(cliRoots, filepath.Join(home, "."+providerSkillDir, "skills"))
	}
	if agentID != "" {
		// daemon-managed skill stores（与 codex skill 实现保持一致）。直
		// 接拿 daemonconfig 默认路径，不再让上层把 SkillsConfig DTO 传下
		// 来——family 子包对 daemon main 流程是不可见的。
		daemonDir := daemonconfig.DaemonDir(nil)
		sessionDir := daemonconfig.SessionDir(nil)
		cliRoots = append(cliRoots,
			filepath.Join(daemonDir, "agents", agentID, "skills"),
			filepath.Join(sessionDir, "agents", agentID, "skills"),
		)
	}

	return agentclient.SkillsResult{
		WorkspaceSkills: scanSkillDirectories(dedupePaths(workspaceRoots), skillScanContext{Source: "workspace", SourceProvider: providerSkillProvider}),
		CLISkills:       scanSkillDirectories(dedupePaths(cliRoots), skillScanContext{Source: "cli", SourceProvider: providerSkillProvider}),
	}, nil
}

var _ agentcore.SkillProvider = (*Agent)(nil)

// ----------------------------------------------------------------------------
// 私有 helper：从 inventory 复制一份 skill 扫描逻辑。复制而不是 import 是
// 阶段 C 的有意决定（plan §5.5）：family 子包不依赖 inventory 包。
// ----------------------------------------------------------------------------

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

func scanSkillDirectories(roots []string, scanCtx skillScanContext) []agentclient.SkillInfo {
	merged := make([]agentclient.SkillInfo, 0)
	seen := map[string]struct{}{}
	for _, root := range roots {
		for _, skill := range scanSkillDirectoryWithContext(root, scanCtx) {
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

func scanSkillDirectoryWithContext(root string, scanCtx skillScanContext) []agentclient.SkillInfo {
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	manifest := readSkillsManifest(root)
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
