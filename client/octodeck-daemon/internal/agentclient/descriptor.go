package agentclient

// Descriptor 是某个 family 子包发布给 daemon 的 family-agnostic 元数据：
// daemon 主流程只通过 Descriptor + Capability 接口（见 agentruntime
// capability.go）认识各 family，不再需要硬编码 claude / codex / traex
// 等字面量。
//
// 各子包通常在 init() 中调用 Register 完成注册，例如：
//
//	func init() {
//	    agentclient.Register(agentclient.Descriptor{
//	        ID:          "claude-acp",
//	        DisplayName: "Claude Code (ACP)",
//	        Family:      "claude",
//	        Provider:    "claude-code",
//	        Transport:   "acp",
//	        Binary:      "claude",
//	        VersionArgs: []string{"--version"},
//	        ...
//	    })
//	}
type Descriptor struct {
	// ID 是 agent client 的稳定标识（如 claude-acp / codex-acp）。
	ID string
	// DisplayName 是前端 UI 展示用名字。
	DisplayName string
	// Family 是这一类 agent 的归属（claude / codex / traex / 自定义）。
	Family string
	// Provider 是逻辑上的 provider 名（如 claude-code / codex / traex）。
	Provider string
	// Transport 是 daemon 与 CLI 之间的传输方式（stdio / acp）。
	Transport string
	// Binary 是默认要在 PATH / SearchDirs 中查找的可执行文件名。
	Binary string
	// Args 是自动发现该 descriptor 后默认传给 binary 的参数。主要用于
	// 同一个可执行文件通过子命令暴露不同 transport 的场景。
	Args []string
	// SearchDirs 是除了 PATH 之外，额外尝试查找 Binary 的目录。
	SearchDirs []string
	// VersionArgs 是 `<binary> --version` 风格的参数集；为空时使用 ["--version"]。
	VersionArgs []string
	// PermissionModes 是该 agent 支持的权限模式（用于前端权限选择器）。
	PermissionModes []string
	// Capabilities 是该 agent 暴露给服务端的能力 tag 集合。
	Capabilities []string
}
