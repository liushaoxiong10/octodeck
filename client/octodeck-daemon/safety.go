package main

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"
)

// validateRunRequest enforces client-side safety rules.
//
//  1. binary must be in cfg.AllowedBinaries (exact match, absolute path).
//  2. cwd must be absolute.
//  3. env keys must not include LD_PRELOAD, NODE_OPTIONS, DYLD_INSERT_LIBRARIES,
//     LD_LIBRARY_PATH, PATH (we don't let server override $PATH wholesale).
//  4. argv entries must not contain NUL bytes.
func validateRunRequest(cfg *Config, req *RunRequestFrame) error {
	if !filepath.IsAbs(req.Binary) {
		return fmt.Errorf("binary must be absolute: %q", req.Binary)
	}
	if !isAllowedBinary(cfg, req.Binary) {
		if !isDiscoveredAgentClientBinary(cfg, req.Binary) {
			return fmt.Errorf("binary not in allowedBinaries or discovered agent clients: %q", req.Binary)
		}
	}
	if req.Cwd == "" {
		return errors.New("cwd is required")
	}
	if !filepath.IsAbs(req.Cwd) {
		return fmt.Errorf("cwd must be absolute: %q", req.Cwd)
	}
	for _, a := range req.Argv {
		if strings.ContainsRune(a, 0) {
			return errors.New("argv contains NUL byte")
		}
	}
	for k := range req.Env {
		if isDangerousEnvKey(k) {
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

func isDiscoveredAgentClientBinary(cfg *Config, bin string) bool {
	clean := filepath.Clean(bin)
	for _, c := range cfg.AgentClients {
		if filepath.Clean(c.Binary) == clean {
			return true
		}
	}
	return false
}

func isAllowedBinary(cfg *Config, bin string) bool {
	clean := filepath.Clean(bin)
	for _, allowed := range cfg.AllowedBinaries {
		if filepath.Clean(allowed) == clean {
			return true
		}
	}
	return false
}

var dangerousEnvKeys = map[string]struct{}{
	"LD_PRELOAD":            {},
	"LD_LIBRARY_PATH":       {},
	"DYLD_INSERT_LIBRARIES": {},
	"DYLD_LIBRARY_PATH":     {},
	"NODE_OPTIONS":          {},
	"PATH":                  {},
}

func isDangerousEnvKey(k string) bool {
	_, ok := dangerousEnvKeys[strings.ToUpper(k)]
	return ok
}
