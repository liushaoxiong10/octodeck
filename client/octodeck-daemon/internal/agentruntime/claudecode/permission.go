// Package claudecode — permission mode mapping.
//
// Claude's CLI accepts OctoDeck's permission mode string directly
// (default / plan / acceptEdits / bypassPermissions), so this mapper is
// effectively a passthrough. It exists as a placeholder so that the four
// family sub-packages share the same shape (each owning argv + permission
// + descriptor + sessions) and so future divergence (claude-specific
// alias normalisation) has an obvious home.
package claudecode

// mapPermissionMode normalises an OctoDeck permission mode for the
// Claude CLI. Claude currently passes the mode through verbatim; this
// function exists as a placeholder so future divergence (alias
// normalisation, mode validation) has an obvious home.
func mapPermissionMode(mode string) string {
	return mode
}
