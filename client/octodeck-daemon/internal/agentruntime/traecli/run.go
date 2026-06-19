// Package traecli — run helpers.
//
// The heavy lifting (BuildRunCommand / RunPrompt) lives in runtime.go.
// This file documents the supported transports for the Trae CLI family.
//
// Note: although the daemonapp module-split target document only lists
// transport_stdio.go for traecli, the actual runtime.go also dispatches
// to ACPConnection when Transport() == "acp", so the family is bi-modal
// in practice. transport_acp.go captures that fact.
package traecli

// SupportedTransports lists the transports the Trae CLI family understands.
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
