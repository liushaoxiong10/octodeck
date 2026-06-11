package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"log"
	"os"
	"path/filepath"
	"time"
)

const memorySyncMaxBytes = 1_000_000

type agentMemorySource struct {
	AgentID string
	Path    string
}

type memorySyncState struct {
	contentHash string
}

type memorySyncPoller struct {
	deviceLinkID string
	sources      []agentMemorySource
	send         func(*MemorySyncFrame) error
	seen         map[string]memorySyncState
	interval     time.Duration
	afterPoll    func()
}

func agentMemorySources(home string, clients []AgentClientInfo) []agentMemorySource {
	if home == "" {
		return nil
	}
	sources := make([]agentMemorySource, 0, len(clients))
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
		sources = append(sources, agentMemorySource{AgentID: agentID, Path: p})
	}

	for _, client := range clients {
		switch client.ID {
		case "claude-code":
			add(client.ID, filepath.Join(home, ".claude", "CLAUDE.md"))
		case "codex":
			add(client.ID, filepath.Join(home, ".codex", "AGENTS.md"))
		case "traecli":
			add(client.ID, filepath.Join(home, ".trae", "AGENTS.md"))
		case "traex":
			// traex 与 codex 调用约定一致，使用 ~/.traex/AGENTS.md 作为外部记忆源。
			add(client.ID, filepath.Join(home, ".traex", "AGENTS.md"))
		}
	}
	return sources
}

func newMemorySyncPoller(deviceLinkID string, sources []agentMemorySource, send func(*MemorySyncFrame) error) *memorySyncPoller {
	return &memorySyncPoller{
		deviceLinkID: deviceLinkID,
		sources:      sources,
		send:         send,
		seen:         map[string]memorySyncState{},
		interval:     30 * time.Second,
	}
}

func (p *memorySyncPoller) run(ctx context.Context) {
	if p == nil {
		return
	}
	p.pollOnce()
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
			p.pollOnce()
			if p.afterPoll != nil {
				p.afterPoll()
			}
		}
	}
}

func (p *memorySyncPoller) pollOnce() {
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
		frame := &MemorySyncFrame{
			Type:         tMemorySync,
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
