package protocol

// Protocol version numbers exchanged in the hello frame.
//
// CurrentProtocolVersion is the version this daemon speaks natively.
// MinProtocolVersion is the lowest version the daemon can still negotiate
// down to when talking to an older server.
const (
	CurrentProtocolVersion = 2
	MinProtocolVersion     = 1
)

// DaemonNamePrefix is the prefix used in version strings reported to the
// server (e.g. "octodeck-daemon/1.2.3"). The fully qualified version string
// is assembled by daemonapp/agentruntime at startup.
const DaemonNamePrefix = "octodeck-daemon"

// FrameType identifies the kind of protocol frame carried in the "type"
// field of every JSON envelope. It is kept in sync with the TypeScript
// counterpart in src/agent-link/protocol.ts.
type FrameType string

// Frame type tag constants.
const (
	THello                     FrameType = "hello"
	THelloAck                  FrameType = "hello_ack"
	TPing                      FrameType = "ping"
	TError                     FrameType = "error"
	TRunRequest                FrameType = "run.request"
	TRunCancel                 FrameType = "run.cancel"
	TRunStatus                 FrameType = "run.status"
	TRunEvent                  FrameType = "run.event"
	TRunResult                 FrameType = "run.result"
	TAgentRunRequest           FrameType = "agent.run.request"
	TAgentRunCancel            FrameType = "agent.run.cancel"
	TAgentRunStatus            FrameType = "agent.run.status"
	TAgentRunEvent             FrameType = "agent.run.event"
	TAgentRunResult            FrameType = "agent.run.result"
	TAgentDiscoverRequest      FrameType = "agent.discover.request"
	TAgentDiscoverResult       FrameType = "agent.discover.result"
	TAgentSessionsRequest      FrameType = "agent.sessions.request"
	TAgentSessionsResult       FrameType = "agent.sessions.result"
	TAgentSessionDeleteRequest FrameType = "agent.session.delete.request"
	TAgentSessionDeleteResult  FrameType = "agent.session.delete.result"
	TWorkspaceCleanupRequest   FrameType = "workspace.cleanup.request"
	TWorkspaceGitStatusRequest FrameType = "workspace.git.status.request"
	TWorkspaceGitStatusResult  FrameType = "workspace.git.status.result"
	TWorkspaceGitCommitRequest FrameType = "workspace.git.commit.request"
	TWorkspaceGitCommitResult  FrameType = "workspace.git.commit.result"
	TAgentPermissionDecision   FrameType = "agent.permission.decision"
	TAgentRuntimeStatus        FrameType = "agent.runtime.status"
	TToolRequest               FrameType = "tool.request"
	TToolCancel                FrameType = "tool.cancel"
	TToolEvent                 FrameType = "tool.event"
	TToolResult                FrameType = "tool.result"
	TModelsRequest             FrameType = "models.request"
	TModelsResult              FrameType = "models.result"
	TSkillsRequest             FrameType = "skills.request"
	TSkillsResult              FrameType = "skills.result"
	TDaemonUpdateRequest       FrameType = "daemon.update.request"
	TMemorySync                FrameType = "memory.sync"
)
