// Package resources collects host-level resource usage (CPU / memory / disk)
// and assembles it into a transport-friendly Snapshot. This package is
// intentionally agent-family agnostic: it only knows about operating-system
// primitives so that the daemon and other callers can share a single resource
// view regardless of which runtime family is active.
package resources

import (
	"runtime"
	"time"
)

// Snapshot is a host resource snapshot (CPU / memory / disk / etc.). It is
// reported by the daemon in hello/ping frames so that the server-side panel
// can display and schedule against it.
type Snapshot struct {
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

// DiskUsage describes the capacity information for a single mount point.
type DiskUsage struct {
	Filesystem      string  `json:"filesystem,omitempty"`
	MountPoint      string  `json:"mountPoint"`
	DiskTotalBytes  uint64  `json:"diskTotalBytes,omitempty"`
	DiskUsedBytes   uint64  `json:"diskUsedBytes,omitempty"`
	DiskUsedPercent float64 `json:"diskUsedPercent,omitempty"`
}

// CollectSnapshot gathers CPU / memory / disk information for the current host
// and assembles it into a Snapshot.
func CollectSnapshot() Snapshot {
	s := Snapshot{
		CPUCount:    runtime.NumCPU(),
		CollectedAt: formatTime(time.Now()),
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

// formatTime renders a timestamp using the same RFC3339 / UTC convention used
// across the daemon's outbound frames.
func formatTime(t time.Time) string {
	return t.UTC().Format(time.RFC3339)
}
