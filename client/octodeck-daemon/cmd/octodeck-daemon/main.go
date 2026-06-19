package main

import (
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"

	node "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/node"
	daemonupdate "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/update"
)

func main() {
	configureLogOutput()
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "version", "--version", "-version":
			runVersionCommand()
			return
		case "update":
			if err := daemonupdate.RunUpdateCommand(os.Args[2:]); err != nil {
				log.Fatalf("octodeck-daemon update: %v", err)
			}
			return
		case "uninstall":
			if err := daemonupdate.RunUninstallCommand(os.Args[2:]); err != nil {
				log.Fatalf("octodeck-daemon uninstall: %v", err)
			}
			return
		case "debug":
			if err := runDebugCommand(os.Args[2:], os.Stdin, os.Stdout); err != nil {
				log.Fatalf("octodeck-daemon debug: %v", err)
			}
			return
		case "mcp-agent-team":
			if err := runAgentTeamMCPCommand(os.Args[2:]); err != nil {
				log.Fatalf("octodeck-daemon mcp-agent-team: %v", err)
			}
			return
		case "agent-runtime":
			if err := runAgentRuntimeCommand(os.Args[2:]); err != nil {
				log.Fatalf("octodeck-daemon agent-runtime: %v", err)
			}
			return
		}
		// Reject any other positional subcommand. Flags (-config etc.)
		// fall through to the default node.Start path.
		if first := os.Args[1]; len(first) > 0 && first[0] != '-' {
			fmt.Fprintf(os.Stderr, "octodeck-daemon: unknown command %q (try: version, update, uninstall, debug, mcp-agent-team, agent-runtime)\n", first)
			os.Exit(2)
		}
	}

	if err := node.Start(node.Options{ConfigPath: parseConfigFlag(os.Args[1:]), Version: daemonVersion}); err != nil {
		log.Fatalf("octodeck-daemon: %v", err)
	}
}

func configureLogOutput() {
	home, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(home) == "" {
		return
	}
	logDir := filepath.Join(home, ".octodeck", "daemon")
	if err := os.MkdirAll(logDir, 0o700); err != nil {
		return
	}
	logPath := filepath.Join(logDir, "octodeck-daemon.log")
	f, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	log.SetOutput(io.MultiWriter(os.Stderr, f))
}

// parseConfigFlag does a minimal scan of the daemon flags so we can pass
// --config through to node.Start without depending on package flag's
// global state.
func parseConfigFlag(args []string) string {
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "-config", "--config":
			if i+1 < len(args) {
				return args[i+1]
			}
		}
		if v, ok := strings.CutPrefix(args[i], "-config="); ok {
			return v
		}
		if v, ok := strings.CutPrefix(args[i], "--config="); ok {
			return v
		}
	}
	return ""
}
