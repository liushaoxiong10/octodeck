package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDiscoverAgentClientsFindsSupportedClientsOnPath(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"claude", "codex", "traecli"} {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte("#!/bin/sh\necho "+name+" 1.0\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", dir)

	clients := discoverAgentClients()
	ids := map[string]string{}
	for _, c := range clients {
		ids[c.ID] = c.Binary
	}

	if ids["claude-code"] != filepath.Join(dir, "claude") {
		t.Fatalf("missing claude-code discovery: %#v", clients)
	}
	if ids["codex"] != filepath.Join(dir, "codex") {
		t.Fatalf("missing codex discovery: %#v", clients)
	}
	if ids["traecli"] != filepath.Join(dir, "traecli") {
		t.Fatalf("missing traecli discovery: %#v", clients)
	}
}

func TestDiscoverAgentClientsCollectsVersion(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "codex")
	if err := os.WriteFile(p, []byte("#!/bin/sh\necho 'codex-cli 1.2.3'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	t.Setenv("HCAGENT_EXTRA_PATH", "")

	clients := discoverAgentClients()
	for _, c := range clients {
		if c.ID == "codex" {
			if c.Version != "codex-cli 1.2.3" {
				t.Fatalf("unexpected codex version %q in %#v", c.Version, clients)
			}
			return
		}
	}
	t.Fatalf("missing codex discovery: %#v", clients)
}

func TestDiscoverAgentClientsFindsHomeLocalBinWhenPathIsMinimal(t *testing.T) {
	home := t.TempDir()
	binDir := filepath.Join(home, ".local", "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"claude", "codex", "traecli"} {
		p := filepath.Join(binDir, name)
		if err := os.WriteFile(p, []byte("#!/bin/sh\necho "+name+" 1.0\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("HOME", home)
	t.Setenv("PATH", "/usr/bin:/bin")
	t.Setenv("HCAGENT_EXTRA_PATH", "")

	clients := discoverAgentClients()
	ids := map[string]string{}
	for _, c := range clients {
		ids[c.ID] = c.Binary
	}

	if ids["claude-code"] != filepath.Join(binDir, "claude") {
		t.Fatalf("missing claude-code from home local bin: %#v", clients)
	}
	if ids["codex"] != filepath.Join(binDir, "codex") {
		t.Fatalf("missing codex from home local bin: %#v", clients)
	}
	if ids["traecli"] != filepath.Join(binDir, "traecli") {
		t.Fatalf("missing traecli from home local bin: %#v", clients)
	}
}

func TestDiscoverAgentClientsFindsExtraPathWhenPathIsMinimal(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "codex")
	if err := os.WriteFile(p, []byte("#!/bin/sh\necho codex 1.0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", "/usr/bin:/bin")
	t.Setenv("HCAGENT_EXTRA_PATH", dir)

	clients := discoverAgentClients()
	for _, c := range clients {
		if c.ID == "codex" && c.Binary == p {
			return
		}
	}
	t.Fatalf("missing codex from HCAGENT_EXTRA_PATH: %#v", clients)
}
