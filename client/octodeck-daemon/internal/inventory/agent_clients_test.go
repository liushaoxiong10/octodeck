package inventory_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	_ "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentruntime"
	inventory "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/inventory"
)

func TestDiscoverFindsSupportedClientsOnPath(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"claude", "codex", "traecli"} {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte("#!/bin/sh\necho "+name+" 1.0\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", dir)
	t.Setenv("OCTODECK_DAEMON_EXTRA_PATH", "")

	clients := inventory.Discover()
	byID := map[string]inventory.Info{}
	for _, c := range clients {
		byID[c.ID] = c
	}
	if byID["claude-code"].Binary != filepath.Join(dir, "claude") {
		t.Fatalf("missing claude-code discovery: %#v", clients)
	}
	if byID["codex"].Binary != filepath.Join(dir, "codex") {
		t.Fatalf("missing codex discovery: %#v", clients)
	}
	trae := byID["traecli"]
	if trae.Binary != filepath.Join(dir, "traecli") {
		t.Fatalf("missing traecli discovery: %#v", clients)
	}
	if trae.Transport != "acp" || strings.Join(trae.Args, " ") != "acp serve" {
		t.Fatalf("traecli should default to ACP subcommand: %#v", trae)
	}
}

func TestRegistryClientsSupportsACPTransport(t *testing.T) {
	clients := inventory.RegistryClients([]inventory.RegistryEntry{{
		ID:              "custom-acp",
		DisplayName:     "Custom ACP",
		Binary:          "/bin/custom",
		Transport:       "acp",
		Provider:        "custom-provider",
		Args:            []string{"serve"},
		PermissionModes: []string{"default", "bypassPermissions"},
		Capabilities:    []string{"acp"},
	}})
	if len(clients) != 1 {
		t.Fatalf("expected one registry client, got %#v", clients)
	}
	client := clients[0]
	if client.Transport != "acp" || client.Provider != "custom-provider" || strings.Join(client.Args, " ") != "serve" {
		t.Fatalf("unexpected registry client: %#v", client)
	}
}
