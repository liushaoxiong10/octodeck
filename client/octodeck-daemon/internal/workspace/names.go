package workspace

import (
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"

	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
)

var unsafePathSegment = regexp.MustCompile(`[^A-Za-z0-9._-]+`)
var validWorkspaceFolderSegment = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$`)

var suspiciousWorkspaceFolderTokens = []string{
	" and ", " or ", "select", "sleep", "extract", "extractvalue", "concat",
	"cast", "chr", "char", "where", "from", "union", "dbms_pipe", "utl_inaddr",
	"__import__", "pickle", "constructor", "child_process", "execsync", "popen",
	"curl", "callback", "oast", "rce", "toDate",
}

func SafePathSegment(s string) string {
	s = unsafePathSegment.ReplaceAllString(s, "-")
	s = strings.Trim(s, ".-")
	if len(s) > 120 {
		s = s[:120]
	}
	return s
}

func SafeGroupFolder(folder string) string {
	if v := SafePathSegment(folder); v != "" {
		return v
	}
	return "workspace"
}

func ValidateNamedWorkspaceFolder(folder string) error {
	raw := strings.TrimSpace(folder)
	if raw == "" {
		return errors.New("workspace folder is required")
	}
	if strings.ContainsAny(raw, `/\`) || filepath.Clean(raw) != raw {
		return fmt.Errorf("invalid workspace folder: %q", folder)
	}
	if !validWorkspaceFolderSegment.MatchString(raw) || SafeGroupFolder(raw) != raw {
		return fmt.Errorf("invalid workspace folder: %q", folder)
	}
	parts := strings.FieldsFunc(raw, func(r rune) bool { return r == '-' || r == '_' || r == '.' })
	if len(parts) > 6 {
		return fmt.Errorf("invalid workspace folder: %q", folder)
	}
	lower := strings.ToLower(" " + raw + " ")
	for _, token := range suspiciousWorkspaceFolderTokens {
		if strings.Contains(lower, strings.ToLower(token)) {
			return fmt.Errorf("invalid workspace folder: %q", folder)
		}
	}
	return nil
}

func RepoNameFromURL(raw string) string {
	u := strings.TrimSpace(raw)
	u = strings.TrimSuffix(u, ".git")
	for _, sep := range []string{"/", ":"} {
		if idx := strings.LastIndex(u, sep); idx >= 0 && idx < len(u)-1 {
			u = u[idx+1:]
		}
	}
	if n := SafePathSegment(u); n != "" {
		return n
	}
	return "repo"
}

func DeriveWorktreeBranch(spec *proto.WorkspaceRepoSpec) string {
	if spec == nil {
		return ""
	}
	scope := strings.TrimSpace(spec.Scope)
	switch scope {
	case "session", "direct_session":
		scopeID := strings.TrimSpace(spec.ScopeID)
		if scopeID == "" {
			return ""
		}
		return "octodeck/session/" + SafePathSegment(scopeID)
	case "task":
		taskID := strings.TrimSpace(spec.TaskID)
		runID := firstNonEmpty(strings.TrimSpace(spec.TaskRunID), strings.TrimSpace(spec.ScopeID))
		if taskID == "" || runID == "" {
			return ""
		}
		return "octodeck/task/" + SafePathSegment(taskID) + "/" + SafePathSegment(runID)
	default:
		return ""
	}
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}
