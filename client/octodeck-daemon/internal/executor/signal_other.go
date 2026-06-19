//go:build !unix

package executor

// getRunSignal is a stub on non-unix platforms.
func getRunSignal(any) (string, bool) { return "", false }
