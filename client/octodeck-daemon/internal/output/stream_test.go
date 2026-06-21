package output

import (
	"strings"
	"sync/atomic"
	"testing"
)

func TestPumpLogAllowsNilEmit(t *testing.T) {
	req := &AgentRunRequestFrame{
		RunID:          "run-1",
		AgentID:        "traex-acp",
		MaxOutputBytes: 1024,
	}
	var sent atomic.Int64

	PumpLog(strings.NewReader("stderr output"), req, &sent, nil)
}

func TestPumpLogAsTextAllowsNilEmit(t *testing.T) {
	req := &AgentRunRequestFrame{
		RunID:          "run-1",
		AgentID:        "traex-acp",
		MaxOutputBytes: 1024,
	}
	var sent atomic.Int64

	PumpLogAsText(strings.NewReader("text output"), req, &sent, nil)
}
