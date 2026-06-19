// Package agentruntime: capabilities_optional.go 冻结了 family 子包可以选择
// 实现的可选能力接口集。daemon 主流程通过类型断言（type assertion）判断
// 某个 Agent 是否实现了某个能力，从而避免在公共层硬编码 claude / codex /
// traecli / traex 等家族字面量。
//
// 这些接口的签名在阶段 A 之后被冻结，B/C/D 阶段的各 family 子包必须严格
// 遵守；如需扩展能力，应通过新增 interface（而不是修改这里的接口）来
// 完成。
package agentruntime

import (
	agentcore "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentcore"
)

// ModelProvider 是 Agent 的可选能力：列出可用模型。
//
// 实现方典型流程：先尝试 family 自家的 jsonrpc / cache / `models --json`，
// 失败时回退到内置默认列表。返回值中 ModelInfo.ID 必须稳定，前端把它直接
// 作为 chat 请求里的 model 字段。
type ModelProvider = agentcore.ModelProvider

// SkillProvider 是 Agent 的可选能力：列出工作区/CLI/全局 skills。
//
// cwd 由 daemon 主流程传入，用于扫描 workspace skills；实现方应把 workspace
// 与 cli 两侧的 skill 分别填入 SkillsResult 的对应字段。
type SkillProvider = agentcore.SkillProvider

// OutputParser 是 Agent 的可选能力：解析自家 stdout 行为事件帧。
//
// 实现方应当是无状态的：每次 ParseLine 拿到一行原始 stdout 文本，返回零或
// 多个 AgentRunEventFrame。daemon 主流程再把它们转交给 uplink。
type OutputParser = agentcore.OutputParser

// MemorySource 是 Agent 的可选能力：返回 memory 文件路径用于 memory sync。
//
// home 是用户家目录绝对路径；实现方根据自家 CLI 的约定返回 memory.md /
// AGENTS.md 等文件的绝对路径。返回空串表示该 Agent 不参与 memory 同步。
type MemorySource = agentcore.MemorySource

// DiagnosticProvider 是 Agent 的可选能力：返回 health/diagnostic 信息。
//
// daemon debug 接口会聚合所有实现 DiagnosticProvider 的 Agent 的健康状态，
// 因此实现方应避免在 Health 内做长耗时的 IO（必要时可在后台缓存）。
type DiagnosticProvider = agentcore.DiagnosticProvider

// DiagnosticInfo 通用诊断信息（family-agnostic）。
//
// Healthy=false 时 Detail 必须给出可读的失败原因；Healthy=true 时 Detail
// 可空，也可附带版本号、模式、登录账号等可观测性信息。
type DiagnosticInfo = agentcore.DiagnosticInfo
