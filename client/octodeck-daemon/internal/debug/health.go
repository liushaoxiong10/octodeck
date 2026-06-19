package debug

import (
	"os"
	"regexp"
	"strings"

	daemonconfig "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/config"
	inventory "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/inventory"
)

// Healthy is a coarse-grained predicate other tools can use to verify
// the daemon's local state is sane (config dirs exist, agent registry
// reasonable). The implementation is intentionally lightweight; it
// does not verify network reachability.
func Healthy(cfg *daemonconfig.Config) bool {
	if cfg == nil {
		return false
	}
	if cfg.LinkID == "" || cfg.Server == "" {
		return false
	}
	if cfg.WorkspaceDir != "" {
		if info, err := os.Stat(cfg.WorkspaceDir); err != nil || !info.IsDir() {
			return false
		}
	}
	return true
}

func hostname() string {
	h, err := os.Hostname()
	if err != nil {
		return ""
	}
	return h
}

var unsafePathSegmentRe = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

// safePathSegment normalises an identifier into a path-safe form,
// matching the historical daemonapp behaviour.
func safePathSegment(s string) string {
	s = unsafePathSegmentRe.ReplaceAllString(s, "-")
	s = strings.Trim(s, ".-")
	if len(s) > 120 {
		s = s[:120]
	}
	return s
}

// providerDirName returns the on-disk session subdirectory for an agent client.
func providerDirName(client inventory.Info) string {
	if id := safePathSegment(client.ID); id != "" {
		return id
	}
	return "agent"
}

// discoverAgentClients mirrors node.inventoryDiscover; duplicated here
// instead of imported so the debug package stays independent of node.
func discoverAgentClients(cfg *daemonconfig.Config) []inventory.Info {
	if cfg == nil {
		return inventory.DiscoverForConfig(inventory.Config{})
	}
	entries := make([]inventory.RegistryEntry, 0, len(cfg.AgentRegistry))
	for _, e := range cfg.AgentRegistry {
		entries = append(entries, inventory.RegistryEntry{
			ID:              e.ID,
			DisplayName:     e.DisplayName,
			Provider:        e.Provider,
			Transport:       e.Transport,
			Binary:          e.Binary,
			Args:            append([]string(nil), e.Args...),
			PermissionModes: append([]string(nil), e.PermissionModes...),
			Capabilities:    append([]string(nil), e.Capabilities...),
		})
	}
	return inventory.DiscoverForConfig(inventory.Config{
		DisableAutoDiscover: cfg.RuntimePolicy.DisableAutoDiscover,
		Registry:            entries,
	})
}
