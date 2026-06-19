//go:build unix

package executor

import "syscall"

// getRunSignal extracts the signal name from a syscall.WaitStatus
// returned by os/exec on unix platforms. Mirrors the helper that used
// to live in internal/daemonrunner/signal_unix.go.
func getRunSignal(sys any) (string, bool) {
	ws, ok := sys.(syscall.WaitStatus)
	if !ok {
		return "", false
	}
	if !ws.Signaled() {
		return "", false
	}
	return ws.Signal().String(), true
}
