package agentruntime

import (
	"testing"

	daemonconfig "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/config"
	inventory "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/inventory"
	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
)

func TestValidateRuntimePolicyAcceptsSandboxAliasesForProductModes(t *testing.T) {
	cfg := &daemonconfig.Config{
		AgentClients: []inventory.Info{{
			ID:              "traex-acp",
			PermissionModes: []string{"default", "acceptEdits", "bypassPermissions", "plan"},
		}},
	}
	for _, mode := range []string{"read-only", "workspace-write", "danger-full-access", "bypass_permissions"} {
		req := &proto.AgentRunRequestFrame{
			AgentID: "traex-acp",
			Policy:  proto.AgentRunPolicy{PermissionMode: mode},
		}
		if err := ValidateRuntimePolicy(cfg, req); err != nil {
			t.Fatalf("ValidateRuntimePolicy(%q) returned error: %v", mode, err)
		}
	}
}

func TestValidateRuntimePolicyRejectsUnsupportedPermissionMode(t *testing.T) {
	cfg := &daemonconfig.Config{
		AgentClients: []inventory.Info{{
			ID:              "traex-acp",
			PermissionModes: []string{"default", "acceptEdits", "bypassPermissions", "plan"},
		}},
	}
	req := &proto.AgentRunRequestFrame{
		AgentID: "traex-acp",
		Policy:  proto.AgentRunPolicy{PermissionMode: "not-a-mode"},
	}
	if err := ValidateRuntimePolicy(cfg, req); err == nil {
		t.Fatal("expected unsupported permission mode to be rejected")
	}
}
