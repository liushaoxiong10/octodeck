package main

import (
	"os"

	agentruntime "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentruntime"
	daemonconfig "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/config"
)

func runAgentRuntimeCommand(args []string) error {
	cfg, err := daemonconfig.Load(parseConfigFlag(args))
	if err != nil {
		return err
	}
	server := agentruntime.NewRuntimeChildServer(cfg)
	return server.Serve(os.Stdin, os.Stdout)
}
