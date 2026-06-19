import { MonitorSmartphone, ShieldCheck, Zap } from 'lucide-react';
import { useEffect } from 'react';

import { DevicesSection } from '../components/settings/AgentLinksSection';
import { useAgentLinksStore } from '../stores/agentLinks';

function formatHeartbeatAge(ageMs: number | undefined): string {
  if (typeof ageMs !== 'number' || !Number.isFinite(ageMs)) return '—';
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

function RuntimePoolPanel() {
  const runtimePool = useAgentLinksStore((s) => s.runtimePool);
  const loadRuntimePool = useAgentLinksStore((s) => s.loadRuntimePool);

  useEffect(() => {
    void loadRuntimePool();
  }, [loadRuntimePool]);

  const summary = runtimePool?.summary;
  const quota = runtimePool?.quota;
  const assignment = runtimePool?.assignment;

  return (
    <section className="rounded-3xl border border-border bg-card p-4 shadow-sm lg:p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Runtime Pool</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            汇总 Server / Device runtime 的在线状态、运行中任务和 availableSlots。
          </p>
        </div>
        <button
          type="button"
          onClick={() => void loadRuntimePool()}
          className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted/40"
        >
          Refresh
        </button>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-7">
        <PoolStat label="Total" value={summary?.totalRuntimes ?? 0} />
        <PoolStat label="Online" value={summary?.onlineRuntimes ?? 0} />
        <PoolStat label="Busy" value={summary?.busyRuntimes ?? 0} />
        <PoolStat label="Degraded" value={summary?.degradedRuntimes ?? 0} />
        <PoolStat label="Slots" value={summary?.availableSlots ?? 0} />
        <PoolStat label="Admissible" value={summary?.admissibleSlots ?? 0} />
        <PoolStat label="Runs" value={summary?.runningRuns ?? 0} />
      </div>
      {quota ? (
        <div className="mt-3 rounded-2xl border border-border bg-background/70 px-3 py-2 text-xs text-muted-foreground">
          Quota: {quota.runningRuns}/{quota.maxConcurrentRuns} running · remaining {quota.remainingRuns}
          {quota.saturated ? ' · saturated' : ''}
        </div>
      ) : null}
      {assignment ? (
        <div className="mt-3 rounded-2xl border border-primary/20 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
          Recommended: {assignment?.recommendedRuntimeId ?? 'none'}
          {assignment.executionNode ? ` · ${assignment.executionNode}` : ''}
          {' · '}{assignment.reason}
        </div>
      ) : null}
      <div className="mt-4 overflow-hidden rounded-2xl border border-border">
        <div className="grid grid-cols-[1.2fr_0.8fr_0.7fr_0.7fr_0.7fr_0.8fr] gap-2 bg-muted/40 px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          <span>Runtime</span>
          <span>Provider</span>
          <span>Status</span>
          <span className="text-right">Heartbeat</span>
          <span className="text-right">availableSlots</span>
          <span className="text-right">Scheduling</span>
        </div>
        {(runtimePool?.runtimes ?? []).slice(0, 8).map((runtime) => (
          <div
            key={runtime.runtimeId}
            className="grid grid-cols-[1.2fr_0.8fr_0.7fr_0.7fr_0.7fr_0.8fr] gap-2 border-t border-border px-3 py-2 text-xs"
          >
            <div className="min-w-0">
              <div className="truncate font-medium">{runtime.displayName}</div>
              <div className="truncate font-mono text-[11px] text-muted-foreground">{runtime.runtimeId}</div>
            </div>
            <span className="truncate text-muted-foreground">{runtime.provider ?? runtime.kind}</span>
            <span className="text-muted-foreground">{runtime.health}</span>
            <span className="text-right font-mono text-muted-foreground">
              {formatHeartbeatAge(runtime.heartbeatAgeMs)}
            </span>
            <span className="text-right font-mono">{runtime.availableSlots ?? '—'}</span>
            <span className="text-right text-muted-foreground">
              {runtime.scheduling.eligible ? 'eligible' : (runtime.scheduling.blockedReason ?? 'blocked')}
            </span>
          </div>
        ))}
        {!runtimePool?.runtimes?.length && (
          <div className="border-t border-border px-3 py-4 text-center text-xs text-muted-foreground">
            暂无 runtime 上报。
          </div>
        )}
      </div>
    </section>
  );
}

function PoolStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-2xl border border-border bg-background/70 p-3">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold text-foreground">{value}</div>
    </div>
  );
}

export function DevicesPage() {
  return (
    <div className="min-h-full bg-background">
      <div className="mx-auto max-w-7xl px-4 py-6 lg:px-8 lg:py-8 space-y-6">
        <div className="relative overflow-hidden rounded-3xl border border-border bg-muted/20 p-6 lg:p-8">
          <div className="absolute inset-y-0 right-0 w-1/2 bg-gradient-to-l from-primary/10 to-transparent" />
          <div className="relative max-w-2xl space-y-3">
            <div className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
              <MonitorSmartphone className="size-3.5" />
              Devices
            </div>
            <div>
              <h1 className="text-2xl lg:text-3xl font-bold tracking-tight text-foreground">
                设备管理
              </h1>
              <p className="mt-2 text-sm text-muted-foreground leading-6">
                将 octodeck-daemon 客户端注册为可信设备。Claude 后端会把本地工具调用转发到设备执行；
                非 Claude 后端会把完整运行上下文交给设备上的本地 agent。
              </p>
            </div>
            <div className="grid gap-2 pt-2 text-xs text-muted-foreground sm:grid-cols-2">
              <div className="flex items-center gap-2 rounded-xl bg-background/70 px-3 py-2 border border-border/60">
                <ShieldCheck className="size-4 text-emerald-500" />
                Token 只展示一次，支持随时重置
              </div>
              <div className="flex items-center gap-2 rounded-xl bg-background/70 px-3 py-2 border border-border/60">
                <Zap className="size-4 text-amber-500" />
                在线状态由实时设备事件更新，可作为执行节点
              </div>
            </div>
          </div>
        </div>

        <RuntimePoolPanel />

        <DevicesSection />
      </div>
    </div>
  );
}

export default DevicesPage;
