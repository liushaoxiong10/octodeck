package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const maxDirectoryEntries = 200

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

	if err := r.normalizeCwd(req); err != nil {
		return fail(err)
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
		if boolArg(req.Input, "base64") {
			return finish(map[string]any{"contentBase64": base64.StdEncoding.EncodeToString(data), "size": len(data)})
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
		content := []byte(strArg(req.Input, "content"))
		if encoded := strArg(req.Input, "contentBase64"); encoded != "" {
			decoded, err := base64.StdEncoding.DecodeString(encoded)
			if err != nil {
				return fail(err)
			}
			content = decoded
		}
		if err := os.WriteFile(p, content, 0o644); err != nil {
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
		payloadEntries := make([]map[string]any, 0, len(entries))
		for _, e := range entries {
			names = append(names, e.Name())
			entryPath := filepath.Join(p, e.Name())
			info, statErr := os.Stat(entryPath)
			if statErr != nil {
				continue
			}
			entryType := "file"
			if info.IsDir() {
				entryType = "directory"
			}
			payloadEntries = append(payloadEntries, map[string]any{
				"name":       e.Name(),
				"path":       entryPath,
				"type":       entryType,
				"size":       info.Size(),
				"modifiedAt": info.ModTime().Format(time.RFC3339Nano),
			})
		}
		return finish(map[string]any{"content": strings.Join(names, "\n"), "entries": payloadEntries})
	case "ListDirectories":
		payload, err := r.listDirectories(strArg(req.Input, "path"))
		if err != nil {
			return fail(err)
		}
		return finish(payload)
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
		return fail(errors.New("WebSearch is not implemented in octodeck-daemon; use WebFetch with a search endpoint"))
	default:
		return fail(fmt.Errorf("unsupported tool: %s", req.ToolName))
	}
}

func (r *toolRunner) normalizeCwd(req *ToolRequestFrame) error {
	if strings.HasPrefix(req.Cwd, deviceWorkspaceURIPrefix) {
		folder := strings.TrimPrefix(req.Cwd, deviceWorkspaceURIPrefix)
		cwd, err := ensureNamedWorkspaceDir(r.cfg, folder)
		if err != nil {
			return err
		}
		req.Cwd = cwd
	} else if strings.HasPrefix(req.Cwd, deviceTmpURIPrefix) {
		folder := strings.TrimPrefix(req.Cwd, deviceTmpURIPrefix)
		cwd, err := ensureNamedTmpDir(r.cfg, folder)
		if err != nil {
			return err
		}
		req.Cwd = cwd
	}
	return nil
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
	if req.ToolName == "ListDirectories" {
		return nil
	}
	if !r.isAllowedPathForCwd(req.Cwd, req.Cwd) {
		return fmt.Errorf("cwd outside allowed roots: %s", req.Cwd)
	}
	return nil
}

func (r *toolRunner) listDirectories(requestedPath string) (map[string]any, error) {
	roots := r.cfg.AllowedRoots
	hasAllowlist := len(roots) > 0

	if requestedPath == "" {
		if hasAllowlist {
			dirs := make([]map[string]any, 0, len(roots))
			for _, root := range roots {
				cleanRoot, err := cleanExistingDirectory(root)
				if err != nil {
					continue
				}
				dirs = append(dirs, directoryPayload(filepath.Base(cleanRoot), cleanRoot, hasVisibleSubdirectory(cleanRoot)))
			}
			sortDirectoryPayloads(dirs)
			return map[string]any{"currentPath": nil, "parentPath": nil, "directories": dirs, "hasAllowlist": true}, nil
		}

		home, err := os.UserHomeDir()
		if err != nil || home == "" {
			home = string(filepath.Separator)
		}
		cleanHome, err := cleanExistingDirectory(home)
		if err != nil {
			cleanHome = string(filepath.Separator)
		}
		return map[string]any{
			"currentPath":  cleanHome,
			"parentPath":   parentPathFor(cleanHome, false, nil),
			"directories":  r.listVisibleSubdirectories(cleanHome),
			"hasAllowlist": false,
		}, nil
	}

	if !filepath.IsAbs(requestedPath) {
		return nil, fmt.Errorf("path must be absolute: %q", requestedPath)
	}
	cleanPath, err := cleanExistingDirectory(requestedPath)
	if err != nil {
		return nil, err
	}
	if hasAllowlist && !r.isAllowedPathForCwd(cleanPath, cleanPath) {
		return nil, fmt.Errorf("path outside allowed roots: %s", cleanPath)
	}

	return map[string]any{
		"currentPath":  cleanPath,
		"parentPath":   parentPathFor(cleanPath, hasAllowlist, r),
		"directories":  r.listVisibleSubdirectories(cleanPath),
		"hasAllowlist": hasAllowlist,
	}, nil
}

func cleanExistingDirectory(p string) (string, error) {
	clean, err := filepath.Abs(filepath.Clean(p))
	if err != nil {
		return "", err
	}
	realPath, err := filepath.EvalSymlinks(clean)
	if err != nil {
		return "", err
	}
	stat, err := os.Stat(realPath)
	if err != nil {
		return "", err
	}
	if !stat.IsDir() {
		return "", fmt.Errorf("path is not a directory: %s", realPath)
	}
	return realPath, nil
}

func parentPathFor(p string, hasAllowlist bool, r *toolRunner) any {
	parent := filepath.Dir(p)
	if parent == p {
		return nil
	}
	if hasAllowlist && r != nil && !r.isAllowedPathForCwd(parent, parent) {
		return nil
	}
	return parent
}

func (r *toolRunner) listVisibleSubdirectories(dirPath string) []map[string]any {
	entries, err := os.ReadDir(dirPath)
	if err != nil {
		return []map[string]any{}
	}
	dirs := make([]map[string]any, 0)
	for _, entry := range entries {
		if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		fullPath := filepath.Join(dirPath, entry.Name())
		cleanPath, err := cleanExistingDirectory(fullPath)
		if err != nil {
			continue
		}
		if !r.isAllowedPathForCwd(cleanPath, cleanPath) {
			continue
		}
		dirs = append(dirs, directoryPayload(entry.Name(), cleanPath, hasVisibleSubdirectory(cleanPath)))
		if len(dirs) >= maxDirectoryEntries {
			break
		}
	}
	sortDirectoryPayloads(dirs)
	return dirs
}

func directoryPayload(name, p string, hasChildren bool) map[string]any {
	return map[string]any{"name": name, "path": p, "hasChildren": hasChildren}
}

func hasVisibleSubdirectory(dirPath string) bool {
	entries, err := os.ReadDir(dirPath)
	if err != nil {
		return false
	}
	for _, entry := range entries {
		if entry.IsDir() && !strings.HasPrefix(entry.Name(), ".") {
			return true
		}
	}
	return false
}

func sortDirectoryPayloads(dirs []map[string]any) {
	sort.Slice(dirs, func(i, j int) bool {
		return fmt.Sprint(dirs[i]["name"]) < fmt.Sprint(dirs[j]["name"])
	})
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
	return isPathAllowedByRoots(p, r.cfg.AllowedRoots, cwd)
}

func isPathAllowedByRoots(p string, roots []string, cwd string) bool {
	if len(roots) == 0 {
		roots = []string{cwd}
	}
	clean, err := filepath.Abs(filepath.Clean(p))
	if err != nil {
		return false
	}
	if realPath, err := filepath.EvalSymlinks(clean); err == nil {
		clean = realPath
	}
	for _, root := range roots {
		r, err := filepath.Abs(filepath.Clean(root))
		if err != nil {
			continue
		}
		if isPathWithinRoot(clean, r) {
			return true
		}
		if realRoot, err := filepath.EvalSymlinks(r); err == nil {
			r = realRoot
		}
		if isPathWithinRoot(clean, r) {
			return true
		}
	}
	return false
}

func isPathAllowedByConfiguredRoots(p string, roots []string) bool {
	if len(roots) == 0 {
		return true
	}
	return isPathAllowedByRoots(p, roots, p)
}

func isPathWithinRoot(p, root string) bool {
	rel, err := filepath.Rel(root, p)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
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
