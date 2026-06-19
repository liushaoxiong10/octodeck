package agentcore

import (
	"context"

	agentclient "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentclient"
	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
)

// ModelProvider 是 Agent 的可选能力：列出可用模型。
type ModelProvider interface {
	ListModels(ctx context.Context) ([]agentclient.ModelInfo, error)
}

// SkillProvider 是 Agent 的可选能力：列出工作区/CLI/全局 skills。
type SkillProvider interface {
	ListSkills(ctx context.Context, cwd string) (agentclient.SkillsResult, error)
}

// OutputParser 是 Agent 的可选能力：解析自家 stdout 行为事件帧。
type OutputParser interface {
	ParseLine(line string) []proto.AgentRunEventFrame
}

// MemorySource 是 Agent 的可选能力：返回 memory 文件路径用于 memory sync。
type MemorySource interface {
	MemoryPath(home string) string
}

// DiagnosticProvider 是 Agent 的可选能力：返回 health/diagnostic 信息。
type DiagnosticProvider interface {
	Health(ctx context.Context) DiagnosticInfo
}

// DiagnosticInfo 通用诊断信息（family-agnostic）。
type DiagnosticInfo struct {
	Healthy bool
	Detail  string
}
