// Package codex — run helpers.
//
// The heavy lifting (BuildRunCommand / RunPrompt / Run) lives in runtime.go.
// This file documents the supported transports for the Codex family.
package codex

// SupportedTransports lists the transports the Codex family understands.
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
