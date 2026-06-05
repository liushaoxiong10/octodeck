package main

import "testing"

func TestParseLoadAverageLine(t *testing.T) {
	load, ok := parseLoadAverageLine("1.25 2.50 3.75 4/100 12345")
	if !ok {
		t.Fatal("expected load average to parse")
	}
	if load.Load1 != 1.25 || load.Load5 != 2.50 || load.Load15 != 3.75 {
		t.Fatalf("unexpected load values: %#v", load)
	}
}

func TestCollectResourceSnapshotIncludesCPUCount(t *testing.T) {
	snapshot := collectResourceSnapshot()
	if snapshot.CPUCount <= 0 {
		t.Fatalf("expected cpu count, got %#v", snapshot)
	}
	if snapshot.CPUUsedPercent < 0 || snapshot.CPUUsedPercent > 100 {
		t.Fatalf("expected bounded cpu percent, got %#v", snapshot)
	}
	if snapshot.CollectedAt == "" {
		t.Fatalf("expected collectedAt, got %#v", snapshot)
	}
	if snapshot.DiskTotalBytes > 0 && len(snapshot.Disks) == 0 {
		t.Fatalf("expected disk list when disk summary is collected, got %#v", snapshot)
	}
}

func TestCPUUsedPercentFromLoad(t *testing.T) {
	if got := cpuUsedPercentFromLoad(2, 8); got != 25 {
		t.Fatalf("unexpected cpu percent: %v", got)
	}
	if got := cpuUsedPercentFromLoad(16, 8); got != 100 {
		t.Fatalf("expected cpu percent to be clamped: %v", got)
	}
}

func TestParseDfOutputDarwinBlocks(t *testing.T) {
	disk, ok := parseDfOutput(`Filesystem 512-blocks Used Available Capacity iused ifree %iused Mounted on
/dev/disk3s1s1 975093952 390037580 420000000 49% 404250 4200000 9% /
`)
	if !ok {
		t.Fatal("expected disk info to parse")
	}
	if disk.DiskTotalBytes != 975093952*512 {
		t.Fatalf("unexpected disk total: %#v", disk)
	}
	if disk.DiskUsedBytes != 390037580*512 {
		t.Fatalf("unexpected disk used: %#v", disk)
	}
	if disk.DiskUsedPercent != 49 {
		t.Fatalf("unexpected disk percent: %#v", disk)
	}
	if len(disk.Disks) != 1 || disk.Disks[0].MountPoint != "/" || disk.Disks[0].Filesystem != "/dev/disk3s1s1" {
		t.Fatalf("unexpected disk list: %#v", disk)
	}
}

func TestParseLinuxMemInfo(t *testing.T) {
	mem, ok := parseLinuxMemInfo(`MemTotal:       16000000 kB
MemFree:         1000000 kB
MemAvailable:    6000000 kB
Buffers:          100000 kB
Cached:          2000000 kB
`)
	if !ok {
		t.Fatal("expected meminfo to parse")
	}
	if mem.MemoryTotalBytes != 16000000*1024 {
		t.Fatalf("unexpected total memory: %#v", mem)
	}
	if mem.MemoryUsedBytes != (16000000-6000000)*1024 {
		t.Fatalf("unexpected used memory: %#v", mem)
	}
	if mem.MemoryUsedPercent < 62.49 || mem.MemoryUsedPercent > 62.51 {
		t.Fatalf("unexpected memory percent: %#v", mem)
	}
}

func TestParseDfOutput(t *testing.T) {
	disk, ok := parseDfOutput("104857600 41943040 62914560 40% /\n")
	if !ok {
		t.Fatal("expected df output to parse")
	}
	if disk.DiskTotalBytes != 104857600 || disk.DiskUsedBytes != 41943040 || disk.DiskUsedPercent != 40 {
		t.Fatalf("unexpected disk values: %#v", disk)
	}
}

func TestParseDfOutputClampsPercent(t *testing.T) {
	disk, ok := parseDfOutput("104857600 105906176 0 101% /\n")
	if !ok {
		t.Fatal("expected df output to parse")
	}
	if disk.DiskUsedPercent != 100 {
		t.Fatalf("expected percent to be clamped for protocol safety: %#v", disk)
	}
}

func TestParseDfOutputAllDisks(t *testing.T) {
	disk, ok := parseDfOutput(`Filesystem     1K-blocks    Used Available Use% Mounted on
/dev/root      104857600 41943040  62914560  40% /
/dev/data      209715200 52428800 157286400  25% /data
tmpfs            1024000        0   1024000   0% /run
devtmpfs         1024000        0   1024000   0% /dev
proc                   0        0         0   0% /proc
overlay         31457280 10485760  20971520  33% /var/lib/docker/overlay2/demo/merged
`)
	if !ok {
		t.Fatal("expected df output to parse")
	}
	if len(disk.Disks) != 2 {
		t.Fatalf("expected virtual filesystems to be filtered, got %#v", disk.Disks)
	}
	if disk.DiskTotalBytes != 104857600*1024 || disk.DiskUsedBytes != 41943040*1024 {
		t.Fatalf("expected root disk to remain primary: %#v", disk)
	}
	if disk.Disks[1].MountPoint != "/data" || disk.Disks[1].Filesystem != "/dev/data" {
		t.Fatalf("unexpected second disk: %#v", disk.Disks[1])
	}
}

func TestParseDfOutputOnlyVirtualDisks(t *testing.T) {
	_, ok := parseDfOutput(`Filesystem     1K-blocks Used Available Use% Mounted on
tmpfs            1024000    0   1024000   0% /run
overlay         31457280 1024  31456256   1% /
proc                   0    0         0   0% /proc
`)
	if ok {
		t.Fatal("expected virtual-only df output to be ignored")
	}
}
