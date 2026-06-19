package security

// Default upper bounds for run request limits. These complement the per-request
// TimeoutMs / MaxOutputBytes fields validated by ValidateRunRequest in
// binaries.go and the runner pool's MaxConcurrentRuns gate.
const (
	// DefaultMaxOutputBytes is the fallback cap on a single run's combined
	// stdout+stderr byte count when the request does not specify one.
	DefaultMaxOutputBytes int64 = 8 * 1024 * 1024 // 8 MiB
	// DefaultTimeoutMs is the fallback per-run timeout when the request does
	// not specify one.
	DefaultTimeoutMs int64 = 5 * 60 * 1000 // 5 minutes
	// DefaultMaxConcurrentRuns is the fallback on parallel run slots.
	DefaultMaxConcurrentRuns int = 8
)
