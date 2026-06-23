package security

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
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
	augmentTrustedPath(base)
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

func augmentTrustedPath(base map[string]string) {
	if base == nil {
		return
	}
	current := base["PATH"]
	seen := map[string]struct{}{}
	for _, dir := range filepath.SplitList(current) {
		if dir != "" {
			seen[dir] = struct{}{}
		}
	}
	add := func(dir string) {
		dir = strings.TrimSpace(dir)
		if dir == "" {
			return
		}
		if expanded, err := filepath.Abs(dir); err == nil {
			dir = expanded
		}
		if _, ok := seen[dir]; ok {
			return
		}
		info, err := os.Stat(dir)
		if err != nil || !info.IsDir() {
			return
		}
		seen[dir] = struct{}{}
		if current == "" {
			current = dir
		} else {
			current = dir + string(os.PathListSeparator) + current
		}
	}

	for _, dir := range filepath.SplitList(os.Getenv("OCTODECK_DAEMON_EXTRA_PATH")) {
		add(dir)
	}
	home, _ := os.UserHomeDir()
	if home != "" {
		for _, rel := range []string{
			".local/bin",
			"bin",
			".bun/bin",
			".npm-global/bin",
			".volta/bin",
			".yarn/bin",
		} {
			add(filepath.Join(home, rel))
		}
		for _, pattern := range []string{
			filepath.Join(home, ".nvm", "versions", "node", "*", "bin"),
			filepath.Join(home, ".fnm", "node-versions", "*", "installation", "bin"),
			filepath.Join(home, "sdk", "go*", "bin"),
		} {
			matches, _ := filepath.Glob(pattern)
			for _, dir := range matches {
				add(dir)
			}
		}
	}

	for _, dir := range []string{
		"/data00/home/liushaoxiong12/code/app/octodeck/node_modules/.bin",
		"/data00/home/liushaoxiong12/code/app/octodeck/web/node_modules/.bin",
		"/usr/local/go/bin",
		"/opt/homebrew/bin",
		"/usr/local/bin",
		"/usr/bin",
		"/bin",
		"/usr/sbin",
		"/sbin",
	} {
		add(dir)
	}
	if runtime.GOOS == "darwin" {
		for _, dir := range []string{
			"/Applications/cmux.app/Contents/Resources/bin",
			"/Applications/Trae.app/Contents/Resources/app/bin",
			"/Applications/TRAE CN.app/Contents/Resources/app/bin",
			"/Applications/TRAE SOLO CN.app/Contents/Resources/app/bin",
		} {
			add(dir)
		}
	}
	if current != "" {
		base["PATH"] = current
	}
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
