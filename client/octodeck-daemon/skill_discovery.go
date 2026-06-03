package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type skillDiscoverer struct {
	cfg  *Config
	send func(any) error
}

type skillsDiscoveryResult struct {
	WorkspaceSkills []SkillInfo
	CLISkills       []SkillInfo
}

type skillsManifest struct {
	Skills map[string]struct {
		PackageName string `json:"packageName"`
	} `json:"skills"`
}

const maxSkillContentBytes = 200_000

func newSkillDiscoverer(cfg *Config, send func(any) error) *skillDiscoverer {
	return &skillDiscoverer{cfg: cfg, send: send}
}

func (d *skillDiscoverer) handle(ctx context.Context, req *SkillsRequestFrame) {
	go func() {
		started := time.Now()
		result, err := discoverProviderSkills(ctx, d.cfg, req.ProviderID, req.Cwd)
		var errPtr *string
		if err != nil {
			msg := err.Error()
			errPtr = &msg
		}
		_ = d.send(&SkillsResultFrame{
			Type:            tSkillsResult,
			RequestID:       req.RequestID,
			OK:              err == nil,
			WorkspaceSkills: result.WorkspaceSkills,
			CLISkills:       result.CLISkills,
			Error:           errPtr,
			DurationMs:      time.Since(started).Milliseconds(),
		})
	}()
}

func discoverProviderSkills(ctx context.Context, cfg *Config, providerID string, cwd string) (skillsDiscoveryResult, error) {
	providerID = strings.TrimSpace(providerID)
	if providerID == "" {
		return skillsDiscoveryResult{}, fmt.Errorf("providerId required")
	}
	clients := discoverAgentClients()
	if cfg != nil && len(cfg.AgentClients) > 0 {
		clients = cfg.AgentClients
	}
	var found bool
	for _, client := range clients {
		if client.ID == providerID {
			found = true
			break
		}
	}
	if !found {
		return skillsDiscoveryResult{}, fmt.Errorf("provider not found on device: %s", providerID)
	}

	select {
	case <-ctx.Done():
		return skillsDiscoveryResult{}, ctx.Err()
	default:
	}

	if strings.TrimSpace(cwd) == "" {
		if wd, err := os.Getwd(); err == nil {
			cwd = wd
		}
	} else if strings.HasPrefix(cwd, deviceWorkspaceURIPrefix) {
		folder := strings.TrimPrefix(cwd, deviceWorkspaceURIPrefix)
		resolved, err := ensureNamedWorkspaceDir(cfg, folder)
		if err != nil {
			return skillsDiscoveryResult{}, err
		}
		cwd = resolved
	}
	home, _ := os.UserHomeDir()
	return skillsDiscoveryResult{
		WorkspaceSkills: scanSkillDirectory(filepath.Join(cwd, ".claude", "skills"), "workspace"),
		CLISkills:       scanSkillDirectory(filepath.Join(home, ".claude", "skills"), "cli"),
	}, nil
}

func scanSkillDirectory(root string, source string) []SkillInfo {
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
		skills = append(skills, SkillInfo{
			ID:          entry.Name(),
			Name:        name,
			Description: description,
			Source:      source,
			Enabled:     enabled,
			PackageName: manifest.packageNameFor(entry.Name()),
			Content:     string(content),
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
