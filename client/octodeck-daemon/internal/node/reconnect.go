package node

import "time"

// reconnect implements an exponential backoff schedule that the main
// loop consults between failed dial attempts.
type reconnect struct {
	schedule []time.Duration
	attempt  int
}

func newReconnect() *reconnect {
	return &reconnect{
		schedule: []time.Duration{
			1 * time.Second,
			2 * time.Second,
			4 * time.Second,
			8 * time.Second,
			15 * time.Second,
			30 * time.Second,
		},
	}
}

// next returns the wait duration for the current attempt and advances
// the counter.
func (r *reconnect) next() time.Duration {
	idx := r.attempt
	if idx >= len(r.schedule) {
		idx = len(r.schedule) - 1
	}
	r.attempt++
	return r.schedule[idx]
}

// reset clears the attempt counter after a successful connect.
func (r *reconnect) reset() { r.attempt = 0 }
