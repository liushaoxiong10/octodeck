// cache.go combines run-context placeholder helpers, the agent-session
// metadata scanner and the memory-sync poller. They share a common theme:
// these helpers manage longer-lived "cache-like" state derived from the
// current run/agent without holding live process handles.
package state

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	daemonconfig "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/config"
	inventory "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/inventory"
	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
	workspaceutil "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/workspace"
)

// ----- runcontext helpers -----

// ReplaceArgvPlaceholder substitutes placeholder with cwd in every element
// of argv. Returns a fresh slice; argv is left untouched.
func ReplaceArgvPlaceholder(argv []string, placeholder, cwd string) []string {
	replacer := strings.NewReplacer(placeholder, cwd)
	out := make([]string, len(argv))
	for i, arg := range argv {
		out[i] = replacer.Replace(arg)
	}
	return out
}

// ReplaceContextPlaceholder roundtrips ctx through JSON, replacing every
// occurrence of placeholder with cwd in the serialised form. Useful for
// nested run-context blobs containing the daemon's `__OCTODECK_REMOTE_CWD__`
// sentinel.
func ReplaceContextPlaceholder(ctx any, placeholder, cwd string) any {
	if ctx == nil || placeholder == "" {
		return ctx
	}
	data, err := json.Marshal(ctx)
	if err != nil {
		return ctx
	}
	replaced := strings.ReplaceAll(string(data), placeholder, cwd)
	var out any
	if err := json.Unmarshal([]byte(replaced), &out); err != nil {
		return ctx
	}
	return out
}

// GroupFolder extracts the workspace folder (run.context.group.folder) from
// an arbitrary run-context value.
func GroupFolder(runContext any) string {
	if m, ok := runContext.(map[string]any); ok {
		return GroupFolderFromParsed(m)
	}
	data, err := json.Marshal(runContext)
	if err != nil {
		return ""
	}
	var parsed map[string]any
	if err := json.Unmarshal(data, &parsed); err != nil {
		return ""
	}
	return GroupFolderFromParsed(parsed)
}

// GroupFolderFromParsed pulls run.context.group.folder out of an already-
// parsed run-context map.
func GroupFolderFromParsed(parsed map[string]any) string {
	if group, ok := parsed["group"].(map[string]any); ok {
		if folder, ok := group["folder"].(string); ok {
			return folder
		}
	}
	return ""
}

// Repo returns the parsed run.context.repo blob (if any).
func Repo(runContext any) any {
	if m, ok := runContext.(map[string]any); ok {
		return m["repo"]
	}
	data, err := json.Marshal(runContext)
	if err != nil {
		return nil
	}
	var parsed map[string]any
	if err := json.Unmarshal(data, &parsed); err != nil {
		return nil
	}
	return parsed["repo"]
}

// WorkspaceSharedDir returns run.context.workspaceSharedDir / workspace.sharedDir.
func WorkspaceSharedDir(runContext any) string {
	if m, ok := runContext.(map[string]any); ok {
		return WorkspaceSharedDirFromParsed(m)
	}
	data, err := json.Marshal(runContext)
	if err != nil {
		return ""
	}
	var parsed map[string]any
	if err := json.Unmarshal(data, &parsed); err != nil {
		return ""
	}
	return WorkspaceSharedDirFromParsed(parsed)
}

// WorkspaceSharedDirFromParsed extracts the shared workspace directory from
// an already-parsed run-context map.
func WorkspaceSharedDirFromParsed(parsed map[string]any) string {
	if shared, ok := parsed["workspaceSharedDir"].(string); ok {
		return shared
	}
	if workspace, ok := parsed["workspace"].(map[string]any); ok {
		if shared, ok := workspace["sharedDir"].(string); ok {
			return shared
		}
	}
	return ""
}

// EnrichWorkspacePaths sets cwd / sharedDir on the run-context's workspace
// block, adding the keys when missing. The original runContext is mutated
// when it is already a map[string]any; otherwise a new map is returned.
func EnrichWorkspacePaths(runContext any, cwd string, sharedDir string) any {
	if sharedDir == "" && cwd == "" {
		return runContext
	}
	var parsed map[string]any
	if m, ok := runContext.(map[string]any); ok {
		parsed = m
	} else if runContext != nil {
		data, err := json.Marshal(runContext)
		if err != nil {
			return runContext
		}
		if err := json.Unmarshal(data, &parsed); err != nil {
			return runContext
		}
	} else {
		parsed = map[string]any{}
	}
	if cwd != "" {
		parsed["cwd"] = cwd
	}
	workspace, _ := parsed["workspace"].(map[string]any)
	if workspace == nil {
		workspace = map[string]any{}
	}
	if cwd != "" {
		workspace["cwd"] = cwd
	}
	if sharedDir != "" {
		workspace["sharedDir"] = sharedDir
		parsed["workspaceSharedDir"] = sharedDir
	}
	parsed["workspace"] = workspace
	return parsed
}

// ----- agent-session metadata helpers (formerly internal/agentsessions) -----

// ListProvider scans the daemon session directory for an agent's persisted
// session metadata. When workspace is empty all workspaces are scanned.
func ListProvider(ctx context.Context, cfg *daemonconfig.Config, agentID, providerDir, workspace string) ([]proto.AgentSessionInfo, error) {
	root := daemonconfig.SessionDir(cfg)
	workspaces := []string{workspace}
	if workspace == "" {
		entries, err := os.ReadDir(root)
		if err != nil {
			if os.IsNotExist(err) {
				return []proto.AgentSessionInfo{}, nil
			}
			return nil, err
		}
		workspaces = workspaces[:0]
		for _, e := range entries {
			if e.IsDir() {
				workspaces = append(workspaces, e.Name())
			}
		}
	}
	sessions := make([]proto.AgentSessionInfo, 0)
	for _, ws := range workspaces {
		if ctx.Err() != nil {
			return sessions, ctx.Err()
		}
		if ws == "" {
			continue
		}
		safeWS := workspaceutil.SafeGroupFolder(ws)
		if providerDir != agentID {
			metaRoot := filepath.Join(root, safeWS, workspaceutil.SafePathSegment(agentID))
			items, err := listSessionEntries(metaRoot, agentID, safeWS)
			if err == nil {
				sessions = append(sessions, items...)
			} else if err != nil && !os.IsNotExist(err) {
				return sessions, err
			}
		}
		providerRoot := filepath.Join(root, safeWS, providerDir)
		items, err := listSessionEntries(providerRoot, agentID, safeWS)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return sessions, err
		}
		sessions = append(sessions, items...)
	}
	return sessions, nil
}

// WriteMetadata persists a session.json metadata file under the daemon's
// session directory for an agent run.
func WriteMetadata(cfg *daemonconfig.Config, req *proto.AgentRunRequestFrame, sessionID, finalText string) error {
	workspace := GroupFolder(req.Context)
	if workspace == "" && req.Workspace != nil {
		workspace = req.Workspace.Folder
	}
	if workspace == "" {
		workspace = filepath.Base(filepath.Clean(req.Cwd))
	}
	safeWorkspace := workspaceutil.SafeGroupFolder(workspace)
	dir := filepath.Join(daemonconfig.SessionDir(cfg), safeWorkspace, workspaceutil.SafePathSegment(req.AgentID), workspaceutil.SafePathSegment(sessionID))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	title := strings.TrimSpace(finalText)
	if len(title) > 120 {
		title = title[:120]
	}
	payload := map[string]any{
		"id":        sessionID,
		"sessionId": sessionID,
		"agentId":   req.AgentID,
		"workspace": safeWorkspace,
		"title":     title,
		"updatedAt": formatSessionTime(time.Now()),
		"cwd":       req.Cwd,
		"runId":     req.RunID,
	}
	data, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "session.json"), data, 0o600)
}

// DeleteProvider deletes a single provider session by id.
func DeleteProvider(ctx context.Context, cfg *daemonconfig.Config, providerDir, workspace, sessionID string) (bool, error) {
	if ctx.Err() != nil {
		return false, ctx.Err()
	}
	if workspace == "" || sessionID == "" {
		return false, errors.New("workspace and sessionId are required")
	}
	root := filepath.Join(daemonconfig.SessionDir(cfg), workspaceutil.SafeGroupFolder(workspace), providerDir)
	target := filepath.Clean(filepath.Join(root, sessionID))
	cleanRoot := filepath.Clean(root)
	if target != cleanRoot && !strings.HasPrefix(target, cleanRoot+string(os.PathSeparator)) {
		return false, fmt.Errorf("session path escapes provider root: %s", sessionID)
	}
	if _, err := os.Stat(target); err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, err
	}
	return true, os.RemoveAll(target)
}

func listSessionEntries(providerRoot, agentID, workspace string) ([]proto.AgentSessionInfo, error) {
	entries, err := os.ReadDir(providerRoot)
	if err != nil {
		return nil, err
	}
	out := make([]proto.AgentSessionInfo, 0, len(entries))
	seen := map[string]struct{}{}
	for _, e := range entries {
		info, err := e.Info()
		if err != nil {
			continue
		}
		path := filepath.Join(providerRoot, e.Name())
		id, title := sessionEntryMetadata(path, e.Name())
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, proto.AgentSessionInfo{ID: id, AgentID: agentID, Workspace: workspace, Provider: agentID, Title: title, Path: path, UpdatedAt: formatSessionTime(info.ModTime()), SizeBytes: sessionEntrySize(path, info)})
	}
	return out, nil
}

func sessionEntryMetadata(path, fallbackID string) (string, string) {
	info, err := os.Stat(path)
	if err != nil {
		return fallbackID, ""
	}
	if info.IsDir() {
		for _, name := range []string{"session.json", "metadata.json", "conversation.json"} {
			if id, title := sessionEntryMetadata(filepath.Join(path, name), fallbackID); id != fallbackID || title != "" {
				return id, title
			}
		}
		return fallbackID, ""
	}
	data, err := os.ReadFile(path)
	if err != nil || len(data) == 0 || len(data) > 2*1024*1024 {
		return fallbackID, ""
	}
	var obj map[string]any
	if err := json.Unmarshal(data, &obj); err != nil {
		return fallbackID, ""
	}
	id := fallbackID
	for _, key := range []string{"session_id", "sessionId", "id", "conversation_id"} {
		if v, ok := obj[key].(string); ok && v != "" {
			id = v
			break
		}
	}
	title := ""
	for _, key := range []string{"title", "summary", "name"} {
		if v, ok := obj[key].(string); ok && v != "" {
			title = v
			break
		}
	}
	return id, title
}

func sessionEntrySize(path string, info os.FileInfo) int64 {
	if !info.IsDir() {
		return info.Size()
	}
	var total int64
	_ = filepath.WalkDir(path, func(_ string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if st, statErr := d.Info(); statErr == nil {
			total += st.Size()
		}
		return nil
	})
	return total
}

func formatSessionTime(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339Nano)
}

// ----- memory-sync poller (formerly internal/memorysync) -----

const memorySyncMaxBytes = 1_000_000

// Source identifies a single agent memory file to watch.
type Source struct {
	AgentID string
	Path    string
}

type memorySyncState struct {
	contentHash string
}

// Poller periodically scans a set of agent memory files and emits a
// MemorySyncFrame whenever a file's content changes.
type Poller struct {
	deviceLinkID string
	sources      []Source
	send         func(*proto.MemorySyncFrame) error
	seen         map[string]memorySyncState
	interval     time.Duration
	afterPoll    func()
}

// Sources resolves the well-known memory-file path for each known agent
// client running under the given home directory.
func Sources(home string, clients []inventory.Info, memoryPath func(home string, client inventory.Info) string) []Source {
	if home == "" {
		return nil
	}
	sources := make([]Source, 0, len(clients))
	seen := map[string]struct{}{}
	add := func(agentID, p string) {
		if agentID == "" || p == "" {
			return
		}
		key := agentID + "\x00" + p
		if _, ok := seen[key]; ok {
			return
		}
		seen[key] = struct{}{}
		sources = append(sources, Source{AgentID: agentID, Path: p})
	}

	for _, client := range clients {
		if memoryPath == nil {
			continue
		}
		if path := memoryPath(home, client); path != "" {
			add(client.ID, path)
		}
	}
	return sources
}

// NewPoller constructs a Poller wired to the given send callback.
func NewPoller(deviceLinkID string, sources []Source, send func(*proto.MemorySyncFrame) error) *Poller {
	return &Poller{
		deviceLinkID: deviceLinkID,
		sources:      sources,
		send:         send,
		seen:         map[string]memorySyncState{},
		interval:     30 * time.Second,
	}
}

// Run polls until ctx is cancelled.
func (p *Poller) Run(ctx context.Context) {
	if p == nil {
		return
	}
	p.PollOnce()
	if p.afterPoll != nil {
		p.afterPoll()
	}
	ticker := time.NewTicker(p.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			p.PollOnce()
			if p.afterPoll != nil {
				p.afterPoll()
			}
		}
	}
}

// PollOnce performs a single poll cycle, emitting frames for any files whose
// content hash has changed since the previous call.
func (p *Poller) PollOnce() {
	if p == nil || p.send == nil {
		return
	}
	for _, source := range p.sources {
		info, err := os.Stat(source.Path)
		if err != nil || info.IsDir() || info.Size() > memorySyncMaxBytes {
			continue
		}
		content, err := os.ReadFile(source.Path)
		if err != nil {
			continue
		}
		sum := sha256.Sum256(content)
		contentHash := hex.EncodeToString(sum[:])
		key := source.AgentID + "\x00" + source.Path
		if previous, ok := p.seen[key]; ok && previous.contentHash == contentHash {
			continue
		}
		p.seen[key] = memorySyncState{contentHash: contentHash}
		frame := &proto.MemorySyncFrame{
			Type:         proto.TMemorySync,
			DeviceLinkID: p.deviceLinkID,
			AgentID:      source.AgentID,
			Path:         filepath.Base(source.Path),
			Content:      string(content),
			Mtime:        info.ModTime().UTC().Format(time.RFC3339Nano),
			ContentHash:  contentHash,
		}
		if err := p.send(frame); err != nil {
			log.Printf("octodeck-daemon: memory sync failed agent=%s path=%s: %v", source.AgentID, source.Path, err)
		}
	}
}
