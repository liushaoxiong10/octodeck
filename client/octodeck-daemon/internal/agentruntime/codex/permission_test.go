package codex

import (
	"reflect"
	"testing"

	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
)

func TestMapPermissionModeAlignsOctoDeckModesToCodexSandbox(t *testing.T) {
	cases := map[string]string{
		"default":           "read-only",
		"plan":              "read-only",
		"acceptEdits":       "workspace-write",
		"bypassPermissions": "danger-full-access",
		"full-access":       "danger-full-access",
	}
	for input, want := range cases {
		if got := mapPermissionMode(input); got != want {
			t.Fatalf("mapPermissionMode(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestBuildStdioArgvUsesAlignedPermissionModes(t *testing.T) {
	req := &proto.AgentRunRequestFrame{
		Input: proto.AgentRunInput{Prompt: "hello"},
		Policy: proto.AgentRunPolicy{
			PermissionMode: "default",
		},
	}
	want := []string{"exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only", "hello"}
	if got := buildStdioArgv(req); !reflect.DeepEqual(got, want) {
		t.Fatalf("buildStdioArgv(default) = %#v, want %#v", got, want)
	}

	req.Policy.PermissionMode = "acceptEdits"
	want = []string{"exec", "--json", "--skip-git-repo-check", "--sandbox", "workspace-write", "hello"}
	if got := buildStdioArgv(req); !reflect.DeepEqual(got, want) {
		t.Fatalf("buildStdioArgv(acceptEdits) = %#v, want %#v", got, want)
	}
}
