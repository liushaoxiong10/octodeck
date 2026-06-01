package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type skillDiscoverer struct {
	send func(any) error
}

type skillsDiscoveryResult struct {
	WorkspaceSkills []SkillInfo
	CLISkills       []SkillInfo
}

func newSkillDiscoverer(send func(any) error) *skillDiscoverer {
	return &skillDiscoverer{send: send}
}

func (d *skillDiscoverer) handle(ctx context.Context, req *SkillsRequestFrame) {
	go func() {
		started := time.Now()
		result, err := discoverProviderSkills(ctx, req.ProviderID, req.Cwd)
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

func discoverProviderSkills(ctx context.Context, providerID string, cwd string) (skillsDiscoveryResult, error) {
	providerID = strings.TrimSpace(providerID)
	if providerID == "" {
		return skillsDiscoveryResult{}, fmt.Errorf("providerId required")
	}
	clients := discoverAgentClients()
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
	skills := make([]SkillInfo, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() || !isSafeSkillID(entry.Name()) {
			continue
		}
		skillDir := filepath.Join(root, entry.Name())
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
		})
	}
	sort.Slice(skills, func(i, j int) bool { return skills[i].ID < skills[j].ID })
	return skills
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
	for _, line := range strings.Split(rest[:end], "\n") {
		key, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		value = strings.Trim(strings.TrimSpace(value), `"'`)
		switch strings.TrimSpace(key) {
		case "name":
			name = value
		case "description":
			description = value
		}
	}
	return name, description
}
