// Package agentclient 提供 family-agnostic 的 agent client 元信息 DTO 与
// 注册中心。它是阶段 A 的产物：B/C/D 阶段的各 family 子包通过本包暴露的
// Descriptor / Register / Discover 把自家二进制 + 能力声明上报给 daemon
// 主流程，无需让 inventory / agentruntime 再认识具体 family 字面量。
package agentclient

// Info 描述一个本机可用的 agent client（如 claude / codex / traecli / traex
// 及其 ACP 子模式）。daemon 在握手 / 心跳帧里把它上报给服务端，作为前端 UI
// 选择 provider 与 transport 的依据。
//
// 字段、json tag 与历史 inventory.Info 完全一致，保证服务端协议不变。
type Info struct {
	ID              string   `json:"id"`
	DisplayName     string   `json:"displayName"`
	Binary          string   `json:"binary"`
	Version         string   `json:"version,omitempty"`
	Family          string   `json:"family,omitempty"`
	Provider        string   `json:"provider,omitempty"`
	Transport       string   `json:"transport,omitempty"`
	Args            []string `json:"-"`
	PermissionModes []string `json:"permissionModes,omitempty"`
	Capabilities    []string `json:"capabilities,omitempty"`
}

// RegistryEntry 是用户在 daemon config 中显式声明的自定义 agent client。
type RegistryEntry struct {
	ID              string
	DisplayName     string
	Provider        string
	Transport       string
	Binary          string
	Args            []string
	PermissionModes []string
	Capabilities    []string
}

// Config 控制 agent client 的发现行为。
type Config struct {
	DisableAutoDiscover bool
	Registry            []RegistryEntry
}

// ModelInfo 描述一个可发布到前端模型选择器的模型条目（id + 展示名）。
//
// 与 inventory.ModelInfo 字段一致，迁移后 inventory 用 type alias re-export
// 给上层（如 protocol / executor）。
type ModelInfo struct {
	ID          string `json:"id"`
	DisplayName string `json:"displayName,omitempty"`
}

// SkillInfo 描述本机可用的一个 skill。
type SkillInfo struct {
	ID             string `json:"id"`
	Name           string `json:"name,omitempty"`
	Description    string `json:"description,omitempty"`
	Source         string `json:"source"`
	SourceProvider string `json:"sourceProvider,omitempty"`
	Level          string `json:"level,omitempty"`
	LevelKey       string `json:"levelKey,omitempty"`
	Enabled        bool   `json:"enabled"`
	PackageName    string `json:"packageName,omitempty"`
	PackageSource  string `json:"packageSource,omitempty"`
	InstalledAt    string `json:"installedAt,omitempty"`
	Content        string `json:"content,omitempty"`
}

// SkillsResult 把 workspace 与 cli 两侧扫描到的 skills 拼成一个结构。
type SkillsResult struct {
	WorkspaceSkills []SkillInfo
	CLISkills       []SkillInfo
}

// SkillsConfig 是 skill 发现的配置。
type SkillsConfig struct {
	AgentClients []Info
	Registry     []RegistryEntry
	DaemonDir    string
	SessionDir   string
}
