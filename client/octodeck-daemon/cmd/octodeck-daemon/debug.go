package main

import (
	"io"

	debugpkg "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/debug"
)

// runDebugCommand is a thin shell that delegates to internal/debug. The
// real implementation (snapshot collection, REPL, render functions)
// lives in internal/debug after stage 5.
func runDebugCommand(args []string, in io.Reader, out io.Writer) error {
	return debugpkg.RunDebugCommand(args, in, out, daemonVersion)
}
