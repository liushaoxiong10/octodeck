package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// Config holds octodeck-daemon configuration loaded from ~/.octodeck-daemon/config.json.
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
	// Absolute workspace roots that remote tools may access. Empty means cwd only.
	AllowedRoots []string `json:"allowedRoots,omitempty"`
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
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".octodeck-daemon", "config.json"), nil
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
	return nil
}
