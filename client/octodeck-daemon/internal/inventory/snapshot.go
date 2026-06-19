package inventory

import "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/resources"

// Snapshot 是主机资源快照的兼容别名。真实定义已迁移到 internal/resources。
//
// Deprecated: 新代码请直接使用 resources.Snapshot；这里仅作为转发壳保留，
// 让现有调用方在迁移过渡期不被破坏。
type Snapshot = resources.Snapshot

// DiskUsage 是磁盘用量结构的兼容别名。真实定义已迁移到 internal/resources。
//
// Deprecated: 新代码请直接使用 resources.DiskUsage。
type DiskUsage = resources.DiskUsage

// CollectSnapshot 转发至 resources.CollectSnapshot。
//
// Deprecated: 新代码请直接调用 resources.CollectSnapshot。
func CollectSnapshot() Snapshot { return resources.CollectSnapshot() }
