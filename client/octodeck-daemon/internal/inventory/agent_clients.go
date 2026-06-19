package inventory

import agentclient "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/agentclient"

type Info = agentclient.Info
type RegistryEntry = agentclient.RegistryEntry
type Config = agentclient.Config

func Discover(cfg ...Config) []Info {
	if len(cfg) > 0 {
		return agentclient.Discover(cfg[0])
	}
	return agentclient.Discover(Config{})
}

func DiscoverForConfig(cfg Config) []Info {
	return agentclient.Discover(cfg)
}

func RegistryClients(registry []RegistryEntry) []Info {
	return agentclient.RegistryClients(registry)
}

func Merge(auto []Info, registry []Info) []Info {
	return agentclient.Merge(auto, registry)
}

func DetectVersion(id string, binary string) string {
	return agentclient.DetectVersion(id, binary)
}

func DetectVersionWithArgs(binary string, args []string) string {
	return agentclient.DetectVersionWithArgs(binary, args)
}

func DetectOutputWithArgs(binary string, args []string) (string, bool) {
	return agentclient.DetectOutputWithArgs(binary, args)
}

func NormalizeVersionOutput(s string) string {
	return agentclient.NormalizeVersionOutput(s)
}
