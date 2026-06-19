package agentclient

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"time"
)

// DetectVersion 基于 descriptor 的 VersionArgs（默认 `--version`）探测
// agent client 的版本字符串。失败时返回空串。
func DetectVersion(id string, binary string) string {
	args := []string{"--version"}
	if d, ok := DescriptorByID(id); ok && len(d.VersionArgs) > 0 {
		args = d.VersionArgs
	}
	return DetectVersionWithArgs(binary, args)
}

// DetectVersionWithArgs 用指定参数运行 binary 并解析版本字符串。
func DetectVersionWithArgs(binary string, args []string) string {
	out, ok := DetectOutputWithArgs(binary, args)
	if !ok {
		return ""
	}
	return NormalizeVersionOutput(out)
}

// DetectOutputWithArgs 运行 binary 并把 combined output 文本返回；带 2s
// 超时，避免离线 / 卡住的二进制阻塞 daemon 启动。
func DetectOutputWithArgs(binary string, args []string) (string, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, binary, args...)
	cmd.Env = os.Environ()
	out, err := cmd.CombinedOutput()
	if err != nil || ctx.Err() != nil {
		return "", false
	}
	return string(out), true
}

// NormalizeVersionOutput 提取首个非空行（最长 128 字符），用于上报。
func NormalizeVersionOutput(s string) string {
	for _, line := range strings.Split(s, "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			if len(line) > 128 {
				return line[:128]
			}
			return line
		}
	}
	return ""
}

// Merge 合并 auto-discovery 与 registry 两组 client，registry 优先级更高。
func Merge(auto []Info, registry []Info) []Info {
	if len(registry) == 0 {
		return auto
	}
	seen := make(map[string]int, len(auto)+len(registry))
	out := make([]Info, 0, len(auto)+len(registry))
	for _, c := range auto {
		seen[c.ID] = len(out)
		out = append(out, c)
	}
	for _, c := range registry {
		if idx, ok := seen[c.ID]; ok {
			out[idx] = c
			continue
		}
		seen[c.ID] = len(out)
		out = append(out, c)
	}
	return out
}

// RegistryClients 把 RegistryEntry 列表实体化为 Info 列表。
//
// 注意：这里不做 family 推断（family 字段保持空），由调用方（inventory
// 或各 family 子包）按需填充。这样 agentclient 包可以保持 family-agnostic。
func RegistryClients(registry []RegistryEntry) []Info {
	if len(registry) == 0 {
		return nil
	}
	out := make([]Info, 0, len(registry))
	for _, entry := range registry {
		transport := entry.Transport
		if transport == "" {
			transport = "stdio"
		}
		provider := entry.Provider
		if provider == "" {
			provider = entry.ID
		}
		out = append(out, Info{
			ID:              entry.ID,
			DisplayName:     ifEmpty(entry.DisplayName, entry.ID),
			Binary:          entry.Binary,
			Version:         "",
			Family:          "",
			Provider:        provider,
			Transport:       transport,
			Args:            append([]string(nil), entry.Args...),
			PermissionModes: append([]string(nil), entry.PermissionModes...),
			Capabilities:    append([]string(nil), entry.Capabilities...),
		})
	}
	return out
}
