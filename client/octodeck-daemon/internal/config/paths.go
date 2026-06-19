package config

import (
	"os"
	"path/filepath"
	"strings"
)

// OctodeckHomeDir returns ~/.octodeck.
func OctodeckHomeDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".octodeck"), nil
}

func DefaultConfigPath() (string, error) {
	if p := os.Getenv("OCTODECK_DAEMON_CONFIG"); p != "" {
		return p, nil
	}
	return DefaultDaemonConfigPath()
}

func DefaultDaemonConfigPath() (string, error) {
	dir, err := DefaultDaemonDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "config.json"), nil
}

func DefaultDaemonDir() (string, error) {
	home, err := OctodeckHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "daemon"), nil
}

func DefaultWorkspaceDir() (string, error) {
	home, err := OctodeckHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "workspace"), nil
}

func DefaultTaskDir() (string, error) {
	home, err := OctodeckHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "tasks"), nil
}

func DefaultSessionDir() (string, error) {
	home, err := OctodeckHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "session"), nil
}

func DefaultReposDir() (string, error) {
	home, err := OctodeckHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "repos"), nil
}

func DefaultCacheDir() (string, error) {
	home, err := OctodeckHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "cache"), nil
}

func DefaultTmpDir() (string, error) {
	home, err := OctodeckHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "tmp"), nil
}

func DefaultStateDir() (string, error) {
	home, err := OctodeckHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "state"), nil
}

func DefaultAllowedRoots() ([]string, error) {
	home, err := OctodeckHomeDir()
	if err != nil {
		return nil, err
	}
	return []string{home}, nil
}

// WorkspaceDir returns the configured workspace directory or a sensible
// default rooted under the user's home directory.
func WorkspaceDir(cfg *Config) string {
	if cfg != nil && cfg.WorkspaceDir != "" {
		return cfg.WorkspaceDir
	}
	workspace, err := DefaultWorkspaceDir()
	if err != nil {
		return filepath.Join(os.TempDir(), "octodeck", "workspace")
	}
	return workspace
}

func DaemonDir(cfg *Config) string {
	if cfg != nil && cfg.WorkspaceDir != "" {
		return filepath.Join(filepath.Dir(cfg.WorkspaceDir), "daemon")
	}
	dir, err := DefaultDaemonDir()
	if err != nil {
		return filepath.Join(os.TempDir(), "octodeck", "daemon")
	}
	return dir
}

func DaemonConfigPath(cfg *Config) (string, error) {
	if p := os.Getenv("OCTODECK_DAEMON_CONFIG"); p != "" && isPathWithinRoot(p, DaemonDir(cfg)) {
		return p, nil
	}
	return filepath.Join(DaemonDir(cfg), "config.json"), nil
}

func DaemonCommandPath(cfg *Config) (string, error) {
	return filepath.Join(DaemonDir(cfg), "bin", "octodeck-daemon"), nil
}

func TaskDir(cfg *Config) string {
	if cfg != nil && cfg.TaskDir != "" {
		return cfg.TaskDir
	}
	if cfg != nil && cfg.WorkspaceDir != "" {
		return filepath.Join(filepath.Dir(cfg.WorkspaceDir), "tasks")
	}
	task, err := DefaultTaskDir()
	if err != nil {
		return filepath.Join(os.TempDir(), "octodeck", "tasks")
	}
	return task
}

func SessionDir(cfg *Config) string {
	if cfg != nil && cfg.SessionDir != "" {
		return cfg.SessionDir
	}
	if cfg != nil && cfg.WorkspaceDir != "" {
		return filepath.Join(filepath.Dir(cfg.WorkspaceDir), "session")
	}
	session, err := DefaultSessionDir()
	if err != nil {
		return filepath.Join(os.TempDir(), "octodeck", "session")
	}
	return session
}

func ReposDir(cfg *Config) string {
	if cfg != nil && cfg.ReposDir != "" {
		return cfg.ReposDir
	}
	if cfg != nil && cfg.WorkspaceDir != "" {
		return filepath.Join(filepath.Dir(cfg.WorkspaceDir), "repos")
	}
	repos, err := DefaultReposDir()
	if err != nil {
		return filepath.Join(os.TempDir(), "octodeck", "repos")
	}
	return repos
}

func CacheDir(cfg *Config) string {
	if cfg != nil && cfg.CacheDir != "" {
		return cfg.CacheDir
	}
	if cfg != nil && cfg.WorkspaceDir != "" {
		return filepath.Join(filepath.Dir(cfg.WorkspaceDir), "cache")
	}
	cache, err := DefaultCacheDir()
	if err != nil {
		return filepath.Join(os.TempDir(), "octodeck", "cache")
	}
	return cache
}

func TmpDir(cfg *Config) string {
	if cfg != nil && cfg.TmpDir != "" {
		return cfg.TmpDir
	}
	if cfg != nil && cfg.WorkspaceDir != "" {
		return filepath.Join(filepath.Dir(cfg.WorkspaceDir), "tmp")
	}
	tmp, err := DefaultTmpDir()
	if err != nil {
		return filepath.Join(os.TempDir(), "octodeck", "tmp")
	}
	return tmp
}

func StateDir(cfg *Config) string {
	if cfg != nil && cfg.StateDir != "" {
		return cfg.StateDir
	}
	if cfg != nil && cfg.WorkspaceDir != "" {
		return filepath.Join(filepath.Dir(cfg.WorkspaceDir), "state")
	}
	state, err := DefaultStateDir()
	if err != nil {
		return filepath.Join(os.TempDir(), "octodeck", "state")
	}
	return state
}

// isPathWithinRoot returns true if p is inside (or equal to) root after a pure
// lexical comparison.
func isPathWithinRoot(p, root string) bool {
	rel, err := filepath.Rel(root, p)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}
