//go:build unix

package main

import (
	"os"
	"strings"
	"syscall"
)

func envSnapshot() map[string]string {
	out := make(map[string]string, len(os.Environ()))
	for _, kv := range os.Environ() {
		i := strings.IndexByte(kv, '=')
		if i <= 0 {
			continue
		}
		out[kv[:i]] = kv[i+1:]
	}
	return out
}

func getSignal(sys any) (string, bool) {
	ws, ok := sys.(syscall.WaitStatus)
	if !ok {
		return "", false
	}
	if !ws.Signaled() {
		return "", false
	}
	return ws.Signal().String(), true
}
