package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// Config holds octodeck-daemon configuration loaded from ~/.octodeck/daemon/config.json.
type Config struct {
	// Server base URL (https://...). The ws endpoint is derived as
	// wss://<host>/api/agent-link/ws.
	Server string `json:"server"`
	// Plain token returned by /api/agent-link when the link was created.
	Token string `json:"token"`
	// LinkID (cl_xxxxxxxxxxxxxxxx).
	LinkID string `json:"linkId"`
	// Absolute paths to binaries the daemon is allowed to spawn.
	AllowedBinaries []string `json:"allowedBinaries"`
	// Absolute workspace roots that remote tools may access. Empty defaults to ~/.octodeck.
	AllowedRoots []string `json:"allowedRoots,omitempty"`
	// WorkspaceDir is the parent directory for per-run agent workspaces.
	WorkspaceDir string `json:"workspaceDir,omitempty"`
	// TaskDir is the parent directory for one-off task workspaces.
	TaskDir string `json:"taskDir,omitempty"`
	// ReposDir stores shared git checkouts used to create per-run worktrees.
	ReposDir string `json:"reposDir,omitempty"`
	// Optional: cap concurrent runs (default 4).
	MaxConcurrentRuns int `json:"maxConcurrentRuns"`
	// Optional: client display version reported in hello.
	Version string `json:"version,omitempty"`
	// Runtime-discovered supported agent clients. Populated by octodeck-daemon on startup.
	AgentClients []AgentClientInfo `json:"-"`
}

func defaultConfigPath() (string, error) {
	if p := os.Getenv("OCTODECK_DAEMON_CONFIG"); p != "" {
		return p, nil
	}
	home, err := octodeckHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "daemon", "config.json"), nil
}

func octodeckHomeDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".octodeck"), nil
}

func defaultWorkspaceDir() (string, error) {
	home, err := octodeckHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "workspace"), nil
}

func defaultTaskDir() (string, error) {
	home, err := octodeckHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "task"), nil
}

func defaultReposDir() (string, error) {
	home, err := octodeckHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "repos"), nil
}

func defaultAllowedRoots() ([]string, error) {
	home, err := octodeckHomeDir()
	if err != nil {
		return nil, err
	}
	return []string{home}, nil
}

func loadConfig(path string) (*Config, error) {
	if path == "" {
		p, err := defaultConfigPath()
		if err != nil {
			return nil, err
		}
		path = p
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config %s: %w", path, err)
	}
	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("parse config %s: %w", path, err)
	}
	if err := cfg.validate(); err != nil {
		return nil, err
	}
	if cfg.MaxConcurrentRuns <= 0 {
		cfg.MaxConcurrentRuns = 4
	}
	if cfg.WorkspaceDir == "" {
		workspace, err := defaultWorkspaceDir()
		if err != nil {
			return nil, err
		}
		cfg.WorkspaceDir = workspace
	}
	if cfg.TaskDir == "" {
		task, err := defaultTaskDir()
		if err != nil {
			return nil, err
		}
		cfg.TaskDir = task
	}
	if cfg.ReposDir == "" {
		repos, err := defaultReposDir()
		if err != nil {
			return nil, err
		}
		cfg.ReposDir = repos
	}
	if len(cfg.AllowedRoots) == 0 {
		roots, err := defaultAllowedRoots()
		if err != nil {
			return nil, err
		}
		cfg.AllowedRoots = roots
	}
	return &cfg, nil
}

func (c *Config) validate() error {
	if c.Server == "" {
		return errors.New("config.server is required")
	}
	if c.Token == "" {
		return errors.New("config.token is required")
	}
	if c.LinkID == "" {
		return errors.New("config.linkId is required")
	}
	for _, b := range c.AllowedBinaries {
		if !filepath.IsAbs(b) {
			return fmt.Errorf("allowedBinaries entry must be absolute: %q", b)
		}
	}
	for _, r := range c.AllowedRoots {
		if !filepath.IsAbs(r) {
			return fmt.Errorf("allowedRoots entry must be absolute: %q", r)
		}
	}
	if c.WorkspaceDir != "" && !filepath.IsAbs(c.WorkspaceDir) {
		return fmt.Errorf("workspaceDir must be absolute: %q", c.WorkspaceDir)
	}
	if c.TaskDir != "" && !filepath.IsAbs(c.TaskDir) {
		return fmt.Errorf("taskDir must be absolute: %q", c.TaskDir)
	}
	if c.ReposDir != "" && !filepath.IsAbs(c.ReposDir) {
		return fmt.Errorf("reposDir must be absolute: %q", c.ReposDir)
	}
	return nil
}
