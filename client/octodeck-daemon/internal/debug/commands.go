package debug

import (
	"bufio"
	"context"
	"flag"
	"fmt"
	"io"
	"strings"

	daemonconfig "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/config"
)

// RunDebugCommand is the debug subcommand entry point. It parses the
// CLI flags, optionally enters a REPL, and dispatches one-shot
// commands. version is plumbed in by the cmd shell so the embedded
// daemon version string appears in the output.
func RunDebugCommand(args []string, in io.Reader, out io.Writer, version string) error {
	fs := flag.NewFlagSet("debug", flag.ContinueOnError)
	var configPath string
	var jsonOutput bool
	fs.StringVar(&configPath, "config", "", "path to config.json")
	fs.BoolVar(&jsonOutput, "json", false, "print JSON for one command")
	if err := fs.Parse(args); err != nil {
		return err
	}
	cfg, err := daemonconfig.Load(configPath)
	if err != nil {
		return err
	}
	cfg.AgentClients = discoverAgentClients(cfg)
	command := strings.TrimSpace(strings.Join(fs.Args(), " "))
	if command == "" && !jsonOutput {
		return runDebugREPL(cfg, in, out, version)
	}
	if command == "" {
		command = "status"
	}
	return runOnce(context.Background(), cfg, command, jsonOutput, out, version)
}

func runDebugREPL(cfg *daemonconfig.Config, in io.Reader, out io.Writer, version string) error {
	fmt.Fprintf(out, "OctoDeck daemon debug shell (%s)\n", version)
	fmt.Fprintln(out, "输入 help 查看命令，quit/exit 退出。")
	scanner := bufio.NewScanner(in)
	for {
		fmt.Fprint(out, "octodeck-daemon> ")
		if !scanner.Scan() {
			fmt.Fprintln(out)
			return scanner.Err()
		}
		cmd := strings.TrimSpace(scanner.Text())
		if cmd == "" {
			continue
		}
		switch strings.ToLower(cmd) {
		case "quit", "exit", "q":
			fmt.Fprintln(out, "bye")
			return nil
		}
		if err := runOnce(context.Background(), cfg, cmd, false, out, version); err != nil {
			fmt.Fprintf(out, "error: %v\n", err)
		}
	}
}

func runOnce(ctx context.Context, cfg *daemonconfig.Config, command string, jsonOutput bool, out io.Writer, version string) error {
	snapshot, err := CollectSnapshot(ctx, cfg, version)
	if err != nil {
		return err
	}
	cmd := strings.ToLower(strings.TrimSpace(command))
	if cmd == "?" {
		cmd = "help"
	}
	if jsonOutput || cmd == "json" {
		return PrintJSON(out, snapshot)
	}
	switch cmd {
	case "help":
		PrintHelp(out)
	case "status", "state":
		PrintStatus(out, snapshot)
	case "clients", "agents":
		PrintClients(out, snapshot)
	case "sessions":
		PrintSessions(out, snapshot)
	case "acp", "mappings", "session-map":
		PrintACPMappings(out, snapshot)
	case "paths", "dirs":
		PrintPaths(out, snapshot)
	case "all":
		PrintStatus(out, snapshot)
		PrintPaths(out, snapshot)
		PrintClients(out, snapshot)
		PrintSessions(out, snapshot)
		PrintACPMappings(out, snapshot)
	default:
		return fmt.Errorf("unknown debug command %q", command)
	}
	return nil
}
