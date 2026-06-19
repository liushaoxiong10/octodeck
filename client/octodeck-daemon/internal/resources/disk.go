package resources

import (
	"context"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// readDiskUsage runs `df -k` and parses the output into a Snapshot whose disk
// fields describe the primary filesystem (preferring `/`) plus the full list of
// real disks discovered.
func readDiskUsage() (Snapshot, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "/bin/df", "-k").Output()
	if err != nil {
		if ctx.Err() != nil {
			return Snapshot{}, false
		}
		fallbackCtx, fallbackCancel := context.WithTimeout(context.Background(), time.Second)
		defer fallbackCancel()
		out, err = exec.CommandContext(fallbackCtx, "df", "-k").Output()
		if fallbackCtx.Err() != nil {
			return Snapshot{}, false
		}
	}
	if err != nil {
		return Snapshot{}, false
	}
	return parseDfOutput(string(out))
}

func parseDfOutput(input string) (Snapshot, bool) {
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
		mountPoint := strings.Join(fields[mountIndex:], " ")
		if !isRealDiskFilesystem(filesystem, mountPoint) {
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
			MountPoint:      mountPoint,
			DiskTotalBytes:  totalBlocks * blockSize,
			DiskUsedBytes:   usedBlocks * blockSize,
			DiskUsedPercent: clampPercentValue(usedPercent),
		})
	}
	if len(disks) == 0 {
		return Snapshot{}, false
	}
	primary := disks[0]
	for _, disk := range disks {
		if disk.MountPoint == "/" {
			primary = disk
			break
		}
	}
	return Snapshot{
		DiskTotalBytes:  primary.DiskTotalBytes,
		DiskUsedBytes:   primary.DiskUsedBytes,
		DiskUsedPercent: primary.DiskUsedPercent,
		Disks:           disks,
	}, true
}

// isRealDiskFilesystem filters out kernel / virtual filesystems so the disk
// summary only carries actual block-device backed mounts.
func isRealDiskFilesystem(filesystem, mountPoint string) bool {
	fs := strings.TrimSpace(filesystem)
	if fs == "" {
		// Keep compatibility with df output that omits the Filesystem column.
		return true
	}
	lowerFS := strings.ToLower(fs)
	virtualFilesystems := map[string]bool{
		"autofs":      true,
		"binfmt_misc": true,
		"bpf":         true,
		"cgroup":      true,
		"cgroup2":     true,
		"configfs":    true,
		"debugfs":     true,
		"devfs":       true,
		"devtmpfs":    true,
		"efivarfs":    true,
		"fusectl":     true,
		"hugetlbfs":   true,
		"mqueue":      true,
		"nsfs":        true,
		"overlay":     true,
		"proc":        true,
		"pstore":      true,
		"ramfs":       true,
		"securityfs":  true,
		"sysfs":       true,
		"tmpfs":       true,
		"tracefs":     true,
	}
	if virtualFilesystems[lowerFS] {
		return false
	}
	if strings.HasPrefix(lowerFS, "/dev/") || strings.HasPrefix(lowerFS, "uuid=") || strings.HasPrefix(lowerFS, "label=") {
		return true
	}
	if strings.HasPrefix(lowerFS, "zfs") || strings.HasPrefix(lowerFS, "zroot") || strings.HasPrefix(lowerFS, "rpool") {
		return true
	}
	// macOS can report special non-disk maps in the Filesystem column.
	if strings.HasPrefix(lowerFS, "map ") || strings.HasPrefix(strings.ToLower(strings.TrimSpace(mountPoint)), "/dev") {
		return false
	}
	return false
}
