package security

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	daemonconfig "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/config"
)

// CleanExistingDirectory cleans the path, evaluates symlinks, and verifies that
// the resulting path exists and is a directory.
func CleanExistingDirectory(p string) (string, error) {
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

// IsPathAllowedByCleanRoots returns true if path is under one of the given
// cleaned root paths. Roots are interpreted as-is (no symlink eval, no cwd
// fallback).
func IsPathAllowedByCleanRoots(p string, roots []string) bool {
	clean, err := filepath.Abs(filepath.Clean(p))
	if err != nil {
		return false
	}
	for _, root := range roots {
		r, err := filepath.Abs(filepath.Clean(root))
		if err != nil {
			continue
		}
		if clean == r {
			return true
		}
		if rel, err := filepath.Rel(r, clean); err == nil && rel != "." && !strings.HasPrefix(rel, "..") && !filepath.IsAbs(rel) {
			return true
		}
	}
	return false
}

// IsPathAllowedByRoots returns true if path is under one of the given roots,
// using cwd as a fallback root. Symlinks on both sides are evaluated.
func IsPathAllowedByRoots(p string, roots []string, cwd string) bool {
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
		if IsPathWithinRoot(clean, r) {
			return true
		}
		if realRoot, err := filepath.EvalSymlinks(r); err == nil {
			r = realRoot
		}
		if IsPathWithinRoot(clean, r) {
			return true
		}
	}
	return false
}

// IsPathAllowedByConfiguredRoots returns true if path is under one of the
// configured root paths. An empty roots slice means "no restriction".
func IsPathAllowedByConfiguredRoots(p string, roots []string) bool {
	if len(roots) == 0 {
		return true
	}
	return IsPathAllowedByRoots(p, roots, p)
}

// IsPathWithinRoot returns true if p is inside (or equal to) root after a pure
// lexical comparison.
func IsPathWithinRoot(p, root string) bool {
	rel, err := filepath.Rel(root, p)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// IsRunCwdAllowed returns true if the cwd is within the configured allowed
// roots or under the device's managed workspace/session/task/tmp directories.
func IsRunCwdAllowed(cfg *daemonconfig.Config, cwd string) bool {
	if IsPathAllowedByRoots(cwd, cfg.AllowedRoots, cwd) {
		return true
	}
	managedRoots := []string{
		daemonconfig.WorkspaceDir(cfg),
		daemonconfig.SessionDir(cfg),
		daemonconfig.TaskDir(cfg),
		daemonconfig.TmpDir(cfg),
	}
	return IsPathAllowedByCleanRoots(cwd, managedRoots)
}
