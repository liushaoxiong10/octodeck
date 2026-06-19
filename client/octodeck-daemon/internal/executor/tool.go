package executor

import (
	"context"
	"strings"

	daemonconfig "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/config"
	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
	security "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/security"
	workspace "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/workspace"
)

// toolExecutor wraps the package-internal toolRunner. Configuration of
// allowed roots and cwd normalization mirrors the historical
// daemonapp.NewToolRunner so behaviour remains identical.
type toolExecutor struct {
	deps   Deps
	runner *toolRunner
}

func newToolExecutor(deps Deps) *toolExecutor {
	te := &toolExecutor{deps: deps}
	cfg := deps.Cfg
	te.runner = newToolRunner(&toolRunnerConfig{
		AllowedRoots: rootsForTool(cfg),
		NormalizeCwd: func(req *proto.ToolRequestFrame) error {
			return te.normalizeCwd(req)
		},
		IsAllowedPath: func(path, cwd string) bool {
			return security.IsPathAllowedByRoots(path, rootsForTool(cfg), cwd)
		},
	}, deps.Send)
	return te
}

func rootsForTool(cfg *daemonconfig.Config) []string {
	if cfg == nil {
		return nil
	}
	return cfg.AllowedRoots
}

// Handle dispatches a tool.request frame asynchronously; the runner
// will normalize cwd, validate, run the tool and emit a tool.result
// via deps.Send.
func (e *toolExecutor) Handle(ctx context.Context, req *proto.ToolRequestFrame) {
	if e == nil || e.runner == nil || req == nil {
		return
	}
	e.runner.Handle(ctx, req)
}

// Execute runs a tool synchronously and returns the result frame.
// Useful for in-process callers that want the result back instead of
// through deps.Send.
func (e *toolExecutor) Execute(ctx context.Context, req *proto.ToolRequestFrame) *proto.ToolResultFrame {
	if e == nil || e.runner == nil {
		return nil
	}
	return e.runner.Execute(ctx, req)
}

// normalizeCwd resolves device:// workspace and tmp URIs and any
// workspaceRepo specs to a concrete absolute path before validation.
func (e *toolExecutor) normalizeCwd(req *proto.ToolRequestFrame) error {
	cfg := e.deps.Cfg
	if req.WorkspaceRepo != nil {
		workspace.NormalizeWorkspaceRepoSpecScope(req.WorkspaceRepo, req.WorkspaceRepo.AgentID)
		cwd, err := workspace.ResolveRunCwd(context.Background(), cfg, []*proto.WorkspaceRepoSpec{req.WorkspaceRepo})
		if err != nil {
			return err
		}
		req.Cwd = cwd
		return nil
	}
	if strings.HasPrefix(req.Cwd, workspace.DeviceWorkspaceURIPrefix) {
		folder := strings.TrimPrefix(req.Cwd, workspace.DeviceWorkspaceURIPrefix)
		cwd, err := workspace.EnsureNamedWorkspaceDir(cfg, folder)
		if err != nil {
			return err
		}
		req.Cwd = cwd
	} else if strings.HasPrefix(req.Cwd, workspace.DeviceTmpURIPrefix) {
		folder := strings.TrimPrefix(req.Cwd, workspace.DeviceTmpURIPrefix)
		cwd, err := workspace.EnsureNamedTmpDir(cfg, folder)
		if err != nil {
			return err
		}
		req.Cwd = cwd
	}
	return nil
}
