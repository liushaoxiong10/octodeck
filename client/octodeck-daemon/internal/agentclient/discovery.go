package agentclient

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// Discover 基于已注册的 descriptors + 调用方传入的 Config，返回当前主机
// 上可用的 agent client 列表。注意：这里只做"binary 可执行存在性"判断，
// 进一步的 ACP / family 专属探测需要由各子包自己在 capability 接口里完成。
//
// Config.DisableAutoDiscover=true 时跳过 PATH 扫描，仅返回 Registry 实例化
// 后的 client 列表。
func Discover(cfg Config) []Info {
	if cfg.DisableAutoDiscover {
		return RegistryClients(cfg.Registry)
	}
	descriptors := RegisteredDescriptors()
	clients := make([]Info, 0, len(descriptors))
	usedCommand := make(map[string]struct{})
	for _, d := range descriptors {
		if d.Binary == "" {
			continue
		}
		if _, taken := usedCommand[d.Binary]; taken {
			// 同一 binary 只发布一种 transport（与 inventory 旧逻辑一致：
			// ACP 候选先注册即先获胜）。
			continue
		}
		dirs := defaultSearchDirs()
		if len(d.SearchDirs) > 0 {
			dirs = append(append([]string(nil), d.SearchDirs...), dirs...)
		}
		bin := findExecutableInDirs(d.Binary, dirs)
		if bin == "" {
			continue
		}
		transport := d.Transport
		if transport == "" {
			transport = "stdio"
		}
		provider := d.Provider
		if provider == "" {
			provider = d.ID
		}
		clients = append(clients, Info{
			ID:              d.ID,
			DisplayName:     ifEmpty(d.DisplayName, d.ID),
			Binary:          bin,
			Version:         "",
			Family:          d.Family,
			Provider:        provider,
			Transport:       transport,
			Args:            append([]string(nil), d.Args...),
			PermissionModes: append([]string(nil), d.PermissionModes...),
			Capabilities:    append([]string(nil), d.Capabilities...),
		})
		usedCommand[d.Binary] = struct{}{}
	}
	return Merge(clients, RegistryClients(cfg.Registry))
}

// defaultSearchDirs 汇总 PATH、OCTODECK_DAEMON_EXTRA_PATH、用户 home 下常见
// node 工具目录、以及 macOS 应用内嵌的 bin 目录，作为 binary 查找路径。
func defaultSearchDirs() []string {
	dirs := make([]string, 0)
	seen := map[string]struct{}{}
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
		seen[dir] = struct{}{}
		dirs = append(dirs, dir)
	}

	for _, dir := range filepath.SplitList(os.Getenv("PATH")) {
		add(dir)
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
		} {
			matches, _ := filepath.Glob(pattern)
			for _, dir := range matches {
				add(dir)
			}
		}
	}

	for _, dir := range []string{
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

	return dirs
}

// findExecutableInDirs 在指定目录列表中按顺序查找可执行文件。
func findExecutableInDirs(command string, dirs []string) string {
	if filepath.IsAbs(command) && isExecutable(command) {
		return command
	}
	for _, dir := range dirs {
		p := filepath.Join(dir, command)
		if isExecutable(p) {
			return p
		}
	}
	return ""
}

func isExecutable(path string) bool {
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return false
	}
	return info.Mode()&0o111 != 0
}

// ifEmpty 返回非空字符串。
func ifEmpty(s, fallback string) string {
	if s == "" {
		return fallback
	}
	return s
}
