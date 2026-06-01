package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type toolRunner struct {
	cfg  *Config
	send func(any) error
}

func newToolRunner(cfg *Config, send func(any) error) *toolRunner {
	return &toolRunner{cfg: cfg, send: send}
}

func (r *toolRunner) handle(ctx context.Context, req *ToolRequestFrame) {
	go func() {
		res := r.execute(ctx, req)
		if r.send != nil {
			_ = r.send(res)
		}
	}()
}

func (r *toolRunner) execute(parent context.Context, req *ToolRequestFrame) *ToolResultFrame {
	started := time.Now()
	result := &ToolResultFrame{Type: tToolResult, RequestID: req.RequestID, OK: false, Result: nil}
	finish := func(v any) *ToolResultFrame {
		result.OK = true
		result.Result = v
		result.DurationMs = time.Since(started).Milliseconds()
		return result
	}
	fail := func(err error) *ToolResultFrame {
		msg := err.Error()
		result.Error = &msg
		result.DurationMs = time.Since(started).Milliseconds()
		return result
	}

	if err := r.validate(req); err != nil {
		return fail(err)
	}

	switch req.ToolName {
	case "Bash":
		return r.execBash(parent, req, started)
	case "Read":
		p, err := r.resolvePath(req.Cwd, strArg(req.Input, "file_path"))
		if err != nil {
			return fail(err)
		}
		data, err := os.ReadFile(p)
		if err != nil {
			return fail(err)
		}
		if int64(len(data)) > req.MaxOutputBytes {
			data = data[:req.MaxOutputBytes]
		}
		return finish(map[string]any{"content": string(data)})
	case "Write":
		p, err := r.resolvePath(req.Cwd, strArg(req.Input, "file_path"))
		if err != nil {
			return fail(err)
		}
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			return fail(err)
		}
		if err := os.WriteFile(p, []byte(strArg(req.Input, "content")), 0o644); err != nil {
			return fail(err)
		}
		return finish(map[string]any{"content": "written"})
	case "Edit":
		p, err := r.resolvePath(req.Cwd, strArg(req.Input, "file_path"))
		if err != nil {
			return fail(err)
		}
		data, err := os.ReadFile(p)
		if err != nil {
			return fail(err)
		}
		oldS, newS := strArg(req.Input, "old_string"), strArg(req.Input, "new_string")
		if oldS == "" {
			return fail(errors.New("old_string is required"))
		}
		text := string(data)
		if boolArg(req.Input, "replace_all") {
			text = strings.ReplaceAll(text, oldS, newS)
		} else {
			if strings.Count(text, oldS) != 1 {
				return fail(fmt.Errorf("old_string must match exactly once, got %d", strings.Count(text, oldS)))
			}
			text = strings.Replace(text, oldS, newS, 1)
		}
		if err := os.WriteFile(p, []byte(text), 0o644); err != nil {
			return fail(err)
		}
		return finish(map[string]any{"content": "edited"})
	case "LS":
		p, err := r.resolvePath(req.Cwd, strArg(req.Input, "path"))
		if err != nil {
			return fail(err)
		}
		entries, err := os.ReadDir(p)
		if err != nil {
			return fail(err)
		}
		names := make([]string, 0, len(entries))
		for _, e := range entries {
			names = append(names, e.Name())
		}
		return finish(map[string]any{"content": strings.Join(names, "\n")})
	case "Glob":
		base, err := r.resolvePath(req.Cwd, strArgDefault(req.Input, "path", req.Cwd))
		if err != nil {
			return fail(err)
		}
		matches, err := filepath.Glob(filepath.Join(base, strArg(req.Input, "pattern")))
		if err != nil {
			return fail(err)
		}
		out := make([]string, 0, len(matches))
		for _, m := range matches {
			if r.isAllowedPathForCwd(m, req.Cwd) {
				out = append(out, m)
			}
		}
		return finish(map[string]any{"content": strings.Join(out, "\n")})
	case "Grep":
		return r.execSimple(parent, req, started, "grep", []string{"-R", "-n", strArg(req.Input, "pattern"), strArgDefault(req.Input, "path", req.Cwd)})
	case "WebFetch":
		return r.execSimple(parent, req, started, "curl", []string{"-L", "--max-time", "30", strArg(req.Input, "url")})
	case "WebSearch":
		return fail(errors.New("WebSearch is not implemented in hcagent; use WebFetch with a search endpoint"))
	default:
		return fail(fmt.Errorf("unsupported tool: %s", req.ToolName))
	}
}

func (r *toolRunner) execBash(parent context.Context, req *ToolRequestFrame, started time.Time) *ToolResultFrame {
	return r.execSimple(parent, req, started, "/bin/sh", []string{"-lc", strArg(req.Input, "command")})
}

func (r *toolRunner) execSimple(parent context.Context, req *ToolRequestFrame, started time.Time, bin string, argv []string) *ToolResultFrame {
	timeout := time.Duration(req.TimeoutMs) * time.Millisecond
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, argv...)
	cmd.Dir = req.Cwd
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	out := stdout.String()
	if int64(len(out)) > req.MaxOutputBytes {
		out = out[:req.MaxOutputBytes]
	}
	if err != nil {
		msg := stderr.String()
		if msg == "" {
			msg = err.Error()
		}
		return &ToolResultFrame{Type: tToolResult, RequestID: req.RequestID, OK: false, Error: &msg, DurationMs: time.Since(started).Milliseconds()}
	}
	return &ToolResultFrame{Type: tToolResult, RequestID: req.RequestID, OK: true, Result: map[string]any{"stdout": out, "stderr": stderr.String()}, DurationMs: time.Since(started).Milliseconds()}
}

func (r *toolRunner) validate(req *ToolRequestFrame) error {
	if req.RequestID == "" {
		return errors.New("requestId is required")
	}
	if req.ToolName == "" {
		return errors.New("toolName is required")
	}
	if req.TimeoutMs <= 0 {
		return errors.New("timeoutMs must be positive")
	}
	if req.MaxOutputBytes <= 0 {
		return errors.New("maxOutputBytes must be positive")
	}
	if req.Cwd == "" || !filepath.IsAbs(req.Cwd) {
		return fmt.Errorf("cwd must be absolute: %q", req.Cwd)
	}
	if !r.isAllowedPathForCwd(req.Cwd, req.Cwd) {
		return fmt.Errorf("cwd outside allowed roots: %s", req.Cwd)
	}
	return nil
}

func (r *toolRunner) resolvePath(cwd, p string) (string, error) {
	if p == "" {
		p = cwd
	}
	if !filepath.IsAbs(p) {
		p = filepath.Join(cwd, p)
	}
	clean, err := filepath.Abs(filepath.Clean(p))
	if err != nil {
		return "", err
	}
	if !r.isAllowedPathForCwd(clean, cwd) {
		return "", fmt.Errorf("path outside allowed roots: %s", clean)
	}
	return clean, nil
}

func (r *toolRunner) isAllowedPathForCwd(p, cwd string) bool {
	roots := r.cfg.AllowedRoots
	if len(roots) == 0 {
		roots = []string{cwd}
	}
	clean, err := filepath.Abs(filepath.Clean(p))
	if err != nil {
		return false
	}
	for _, root := range roots {
		r, err := filepath.Abs(filepath.Clean(root))
		if err != nil {
			continue
		}
		rel, err := filepath.Rel(r, clean)
		if err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return true
		}
	}
	return false
}

func strArg(m map[string]any, key string) string { return strArgDefault(m, key, "") }
func strArgDefault(m map[string]any, key, def string) string {
	if v, ok := m[key].(string); ok {
		return v
	}
	return def
}
func boolArg(m map[string]any, key string) bool {
	if v, ok := m[key].(bool); ok {
		return v
	}
	return false
}
