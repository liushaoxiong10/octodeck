package main

import (
	"encoding/json"
	"errors"
	"fmt"
)

// Frame types kept in sync with src/agent-link/protocol.ts.

type frameType string

const (
	tHello       frameType = "hello"
	tHelloAck    frameType = "hello_ack"
	tPing        frameType = "ping"
	tError       frameType = "error"
	tRunRequest  frameType = "run.request"
	tRunCancel   frameType = "run.cancel"
	tRunEvent    frameType = "run.event"
	tRunResult   frameType = "run.result"
	tToolRequest frameType = "tool.request"
	tToolCancel  frameType = "tool.cancel"
	tToolEvent   frameType = "tool.event"
	tToolResult  frameType = "tool.result"
	tModelsRequest frameType = "models.request"
	tModelsResult  frameType = "models.result"
	tSkillsRequest frameType = "skills.request"
	tSkillsResult  frameType = "skills.result"
)

// ─── Outbound (C→S) ──────────────────────────────────────────

type HelloFrame struct {
	Type         frameType         `json:"type"`
	ID           int64             `json:"id"`
	Version      string            `json:"version"`
	OS           string            `json:"os,omitempty"`
	Arch         string            `json:"arch,omitempty"`
	Hostname     string            `json:"hostname,omitempty"`
	Capabilities []string          `json:"capabilities"`
	AgentClients []AgentClientInfo `json:"agentClients,omitempty"`
	Resources    ResourceSnapshot  `json:"resources"`
}

type PingFrame struct {
	Type      frameType        `json:"type"`
	ID        int64            `json:"id"`
	Resources ResourceSnapshot `json:"resources"`
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
	ID          string `json:"id"`
	Name        string `json:"name,omitempty"`
	Description string `json:"description,omitempty"`
	Source      string `json:"source"`
	Enabled     bool   `json:"enabled"`
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
	Type           frameType         `json:"type"`
	ID             int64             `json:"id"`
	RunID          string            `json:"runId"`
	BackendID      string            `json:"backendId"`
	Binary         string            `json:"binary"`
	Argv           []string          `json:"argv"`
	Cwd            string            `json:"cwd"`
	Env            map[string]string `json:"env,omitempty"`
	OutputProtocol string            `json:"outputProtocol"`
	TimeoutMs      int64             `json:"timeoutMs"`
	MaxOutputBytes int64             `json:"maxOutputBytes"`
	Context        any               `json:"context,omitempty"`
	StdinJSON      string            `json:"stdinJson,omitempty"`
}

type RunCancelFrame struct {
	Type   frameType `json:"type"`
	RunID  string    `json:"runId"`
	Reason string    `json:"reason"`
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
