package config

import "strings"

var defaultVersion = "octodeck-daemon/0.0.0"

// SetDefaultVersion overrides the default version string reported to the
// server when a config file does not specify one.
func SetDefaultVersion(version string) {
	if strings.TrimSpace(version) != "" {
		defaultVersion = version
	}
}

// applyDefaults fills in derived defaults for paths and version after the
// raw config has been validated.
func applyDefaults(cfg *Config) error {
	if cfg.WorkspaceDir == "" {
		workspace, err := DefaultWorkspaceDir()
		if err != nil {
			return err
		}
		cfg.WorkspaceDir = workspace
	}
	if cfg.TaskDir == "" {
		task, err := DefaultTaskDir()
		if err != nil {
			return err
		}
		cfg.TaskDir = task
	}
	if cfg.SessionDir == "" {
		session, err := DefaultSessionDir()
		if err != nil {
			return err
		}
		cfg.SessionDir = session
	}
	if cfg.ReposDir == "" {
		repos, err := DefaultReposDir()
		if err != nil {
			return err
		}
		cfg.ReposDir = repos
	}
	if cfg.CacheDir == "" {
		cache, err := DefaultCacheDir()
		if err != nil {
			return err
		}
		cfg.CacheDir = cache
	}
	if cfg.TmpDir == "" {
		tmp, err := DefaultTmpDir()
		if err != nil {
			return err
		}
		cfg.TmpDir = tmp
	}
	if cfg.StateDir == "" {
		state, err := DefaultStateDir()
		if err != nil {
			return err
		}
		cfg.StateDir = state
	}
	if len(cfg.AllowedRoots) == 0 {
		roots, err := DefaultAllowedRoots()
		if err != nil {
			return err
		}
		cfg.AllowedRoots = roots
	}
	if cfg.Version == "" || strings.HasPrefix(cfg.Version, "octodeck-daemon/") {
		cfg.Version = defaultVersion
	}
	return nil
}
