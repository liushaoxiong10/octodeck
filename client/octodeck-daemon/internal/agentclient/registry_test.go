package agentclient

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRegisterAndRegisteredDescriptors(t *testing.T) {
	t.Cleanup(resetRegistryForTest)
	resetRegistryForTest()
	d1 := Descriptor{
		ID:              "demo-acp",
		DisplayName:     "Demo ACP",
		Family:          "demo",
		Provider:        "demo",
		Transport:       "acp",
		Binary:          "demo",
		Args:            []string{"acp"},
		VersionArgs:     []string{"--version"},
		PermissionModes: []string{"default"},
		Capabilities:    []string{"acp"},
	}
	Register(d1)

	got := RegisteredDescriptors()
	if len(got) != 1 {
		t.Fatalf("expected 1 descriptor, got %d", len(got))
	}
	if got[0].ID != "demo-acp" {
		t.Fatalf("unexpected descriptor: %#v", got[0])
	}
	// caller mutation must not leak back.
	got[0].Args[0] = "mutated"
	got[0].PermissionModes[0] = "mutated"
	if RegisteredDescriptors()[0].Args[0] != "acp" {
		t.Fatalf("registry returned aliased args slice")
	}
	if RegisteredDescriptors()[0].PermissionModes[0] != "default" {
		t.Fatalf("registry returned aliased slice")
	}
	d, ok := DescriptorByID("demo-acp")
	if !ok || d.Family != "demo" {
		t.Fatalf("DescriptorByID failed: %#v", d)
	}
	d2, ok := DescriptorByFamily("demo")
	if !ok || d2.ID != "demo-acp" {
		t.Fatalf("DescriptorByFamily failed: %#v", d2)
	}
	if _, ok := DescriptorByID("nope"); ok {
		t.Fatalf("DescriptorByID should miss")
	}
}

func TestRegisterPanicsOnDuplicateID(t *testing.T) {
	t.Cleanup(resetRegistryForTest)
	resetRegistryForTest()
	Register(Descriptor{ID: "dup", Binary: "x"})
	defer func() {
		if r := recover(); r == nil {
			t.Fatalf("expected panic on duplicate ID")
		}
	}()
	Register(Descriptor{ID: "dup", Binary: "y"})
}

func TestDiscoverFindsRegisteredDescriptorsOnPath(t *testing.T) {
	t.Cleanup(resetRegistryForTest)
	resetRegistryForTest()
	dir := t.TempDir()
	bin := filepath.Join(dir, "demo")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\necho ok\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	t.Setenv("OCTODECK_DAEMON_EXTRA_PATH", "")
	Register(Descriptor{
		ID:           "demo",
		DisplayName:  "Demo",
		Family:       "demo",
		Provider:     "demo",
		Transport:    "acp",
		Binary:       "demo",
		Args:         []string{"acp"},
		VersionArgs:  []string{"--version"},
		Capabilities: []string{"print"},
	})
	clients := Discover(Config{})
	if len(clients) != 1 || clients[0].Binary != bin {
		t.Fatalf("unexpected discover result: %#v", clients)
	}
	if clients[0].Family != "demo" || clients[0].Provider != "demo" {
		t.Fatalf("descriptor metadata not propagated: %#v", clients[0])
	}
	if clients[0].Transport != "acp" || len(clients[0].Args) != 1 || clients[0].Args[0] != "acp" {
		t.Fatalf("descriptor transport args not propagated: %#v", clients[0])
	}
}

func TestDiscoverDisableAutoDiscoverUsesRegistryOnly(t *testing.T) {
	t.Cleanup(resetRegistryForTest)
	resetRegistryForTest()
	Register(Descriptor{ID: "demo", Binary: "demo", Family: "demo"})
	clients := Discover(Config{
		DisableAutoDiscover: true,
		Registry: []RegistryEntry{{
			ID:        "custom",
			Binary:    "/bin/custom",
			Transport: "acp",
			Provider:  "custom",
		}},
	})
	if len(clients) != 1 || clients[0].ID != "custom" {
		t.Fatalf("expected only registry client, got %#v", clients)
	}
}

func TestNormalizeVersionOutput(t *testing.T) {
	if got := NormalizeVersionOutput("\n\nv1.2.3\nblah\n"); got != "v1.2.3" {
		t.Fatalf("unexpected version: %q", got)
	}
	if got := NormalizeVersionOutput(""); got != "" {
		t.Fatalf("expected empty string, got %q", got)
	}
}

func TestMergePrefersRegistryOverrides(t *testing.T) {
	auto := []Info{{ID: "a", Provider: "auto"}, {ID: "b", Provider: "auto"}}
	reg := []Info{{ID: "b", Provider: "registry"}, {ID: "c", Provider: "registry"}}
	merged := Merge(auto, reg)
	if len(merged) != 3 {
		t.Fatalf("expected 3, got %#v", merged)
	}
	for _, c := range merged {
		if c.ID == "b" && c.Provider != "registry" {
			t.Fatalf("registry override lost: %#v", c)
		}
	}
}
