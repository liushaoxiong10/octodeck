// Package claudecode — run helpers.
//
// The heavy lifting (BuildRunCommand / RunPrompt / Run) lives in runtime.go.
// This file only carries a small family-scoped helper that documents which
// transport modes the Claude family supports so callers don't need to grep
// runtime.go to answer the question.
package claudecode

// SupportedTransports lists the transports the Claude family understands.
// The order is meaningful: stdio first because it is the default, followed
// by acp which uses the embedded claudeacp adapter.
var SupportedTransports = []string{"stdio", "acp"}

// IsSupportedTransport reports whether the given transport string can be
// dispatched by Agent.RunPrompt for this family.
func IsSupportedTransport(transport string) bool {
	for _, t := range SupportedTransports {
		if t == transport {
			return true
		}
	}
	return false
}
