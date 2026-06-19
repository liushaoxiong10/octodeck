package protocol

import (
	"encoding/json"
	"fmt"
)

// inboundEnvelope is the partial decoder used to dispatch frames.
type inboundEnvelope struct {
	Type FrameType `json:"type"`
}

// ParseInbound decodes a raw JSON frame and returns the concrete typed
// frame value (always returned as a pointer). The returned value is one
// of: *HelloAckFrame, *RunRequestFrame, *RunCancelFrame, *AgentRun*Frame,
// *Tool*Frame, *Models/SkillsRequestFrame, *DaemonUpdateRequestFrame,
// or *ErrorFrame.
func ParseInbound(raw []byte) (any, error) {
	var env inboundEnvelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, fmt.Errorf("invalid_json: %w", err)
	}
	switch env.Type {
	case THelloAck:
		var f HelloAckFrame
		if err := json.Unmarshal(raw, &f); err != nil {
			return nil, err
		}
		return &f, nil
	case TRunRequest:
		var f RunRequestFrame
		if err := json.Unmarshal(raw, &f); err != nil {
			return nil, err
		}
		return &f, nil
	case TRunCancel:
		var f RunCancelFrame
		if err := json.Unmarshal(raw, &f); err != nil {
			return nil, err
		}
		return &f, nil
	case TAgentRunRequest:
		var f AgentRunRequestFrame
		if err := json.Unmarshal(raw, &f); err != nil {
			return nil, err
		}
		return &f, nil
	case TAgentRunCancel:
		var f AgentRunCancelFrame
		if err := json.Unmarshal(raw, &f); err != nil {
			return nil, err
		}
		return &f, nil
	case TAgentDiscoverRequest:
		var f AgentDiscoverRequestFrame
		if err := json.Unmarshal(raw, &f); err != nil {
			return nil, err
		}
		return &f, nil
	case TAgentSessionsRequest:
		var f AgentSessionsRequestFrame
		if err := json.Unmarshal(raw, &f); err != nil {
			return nil, err
		}
		return &f, nil
	case TAgentSessionDeleteRequest:
		var f AgentSessionDeleteRequestFrame
		if err := json.Unmarshal(raw, &f); err != nil {
			return nil, err
		}
		return &f, nil
	case TWorkspaceCleanupRequest:
		var f WorkspaceCleanupRequestFrame
		if err := json.Unmarshal(raw, &f); err != nil {
			return nil, err
		}
		return &f, nil
	case TAgentPermissionDecision:
		var f AgentPermissionDecisionFrame
		if err := json.Unmarshal(raw, &f); err != nil {
			return nil, err
		}
		return &f, nil
	case TToolRequest:
		var f ToolRequestFrame
		if err := json.Unmarshal(raw, &f); err != nil {
			return nil, err
		}
		return &f, nil
	case TToolCancel:
		var f ToolCancelFrame
		if err := json.Unmarshal(raw, &f); err != nil {
			return nil, err
		}
		return &f, nil
	case TModelsRequest:
		var f ModelsRequestFrame
		if err := json.Unmarshal(raw, &f); err != nil {
			return nil, err
		}
		return &f, nil
	case TSkillsRequest:
		var f SkillsRequestFrame
		if err := json.Unmarshal(raw, &f); err != nil {
			return nil, err
		}
		return &f, nil
	case TDaemonUpdateRequest:
		var f DaemonUpdateRequestFrame
		if err := json.Unmarshal(raw, &f); err != nil {
			return nil, err
		}
		return &f, nil
	case TError:
		var f ErrorFrame
		if err := json.Unmarshal(raw, &f); err != nil {
			return nil, err
		}
		return &f, nil
	default:
		return nil, fmt.Errorf("unknown frame type: %q", env.Type)
	}
}
