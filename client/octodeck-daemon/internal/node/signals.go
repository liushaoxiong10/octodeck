package node

import (
	"os"
	"os/signal"
	"syscall"

	"log"
)

// installSignalHandlers wires SIGINT/SIGTERM to the supplied cancel func
// so the main loop can drain the connection and exit cleanly.
func installSignalHandlers(cancel func()) {
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		s := <-sigCh
		log.Printf("octodeck-daemon: received %s, shutting down", s)
		cancel()
	}()
}
