package security

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	state "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/state"
)

// EnvConfig configures the environment-builder with the session directory used
// to derive per-provider config dirs (CODEX_HOME, TRAEX_HOME, ...).
type EnvConfig struct {
	SessionDir string
}

// BuildEnv constructs the final environment variable list for a process from
// the given config, overrides, run context, base snapshot, and safe-folder
// sanitizer. Dangerous keys in overrides are dropped silently.
func BuildEnv(cfg EnvConfig, overrides map[string]string, runCtx any, base map[string]string, safeGroupFolder func(string) string) []string {
	if base == nil {
		base = EnvSnapshot()
	}
	if safeGroupFolder == nil {
		safeGroupFolder = func(s string) string { return s }
	}
	for k, v := range overrides {
		if IsDangerousKey(k) {
			continue
		}
		base[k] = v
	}
	if folder := state.GroupFolder(runCtx); folder != "" {
		root := filepath.Join(cfg.SessionDir, safeGroupFolder(folder))
		_ = os.MkdirAll(root, 0o700)
		base["OCTODECK_SESSION_DIR"] = root
		providerDirs := map[string]string{
			"CODEX_HOME": filepath.Join(root, "codex"),
			"TRAEX_HOME": filepath.Join(root, "traex"),
		}
		for key, dir := range providerDirs {
			_ = os.MkdirAll(dir, 0o700)
			base[key] = dir
		}
	}
	if sharedDir := state.WorkspaceSharedDir(runCtx); sharedDir != "" {
		base["OCTODECK_WORKSPACE_SHARED_DIR"] = sharedDir
	}
	if runCtx != nil {
		if data, err := json.Marshal(runCtx); err == nil {
			base["OCTODECK_RUN_CONTEXT_JSON"] = string(data)
		}
		if repo := state.Repo(runCtx); repo != nil {
			if data, err := json.Marshal(repo); err == nil {
				base["OCTODECK_REPO_CONTEXT_JSON"] = string(data)
			}
		}
	}
	out := make([]string, 0, len(base))
	for k, v := range base {
		out = append(out, k+"="+v)
	}
	return out
}

// EnvSnapshot returns the current process environment as a map.
func EnvSnapshot() map[string]string {
	out := make(map[string]string, len(os.Environ()))
	for _, kv := range os.Environ() {
		i := strings.IndexByte(kv, '=')
		if i <= 0 {
			continue
		}
		out[kv[:i]] = kv[i+1:]
	}
	return out
}

var dangerousEnvKeys = map[string]struct{}{
	"LD_PRELOAD":            {},
	"LD_LIBRARY_PATH":       {},
	"DYLD_INSERT_LIBRARIES": {},
	"DYLD_LIBRARY_PATH":     {},
	"NODE_OPTIONS":          {},
	"PATH":                  {},
}

// IsDangerousKey returns true if the environment variable key must not be set
// by untrusted callers (e.g. LD_PRELOAD, PATH, NODE_OPTIONS).
func IsDangerousKey(k string) bool {
	_, ok := dangerousEnvKeys[strings.ToUpper(k)]
	return ok
}
