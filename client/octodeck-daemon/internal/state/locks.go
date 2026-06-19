package state

import "sync"

// withLock runs fn with mu held. The convention `defer mu.Unlock()` is more
// common, but for deeply-nested helpers this little wrapper avoids forgetting
// to release the mutex on early returns.
func withLock(mu *sync.Mutex, fn func()) {
	mu.Lock()
	defer mu.Unlock()
	fn()
}

// withRLock runs fn with the read side of rw held.
func withRLock(rw *sync.RWMutex, fn func()) {
	rw.RLock()
	defer rw.RUnlock()
	fn()
}
