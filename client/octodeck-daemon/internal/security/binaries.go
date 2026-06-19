package security

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"

	daemonconfig "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/config"
	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
	workspace "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/workspace"
)

// IsAllowedBinary returns true if the binary path exactly matches (after
// filepath.Clean) one of the configured AllowedBinaries entries.
func IsAllowedBinary(cfg *daemonconfig.Config, binary string) bool {
	clean := filepath.Clean(binary)
	for _, allowed := range cfg.AllowedBinaries {
		if filepath.Clean(allowed) == clean {
			return true
		}
	}
	return false
}

// IsDiscoveredAgentClientBinary returns true if the binary path matches the
// Binary field of any runtime-discovered agent client entry.
func IsDiscoveredAgentClientBinary(cfg *daemonconfig.Config, binary string) bool {
	clean := filepath.Clean(binary)
	for _, c := range cfg.AgentClients {
		if filepath.Clean(c.Binary) == clean {
			return true
		}
	}
	return false
}

// ValidateRunRequest enforces client-side safety rules for a plain run request.
//
//  1. binary must be in cfg.AllowedBinaries (exact match, absolute path).
//  2. cwd must be absolute, or an octodeck-workspace:// / octodeck-tmp:// URI
//     that will be resolved under the managed device runtime root before spawning.
//  3. env keys must not include LD_PRELOAD, NODE_OPTIONS, DYLD_INSERT_LIBRARIES,
//     LD_LIBRARY_PATH, PATH (we don't let server override $PATH wholesale).
//  4. cwd must be under ~/.octodeck or the configured allowed roots.
//  5. argv entries must not contain NUL bytes.
func ValidateRunRequest(cfg *daemonconfig.Config, req *proto.RunRequestFrame) error {
	if !filepath.IsAbs(req.Binary) {
		return fmt.Errorf("binary must be absolute: %q", req.Binary)
	}
	if !IsAllowedBinary(cfg, req.Binary) {
		if !IsDiscoveredAgentClientBinary(cfg, req.Binary) {
			return fmt.Errorf("binary not in allowedBinaries or discovered agent clients: %q", req.Binary)
		}
	}
	if req.Cwd == "" {
		return errors.New("cwd is required")
	}
	if !filepath.IsAbs(req.Cwd) && !IsDeviceManagedURI(req.Cwd) {
		return fmt.Errorf("cwd must be absolute: %q", req.Cwd)
	}
	for _, a := range req.Argv {
		if strings.ContainsRune(a, 0) {
			return errors.New("argv contains NUL byte")
		}
	}
	for k := range req.Env {
		if IsDangerousKey(k) {
			return fmt.Errorf("env key not allowed: %q", k)
		}
	}
	if req.TimeoutMs <= 0 {
		return errors.New("timeoutMs must be positive")
	}
	if req.MaxOutputBytes <= 0 {
		return errors.New("maxOutputBytes must be positive")
	}
	switch req.OutputProtocol {
	case "jsonline-stream-json", "plain-text":
		// ok
	default:
		return fmt.Errorf("unknown outputProtocol: %q", req.OutputProtocol)
	}
	return nil
}

// IsDeviceManagedURI returns true if the path is an octodeck-workspace:// or
// octodeck-tmp:// URI.
func IsDeviceManagedURI(value string) bool {
	return workspace.IsManagedURI(value)
}
