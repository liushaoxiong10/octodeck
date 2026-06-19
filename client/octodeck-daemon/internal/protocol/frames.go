package protocol

import (
	"encoding/json"

	inventory "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/inventory"
)

// ─── Outbound (C→S) ──────────────────────────────────────────

type HelloFrame struct {
	Type                     FrameType           `json:"type"`
	ID                       int64               `json:"id"`
	Version                  string              `json:"version"`
	ProtocolVersion          int                 `json:"protocolVersion,omitempty"`
	ProtocolMinVersion       int                 `json:"protocolMinVersion,omitempty"`
	OS                       string              `json:"os,omitempty"`
	Arch                     string              `json:"arch,omitempty"`
	Hostname                 string              `json:"hostname,omitempty"`
	Capabilities             []string            `json:"capabilities"`
	AgentClients             []inventory.Info    `json:"agentClients,omitempty"`
	AgentRuntimeCapabilities []RuntimeCapability `json:"agentRuntimeCapabilities,omitempty"`
	Resources                inventory.Snapshot  `json:"resources"`
}

type RuntimeCapability struct {
	RuntimeID         string            `json:"runtimeId"`
	AgentID           string            `json:"agentId"`
	Family            string            `json:"family,omitempty"`
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
	Type              FrameType          `json:"type"`
	ID                int64              `json:"id"`
	Resources         inventory.Snapshot `json:"resources"`
	Status            string             `json:"status,omitempty"`
	RunningRuns       []RunningRunInfo   `json:"runningRuns,omitempty"`
	MaxConcurrentRuns int                `json:"maxConcurrentRuns,omitempty"`
	AvailableSlots    int                `json:"availableSlots,omitempty"`
	Runtimes          []RuntimeStatus    `json:"runtimes,omitempty"`
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
	Family            string           `json:"family,omitempty"`
	Provider          string           `json:"provider,omitempty"`
	Transport         string           `json:"transport,omitempty"`
	Status            string           `json:"status"`
	MaxConcurrentRuns int              `json:"maxConcurrentRuns,omitempty"`
	RunningRuns       []RunningRunInfo `json:"runningRuns,omitempty"`
	AvailableSlots    int              `json:"availableSlots,omitempty"`
}

type RunStatusFrame struct {
	Type           FrameType `json:"type"`
	RunID          string    `json:"runId"`
	Status         string    `json:"status"`
	BackendID      string    `json:"backendId,omitempty"`
	Cwd            string    `json:"cwd,omitempty"`
	Message        string    `json:"message,omitempty"`
	StartedAt      string    `json:"startedAt,omitempty"`
	LastActivityAt string    `json:"lastActivityAt,omitempty"`
}

type RunEventFrame struct {
	Type   FrameType `json:"type"`
	RunID  string    `json:"runId"`
	Stream string    `json:"stream"` // "stdout" | "stderr"
	Data   string    `json:"data"`
}

type RunResultFrame struct {
	Type       FrameType `json:"type"`
	RunID      string    `json:"runId"`
	ExitCode   *int      `json:"exitCode"`
	Signal     *string   `json:"signal"`
	TimedOut   bool      `json:"timedOut"`
	DurationMs int64     `json:"durationMs"`
}

type AgentRunStatusFrame struct {
	Type           FrameType `json:"type"`
	RunID          string    `json:"runId"`
	AgentID        string    `json:"agentId,omitempty"`
	Status         string    `json:"status"`
	Cwd            string    `json:"cwd,omitempty"`
	Message        string    `json:"message,omitempty"`
	StartedAt      string    `json:"startedAt,omitempty"`
	LastActivityAt string    `json:"lastActivityAt,omitempty"`
}

type AgentRunEventFrame struct {
	Type      FrameType      `json:"type"`
	RunID     string         `json:"runId"`
	AgentID   string         `json:"agentId,omitempty"`
	EventType string         `json:"eventType"`
	Text      string         `json:"text,omitempty"`
	SessionID string         `json:"sessionId,omitempty"`
	Payload   map[string]any `json:"payload,omitempty"`
	At        string         `json:"at,omitempty"`
}

type AgentRunResultFrame struct {
	Type       FrameType      `json:"type"`
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
	Type                FrameType           `json:"type"`
	RequestID           string              `json:"requestId"`
	OK                  bool                `json:"ok"`
	Agents              []inventory.Info    `json:"agents"`
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
	Type       FrameType          `json:"type"`
	RequestID  string             `json:"requestId"`
	OK         bool               `json:"ok"`
	Sessions   []AgentSessionInfo `json:"sessions"`
	Error      *string            `json:"error"`
	DurationMs int64              `json:"durationMs"`
}

type AgentSessionDeleteResultFrame struct {
	Type       FrameType `json:"type"`
	RequestID  string    `json:"requestId"`
	OK         bool      `json:"ok"`
	Deleted    bool      `json:"deleted"`
	Error      *string   `json:"error"`
	DurationMs int64     `json:"durationMs"`
}

type AgentRuntimeStatusFrame struct {
	Type       FrameType `json:"type"`
	RuntimeID  string    `json:"runtimeId"`
	Status     string    `json:"status"`
	Message    string    `json:"message,omitempty"`
	StartedAt  string    `json:"startedAt,omitempty"`
	CrashCount int       `json:"crashCount,omitempty"`
}

type WorkspaceGitStatusFile struct {
	Path      string `json:"path"`
	Status    string `json:"status"`
	Additions int    `json:"additions,omitempty"`
	Deletions int    `json:"deletions,omitempty"`
	Patch     string `json:"patch,omitempty"`
}

type WorkspaceGitStatusResultFrame struct {
	Type          FrameType                `json:"type"`
	RequestID     string                   `json:"requestId"`
	OK            bool                     `json:"ok"`
	WorkspacePath string                   `json:"workspacePath,omitempty"`
	Branch        string                   `json:"branch,omitempty"`
	Head          string                   `json:"head,omitempty"`
	Clean         bool                     `json:"clean"`
	Files         []WorkspaceGitStatusFile `json:"files"`
	DiffStat      string                   `json:"diffStat,omitempty"`
	Error         *string                  `json:"error"`
	DurationMs    int64                    `json:"durationMs"`
}

type WorkspaceGitCommitResultFrame struct {
	Type           FrameType `json:"type"`
	RequestID      string    `json:"requestId"`
	OK             bool      `json:"ok"`
	WorkspacePath  string    `json:"workspacePath,omitempty"`
	Branch         string    `json:"branch,omitempty"`
	Commit         string    `json:"commit,omitempty"`
	Clean          bool      `json:"clean"`
	FilesCommitted int       `json:"filesCommitted"`
	Error          *string   `json:"error"`
	DurationMs     int64     `json:"durationMs"`
}

type ToolEventFrame struct {
	Type      FrameType `json:"type"`
	RequestID string    `json:"requestId"`
	Stream    string    `json:"stream"`
	Data      string    `json:"data"`
}

type ToolResultFrame struct {
	Type       FrameType `json:"type"`
	RequestID  string    `json:"requestId"`
	OK         bool      `json:"ok"`
	Result     any       `json:"result"`
	Error      *string   `json:"error"`
	DurationMs int64     `json:"durationMs"`
}

type ModelInfo = inventory.ModelInfo

type ModelsResultFrame struct {
	Type       FrameType   `json:"type"`
	RequestID  string      `json:"requestId"`
	OK         bool        `json:"ok"`
	Models     []ModelInfo `json:"models"`
	Error      *string     `json:"error"`
	DurationMs int64       `json:"durationMs"`
}

type SkillInfo = inventory.SkillInfo

type SkillsResultFrame struct {
	Type            FrameType   `json:"type"`
	RequestID       string      `json:"requestId"`
	OK              bool        `json:"ok"`
	WorkspaceSkills []SkillInfo `json:"workspaceSkills"`
	CLISkills       []SkillInfo `json:"cliSkills"`
	Error           *string     `json:"error"`
	DurationMs      int64       `json:"durationMs"`
}

type MemorySyncFrame struct {
	Type         FrameType `json:"type"`
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
	Type                FrameType `json:"type"`
	ID                  int64     `json:"id"`
	ClientID            string    `json:"clientId"`
	DisplayName         string    `json:"displayName"`
	ServerVersion       string    `json:"serverVersion"`
	HeartbeatIntervalMs int       `json:"heartbeatIntervalMs"`
}

type RunRequestFrame struct {
	Type                 FrameType            `json:"type"`
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
	Type                 FrameType            `json:"type"`
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
	Prompt     string               `json:"prompt"`
	SessionID  string               `json:"sessionId,omitempty"`
	Metadata   map[string]any       `json:"metadata,omitempty"`
	ImageFiles []AgentRunInputImage `json:"imageFiles,omitempty"`
}

type AgentRunInputImage struct {
	Path     string `json:"path"`
	Data     string `json:"data"`
	MimeType string `json:"mimeType,omitempty"`
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
	Type   FrameType `json:"type"`
	RunID  string    `json:"runId"`
	Reason string    `json:"reason"`
}

type AgentRunCancelFrame struct {
	Type   FrameType `json:"type"`
	RunID  string    `json:"runId"`
	Reason string    `json:"reason"`
}

type AgentDiscoverRequestFrame struct {
	Type      FrameType `json:"type"`
	ID        int64     `json:"id"`
	RequestID string    `json:"requestId"`
}

type AgentSessionsRequestFrame struct {
	Type      FrameType `json:"type"`
	ID        int64     `json:"id"`
	RequestID string    `json:"requestId"`
	AgentID   string    `json:"agentId,omitempty"`
	Workspace string    `json:"workspace,omitempty"`
}

type AgentSessionDeleteRequestFrame struct {
	Type      FrameType `json:"type"`
	ID        int64     `json:"id"`
	RequestID string    `json:"requestId"`
	AgentID   string    `json:"agentId"`
	Workspace string    `json:"workspace"`
	SessionID string    `json:"sessionId"`
}

type WorkspaceCleanupRequestFrame struct {
	Type      FrameType `json:"type"`
	ID        int64     `json:"id"`
	Workspace string    `json:"workspace"`
	Scope     string    `json:"scope,omitempty"`
	SessionID string    `json:"sessionId,omitempty"`
	TaskID    string    `json:"taskId,omitempty"`
	TaskRunID string    `json:"taskRunId,omitempty"`
}

type WorkspaceGitStatusRequestFrame struct {
	Type            FrameType            `json:"type"`
	ID              int64                `json:"id"`
	RequestID       string               `json:"requestId"`
	Workspace       *AgentRunWorkspace   `json:"workspace,omitempty"`
	WorkspaceRepos  []*WorkspaceRepoSpec `json:"workspaceRepos,omitempty"`
	WorkspaceRepo   *WorkspaceRepoSpec   `json:"workspaceRepo,omitempty"`
	IncludeDiffStat bool                 `json:"includeDiffStat,omitempty"`
	IncludePatch    bool                 `json:"includePatch,omitempty"`
}

type WorkspaceGitCommitRequestFrame struct {
	Type           FrameType            `json:"type"`
	ID             int64                `json:"id"`
	RequestID      string               `json:"requestId"`
	Workspace      *AgentRunWorkspace   `json:"workspace,omitempty"`
	WorkspaceRepos []*WorkspaceRepoSpec `json:"workspaceRepos,omitempty"`
	WorkspaceRepo  *WorkspaceRepoSpec   `json:"workspaceRepo,omitempty"`
	Message        string               `json:"message"`
}

type AgentPermissionDecisionFrame struct {
	Type      FrameType `json:"type"`
	RunID     string    `json:"runId"`
	RequestID string    `json:"requestId"`
	Decision  string    `json:"decision"`
	Message   string    `json:"message,omitempty"`
}

type ToolRequestFrame struct {
	Type           FrameType          `json:"type"`
	ID             int64              `json:"id"`
	RequestID      string             `json:"requestId"`
	ToolName       string             `json:"toolName"`
	Input          map[string]any     `json:"input"`
	Cwd            string             `json:"cwd"`
	WorkspaceRepo  *WorkspaceRepoSpec `json:"workspaceRepo,omitempty"`
	TimeoutMs      int64              `json:"timeoutMs"`
	MaxOutputBytes int64              `json:"maxOutputBytes"`
}

type ToolCancelFrame struct {
	Type      FrameType `json:"type"`
	RequestID string    `json:"requestId"`
	Reason    string    `json:"reason"`
}

type ModelsRequestFrame struct {
	Type       FrameType `json:"type"`
	ID         int64     `json:"id"`
	RequestID  string    `json:"requestId"`
	ProviderID string    `json:"providerId"`
}

type SkillsRequestFrame struct {
	Type       FrameType `json:"type"`
	ID         int64     `json:"id"`
	RequestID  string    `json:"requestId"`
	ProviderID string    `json:"providerId"`
	Cwd        string    `json:"cwd,omitempty"`
}

type DaemonUpdateRequestFrame struct {
	Type           FrameType `json:"type"`
	ID             int64     `json:"id"`
	LatestVersion  string    `json:"latestVersion"`
	CurrentVersion string    `json:"currentVersion,omitempty"`
	Reason         string    `json:"reason,omitempty"`
}

// ─── Bidirectional ───────────────────────────────────────────

type ErrorFrame struct {
	Type    FrameType `json:"type"`
	ID      *int64    `json:"id,omitempty"`
	Code    string    `json:"code"`
	Message string    `json:"message"`
	Fatal   bool      `json:"fatal,omitempty"`
}
