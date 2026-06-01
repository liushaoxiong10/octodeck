package main

import (
	"context"
	"os/exec"
	"sync"
)

// runEntry tracks a single in-flight run.
type runEntry struct {
	cmd    *exec.Cmd
	cancel context.CancelFunc
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
	p.runs[runID] = nil // placeholder
	return true
}

// attach binds a started cmd to an existing reservation. Idempotent on missing.
func (p *runnerPool) attach(runID string, cmd *exec.Cmd, cancel context.CancelFunc) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if _, ok := p.runs[runID]; !ok {
		// reservation already released (e.g. cancel raced); kill and bail
		cancel()
		return
	}
	p.runs[runID] = &runEntry{cmd: cmd, cancel: cancel}
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
	entry.cancel()
	return true
}

// cancelAll signals every in-flight run.
func (p *runnerPool) cancelAll() {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, e := range p.runs {
		if e != nil {
			e.cancel()
		}
	}
}
