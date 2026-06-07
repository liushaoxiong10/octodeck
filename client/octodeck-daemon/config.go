package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Config holds octodeck-daemon configuration loaded from ~/.octodeck/daemon/config.json.
type Config struct {
	// Path is the loaded config file path. Runtime-only; not serialized.
	Path string `json:"-"`
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
	// SessionDir stores provider-native session/config data for workspace runs.
	SessionDir string `json:"sessionDir,omitempty"`
	// TaskDir is the parent directory for one-off task workspaces.
	TaskDir string `json:"taskDir,omitempty"`
	// ReposDir stores shared git checkouts used to create per-run worktrees.
	ReposDir string `json:"reposDir,omitempty"`
	// CacheDir stores safely removable daemon/runtime caches.
	CacheDir string `json:"cacheDir,omitempty"`
	// TmpDir stores short-lived daemon/runtime temporary files.
	TmpDir string `json:"tmpDir,omitempty"`
	// StateDir stores local daemon runtime state such as locks and pid files.
	StateDir string `json:"stateDir,omitempty"`
	// Optional: cap concurrent runs. <=0 or omitted means unlimited.
	MaxConcurrentRuns int `json:"maxConcurrentRuns"`
	// Optional: client display version reported in hello.
	Version string `json:"version,omitempty"`
	// Optional: automatically download and restart into newer daemon versions.
	// Nil defaults to enabled.
	AutoUpdate *bool `json:"autoUpdate,omitempty"`
	// AgentRegistry defines local agent adapters the server may reference by ID.
	AgentRegistry []AgentRegistryEntry `json:"agentRegistry,omitempty"`
	// RuntimePolicy constrains agent-runtime behavior and remote policy requests.
	RuntimePolicy RuntimePolicyConfig `json:"runtimePolicy,omitempty"`
	// Runtime-discovered supported agent clients. Populated by octodeck-daemon on startup.
	AgentClients []AgentClientInfo `json:"-"`
}

type AgentRegistryEntry struct {
	ID                string            `json:"id"`
	DisplayName       string            `json:"displayName,omitempty"`
	Provider          string            `json:"provider,omitempty"`
	Transport         string            `json:"transport,omitempty"`
	Binary            string            `json:"binary,omitempty"`
	Args              []string          `json:"args,omitempty"`
	Env               map[string]string `json:"env,omitempty"`
	URL               string            `json:"url,omitempty"`
	VersionCommand    []string          `json:"versionCommand,omitempty"`
	PermissionModes   []string          `json:"permissionModes,omitempty"`
	Capabilities      []string          `json:"capabilities,omitempty"`
	AllowedWorkspaces []string          `json:"allowedWorkspaces,omitempty"`
	AllowedTools      []string          `json:"allowedTools,omitempty"`
	DisallowedTools   []string          `json:"disallowedTools,omitempty"`
	ToolPolicy        map[string]string `json:"toolPolicy,omitempty"`
}

type RuntimePolicyConfig struct {
	AllowedWorkspaces   []string          `json:"allowedWorkspaces,omitempty"`
	AllowedTools        []string          `json:"allowedTools,omitempty"`
	DisallowedTools     []string          `json:"disallowedTools,omitempty"`
	ToolPolicy          map[string]string `json:"toolPolicy,omitempty"`
	PermissionModes     []string          `json:"permissionModes,omitempty"`
	PermissionTimeoutMs int64             `json:"permissionTimeoutMs,omitempty"`
	MaxRestarts         int               `json:"maxRestarts,omitempty"`
	RestartBackoffMs    int64             `json:"restartBackoffMs,omitempty"`
	DisableAutoDiscover bool              `json:"disableAutoDiscover,omitempty"`
}

func defaultConfigPath() (string, error) {
	if p := os.Getenv("OCTODECK_DAEMON_CONFIG"); p != "" {
		return p, nil
	}
	return defaultDaemonConfigPath()
}

func defaultDaemonConfigPath() (string, error) {
	dir, err := defaultDaemonDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "config.json"), nil
}

func defaultDaemonDir() (string, error) {
	home, err := octodeckHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "daemon"), nil
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
	return filepath.Join(home, "tasks"), nil
}

func defaultSessionDir() (string, error) {
	home, err := octodeckHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "session"), nil
}

func defaultReposDir() (string, error) {
	home, err := octodeckHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "repos"), nil
}

func defaultCacheDir() (string, error) {
	home, err := octodeckHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "cache"), nil
}

func defaultTmpDir() (string, error) {
	home, err := octodeckHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "tmp"), nil
}

func defaultStateDir() (string, error) {
	home, err := octodeckHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "state"), nil
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
	cfg.Path = path
	if err := cfg.validate(); err != nil {
		return nil, err
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
	if cfg.SessionDir == "" {
		session, err := defaultSessionDir()
		if err != nil {
			return nil, err
		}
		cfg.SessionDir = session
	}
	if cfg.ReposDir == "" {
		repos, err := defaultReposDir()
		if err != nil {
			return nil, err
		}
		cfg.ReposDir = repos
	}
	if cfg.CacheDir == "" {
		cache, err := defaultCacheDir()
		if err != nil {
			return nil, err
		}
		cfg.CacheDir = cache
	}
	if cfg.TmpDir == "" {
		tmp, err := defaultTmpDir()
		if err != nil {
			return nil, err
		}
		cfg.TmpDir = tmp
	}
	if cfg.StateDir == "" {
		state, err := defaultStateDir()
		if err != nil {
			return nil, err
		}
		cfg.StateDir = state
	}
	if len(cfg.AllowedRoots) == 0 {
		roots, err := defaultAllowedRoots()
		if err != nil {
			return nil, err
		}
		cfg.AllowedRoots = roots
	}
	if cfg.Version == "" || strings.HasPrefix(cfg.Version, "octodeck-daemon/") {
		cfg.Version = daemonVersion
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
	for _, a := range c.AgentRegistry {
		if strings.TrimSpace(a.ID) == "" {
			return errors.New("agentRegistry entry id is required")
		}
		if a.Transport == "" || a.Transport == "stdio" || a.Transport == "a2a" || a.Transport == "acp" {
			if a.Binary == "" {
				return fmt.Errorf("agentRegistry[%s].binary is required for %s transport", a.ID, ifEmpty(a.Transport, "stdio"))
			}
			if !filepath.IsAbs(a.Binary) {
				return fmt.Errorf("agentRegistry[%s].binary must be absolute: %q", a.ID, a.Binary)
			}
		} else if a.Transport == "http" {
			if strings.TrimSpace(a.URL) == "" {
				return fmt.Errorf("agentRegistry[%s].url is required for http transport", a.ID)
			}
		} else {
			return fmt.Errorf("agentRegistry[%s].transport must be stdio, acp, a2a or http", a.ID)
		}
		for k := range a.Env {
			if isDangerousEnvKey(k) {
				return fmt.Errorf("agentRegistry[%s].env key not allowed: %q", a.ID, k)
			}
		}
	}
	for _, r := range c.AllowedRoots {
		if !filepath.IsAbs(r) {
			return fmt.Errorf("allowedRoots entry must be absolute: %q", r)
		}
	}
	for _, r := range c.RuntimePolicy.AllowedWorkspaces {
		if !filepath.IsAbs(r) {
			return fmt.Errorf("runtimePolicy.allowedWorkspaces entry must be absolute: %q", r)
		}
	}
	for _, a := range c.AgentRegistry {
		for _, r := range a.AllowedWorkspaces {
			if !filepath.IsAbs(r) {
				return fmt.Errorf("agentRegistry[%s].allowedWorkspaces entry must be absolute: %q", a.ID, r)
			}
		}
	}
	if c.WorkspaceDir != "" && !filepath.IsAbs(c.WorkspaceDir) {
		return fmt.Errorf("workspaceDir must be absolute: %q", c.WorkspaceDir)
	}
	if c.TaskDir != "" && !filepath.IsAbs(c.TaskDir) {
		return fmt.Errorf("taskDir must be absolute: %q", c.TaskDir)
	}
	if c.SessionDir != "" && !filepath.IsAbs(c.SessionDir) {
		return fmt.Errorf("sessionDir must be absolute: %q", c.SessionDir)
	}
	if c.ReposDir != "" && !filepath.IsAbs(c.ReposDir) {
		return fmt.Errorf("reposDir must be absolute: %q", c.ReposDir)
	}
	if c.CacheDir != "" && !filepath.IsAbs(c.CacheDir) {
		return fmt.Errorf("cacheDir must be absolute: %q", c.CacheDir)
	}
	if c.TmpDir != "" && !filepath.IsAbs(c.TmpDir) {
		return fmt.Errorf("tmpDir must be absolute: %q", c.TmpDir)
	}
	if c.StateDir != "" && !filepath.IsAbs(c.StateDir) {
		return fmt.Errorf("stateDir must be absolute: %q", c.StateDir)
	}
	return nil
}
