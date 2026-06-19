package main

import (
	_ "embed"
	"fmt"
	"strings"
)

//go:embed VERSION
var rawDaemonVersion string

var daemonVersion = "octodeck-daemon/" + strings.TrimSpace(rawDaemonVersion)

func runVersionCommand() {
	fmt.Println(daemonVersion)
}
