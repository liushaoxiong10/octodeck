package main

import (
	"encoding/json"
	"errors"
	"fmt"
)

// Frame types kept in sync with src/agent-link/protocol.ts.

type frameType string

const (
	tHello                     frameType = "hello"
	tHelloAck                  frameType = "hello_ack"
	tPing                      frameType = "ping"
	tError                     frameType = "error"
	tRunRequest                frameType = "run.request"
	tRunCancel                 frameType = "run.cancel"
	tRunStatus                 frameType = "run.status"
	tRunEvent                  frameType = "run.event"
	tRunResult                 frameType = "run.result"
	tAgentRunRequest           frameType = "agent.run.request"
	tAgentRunCancel            frameType = "agent.run.cancel"
	tAgentRunStatus            frameType = "agent.run.status"
	tAgentRunEvent             frameType = "agent.run.event"
	tAgentRunResult            frameType = "agent.run.result"
	tAgentDiscoverRequest      frameType = "agent.discover.request"
	tAgentDiscoverResult       frameType = "agent.discover.result"
	tAgentSessionsRequest      frameType = "agent.sessions.request"
	tAgentSessionsResult       frameType = "agent.sessions.result"
	tAgentSessionDeleteRequest frameType = "agent.session.delete.request"
	tAgentSessionDeleteResult  frameType = "agent.session.delete.result"
	tWorkspaceCleanupRequest   frameType = "workspace.cleanup.request"
	tAgentPermissionDecision   frameType = "agent.permission.decision"
	tAgentRuntimeStatus        frameType = "agent.runtime.status"
	tToolRequest               frameType = "tool.request"
	tToolCancel                frameType = "tool.cancel"
	tToolEvent                 frameType = "tool.event"
	tToolResult                frameType = "tool.result"
	tModelsRequest             frameType = "models.request"
	tModelsResult              frameType = "models.result"
	tSkillsRequest             frameType = "skills.request"
	tSkillsResult              frameType = "skills.result"
	tDaemonUpdateRequest       frameType = "daemon.update.request"
	tMemorySync                frameType = "memory.sync"
)

// ─── Outbound (C→S) ──────────────────────────────────────────

type HelloFrame struct {
	Type                     frameType           `json:"type"`
	ID                       int64               `json:"id"`
	Version                  string              `json:"version"`
	ProtocolVersion          int                 `json:"protocolVersion,omitempty"`
	ProtocolMinVersion       int                 `json:"protocolMinVersion,omitempty"`
	OS                       string              `json:"os,omitempty"`
	Arch                     string              `json:"arch,omitempty"`
	Hostname                 string              `json:"hostname,omitempty"`
	Capabilities             []string            `json:"capabilities"`
	AgentClients             []AgentClientInfo   `json:"agentClients,omitempty"`
	AgentRuntimeCapabilities []RuntimeCapability `json:"agentRuntimeCapabilities,omitempty"`
	Resources                ResourceSnapshot    `json:"resources"`
}

type RuntimeCapability struct {
	RuntimeID         string            `json:"runtimeId"`
	AgentID           string            `json:"agentId"`
	Provider          string            `json:"provider,omitempty"`
	Transport         string            `json:"transport,omitempty"`
	Features          []string          `json:"features,omitempty"`
	PermissionModes   []string          `json:"permissionModes,omitempty"`
	AllowedWorkspaces []string          `json:"allowedWorkspaces,omitempty"`
	AllowedTools      []string          `json:"allowedTools,omitempty"`
	DisallowedTools   []string          `json:"disallowedTools,omitempty"`
	ToolPolicy        map[string]string `json:"toolPolicy,omitempty"`
	MaxConcurrentRuns int               `json:"maxConcurrentRuns,omitempty"`
	AvailableSlots    int               `json:"availableSlots,omitempty"`
}

type PingFrame struct {
	Type              frameType        `json:"type"`
	ID                int64            `json:"id"`
	Resources         ResourceSnapshot `json:"resources"`
	Status            string           `json:"status,omitempty"`
	RunningRuns       []RunningRunInfo `json:"runningRuns,omitempty"`
	MaxConcurrentRuns int              `json:"maxConcurrentRuns,omitempty"`
	AvailableSlots    int              `json:"availableSlots,omitempty"`
	Runtimes          []RuntimeStatus  `json:"runtimes,omitempty"`
}

type RunningRunInfo struct {
	RunID          string `json:"runId"`
	BackendID      string `json:"backendId,omitempty"`
	Cwd            string `json:"cwd,omitempty"`
	Status         string `json:"status,omitempty"`
	StartedAt      string `json:"startedAt,omitempty"`
	LastActivityAt string `json:"lastActivityAt,omitempty"`
}

type RuntimeStatus struct {
	RuntimeID         string           `json:"runtimeId"`
	DeviceLinkID      string           `json:"deviceLinkId"`
	AgentClientID     string           `json:"agentClientId"`
	DisplayName       string           `json:"displayName,omitempty"`
	Provider          string           `json:"provider,omitempty"`
	Transport         string           `json:"transport,omitempty"`
	Status            string           `json:"status"`
	MaxConcurrentRuns int              `json:"maxConcurrentRuns,omitempty"`
	RunningRuns       []RunningRunInfo `json:"runningRuns,omitempty"`
	AvailableSlots    int              `json:"availableSlots,omitempty"`
}

type RunStatusFrame struct {
	Type           frameType `json:"type"`
	RunID          string    `json:"runId"`
	Status         string    `json:"status"`
	BackendID      string    `json:"backendId,omitempty"`
	Cwd            string    `json:"cwd,omitempty"`
	Message        string    `json:"message,omitempty"`
	StartedAt      string    `json:"startedAt,omitempty"`
	LastActivityAt string    `json:"lastActivityAt,omitempty"`
}

type RunEventFrame struct {
	Type   frameType `json:"type"`
	RunID  string    `json:"runId"`
	Stream string    `json:"stream"` // "stdout" | "stderr"
	Data   string    `json:"data"`
}

type RunResultFrame struct {
	Type       frameType `json:"type"`
	RunID      string    `json:"runId"`
	ExitCode   *int      `json:"exitCode"`
	Signal     *string   `json:"signal"`
	TimedOut   bool      `json:"timedOut"`
	DurationMs int64     `json:"durationMs"`
}

type AgentRunStatusFrame struct {
	Type           frameType `json:"type"`
	RunID          string    `json:"runId"`
	AgentID        string    `json:"agentId,omitempty"`
	Status         string    `json:"status"`
	Cwd            string    `json:"cwd,omitempty"`
	Message        string    `json:"message,omitempty"`
	StartedAt      string    `json:"startedAt,omitempty"`
	LastActivityAt string    `json:"lastActivityAt,omitempty"`
}

type AgentRunEventFrame struct {
	Type      frameType      `json:"type"`
	RunID     string         `json:"runId"`
	AgentID   string         `json:"agentId,omitempty"`
	EventType string         `json:"eventType"`
	Text      string         `json:"text,omitempty"`
	SessionID string         `json:"sessionId,omitempty"`
	Payload   map[string]any `json:"payload,omitempty"`
	At        string         `json:"at,omitempty"`
}

type AgentRunResultFrame struct {
	Type       frameType      `json:"type"`
	RunID      string         `json:"runId"`
	AgentID    string         `json:"agentId,omitempty"`
	OK         bool           `json:"ok"`
	Result     string         `json:"result,omitempty"`
	Error      *string        `json:"error"`
	ErrorInfo  *AgentRunError `json:"errorInfo,omitempty"`
	SessionID  string         `json:"sessionId,omitempty"`
	Usage      map[string]any `json:"usage,omitempty"`
	TimedOut   bool           `json:"timedOut"`
	DurationMs int64          `json:"durationMs"`
}

type AgentRunError struct {
	Code      string         `json:"code"`
	Message   string         `json:"message"`
	Retryable bool           `json:"retryable,omitempty"`
	Details   map[string]any `json:"details,omitempty"`
}

type AgentDiscoverResultFrame struct {
	Type                frameType           `json:"type"`
	RequestID           string              `json:"requestId"`
	OK                  bool                `json:"ok"`
	Agents              []AgentClientInfo   `json:"agents"`
	RuntimeCapabilities []RuntimeCapability `json:"runtimeCapabilities,omitempty"`
	Error               *string             `json:"error"`
	DurationMs          int64               `json:"durationMs"`
}

type AgentSessionInfo struct {
	ID        string `json:"id"`
	AgentID   string `json:"agentId"`
	Workspace string `json:"workspace"`
	Title     string `json:"title,omitempty"`
	Provider  string `json:"provider,omitempty"`
	Path      string `json:"path"`
	UpdatedAt string `json:"updatedAt,omitempty"`
	SizeBytes int64  `json:"sizeBytes,omitempty"`
}

type AgentSessionsResultFrame struct {
	Type       frameType          `json:"type"`
	RequestID  string             `json:"requestId"`
	OK         bool               `json:"ok"`
	Sessions   []AgentSessionInfo `json:"sessions"`
	Error      *string            `json:"error"`
	DurationMs int64              `json:"durationMs"`
}

type AgentSessionDeleteResultFrame struct {
	Type       frameType `json:"type"`
	RequestID  string    `json:"requestId"`
	OK         bool      `json:"ok"`
	Deleted    bool      `json:"deleted"`
	Error      *string   `json:"error"`
	DurationMs int64     `json:"durationMs"`
}

type AgentRuntimeStatusFrame struct {
	Type       frameType `json:"type"`
	RuntimeID  string    `json:"runtimeId"`
	Status     string    `json:"status"`
	Message    string    `json:"message,omitempty"`
	StartedAt  string    `json:"startedAt,omitempty"`
	CrashCount int       `json:"crashCount,omitempty"`
}

type ToolEventFrame struct {
	Type      frameType `json:"type"`
	RequestID string    `json:"requestId"`
	Stream    string    `json:"stream"`
	Data      string    `json:"data"`
}

type ToolResultFrame struct {
	Type       frameType `json:"type"`
	RequestID  string    `json:"requestId"`
	OK         bool      `json:"ok"`
	Result     any       `json:"result"`
	Error      *string   `json:"error"`
	DurationMs int64     `json:"durationMs"`
}

type ModelInfo struct {
	ID          string `json:"id"`
	DisplayName string `json:"displayName,omitempty"`
}

type ModelsResultFrame struct {
	Type       frameType   `json:"type"`
	RequestID  string      `json:"requestId"`
	OK         bool        `json:"ok"`
	Models     []ModelInfo `json:"models"`
	Error      *string     `json:"error"`
	DurationMs int64       `json:"durationMs"`
}

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

type SkillsResultFrame struct {
	Type            frameType   `json:"type"`
	RequestID       string      `json:"requestId"`
	OK              bool        `json:"ok"`
	WorkspaceSkills []SkillInfo `json:"workspaceSkills"`
	CLISkills       []SkillInfo `json:"cliSkills"`
	Error           *string     `json:"error"`
	DurationMs      int64       `json:"durationMs"`
}

type MemorySyncFrame struct {
	Type         frameType `json:"type"`
	RequestID    string    `json:"requestId"`
	DeviceLinkID string    `json:"deviceLinkId,omitempty"`
	AgentID      string    `json:"agentId"`
	Path         string    `json:"path"`
	Content      string    `json:"content"`
	Mtime        string    `json:"mtime,omitempty"`
	ContentHash  string    `json:"contentHash,omitempty"`
}

func (f SkillsResultFrame) MarshalJSON() ([]byte, error) {
	type alias SkillsResultFrame
	normalized := alias(f)
	if normalized.WorkspaceSkills == nil {
		normalized.WorkspaceSkills = []SkillInfo{}
	}
	if normalized.CLISkills == nil {
		normalized.CLISkills = []SkillInfo{}
	}
	return json.Marshal(normalized)
}

// ─── Inbound (S→C) ───────────────────────────────────────────

type HelloAckFrame struct {
	Type                frameType `json:"type"`
	ID                  int64     `json:"id"`
	ClientID            string    `json:"clientId"`
	DisplayName         string    `json:"displayName"`
	ServerVersion       string    `json:"serverVersion"`
	HeartbeatIntervalMs int       `json:"heartbeatIntervalMs"`
}

type RunRequestFrame struct {
	Type                 frameType            `json:"type"`
	ID                   int64                `json:"id"`
	RunID                string               `json:"runId"`
	BackendID            string               `json:"backendId"`
	Binary               string               `json:"binary"`
	Argv                 []string             `json:"argv"`
	Cwd                  string               `json:"cwd"`
	Env                  map[string]string    `json:"env,omitempty"`
	OutputProtocol       string               `json:"outputProtocol"`
	TimeoutMs            int64                `json:"timeoutMs"`
	MaxOutputBytes       int64                `json:"maxOutputBytes"`
	Context              any                  `json:"context,omitempty"`
	StdinJSON            string               `json:"stdinJson,omitempty"`
	RemoteCwdPlaceholder string               `json:"remoteCwdPlaceholder,omitempty"`
	WorkspaceRepos       []*WorkspaceRepoSpec `json:"workspaceRepos,omitempty"`
	WorkspaceRepo        *WorkspaceRepoSpec   `json:"workspaceRepo,omitempty"`
}

type AgentRunRequestFrame struct {
	Type                 frameType            `json:"type"`
	ID                   int64                `json:"id"`
	RunID                string               `json:"runId"`
	AgentID              string               `json:"agentId"`
	Workspace            *AgentRunWorkspace   `json:"workspace,omitempty"`
	Input                AgentRunInput        `json:"input"`
	Cwd                  string               `json:"cwd,omitempty"`
	Env                  map[string]string    `json:"env,omitempty"`
	TimeoutMs            int64                `json:"timeoutMs"`
	MaxOutputBytes       int64                `json:"maxOutputBytes"`
	Policy               AgentRunPolicy       `json:"policy,omitempty"`
	Context              any                  `json:"context,omitempty"`
	RemoteCwdPlaceholder string               `json:"remoteCwdPlaceholder,omitempty"`
	WorkspaceRepos       []*WorkspaceRepoSpec `json:"workspaceRepos,omitempty"`
	WorkspaceRepo        *WorkspaceRepoSpec   `json:"workspaceRepo,omitempty"`
}

type AgentRunWorkspace struct {
	Kind        string               `json:"kind,omitempty"`
	Cwd         string               `json:"cwd,omitempty"`
	Folder      string               `json:"folder,omitempty"`
	AgentID     string               `json:"agentId,omitempty"`
	AgentRoot   string               `json:"agentRoot,omitempty"`
	WorkdirMode string               `json:"workdirMode,omitempty"`
	Scope       string               `json:"scope,omitempty"`
	ScopeID     string               `json:"scopeId,omitempty"`
	TaskID      string               `json:"taskId,omitempty"`
	TaskRunID   string               `json:"taskRunId,omitempty"`
	Repo        *WorkspaceRepoSpec   `json:"repo,omitempty"`
	Repos       []*WorkspaceRepoSpec `json:"repos,omitempty"`
	SessionRoot string               `json:"sessionRoot,omitempty"`
}

type AgentRunInput struct {
	Prompt    string         `json:"prompt"`
	SessionID string         `json:"sessionId,omitempty"`
	Metadata  map[string]any `json:"metadata,omitempty"`
}

type AgentRunPolicy struct {
	PermissionMode  string            `json:"permissionMode,omitempty"`
	AllowedTools    []string          `json:"allowedTools,omitempty"`
	DisallowedTools []string          `json:"disallowedTools,omitempty"`
	ToolPolicy      map[string]string `json:"toolPolicy,omitempty"`
	Model           string            `json:"model,omitempty"`
	SystemPrompt    string            `json:"systemPrompt,omitempty"`
}

type WorkspaceRepoSpec struct {
	Kind        string `json:"kind"`
	Name        string `json:"name,omitempty"`
	GitURL      string `json:"gitUrl,omitempty"`
	MainBranch  string `json:"mainBranch,omitempty"`
	DevicePath  string `json:"devicePath,omitempty"`
	GroupFolder string `json:"groupFolder"`
	AgentID     string `json:"agentId,omitempty"`
	AgentRoot   string `json:"agentRoot,omitempty"`
	WorkdirMode string `json:"workdirMode,omitempty"`
	Scope       string `json:"scope,omitempty"`
	ScopeID     string `json:"scopeId,omitempty"`
	TaskID      string `json:"taskId,omitempty"`
	TaskRunID   string `json:"taskRunId,omitempty"`
}

type RunCancelFrame struct {
	Type   frameType `json:"type"`
	RunID  string    `json:"runId"`
	Reason string    `json:"reason"`
}

type AgentRunCancelFrame struct {
	Type   frameType `json:"type"`
	RunID  string    `json:"runId"`
	Reason string    `json:"reason"`
}

type AgentDiscoverRequestFrame struct {
	Type      frameType `json:"type"`
	ID        int64     `json:"id"`
	RequestID string    `json:"requestId"`
}

type AgentSessionsRequestFrame struct {
	Type      frameType `json:"type"`
	ID        int64     `json:"id"`
	RequestID string    `json:"requestId"`
	AgentID   string    `json:"agentId,omitempty"`
	Workspace string    `json:"workspace,omitempty"`
}

type AgentSessionDeleteRequestFrame struct {
	Type      frameType `json:"type"`
	ID        int64     `json:"id"`
	RequestID string    `json:"requestId"`
	AgentID   string    `json:"agentId"`
	Workspace string    `json:"workspace"`
	SessionID string    `json:"sessionId"`
}

type WorkspaceCleanupRequestFrame struct {
	Type      frameType `json:"type"`
	ID        int64     `json:"id"`
	Workspace string    `json:"workspace"`
	Scope     string    `json:"scope,omitempty"`
	SessionID string    `json:"sessionId,omitempty"`
	TaskID    string    `json:"taskId,omitempty"`
	TaskRunID string    `json:"taskRunId,omitempty"`
}

type AgentPermissionDecisionFrame struct {
	Type      frameType `json:"type"`
	RunID     string    `json:"runId"`
	RequestID string    `json:"requestId"`
	Decision  string    `json:"decision"`
	Message   string    `json:"message,omitempty"`
}

type ToolRequestFrame struct {
	Type           frameType      `json:"type"`
	ID             int64          `json:"id"`
	RequestID      string         `json:"requestId"`
	ToolName       string         `json:"toolName"`
	Input          map[string]any `json:"input"`
	Cwd            string         `json:"cwd"`
	TimeoutMs      int64          `json:"timeoutMs"`
	MaxOutputBytes int64          `json:"maxOutputBytes"`
}

type ToolCancelFrame struct {
	Type      frameType `json:"type"`
	RequestID string    `json:"requestId"`
	Reason    string    `json:"reason"`
}

type ModelsRequestFrame struct {
	Type       frameType `json:"type"`
	ID         int64     `json:"id"`
	RequestID  string    `json:"requestId"`
	ProviderID string    `json:"providerId"`
}

type SkillsRequestFrame struct {
	Type       frameType `json:"type"`
	ID         int64     `json:"id"`
	RequestID  string    `json:"requestId"`
	ProviderID string    `json:"providerId"`
	Cwd        string    `json:"cwd,omitempty"`
}

type DaemonUpdateRequestFrame struct {
	Type           frameType `json:"type"`
	ID             int64     `json:"id"`
	LatestVersion  string    `json:"latestVersion"`
	CurrentVersion string    `json:"currentVersion,omitempty"`
	Reason         string    `json:"reason,omitempty"`
}

// ─── Bidirectional ───────────────────────────────────────────

type ErrorFrame struct {
	Type    frameType `json:"type"`
	ID      *int64    `json:"id,omitempty"`
	Code    string    `json:"code"`
	Message string    `json:"message"`
	Fatal   bool      `json:"fatal,omitempty"`
}

// inboundEnvelope is the partial decoder used to dispatch frames.
type inboundEnvelope struct {
	Type frameType `json:"type"`
}

// parseInbound returns one of: HelloAckFrame, RunRequestFrame, RunCancelFrame,
// ErrorFrame.
func parseInbound(raw []byte) (any, error) {
	var env inboundEnvelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, fmt.Errorf("invalid_json: %w", err)
	}
	switch env.Type {
	case tHelloAck:
		var f HelloAckFrame
		if err := json.Unmarshal(raw, &f); err != nil {
			return nil, err
		}
		return &f, nil
	case tRunRequest:
		var f RunRequestFrame
		if err := json.Unmarshal(raw, &f); err != nil {
			return nil, err
		}
		return &f, nil
	case tRunCancel:
		var f RunCancelFrame
		if err := json.Unmarshal(raw, &f); err != nil {
			return nil, err
		}
		return &f, nil
	case tAgentRunRequest:
		var f AgentRunRequestFrame
		if err := json.Unmarshal(raw, &f); err != nil {
			return nil, err
		}
		return &f, nil
	case tAgentRunCancel:
		var f AgentRunCancelFrame
		if err := json.Unmarshal(raw, &f); err != nil {
			return nil, err
		}
		return &f, nil
	case tAgentDiscoverRequest:
		var f AgentDiscoverRequestFrame
		if err := json.Unmarshal(raw, &f); err != nil {
			return nil, err
		}
		return &f, nil
	case tAgentSessionsRequest:
		var f AgentSessionsRequestFrame
		if err := json.Unmarshal(raw, &f); err != nil {
			return nil, err
		}
		return &f, nil
	case tAgentSessionDeleteRequest:
		var f AgentSessionDeleteRequestFrame
		if err := json.Unmarshal(raw, &f); err != nil {
			return nil, err
		}
		return &f, nil
	case tWorkspaceCleanupRequest:
		var f WorkspaceCleanupRequestFrame
		if err := json.Unmarshal(raw, &f); err != nil {
			return nil, err
		}
		return &f, nil
	case tAgentPermissionDecision:
		var f AgentPermissionDecisionFrame
		if err := json.Unmarshal(raw, &f); err != nil {
			return nil, err
		}
		return &f, nil
	case tToolRequest:
		var f ToolRequestFrame
		if err := json.Unmarshal(raw, &f); err != nil {
			return nil, err
		}
		return &f, nil
	case tToolCancel:
		var f ToolCancelFrame
		if err := json.Unmarshal(raw, &f); err != nil {
			return nil, err
		}
		return &f, nil
	case tModelsRequest:
		var f ModelsRequestFrame
		if err := json.Unmarshal(raw, &f); err != nil {
			return nil, err
		}
		return &f, nil
	case tSkillsRequest:
		var f SkillsRequestFrame
		if err := json.Unmarshal(raw, &f); err != nil {
			return nil, err
		}
		return &f, nil
	case tDaemonUpdateRequest:
		var f DaemonUpdateRequestFrame
		if err := json.Unmarshal(raw, &f); err != nil {
			return nil, err
		}
		return &f, nil
	case tError:
		var f ErrorFrame
		if err := json.Unmarshal(raw, &f); err != nil {
			return nil, err
		}
		return &f, nil
	default:
		return nil, fmt.Errorf("unknown frame type: %q", env.Type)
	}
}

func encodeFrame(frame any) ([]byte, error) {
	if frame == nil {
		return nil, errors.New("encodeFrame: nil")
	}
	return json.Marshal(frame)
}
