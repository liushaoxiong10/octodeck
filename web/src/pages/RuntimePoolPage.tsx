import { Activity, CheckCircle2, RefreshCw, Server, ShieldAlert, SlidersHorizontal } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { useAgentLinksStore, type RuntimePoolSnapshot } from '../stores/agentLinks';

type RuntimeHealthFilter = 'all' | RuntimePoolSnapshot['runtimes'][number]['health'];

function formatHeartbeatAge(ageMs: number | undefined): string {
  if (typeof ageMs !== 'number' || !Number.isFinite(ageMs)) return '—';
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

function RuntimeStat({ label, value, tone = 'default' }: { label: string; value: number; tone?: 'default' | 'good' | 'warn' }) {
  const toneClass = tone === 'good' ? 'text-emerald-500' : tone === 'warn' ? 'text-amber-500' : 'text-foreground';
  return (
    <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`mt-2 text-2xl font-semibold ${toneClass}`}>{value}</div>
    </div>
  );
}

export function RuntimePoolPage() {
  const runtimePool = useAgentLinksStore((s) => s.runtimePool);
  const loadRuntimePool = useAgentLinksStore((s) => s.loadRuntimePool);
  const [healthFilter, setHealthFilter] = useState<RuntimeHealthFilter>('all');

  useEffect(() => {
    void loadRuntimePool();
  }, [loadRuntimePool]);

  const runtimes = runtimePool?.runtimes ?? [];
  const blockedReasonCounts = useMemo(() => {
    return runtimes.reduce<Record<string, number>>((acc, runtime) => {
      const blockedReason = runtime.scheduling.blockedReason;
      if (blockedReason) acc[blockedReason] = (acc[blockedReason] ?? 0) + 1;
      return acc;
    }, {});
  }, [runtimes]);
  const filteredRuntimes = useMemo(() => {
    if (healthFilter === 'all') return runtimes;
    return runtimes.filter((runtime) => runtime.health === healthFilter);
  }, [healthFilter, runtimes]);
  const runningRunContexts = useMemo(() => {
    return runtimes.flatMap((runtime) =>
      runtime.runningRuns.map((run) => ({
        ...run,
        runId: run.runId,
        runtimeId: runtime.runtimeId,
        runtimeName: runtime.displayName,
        runtimeKind: runtime.kind,
      })),
    );
  }, [runtimes]);
  const pendingApprovalRuns = runningRunContexts.filter((run) =>
    run.status === 'waiting_approval' || run.status === 'awaiting_input',
  );

  const summary = runtimePool?.summary;
  const quota = runtimePool?.quota;
  const recommendedRuntimeId = runtimePool?.assignment?.recommendedRuntimeId ?? null;

  return (
    <div className="min-h-full bg-background">
      <div className="mx-auto max-w-7xl space-y-6 px-4 py-6 lg:px-8 lg:py-8">
        <section className="relative overflow-hidden rounded-3xl border border-border bg-muted/20 p-6 lg:p-8">
          <div className="absolute inset-y-0 right-0 w-1/2 bg-gradient-to-l from-primary/10 to-transparent" />
          <div className="relative flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl space-y-3">
              <div className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
                <Server className="size-3.5" />
                Stage 18 · Runtime Self-Healing & Recovery
              </div>
              <div>
                <h1 className="text-2xl font-bold tracking-tight text-foreground lg:text-3xl">Runtime 资源池</h1>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  统一展示 Server / Device runtime 的健康状态、容量、调度阻塞原因和推荐执行目标，作为 Issue、Task、Agent Team 的调度治理入口。
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => void loadRuntimePool()}
              className="inline-flex items-center gap-2 rounded-xl border border-border bg-background px-4 py-2 text-sm text-muted-foreground shadow-sm hover:bg-muted/40"
            >
              <RefreshCw className="size-4" />
              Refresh
            </button>
          </div>
        </section>

        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-8">
          <RuntimeStat label="Total" value={summary?.totalRuntimes ?? 0} />
          <RuntimeStat label="Online" value={summary?.onlineRuntimes ?? 0} tone="good" />
          <RuntimeStat label="Busy" value={summary?.busyRuntimes ?? 0} />
          <RuntimeStat label="Degraded" value={summary?.degradedRuntimes ?? 0} tone="warn" />
          <RuntimeStat label="Recoverable" value={summary?.recoverableRuntimes ?? 0} tone="warn" />
          <RuntimeStat label="Slots" value={summary?.availableSlots ?? 0} />
          <RuntimeStat label="Admissible" value={summary?.admissibleSlots ?? 0} tone="good" />
          <RuntimeStat label="Running" value={summary?.runningRuns ?? 0} />
        </section>

        <section className="grid gap-4 lg:grid-cols-3">
          <div className="rounded-3xl border border-border bg-card p-4 shadow-sm">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <CheckCircle2 className="size-4 text-emerald-500" />
              推荐调度目标
            </div>
            <div className="mt-3 rounded-2xl border border-primary/20 bg-primary/5 p-3 text-xs text-muted-foreground">
              <div className="font-mono text-foreground">{recommendedRuntimeId ?? 'none'}</div>
              <div className="mt-1">executionNode: {runtimePool?.assignment?.executionNode ?? '—'}</div>
              <div className="mt-1">reason: {runtimePool?.assignment?.reason ?? 'no_assignment'}</div>
            </div>
          </div>
          <div className="rounded-3xl border border-border bg-card p-4 shadow-sm">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Activity className="size-4 text-primary" />
              用户配额
            </div>
            <div className="mt-3 text-sm text-muted-foreground">
              {quota ? `${quota.runningRuns}/${quota.maxConcurrentRuns} running · remaining ${quota.remainingRuns}${quota.saturated ? ' · saturated' : ''}` : '未启用 quota'}
            </div>
          </div>
          <div className="rounded-3xl border border-border bg-card p-4 shadow-sm">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <ShieldAlert className="size-4 text-amber-500" />
              阻塞原因
            </div>
            <div className="mt-3 flex flex-wrap gap-2 text-xs">
              {Object.keys(blockedReasonCounts).length ? Object.entries(blockedReasonCounts).map(([blockedReason, count]) => (
                <span key={blockedReason} className="rounded-full border border-border bg-muted/40 px-2.5 py-1 text-muted-foreground">
                  {blockedReason}: {count}
                </span>
              )) : <span className="text-muted-foreground">暂无 blockedReason</span>}
            </div>
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-3xl border border-border bg-card p-4 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-foreground">Run drill-down</h2>
                <p className="mt-1 text-xs text-muted-foreground">Issue / Task / Agent Team runtime 占用上下文，按 runId 反查正在执行的任务。</p>
              </div>
              <span className="rounded-full border border-border bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground">
                {runningRunContexts.length} runningRuns
              </span>
            </div>
            <div className="mt-3 space-y-2">
              {runningRunContexts.slice(0, 5).map((run) => (
                <div key={`${run.runtimeId}:${run.runId}`} className="rounded-2xl border border-border bg-muted/20 p-3 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-foreground">{run.runId}</span>
                    <span className="text-muted-foreground">{run.status ?? 'running'}</span>
                  </div>
                  <div className="mt-1 truncate text-muted-foreground">{run.runtimeName} · {run.runtimeKind} · {run.cwd ?? 'no cwd'}</div>
                </div>
              ))}
              {!runningRunContexts.length ? <div className="text-sm text-muted-foreground">暂无运行中的 runId。</div> : null}
            </div>
          </div>
          <div className="rounded-3xl border border-border bg-card p-4 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-foreground">pending approvals</h2>
                <p className="mt-1 text-xs text-muted-foreground">聚合等待人工授权的 Issue / Task / Agent Team 执行上下文，辅助调度前排障。</p>
              </div>
              <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-xs text-amber-600">
                {pendingApprovalRuns.length}
              </span>
            </div>
            <div className="mt-3 space-y-2 text-xs text-muted-foreground">
              {pendingApprovalRuns.slice(0, 5).map((run) => (
                <div key={`${run.runtimeId}:${run.runId}:approval`} className="rounded-2xl border border-border bg-muted/20 p-3">
                  <div className="font-mono text-foreground">{run.runId}</div>
                  <div className="mt-1">{run.runtimeName} · waiting for approval context</div>
                  <a href="/api/approval-requests?status=pending" className="mt-2 inline-flex text-primary hover:underline">
                    Open Approval Inbox
                  </a>
                </div>
              ))}
              {!pendingApprovalRuns.length ? <div>暂无 pending approvals。Approval Inbox 会实时同步全局审批上下文。</div> : null}
            </div>
          </div>
        </section>

        <section className="rounded-3xl border border-border bg-card shadow-sm">
          <div className="flex flex-col gap-3 border-b border-border p-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h2 className="text-sm font-semibold text-foreground">Runtime Inventory</h2>
              <p className="mt-1 text-xs text-muted-foreground">按 health 过滤，定位 offline / full / degraded runtime 与调度阻塞原因。</p>
            </div>
            <div className="flex items-center gap-2">
              <SlidersHorizontal className="size-4 text-muted-foreground" />
              <select
                value={healthFilter}
                onChange={(event) => setHealthFilter(event.target.value as RuntimeHealthFilter)}
                className="rounded-lg border border-border bg-background px-3 py-2 text-xs text-foreground"
              >
                {['all', 'available', 'full', 'degraded', 'draining', 'offline'].map((item) => (
                  <option key={item} value={item}>{item}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="overflow-x-auto">
            <div className="min-w-[980px]">
              <div className="grid grid-cols-[1.4fr_0.7fr_0.8fr_0.8fr_0.7fr_0.7fr_0.9fr_1fr_1fr] gap-3 bg-muted/40 px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                <span>Runtime</span><span>Kind</span><span>Provider</span><span>Health</span><span>Slots</span><span>Running</span><span>Heartbeat</span><span>Scheduling</span><span>Recovery</span>
              </div>
              {filteredRuntimes.map((runtime) => (
                <div key={runtime.runtimeId} className="grid grid-cols-[1.4fr_0.7fr_0.8fr_0.8fr_0.7fr_0.7fr_0.9fr_1fr_1fr] gap-3 border-t border-border px-4 py-3 text-xs">
                  <div className="min-w-0">
                    <div className="truncate font-medium text-foreground">{runtime.displayName}</div>
                    <div className="truncate font-mono text-[11px] text-muted-foreground">{runtime.runtimeId}</div>
                  </div>
                  <span className="text-muted-foreground">{runtime.kind}</span>
                  <span className="truncate text-muted-foreground">{runtime.provider ?? runtime.backendId ?? runtime.agentClientId}</span>
                  <span className="text-muted-foreground">{runtime.health}</span>
                  <span className="font-mono text-foreground">{runtime.availableSlots ?? '—'}/{runtime.maxConcurrentRuns ?? '—'}</span>
                  <span className="font-mono text-foreground">{runtime.runningRuns.length}</span>
                  <span className="font-mono text-muted-foreground">{formatHeartbeatAge(runtime.heartbeatAgeMs)}</span>
                  <span className="text-muted-foreground">
                    {runtime.scheduling.eligible ? 'eligible' : (runtime.scheduling.blockedReason ?? 'blocked')}
                  </span>
                  <span className="truncate text-muted-foreground" title={runtime.recovery.reason}>
                    {runtime.recovery.action === 'none' ? 'healthy' : runtime.recovery.action}
                  </span>
                </div>
              ))}
              {!filteredRuntimes.length ? (
                <div className="border-t border-border px-4 py-8 text-center text-sm text-muted-foreground">暂无匹配 runtime。</div>
              ) : null}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

export default RuntimePoolPage;
