package agentruntime

import (
	agentprotocol "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentprotocol"
)

// Agent is the daemon-internal abstraction every CLI/protocol backend must
// implement. The lifecycle is:
//
//	Discover  → return per-process client metadata
//	Connect   → write any provider-specific config (mcp.json, etc.)
//	CreateSession → optional pre-run hook (most agents leave this empty)
//	RunPrompt → produce the final AgentRunResultFrame for the request
//	ListSessions / DeleteSession → enumerate / remove provider sessions
//
// Implementations live in daemonapp; this interface is hosted here so the
// agent-runtime supervisor and the child server can both reference it
// without importing daemonapp.
type Agent = agentprotocol.Agent

// DirectPromptRunner lets transports that bypass the stdio CLI surface (HTTP,
// A2A, ACP) plug into runDirectAgentPrompt without inheriting from a
// generic agent struct.
type DirectPromptRunner = agentprotocol.DirectPromptRunner
