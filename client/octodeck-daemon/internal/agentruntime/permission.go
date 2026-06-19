package agentruntime

import (
	"strings"

	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
)

// PromptWithSystemContext wraps the OctoDeck-side system prompt around the
// user prompt when the family does not natively carry a system prompt and the
// turn is not a continued session.
func PromptWithSystemContext(req *proto.AgentRunRequestFrame, includeSystemContext bool) string {
	if req == nil {
		return ""
	}
	if !includeSystemContext || strings.TrimSpace(req.Policy.SystemPrompt) == "" {
		return req.Input.Prompt
	}
	return strings.Join([]string{
		"<octodeck-system-context>",
		req.Policy.SystemPrompt,
		"</octodeck-system-context>",
		"",
		"<user-prompt>",
		req.Input.Prompt,
		"</user-prompt>",
	}, "\n")
}
