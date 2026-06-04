package main

import (
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"time"
)

type ResourceSnapshot struct {
	CPUCount          int         `json:"cpuCount"`
	CPUUsedPercent    float64     `json:"cpuUsedPercent,omitempty"`
	Load1             float64     `json:"load1,omitempty"`
	Load5             float64     `json:"load5,omitempty"`
	Load15            float64     `json:"load15,omitempty"`
	MemoryTotalBytes  uint64      `json:"memoryTotalBytes,omitempty"`
	MemoryUsedBytes   uint64      `json:"memoryUsedBytes,omitempty"`
	MemoryUsedPercent float64     `json:"memoryUsedPercent,omitempty"`
	DiskTotalBytes    uint64      `json:"diskTotalBytes,omitempty"`
	DiskUsedBytes     uint64      `json:"diskUsedBytes,omitempty"`
	DiskUsedPercent   float64     `json:"diskUsedPercent,omitempty"`
	Disks             []DiskUsage `json:"disks,omitempty"`
	CollectedAt       string      `json:"collectedAt"`
}

type DiskUsage struct {
	Filesystem      string  `json:"filesystem,omitempty"`
	MountPoint      string  `json:"mountPoint"`
	DiskTotalBytes  uint64  `json:"diskTotalBytes,omitempty"`
	DiskUsedBytes   uint64  `json:"diskUsedBytes,omitempty"`
	DiskUsedPercent float64 `json:"diskUsedPercent,omitempty"`
}

func collectResourceSnapshot() ResourceSnapshot {
	s := ResourceSnapshot{
		CPUCount:    runtime.NumCPU(),
		CollectedAt: time.Now().UTC().Format(time.RFC3339),
	}
	if load, ok := readLoadAverage(); ok {
		s.Load1 = load.Load1
		s.Load5 = load.Load5
		s.Load15 = load.Load15
		s.CPUUsedPercent = cpuUsedPercentFromLoad(load.Load1, s.CPUCount)
	}
	if memory, ok := readMemoryUsage(); ok {
		s.MemoryTotalBytes = memory.MemoryTotalBytes
		s.MemoryUsedBytes = memory.MemoryUsedBytes
		s.MemoryUsedPercent = memory.MemoryUsedPercent
	}
	if disk, ok := readDiskUsage(); ok {
		s.DiskTotalBytes = disk.DiskTotalBytes
		s.DiskUsedBytes = disk.DiskUsedBytes
		s.DiskUsedPercent = disk.DiskUsedPercent
		s.Disks = disk.Disks
	}
	return s
}

func readLoadAverage() (ResourceSnapshot, bool) {
	if data, err := os.ReadFile("/proc/loadavg"); err == nil {
		return parseLoadAverageLine(string(data))
	}

	out, err := exec.Command("/usr/bin/uptime").Output()
	if err != nil {
		out, err = exec.Command("uptime").Output()
	}
	if err != nil {
		return ResourceSnapshot{}, false
	}
	return parseUptimeLoadAverage(string(out))
}

func parseLoadAverageLine(line string) (ResourceSnapshot, bool) {
	fields := strings.Fields(strings.TrimSpace(line))
	if len(fields) < 3 {
		return ResourceSnapshot{}, false
	}
	load1, err1 := strconv.ParseFloat(strings.TrimSuffix(fields[0], ","), 64)
	load5, err5 := strconv.ParseFloat(strings.TrimSuffix(fields[1], ","), 64)
	load15, err15 := strconv.ParseFloat(strings.TrimSuffix(fields[2], ","), 64)
	if err1 != nil || err5 != nil || err15 != nil {
		return ResourceSnapshot{}, false
	}
	return ResourceSnapshot{Load1: load1, Load5: load5, Load15: load15}, true
}

func parseUptimeLoadAverage(output string) (ResourceSnapshot, bool) {
	idx := strings.LastIndex(output, "load averages:")
	if idx == -1 {
		idx = strings.LastIndex(output, "load average:")
	}
	if idx == -1 {
		return ResourceSnapshot{}, false
	}
	loads := output[idx:]
	loads = strings.TrimPrefix(loads, "load averages:")
	loads = strings.TrimPrefix(loads, "load average:")
	return parseLoadAverageLine(loads)
}

func readMemoryUsage() (ResourceSnapshot, bool) {
	if data, err := os.ReadFile("/proc/meminfo"); err == nil {
		return parseLinuxMemInfo(string(data))
	}
	if runtime.GOOS == "darwin" {
		return readDarwinMemoryUsage()
	}
	return ResourceSnapshot{}, false
}

func parseLinuxMemInfo(input string) (ResourceSnapshot, bool) {
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
		return ResourceSnapshot{}, false
	}
	if available == 0 {
		available = values["MemFree"] + values["Buffers"] + values["Cached"]
	}
	if available > total {
		available = total
	}
	used := total - available
	return ResourceSnapshot{
		MemoryTotalBytes:  total,
		MemoryUsedBytes:   used,
		MemoryUsedPercent: percent(used, total),
	}, true
}

func readDarwinMemoryUsage() (ResourceSnapshot, bool) {
	totalOut, err := exec.Command("/usr/sbin/sysctl", "-n", "hw.memsize").Output()
	if err != nil {
		totalOut, err = exec.Command("sysctl", "-n", "hw.memsize").Output()
	}
	if err != nil {
		return ResourceSnapshot{}, false
	}
	total, err := strconv.ParseUint(strings.TrimSpace(string(totalOut)), 10, 64)
	if err != nil || total == 0 {
		return ResourceSnapshot{}, false
	}
	out, err := exec.Command("/usr/bin/vm_stat").Output()
	if err != nil {
		out, err = exec.Command("vm_stat").Output()
	}
	if err != nil {
		return ResourceSnapshot{}, false
	}
	used, ok := parseDarwinVMStatUsedBytes(string(out), total)
	if !ok {
		return ResourceSnapshot{}, false
	}
	return ResourceSnapshot{
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

func readDiskUsage() (ResourceSnapshot, bool) {
	out, err := exec.Command("/bin/df", "-k").Output()
	if err != nil {
		out, err = exec.Command("df", "-k").Output()
	}
	if err != nil {
		return ResourceSnapshot{}, false
	}
	return parseDfOutput(string(out))
}

func parseDfOutput(input string) (ResourceSnapshot, bool) {
	var disks []DiskUsage
	for _, line := range strings.Split(input, "\n") {
		fields := strings.Fields(strings.TrimSpace(line))
		if len(fields) < 4 || strings.EqualFold(fields[0], "Filesystem") {
			continue
		}
		totalIndex := 0
		filesystem := ""
		if _, err := strconv.ParseUint(fields[0], 10, 64); err != nil {
			totalIndex = 1
			filesystem = fields[0]
		}
		if len(fields) <= totalIndex+3 {
			continue
		}
		percentIndex := -1
		for i := totalIndex + 3; i < len(fields); i++ {
			if strings.HasSuffix(fields[i], "%") {
				percentIndex = i
				break
			}
		}
		if percentIndex == -1 {
			continue
		}
		mountIndex := percentIndex + 1
		if len(fields) > percentIndex+3 && strings.HasSuffix(fields[percentIndex+3], "%") {
			mountIndex = percentIndex + 4
		}
		if mountIndex >= len(fields) {
			continue
		}
		totalBlocks, err1 := strconv.ParseUint(fields[totalIndex], 10, 64)
		usedBlocks, err2 := strconv.ParseUint(fields[totalIndex+1], 10, 64)
		percentText := strings.TrimSuffix(fields[percentIndex], "%")
		usedPercent, err3 := strconv.ParseFloat(percentText, 64)
		if err1 != nil || err2 != nil || err3 != nil {
			continue
		}
		blockSize := uint64(1024)
		if strings.Contains(input, "512-blocks") {
			blockSize = 512
		} else if !strings.Contains(input, "1K-blocks") && !strings.Contains(input, "1024-blocks") {
			blockSize = 1
		}
		disks = append(disks, DiskUsage{
			Filesystem:      filesystem,
			MountPoint:      strings.Join(fields[mountIndex:], " "),
			DiskTotalBytes:  totalBlocks * blockSize,
			DiskUsedBytes:   usedBlocks * blockSize,
			DiskUsedPercent: clampPercentValue(usedPercent),
		})
	}
	if len(disks) == 0 {
		return ResourceSnapshot{}, false
	}
	primary := disks[0]
	for _, disk := range disks {
		if disk.MountPoint == "/" {
			primary = disk
			break
		}
	}
	return ResourceSnapshot{
		DiskTotalBytes:  primary.DiskTotalBytes,
		DiskUsedBytes:   primary.DiskUsedBytes,
		DiskUsedPercent: primary.DiskUsedPercent,
		Disks:           disks,
	}, true
}

func percent(used uint64, total uint64) float64 {
	if total == 0 {
		return 0
	}
	return float64(used) / float64(total) * 100
}

func clampPercentValue(value float64) float64 {
	if value < 0 {
		return 0
	}
	if value > 100 {
		return 100
	}
	return value
}

func cpuUsedPercentFromLoad(load1 float64, cpuCount int) float64 {
	if cpuCount <= 0 || load1 <= 0 {
		return 0
	}
	return clampPercentValue(load1 / float64(cpuCount) * 100)
}
