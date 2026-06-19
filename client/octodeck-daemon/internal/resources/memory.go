package resources

import (
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
)

// readMemoryUsage returns a Snapshot populated with the memory fields. It
// prefers Linux's /proc/meminfo, then falls back to macOS sysctl/vm_stat. On
// platforms where neither path is available it reports false.
func readMemoryUsage() (Snapshot, bool) {
	if data, err := os.ReadFile("/proc/meminfo"); err == nil {
		return parseLinuxMemInfo(string(data))
	}
	if runtime.GOOS == "darwin" {
		return readDarwinMemoryUsage()
	}
	return Snapshot{}, false
}

func parseLinuxMemInfo(input string) (Snapshot, bool) {
	values := map[string]uint64{}
	for _, line := range strings.Split(input, "\n") {
		parts := strings.Fields(line)
		if len(parts) < 2 {
			continue
		}
		key := strings.TrimSuffix(parts[0], ":")
		value, err := strconv.ParseUint(parts[1], 10, 64)
		if err != nil {
			continue
		}
		multiplier := uint64(1)
		if len(parts) >= 3 && strings.EqualFold(parts[2], "kB") {
			multiplier = 1024
		}
		values[key] = value * multiplier
	}
	total := values["MemTotal"]
	available := values["MemAvailable"]
	if total == 0 {
		return Snapshot{}, false
	}
	if available == 0 {
		available = values["MemFree"] + values["Buffers"] + values["Cached"]
	}
	if available > total {
		available = total
	}
	used := total - available
	return Snapshot{
		MemoryTotalBytes:  total,
		MemoryUsedBytes:   used,
		MemoryUsedPercent: percent(used, total),
	}, true
}

func readDarwinMemoryUsage() (Snapshot, bool) {
	totalOut, err := exec.Command("/usr/sbin/sysctl", "-n", "hw.memsize").Output()
	if err != nil {
		totalOut, err = exec.Command("sysctl", "-n", "hw.memsize").Output()
	}
	if err != nil {
		return Snapshot{}, false
	}
	total, err := strconv.ParseUint(strings.TrimSpace(string(totalOut)), 10, 64)
	if err != nil || total == 0 {
		return Snapshot{}, false
	}
	out, err := exec.Command("/usr/bin/vm_stat").Output()
	if err != nil {
		out, err = exec.Command("vm_stat").Output()
	}
	if err != nil {
		return Snapshot{}, false
	}
	used, ok := parseDarwinVMStatUsedBytes(string(out), total)
	if !ok {
		return Snapshot{}, false
	}
	return Snapshot{
		MemoryTotalBytes:  total,
		MemoryUsedBytes:   used,
		MemoryUsedPercent: percent(used, total),
	}, true
}

func parseDarwinVMStatUsedBytes(input string, total uint64) (uint64, bool) {
	pageSize := uint64(4096)
	pages := map[string]uint64{}
	for _, line := range strings.Split(input, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "Mach Virtual Memory Statistics:") {
			if idx := strings.Index(line, "page size of "); idx >= 0 {
				rest := line[idx+len("page size of "):]
				fields := strings.Fields(rest)
				if len(fields) > 0 {
					if parsed, err := strconv.ParseUint(fields[0], 10, 64); err == nil && parsed > 0 {
						pageSize = parsed
					}
				}
			}
			continue
		}
		parts := strings.SplitN(line, ":", 2)
		if len(parts) != 2 {
			continue
		}
		valueText := strings.Trim(strings.TrimSpace(parts[1]), ".")
		value, err := strconv.ParseUint(valueText, 10, 64)
		if err != nil {
			continue
		}
		pages[strings.TrimSpace(parts[0])] = value
	}
	freePages := pages["Pages free"] + pages["Pages speculative"]
	freeBytes := freePages * pageSize
	if freeBytes > total {
		freeBytes = total
	}
	return total - freeBytes, true
}
