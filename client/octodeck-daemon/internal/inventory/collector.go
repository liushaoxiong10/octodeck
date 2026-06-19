package inventory

import "context"

// collector.go 预留为 inventory 包的 "通用 collector / runtime capabilities" 入口。
//
// 本阶段（阶段 2）暂未把 daemonapp.BuildRuntimeCapabilities /
// daemonapp.BuildRuntimeStatuses 迁移过来，因为它们与 daemonapp 的 *Config /
// runnerPool / RuntimePolicy / findAgentRegistryEntry 等内部符号纠缠较深，
// 不能在不破坏 daemonapp 接口的情况下安全独立。这部分会在阶段 3 与
// agentruntime 重构一并处理。
//
// 这里先定义一个最小的 Collector 接口与一个聚合 Inventory，让 inventory 包对
// 外有一个统一的"主机清单"概念，后续可以按需加上 RuntimeCapabilities /
// RuntimeStatuses 字段。

// Collector 描述 "采集主机一类信息" 的统一抽象（资源 / agent client / 模型 /
// skill）。各方法都以 context 控制取消，便于后续在 daemon 内并发运行。
type Collector interface {
	CollectSnapshot(ctx context.Context) Snapshot
	CollectAgentClients(ctx context.Context, cfg Config) []Info
}

// Inventory 是聚合后的主机清单视图，暂未在生产代码中被消费，但 daemon 后续
// 阶段会把 RuntimeCapabilities/Statuses 接进来，所以提前留出字段。
type Inventory struct {
	Resources    Snapshot
	AgentClients []Info
}

// DefaultCollector 是基于本包顶层函数（CollectSnapshot / DiscoverForConfig）
// 构造的默认 Collector 实现，便于调用方直接使用。
type DefaultCollector struct{}

// CollectSnapshot 复用 inventory.CollectSnapshot。
func (DefaultCollector) CollectSnapshot(ctx context.Context) Snapshot {
	_ = ctx
	return CollectSnapshot()
}

// CollectAgentClients 复用 inventory.DiscoverForConfig。
func (DefaultCollector) CollectAgentClients(ctx context.Context, cfg Config) []Info {
	_ = ctx
	return DiscoverForConfig(cfg)
}
