// Package traecli — permission mode mapping.
//
// The trae CLI's stdio surface mostly passes the OctoDeck permission
// mode through verbatim — the only side-effect that historically lived
// inside agentruntime.TraecliArgvBuilder is appending "-y" when the
// requested mode resolves to one of the "bypass / auto-approve" aliases.
//
// This file owns both halves so the family sub-package is self-
// contained: argv construction (transport_stdio.go::buildStdioArgv)
// reads `shouldAutoApprove` from this file, and any future divergence
// (e.g. trae-specific alias normalisation) has an obvious home.
package traecli

import "strings"

// mapPermissionMode normalises an OctoDeck permission mode for the
// trae CLI. Today the trae CLI does not accept a `--permission-mode`
// flag on stdio — auto-approval is conveyed via the `-y` shortcut
// instead — so this mapper is effectively a passthrough placeholder
// kept for symmetry with the other family sub-packages.
func mapPermissionMode(mode string) string { return mode }

// shouldAutoApprove returns true when the OctoDeck-side permission mode
// resolves to one of the "bypass" aliases that the trae CLI honours by
// appending `-y` to its argv. Mirrors the original
// agentruntime.shouldAutoApprove logic.
func shouldAutoApprove(mode string) bool {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case "bypasspermissions", "full-access", "dangerously-skip-permissions", "no-approval", "auto-approve":
		return true
	default:
		return false
	}
}
