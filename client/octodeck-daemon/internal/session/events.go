package session

import "time"

// EventKind enumerates the lifecycle events emitted on a Session.
type EventKind int

const (
	// EventCreated fires once when Manager.GetOrCreate registered a new
	// session.
	EventCreated EventKind = iota
	// EventRunStarted fires when a run is registered via RegisterCancel.
	EventRunStarted
	// EventRunFinished fires when a run is removed via CancelRun or its
	// cancel function is invoked, regardless of cancellation reason.
	EventRunFinished
	// EventClosed fires once when Session.Close has fully completed.
	EventClosed
)

// String renders the event kind for log output.
func (k EventKind) String() string {
	switch k {
	case EventCreated:
		return "created"
	case EventRunStarted:
		return "run_started"
	case EventRunFinished:
		return "run_finished"
	case EventClosed:
		return "closed"
	default:
		return "unknown"
	}
}

// SessionEvent is the value broadcast to subscribers.
type SessionEvent struct {
	Kind  EventKind
	Key   string
	RunID string
	At    time.Time
}

// Subscribe returns a buffered channel that will receive subsequent events
// emitted on this session. Subscribers should drain promptly; full channels
// are skipped (Emit is non-blocking).
//
// The returned channel is closed when the session itself is closed.
func (s *Session) Subscribe(buffer int) <-chan SessionEvent {
	if s == nil {
		ch := make(chan SessionEvent)
		close(ch)
		return ch
	}
	if buffer < 1 {
		buffer = 4
	}
	ch := make(chan SessionEvent, buffer)
	s.mu.Lock()
	s.subscribers = append(s.subscribers, ch)
	s.mu.Unlock()
	return ch
}

// Emit sends an event to every subscriber. It never blocks: subscribers
// whose channels are full simply miss the event. When the session is in
// the Closed state subscribers are also closed.
func (s *Session) Emit(ev SessionEvent) {
	s.emit(ev)
}

func (s *Session) emit(ev SessionEvent) {
	if s == nil {
		return
	}
	if ev.At.IsZero() {
		ev.At = time.Now()
	}
	if ev.Key == "" {
		ev.Key = s.Key
	}
	s.mu.Lock()
	subs := append([]chan SessionEvent(nil), s.subscribers...)
	closing := s.Status == StateClosed && ev.Kind == EventClosed
	if closing {
		s.subscribers = nil
	}
	s.mu.Unlock()

	for _, ch := range subs {
		select {
		case ch <- ev:
		default:
			// drop: subscriber is too slow.
		}
		if closing {
			close(ch)
		}
	}
}
