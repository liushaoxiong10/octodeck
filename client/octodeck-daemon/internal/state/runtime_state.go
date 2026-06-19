package state

import (
	"context"
	"os/exec"
	"sync"
	"time"

	daemonprotocol "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
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

// RunPool keeps track of currently running children. (Formerly runpool.Pool;
// renamed to disambiguate from the ACP process pool.)
type RunPool struct {
	mu       sync.Mutex
	runs     map[string]*runEntry // runId → entry
	draining bool                 // true while daemon is waiting to restart for a graceful update
	// maxRuns <= 0 means unlimited concurrent runs.
	maxRuns int
}

// NewRunPool creates a new run pool with the given concurrency limit. A
// non-positive max means unlimited concurrent runs.
func NewRunPool(max int) *RunPool {
	return &RunPool{runs: make(map[string]*runEntry), maxRuns: max}
}

// Reserve returns false if the pool is full or the runId is already known.
func (p *RunPool) Reserve(runID string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.draining {
		return false
	}
	if _, exists := p.runs[runID]; exists {
		return false
	}
	if p.maxRuns > 0 && len(p.runs) >= p.maxRuns {
		return false
	}
	now := time.Now()
	p.runs[runID] = &runEntry{runID: runID, status: "accepted", lastActivityAt: now}
	return true
}

func (p *RunPool) NoteAccepted(runID, backendID, cwd string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if e, ok := p.runs[runID]; ok && e != nil {
		e.backendID = backendID
		e.cwd = cwd
		e.status = "accepted"
		e.lastActivityAt = time.Now()
	}
}

// Attach binds a started cmd to an existing reservation. Idempotent on missing.
func (p *RunPool) Attach(runID string, cmd *exec.Cmd, cancel context.CancelFunc) {
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

func (p *RunPool) NoteActivity(runID string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if e, ok := p.runs[runID]; ok && e != nil {
		if e.status == "started" {
			e.status = "running"
		}
		e.lastActivityAt = time.Now()
	}
}

// Release removes a run after it has finished (or after a failed reservation).
func (p *RunPool) Release(runID string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.runs, runID)
}

func (p *RunPool) SetDraining(draining bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.draining = draining
}

func (p *RunPool) IsDraining() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.draining
}

func (p *RunPool) ActiveCount() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.runs)
}

// CancelRun signals the given run to stop. Returns true if found.
func (p *RunPool) CancelRun(runID string) bool {
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

// CancelAll signals every in-flight run.
func (p *RunPool) CancelAll() {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, e := range p.runs {
		if e != nil && e.cancel != nil {
			e.cancel()
		}
	}
}

func (p *RunPool) MaxConcurrentRuns() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.maxRuns
}

func (p *RunPool) Snapshot() []daemonprotocol.RunningRunInfo {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]daemonprotocol.RunningRunInfo, 0, len(p.runs))
	for runID, e := range p.runs {
		if e == nil {
			out = append(out, daemonprotocol.RunningRunInfo{RunID: runID, Status: "accepted"})
			continue
		}
		info := daemonprotocol.RunningRunInfo{
			RunID:          e.runID,
			BackendID:      e.backendID,
			Cwd:            e.cwd,
			Status:         e.status,
			StartedAt:      FormatTime(e.startedAt),
			LastActivityAt: FormatTime(e.lastActivityAt),
		}
		out = append(out, info)
	}
	return out
}

func (p *RunPool) AvailableSlots() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.draining {
		return 0
	}
	if p.maxRuns <= 0 {
		return 0
	}
	available := p.maxRuns - len(p.runs)
	if available < 0 {
		return 0
	}
	return available
}

// FormatTime renders t in RFC3339Nano UTC, returning "" for zero values.
func FormatTime(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339Nano)
}
