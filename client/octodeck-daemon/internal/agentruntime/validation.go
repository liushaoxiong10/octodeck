package agentruntime

import (
	"errors"
	"fmt"
	"path/filepath"

	daemonconfig "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/config"
	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
	security "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/security"
	workspace "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/workspace"
)

// ValidateAgentRunRequest runs pre-flight validation on an agent run request.
func ValidateAgentRunRequest(cfg *daemonconfig.Config, req *proto.AgentRunRequestFrame) error {
	if req.RunID == "" || req.AgentID == "" {
		return errors.New("runId and agentId are required")
	}
	if req.Input.Prompt == "" {
		return errors.New("input.prompt is required")
	}
	if FindAgentClient(cfg, req.AgentID) == nil {
		return fmt.Errorf("agent client not discovered: %s", req.AgentID)
	}
	if req.Cwd == "" && (req.Workspace == nil || (req.Workspace.Cwd == "" && req.Workspace.Folder == "" && req.Workspace.Repo == nil)) {
		return errors.New("cwd is required")
	}
	if req.Cwd != "" && !filepath.IsAbs(req.Cwd) && !IsDeviceManagedURI(req.Cwd) {
		return fmt.Errorf("cwd must be absolute: %q", req.Cwd)
	}
	if req.Workspace != nil && req.Workspace.Cwd != "" && !filepath.IsAbs(req.Workspace.Cwd) && !IsDeviceManagedURI(req.Workspace.Cwd) {
		return fmt.Errorf("workspace.cwd must be absolute: %q", req.Workspace.Cwd)
	}
	for k := range req.Env {
		if IsDangerousEnvKey(k) {
			return fmt.Errorf("env key not allowed: %q", k)
		}
	}
	if err := ValidateRuntimePolicy(cfg, req); err != nil {
		return err
	}
	if req.TimeoutMs <= 0 {
		return errors.New("timeoutMs must be positive")
	}
	if req.MaxOutputBytes <= 0 {
		return errors.New("maxOutputBytes must be positive")
	}
	return nil
}

// ValidateRuntimePolicy checks the request's policy against the runtime policy
// configuration (allowed/disallowed tools, permission modes).
func ValidateRuntimePolicy(cfg *daemonconfig.Config, req *proto.AgentRunRequestFrame) error {
	entry := FindAgentRegistryEntry(cfg, req.AgentID)
	allowedTools := cfg.RuntimePolicy.AllowedTools
	disallowedTools := cfg.RuntimePolicy.DisallowedTools
	if entry != nil {
		if len(entry.AllowedTools) > 0 {
			allowedTools = entry.AllowedTools
		}
		if len(entry.DisallowedTools) > 0 {
			disallowedTools = entry.DisallowedTools
		}
	}
	if req.Policy.PermissionMode != "" {
		client := FindAgentClient(cfg, req.AgentID)
		if client != nil {
			modes := EffectivePermissionModes(cfg, entry, *client)
			if len(modes) > 0 && !IsSupportedPermissionMode(modes, req.Policy.PermissionMode) {
				return fmt.Errorf("permissionMode not allowed for agent %s: %s", req.AgentID, req.Policy.PermissionMode)
			}
		}
	}
	if len(allowedTools) > 0 {
		for _, tool := range req.Policy.AllowedTools {
			if !ContainsString(allowedTools, tool) {
				return fmt.Errorf("tool not allowed by runtime policy: %s", tool)
			}
		}
	}
	for _, tool := range req.Policy.AllowedTools {
		if ContainsString(disallowedTools, tool) {
			return fmt.Errorf("tool disallowed by runtime policy: %s", tool)
		}
	}
	for _, tool := range req.Policy.DisallowedTools {
		if len(allowedTools) > 0 && !ContainsString(allowedTools, tool) {
			return fmt.Errorf("tool policy references unknown tool: %s", tool)
		}
	}
	return nil
}

// IsWorkspaceAllowedByRuntimePolicy returns true if the given cwd is within the
// configured allowed workspaces for the agent.
func IsWorkspaceAllowedByRuntimePolicy(cfg *daemonconfig.Config, agentID, cwd string) bool {
	if cfg == nil {
		return true
	}
	allowed := cfg.RuntimePolicy.AllowedWorkspaces
	if entry := FindAgentRegistryEntry(cfg, agentID); entry != nil && len(entry.AllowedWorkspaces) > 0 {
		allowed = entry.AllowedWorkspaces
	}
	if len(allowed) == 0 {
		return true
	}
	return IsPathAllowedByConfiguredRoots(cwd, allowed)
}

// IsDeviceManagedURI returns true if the path is an octodeck-workspace:// or
// octodeck-tmp:// URI.
func IsDeviceManagedURI(value string) bool {
	return workspace.IsManagedURI(value)
}

// IsRunCwdAllowed returns true if the cwd is within the configured allowed
// roots or under the device's managed workspace/session/task/tmp directories.
func IsRunCwdAllowed(cfg *daemonconfig.Config, cwd string) bool {
	return security.IsRunCwdAllowed(cfg, cwd)
}

// IsPathAllowedByRoots returns true if path is under one of the given roots,
// using cwd as a fallback root.
func IsPathAllowedByRoots(p string, roots []string, cwd string) bool {
	return security.IsPathAllowedByRoots(p, roots, cwd)
}

// IsPathAllowedByConfiguredRoots returns true if path is under one of the
// configured root paths (roots are interpreted as-is, without cwd fallback).
func IsPathAllowedByConfiguredRoots(p string, roots []string) bool {
	return security.IsPathAllowedByConfiguredRoots(p, roots)
}
