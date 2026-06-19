package agentprotocol

import (
	"context"
	"io"
	"strings"
	"time"

	daemonconfig "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/config"
	inventory "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/inventory"
	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
)

// PermissionWaiter is the child/runtime bridge used by concrete agents when a
// transport emits a permission request and needs to wait for the platform
// decision.
type PermissionWaiter interface {
	AwaitPermissionDecision(ctx context.Context, runID, requestID string, timeout time.Duration) (proto.AgentPermissionDecisionFrame, error)
}

// EventEmitter forwards provider-native streaming events to the runtime
// facade. It intentionally carries only protocol frames and contains no
// factory or scheduling behaviour.
type EventEmitter func(proto.AgentRunEventFrame)

// RunContext carries the per-prompt data shared by agentruntime and concrete
// agent packages. It lives outside agentruntime so agent packages can implement
// their run methods without importing the runtime facade.
type RunContext struct {
	Runtime        PermissionWaiter
	Out            io.Writer
	Cfg            *daemonconfig.Config
	Client         inventory.Info
	Req            *proto.AgentRunRequestFrame
	Cwd            string
	Started        time.Time
	ProcessKey     string
	ConversationID string
	Emit           EventEmitter
	ParseLine      func(string) []proto.AgentRunEventFrame
}

// Agent is the daemon-internal abstraction every CLI/protocol backend must
// implement. The lifecycle is:
//
//	Discover  -> return per-process client metadata
//	Connect   -> write any provider-specific config (mcp.json, etc.)
//	CreateSession -> optional pre-run hook (most agents leave this empty)
//	RunPrompt -> produce the final AgentRunResultFrame for the request
//	ListSessions / DeleteSession -> enumerate / remove provider sessions
type Agent interface {
	Discover(ctx context.Context) inventory.Info
	Connect(ctx context.Context, run *RunContext) error
	CreateSession(ctx context.Context, run *RunContext) error
	RunPrompt(ctx context.Context, run *RunContext) (proto.AgentRunResultFrame, error)
	ListSessions(ctx context.Context, cfg *daemonconfig.Config, workspace string) ([]proto.AgentSessionInfo, error)
	DeleteSession(ctx context.Context, cfg *daemonconfig.Config, workspace, sessionID string) (bool, error)
}

// DirectPromptRunner lets transports that bypass the stdio CLI surface (HTTP,
// A2A, ACP) plug into direct prompt execution without inheriting from a
// generic agent struct.
type DirectPromptRunner interface {
	RunDirect(ctx context.Context, cfg *daemonconfig.Config, req *proto.AgentRunRequestFrame, emit func(proto.AgentRunEventFrame)) (proto.AgentRunResultFrame, error)
}

// FamilyConfig is the per-instance runtime configuration the AgentRuntime layer
// hands to a FamilyDriver when starting or restarting the underlying agent
// process.
type FamilyConfig struct {
	AgentClientID  string
	Cwd            string
	Workspace      *proto.AgentRunWorkspace
	Env            map[string]string
	MaxOutputBytes int64
	TimeoutMs      int64

	Model           string
	PermissionMode  string
	SystemPrompt    string
	AllowedTools    []string
	DisallowedTools []string
	ToolPolicy      map[string]string

	ResumeSessionID string

	Cfg    *daemonconfig.Config
	Client inventory.Info
	Entry  *daemonconfig.AgentRegistryEntry
}

// FamilyProcess wraps the driver-private handle to the underlying agent
// process plus the provider SessionID that process is currently bound to.
type FamilyProcess struct {
	SessionID  string
	CreatedNew bool
	handle     any
}

// Handle returns the driver-private handle. Only the FamilyDriver that created
// the FamilyProcess should call this; the AgentRuntime layer treats it as
// opaque.
func (p *FamilyProcess) Handle() any {
	if p == nil {
		return nil
	}
	return p.handle
}

// SetHandle lets a driver attach its private handle at StartProcess time.
func (p *FamilyProcess) SetHandle(h any) {
	if p == nil {
		return
	}
	p.handle = h
}

// FamilyDriver is the uniform adapter each agent family implements.
type FamilyDriver interface {
	ID() string
	StartProcess(ctx context.Context, cfg FamilyConfig) (*FamilyProcess, error)
	Prompt(ctx context.Context, fp *FamilyProcess, req *proto.AgentRunRequestFrame, emit func(proto.AgentRunEventFrame)) (proto.AgentRunResultFrame, error)
	Stop(fp *FamilyProcess) error
	ListSessions(ctx context.Context, cfg *daemonconfig.Config, workspace string) ([]proto.AgentSessionInfo, error)
	DeleteSession(ctx context.Context, cfg *daemonconfig.Config, workspace, sessionID string) (bool, error)
}

// RuntimePolicyUpdater is implemented by families whose live process can apply
// policy changes without a restart.
type RuntimePolicyUpdater interface {
	CanUpdateRuntimePolicy(req *proto.AgentRunRequestFrame) bool
}

// ConversationID picks the stable OctoDeck conversation identifier that owns
// the local agent runtime. The provider-native ACP session id is only the
// mapped value stored under this key; it must not define the runtime key.
func ConversationID(req *proto.AgentRunRequestFrame) string {
	if req == nil {
		return ""
	}
	if req.Workspace != nil {
		if v := strings.TrimSpace(req.Workspace.SessionRoot); v != "" {
			return v
		}
	}
	if req.Input.Metadata != nil {
		for _, key := range []string{"workspaceSessionId", "serverConversationId"} {
			if v, ok := req.Input.Metadata[key].(string); ok && strings.TrimSpace(v) != "" {
				return strings.TrimSpace(v)
			}
		}
	}
	if req.Workspace != nil && req.Workspace.ScopeID != "" && isSessionScope(req.Workspace.Scope, req.Workspace.ScopeID) {
		return req.Workspace.ScopeID
	}
	if req.Input.Metadata != nil {
		for _, key := range []string{"chatId", "conversationId", "conversationID", "sessionKey", "chatJid"} {
			if v, ok := req.Input.Metadata[key].(string); ok && strings.TrimSpace(v) != "" {
				return strings.TrimSpace(v)
			}
		}
	}
	if req.Workspace != nil && req.Workspace.Folder != "" {
		return req.Workspace.Folder
	}
	return req.RunID
}

func isSessionScope(scope, scopeID string) bool {
	return scope == "session" || scope == "direct_session" || (scope == "" && scopeID != "")
}
