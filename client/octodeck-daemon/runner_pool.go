package main

import (
	"context"
	"os/exec"
	"sync"
	"time"
)

// runEntry tracks a single in-flight run.
type runEntry struct {
	cmd            *exec.Cmd
	cancel         context.CancelFunc
	runID          string
	backendID      string
	cwd            string
	status         string
	startedAt      time.Time
	lastActivityAt time.Time
}

// runnerPool keeps track of currently running children.
type runnerPool struct {
	mu      sync.Mutex
	runs    map[string]*runEntry // runId → entry
	maxRuns int
}

func newRunnerPool(max int) *runnerPool {
	return &runnerPool{runs: make(map[string]*runEntry), maxRuns: max}
}

// reserve returns false if the pool is full or the runId is already known.
func (p *runnerPool) reserve(runID string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if _, exists := p.runs[runID]; exists {
		return false
	}
	if len(p.runs) >= p.maxRuns {
		return false
	}
	now := time.Now()
	p.runs[runID] = &runEntry{runID: runID, status: "accepted", lastActivityAt: now}
	return true
}

func (p *runnerPool) noteAccepted(runID, backendID, cwd string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if e, ok := p.runs[runID]; ok && e != nil {
		e.backendID = backendID
		e.cwd = cwd
		e.status = "accepted"
		e.lastActivityAt = time.Now()
	}
}

// attach binds a started cmd to an existing reservation. Idempotent on missing.
func (p *runnerPool) attach(runID string, cmd *exec.Cmd, cancel context.CancelFunc) {
	p.mu.Lock()
	defer p.mu.Unlock()
	e, ok := p.runs[runID]
	if !ok || e == nil {
		// reservation already released (e.g. cancel raced); kill and bail
		cancel()
		return
	}
	now := time.Now()
	e.cmd = cmd
	e.cancel = cancel
	e.status = "started"
	e.startedAt = now
	e.lastActivityAt = now
}

func (p *runnerPool) noteActivity(runID string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if e, ok := p.runs[runID]; ok && e != nil {
		if e.status == "started" {
			e.status = "running"
		}
		e.lastActivityAt = time.Now()
	}
}

// release removes a run after it has finished (or after a failed reservation).
func (p *runnerPool) release(runID string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.runs, runID)
}

// cancelRun signals the given run to stop. Returns true if found.
func (p *runnerPool) cancelRun(runID string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	entry, ok := p.runs[runID]
	if !ok || entry == nil {
		return false
	}
	if entry.cancel != nil {
		entry.cancel()
	}
	return true
}

// cancelAll signals every in-flight run.
func (p *runnerPool) cancelAll() {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, e := range p.runs {
		if e != nil && e.cancel != nil {
			e.cancel()
		}
	}
}

func (p *runnerPool) maxConcurrentRuns() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.maxRuns
}

func (p *runnerPool) snapshot() []RunningRunInfo {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]RunningRunInfo, 0, len(p.runs))
	for runID, e := range p.runs {
		if e == nil {
			out = append(out, RunningRunInfo{RunID: runID, Status: "accepted"})
			continue
		}
		info := RunningRunInfo{
			RunID:          e.runID,
			BackendID:      e.backendID,
			Cwd:            e.cwd,
			Status:         e.status,
			StartedAt:      formatTime(e.startedAt),
			LastActivityAt: formatTime(e.lastActivityAt),
		}
		out = append(out, info)
	}
	return out
}

func (p *runnerPool) availableSlots() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	available := p.maxRuns - len(p.runs)
	if available < 0 {
		return 0
	}
	return available
}

func formatTime(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339Nano)
}
