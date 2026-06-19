package resources

import (
	"os"
	"os/exec"
	"strconv"
	"strings"
)

// readLoadAverage returns a Snapshot populated with Load1/Load5/Load15. On
// Linux it prefers /proc/loadavg, falling back to the `uptime` command (which
// also covers macOS and most BSDs).
func readLoadAverage() (Snapshot, bool) {
	if data, err := os.ReadFile("/proc/loadavg"); err == nil {
		return parseLoadAverageLine(string(data))
	}

	out, err := exec.Command("/usr/bin/uptime").Output()
	if err != nil {
		out, err = exec.Command("uptime").Output()
	}
	if err != nil {
		return Snapshot{}, false
	}
	return parseUptimeLoadAverage(string(out))
}

func parseLoadAverageLine(line string) (Snapshot, bool) {
	fields := strings.Fields(strings.TrimSpace(line))
	if len(fields) < 3 {
		return Snapshot{}, false
	}
	load1, err1 := strconv.ParseFloat(strings.TrimSuffix(fields[0], ","), 64)
	load5, err5 := strconv.ParseFloat(strings.TrimSuffix(fields[1], ","), 64)
	load15, err15 := strconv.ParseFloat(strings.TrimSuffix(fields[2], ","), 64)
	if err1 != nil || err5 != nil || err15 != nil {
		return Snapshot{}, false
	}
	return Snapshot{Load1: load1, Load5: load5, Load15: load15}, true
}

func parseUptimeLoadAverage(output string) (Snapshot, bool) {
	idx := strings.LastIndex(output, "load averages:")
	if idx == -1 {
		idx = strings.LastIndex(output, "load average:")
	}
	if idx == -1 {
		return Snapshot{}, false
	}
	loads := output[idx:]
	loads = strings.TrimPrefix(loads, "load averages:")
	loads = strings.TrimPrefix(loads, "load average:")
	return parseLoadAverageLine(loads)
}

// percent returns used / total * 100 with a zero-safe guard.
func percent(used uint64, total uint64) float64 {
	if total == 0 {
		return 0
	}
	return float64(used) / float64(total) * 100
}

// clampPercentValue keeps a percentage within [0, 100] so the wire protocol
// never carries inconsistent values (df may briefly report >100% for example).
func clampPercentValue(value float64) float64 {
	if value < 0 {
		return 0
	}
	if value > 100 {
		return 100
	}
	return value
}

// cpuUsedPercentFromLoad approximates CPU utilization from the 1-minute load
// average and the number of CPUs, clamped to [0, 100].
func cpuUsedPercentFromLoad(load1 float64, cpuCount int) float64 {
	if cpuCount <= 0 || load1 <= 0 {
		return 0
	}
	return clampPercentValue(load1 / float64(cpuCount) * 100)
}
