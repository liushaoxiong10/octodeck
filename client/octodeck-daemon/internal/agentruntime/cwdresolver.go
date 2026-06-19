// Package agentruntime: cwdresolver.go contains the per-run cwd resolution
// logic used by the agent-runtime child process. It mirrors the legacy
// daemonapp.agentRuntimeProcess.resolveCwd, factored out so the shim layer
// can call into it.
package agentruntime

import (
	"context"
	"errors"
	"fmt"
	"log"
	"time"

	daemonconfig "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/config"
	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
	session "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/session"
	state "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/state"
	workspaceutil "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/workspace"
)

// ResolveRunCwd determines the working directory for an agent run. It
// applies workspace/session/task scope normalisation, materialises any
// device-managed workspace URIs, and validates the resulting cwd against
// the runtime policy.
func ResolveRunCwd(ctx context.Context, cfg *daemonconfig.Config, req *proto.AgentRunRequestFrame) (string, error) {
	started := time.Now()
	log.Printf(
		"octodeck-daemon: resolve-cwd start runId=%s agent=%s cwd=%s hasWorkspace=%t workspaceScope=%s workspaceScopeId=%s workspaceFolder=%s workspaceCwd=%s workspaceRepos=%d",
		req.RunID,
		req.AgentID,
		req.Cwd,
		req.Workspace != nil,
		func() string {
			if req.Workspace == nil {
				return ""
			}
			return req.Workspace.Scope
		}(),
		func() string {
			if req.Workspace == nil {
				return ""
			}
			return req.Workspace.ScopeID
		}(),
		func() string {
			if req.Workspace == nil {
				return ""
			}
			return req.Workspace.Folder
		}(),
		func() string {
			if req.Workspace == nil {
				return ""
			}
			return req.Workspace.Cwd
		}(),
		len(req.WorkspaceRepos),
	)
	session.NormalizeWorkspaceScope(req)
	session.ApplyChatSessionScope(req)
	log.Printf(
		"octodeck-daemon: resolve-cwd workspace scope normalized runId=%s agent=%s cwd=%s workspaceScope=%s workspaceScopeId=%s elapsedMs=%d",
		req.RunID,
		req.AgentID,
		req.Cwd,
		func() string {
			if req.Workspace == nil {
				return ""
			}
			return req.Workspace.Scope
		}(),
		func() string {
			if req.Workspace == nil {
				return ""
			}
			return req.Workspace.ScopeID
		}(),
		time.Since(started).Milliseconds(),
	)

	var repos []*proto.WorkspaceRepoSpec
	if len(req.WorkspaceRepos) > 0 {
		repos = req.WorkspaceRepos
	} else if req.Workspace != nil && len(req.Workspace.Repos) > 0 {
		repos = req.Workspace.Repos
	} else if req.Workspace != nil && req.Workspace.Repo != nil {
		repos = []*proto.WorkspaceRepoSpec{req.Workspace.Repo}
	} else if req.WorkspaceRepo != nil {
		repos = []*proto.WorkspaceRepoSpec{req.WorkspaceRepo}
	}
	log.Printf("octodeck-daemon: resolve-cwd repo specs selected runId=%s agent=%s repoCount=%d elapsedMs=%d", req.RunID, req.AgentID, len(repos), time.Since(started).Milliseconds())

	if len(repos) > 0 {
		if repos[0] == nil {
			return "", errors.New("workspace repo spec is required")
		}
		stepStarted := time.Now()
		wsRoot, err := workspaceutil.ResolveRepoRoot(ctx, cfg, req, repos)
		if err != nil {
			return "", err
		}
		log.Printf("octodeck-daemon: resolve-cwd repo root resolved runId=%s agent=%s wsRoot=%s stepMs=%d elapsedMs=%d", req.RunID, req.AgentID, wsRoot, time.Since(stepStarted).Milliseconds(), time.Since(started).Milliseconds())
		stepStarted = time.Now()
		if err := workspaceutil.MountRepos(ctx, cfg, wsRoot, repos); err != nil {
			return "", err
		}
		log.Printf("octodeck-daemon: resolve-cwd repos mounted runId=%s agent=%s wsRoot=%s repoCount=%d stepMs=%d elapsedMs=%d", req.RunID, req.AgentID, wsRoot, len(repos), time.Since(stepStarted).Milliseconds(), time.Since(started).Milliseconds())
		req.Cwd = wsRoot
	} else {
		requested := req.Cwd
		if workspaceutil.HasScopedWorkspace(req.Workspace) {
			stepStarted := time.Now()
			cwd, err := workspaceutil.ResolveRoot(cfg, req)
			if err != nil {
				return "", err
			}
			req.Cwd = cwd
			log.Printf("octodeck-daemon: resolve-cwd scoped root resolved runId=%s agent=%s cwd=%s stepMs=%d elapsedMs=%d", req.RunID, req.AgentID, cwd, time.Since(stepStarted).Milliseconds(), time.Since(started).Milliseconds())
		} else if req.Workspace != nil && req.Workspace.Cwd != "" {
			requested = req.Workspace.Cwd
			log.Printf("octodeck-daemon: resolve-cwd using workspace cwd runId=%s agent=%s requested=%s elapsedMs=%d", req.RunID, req.AgentID, requested, time.Since(started).Milliseconds())
		} else if req.Workspace != nil && req.Workspace.Folder != "" {
			requested = workspaceutil.EnrichWorkspaceURI(req.Workspace, requested)
			log.Printf("octodeck-daemon: resolve-cwd enriched workspace uri runId=%s agent=%s requested=%s elapsedMs=%d", req.RunID, req.AgentID, requested, time.Since(started).Milliseconds())
		}
		if req.Cwd == "" {
			stepStarted := time.Now()
			cwd, err := workspaceutil.DefaultRunCwd(cfg, requested)
			if err != nil {
				return "", err
			}
			req.Cwd = cwd
			log.Printf("octodeck-daemon: resolve-cwd default cwd resolved runId=%s agent=%s requested=%s cwd=%s stepMs=%d elapsedMs=%d", req.RunID, req.AgentID, requested, cwd, time.Since(stepStarted).Milliseconds(), time.Since(started).Milliseconds())
		}
	}
	if req.RemoteCwdPlaceholder != "" {
		stepStarted := time.Now()
		req.Context = state.ReplaceContextPlaceholder(req.Context, req.RemoteCwdPlaceholder, req.Cwd)
		log.Printf("octodeck-daemon: resolve-cwd context placeholder replaced runId=%s agent=%s stepMs=%d elapsedMs=%d", req.RunID, req.AgentID, time.Since(stepStarted).Milliseconds(), time.Since(started).Milliseconds())
	}
	stepStarted := time.Now()
	sharedDir, _ := workspaceutil.EnsureSharedDirForWorkspace(cfg, req.Workspace)
	log.Printf("octodeck-daemon: resolve-cwd shared dir ensured runId=%s agent=%s sharedDir=%s stepMs=%d elapsedMs=%d", req.RunID, req.AgentID, sharedDir, time.Since(stepStarted).Milliseconds(), time.Since(started).Milliseconds())
	stepStarted = time.Now()
	req.Context = state.EnrichWorkspacePaths(req.Context, req.Cwd, sharedDir)
	log.Printf("octodeck-daemon: resolve-cwd context enriched runId=%s agent=%s stepMs=%d elapsedMs=%d", req.RunID, req.AgentID, time.Since(stepStarted).Milliseconds(), time.Since(started).Milliseconds())
	stepStarted = time.Now()
	if !IsRunCwdAllowed(cfg, req.Cwd) {
		return "", fmt.Errorf("cwd outside allowed roots: %s", req.Cwd)
	}
	log.Printf("octodeck-daemon: resolve-cwd allowed roots checked runId=%s agent=%s stepMs=%d elapsedMs=%d", req.RunID, req.AgentID, time.Since(stepStarted).Milliseconds(), time.Since(started).Milliseconds())
	stepStarted = time.Now()
	if !IsWorkspaceAllowedByRuntimePolicy(cfg, req.AgentID, req.Cwd) {
		return "", fmt.Errorf("cwd outside runtime allowedWorkspaces: %s", req.Cwd)
	}
	log.Printf("octodeck-daemon: resolve-cwd runtime policy checked runId=%s agent=%s stepMs=%d elapsedMs=%d", req.RunID, req.AgentID, time.Since(stepStarted).Milliseconds(), time.Since(started).Milliseconds())
	log.Printf("octodeck-daemon: resolve-cwd completed runId=%s agent=%s cwd=%s elapsedMs=%d", req.RunID, req.AgentID, req.Cwd, time.Since(started).Milliseconds())
	return req.Cwd, nil
}
