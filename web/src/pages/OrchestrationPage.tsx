import { AlertTriangle, Archive, BookOpen, CheckCircle2, GitBranch, Gauge, PlayCircle, RefreshCw, ShieldCheck, SlidersHorizontal, TimerReset, type LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import {
  type OrchestrationControlEvent,
  type OrchestrationControlEventType,
  type OrchestrationControlSource,
  useOrchestrationStore,
} from '../stores/orchestration';

const EVENT_TONE: Record<OrchestrationControlEventType, string> = {
  policy_evaluated: 'border-slate-500/20 bg-slate-500/10 text-slate-600 dark:text-slate-300',
  auto_executed: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
  approval_requested: 'border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-300',
  approval_approved: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
  approval_rejected: 'border-red-500/20 bg-red-500/10 text-red-600 dark:text-red-300',
  blocked: 'border-red-500/20 bg-red-500/10 text-red-600 dark:text-red-300',
  manual_review: 'border-blue-500/20 bg-blue-500/10 text-blue-600 dark:text-blue-300',
  runtime_recovered: 'border-cyan-500/20 bg-cyan-500/10 text-cyan-600 dark:text-cyan-300',
  quality_passed: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
  quality_failed: 'border-red-500/20 bg-red-500/10 text-red-600 dark:text-red-300',
  quality_needs_review: 'border-violet-500/20 bg-violet-500/10 text-violet-600 dark:text-violet-300',
  delivery_blocked: 'border-red-500/20 bg-red-500/10 text-red-600 dark:text-red-300',
  delivery_review_required: 'border-violet-500/20 bg-violet-500/10 text-violet-600 dark:text-violet-300',
  delivery_ready: 'border-sky-500/20 bg-sky-500/10 text-sky-600 dark:text-sky-300',
  delivery_completed: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
  release_pending: 'border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-300',
  release_blocked: 'border-red-500/20 bg-red-500/10 text-red-600 dark:text-red-300',
  release_ready: 'border-sky-500/20 bg-sky-500/10 text-sky-600 dark:text-sky-300',
  release_completed: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
  release_rollback_required: 'border-red-500/20 bg-red-500/10 text-red-600 dark:text-red-300',
  production_observing: 'border-blue-500/20 bg-blue-500/10 text-blue-600 dark:text-blue-300',
  production_healthy: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
  production_degraded: 'border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-300',
  production_incident: 'border-red-500/20 bg-red-500/10 text-red-600 dark:text-red-300',
  production_mitigation_running: 'border-orange-500/20 bg-orange-500/10 text-orange-600 dark:text-orange-300',
  production_recovered: 'border-cyan-500/20 bg-cyan-500/10 text-cyan-600 dark:text-cyan-300',
  production_rollback_recommended: 'border-red-500/20 bg-red-500/10 text-red-600 dark:text-red-300',
  remediation_proposed: 'border-violet-500/20 bg-violet-500/10 text-violet-600 dark:text-violet-300',
  remediation_waiting_approval: 'border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-300',
  remediation_running: 'border-blue-500/20 bg-blue-500/10 text-blue-600 dark:text-blue-300',
  remediation_verifying: 'border-sky-500/20 bg-sky-500/10 text-sky-600 dark:text-sky-300',
  remediation_resolved: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
  remediation_failed: 'border-red-500/20 bg-red-500/10 text-red-600 dark:text-red-300',
  incident_detected: 'border-red-500/20 bg-red-500/10 text-red-600 dark:text-red-300',
  incident_reusable: 'border-violet-500/20 bg-violet-500/10 text-violet-600 dark:text-violet-300',
  incident_archived: 'border-slate-500/20 bg-slate-500/10 text-slate-600 dark:text-slate-300',
  incident_resolved: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
  runbook_reuse_recommended: 'border-violet-500/20 bg-violet-500/10 text-violet-600 dark:text-violet-300',
  runbook_reuse_applied: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
  runbook_reuse_blocked: 'border-red-500/20 bg-red-500/10 text-red-600 dark:text-red-300',
  fix_run_proposed: 'border-violet-500/20 bg-violet-500/10 text-violet-600 dark:text-violet-300',
  fix_run_spawned: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
  fix_run_blocked: 'border-red-500/20 bg-red-500/10 text-red-600 dark:text-red-300',
  fix_run_verifying: 'border-sky-500/20 bg-sky-500/10 text-sky-600 dark:text-sky-300',
  fix_run_resolved: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
  fix_run_failed: 'border-red-500/20 bg-red-500/10 text-red-600 dark:text-red-300',
  fix_run_needs_review: 'border-violet-500/20 bg-violet-500/10 text-violet-600 dark:text-violet-300',
  resolution_ready: 'border-violet-500/20 bg-violet-500/10 text-violet-600 dark:text-violet-300',
  resolution_applied: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
  resolution_blocked: 'border-red-500/20 bg-red-500/10 text-red-600 dark:text-red-300',
  resolution_needs_review: 'border-violet-500/20 bg-violet-500/10 text-violet-600 dark:text-violet-300',
  run_waiting: 'border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-300',
  run_started: 'border-blue-500/20 bg-blue-500/10 text-blue-600 dark:text-blue-300',
  run_completed: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
  run_failed: 'border-red-500/20 bg-red-500/10 text-red-600 dark:text-red-300',
};

const EVENT_ICON: Partial<Record<OrchestrationControlEventType, LucideIcon>> = {
  incident_detected: AlertTriangle,
  incident_reusable: BookOpen,
  incident_archived: Archive,
  incident_resolved: CheckCircle2,
  runbook_reuse_recommended: BookOpen,
  runbook_reuse_applied: CheckCircle2,
  runbook_reuse_blocked: AlertTriangle,
  fix_run_proposed: PlayCircle,
  fix_run_spawned: CheckCircle2,
  fix_run_blocked: AlertTriangle,
  fix_run_verifying: RefreshCw,
  fix_run_resolved: CheckCircle2,
  fix_run_failed: AlertTriangle,
  fix_run_needs_review: SlidersHorizontal,
  resolution_ready: ShieldCheck,
  resolution_applied: CheckCircle2,
  resolution_blocked: AlertTriangle,
  resolution_needs_review: SlidersHorizontal,
};

const EVENT_LABEL: Partial<Record<OrchestrationControlEventType, string>> = {
  incident_detected: 'Incident detected',
  incident_reusable: 'Reusable incident knowledge',
  incident_archived: 'Incident archived',
  incident_resolved: 'Incident resolved',
  runbook_reuse_recommended: 'Runbook reuse recommended',
  runbook_reuse_applied: 'Runbook reuse applied',
  runbook_reuse_blocked: 'Runbook reuse blocked',
  fix_run_proposed: 'Fix run proposed',
  fix_run_spawned: 'Fix run spawned',
  fix_run_blocked: 'Fix run blocked',
  fix_run_verifying: 'Fix run verifying',
  fix_run_resolved: 'Fix run resolved',
  fix_run_failed: 'Fix run failed',
  fix_run_needs_review: 'Fix run needs review',
  resolution_ready: 'Resolution ready',
  resolution_applied: 'Resolution applied',
  resolution_blocked: 'Resolution blocked',
  resolution_needs_review: 'Resolution needs review',
};

function StatCard({ label, value, icon: Icon, tone = 'default' }: { label: string; value: number; icon: LucideIcon; tone?: 'default' | 'good' | 'warn' | 'bad' }) {
  const toneClass = tone === 'good' ? 'text-emerald-500' : tone === 'warn' ? 'text-amber-500' : tone === 'bad' ? 'text-red-500' : 'text-primary';
  return (
    <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
        <Icon className={`size-4 ${toneClass}`} />
      </div>
      <div className={`mt-3 text-2xl font-semibold ${toneClass}`}>{value}</div>
    </div>
  );
}

function eventActionLabel(event: OrchestrationControlEvent): string {
  return event.enforcementAction || EVENT_LABEL[event.type] || event.type.replaceAll('_', ' ');
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function orchestrationControlQuery(searchParams: URLSearchParams): { source?: OrchestrationControlSource; id?: string; limit: number } {
  const source = searchParams.get('source') as OrchestrationControlSource | null;
  const id = searchParams.get('id') || undefined;
  return {
    source: source === 'issue' || source === 'task' || source === 'agent_team' ? source : undefined,
    id,
    limit: 200,
  };
}

export function OrchestrationPage() {
  const [searchParams] = useSearchParams();
  const control = useOrchestrationStore((s) => s.control);
  const loading = useOrchestrationStore((s) => s.controlLoading);
  const error = useOrchestrationStore((s) => s.error);
  const loadControl = useOrchestrationStore((s) => s.loadControl);
  const reEvaluate = useOrchestrationStore((s) => s.reEvaluate);
  const [sourceFilter, setSourceFilter] = useState<OrchestrationControlSource | 'all'>('all');
  const [reEvaluating, setReEvaluating] = useState<string | null>(null);

  useEffect(() => {
    const source = searchParams.get('source') as OrchestrationControlSource | null;
    const id = searchParams.get('id') || undefined;
    void loadControl({
      source: source === 'issue' || source === 'task' || source === 'agent_team' ? source : undefined,
      id,
      limit: 200,
    });
  }, [loadControl, searchParams]);

  const events = control?.events ?? [];
  const quality = control?.quality;
  const topReliabilityRows = useMemo(() => {
    return [
      ...(quality?.runtimes.slice(0, 2).map((row) => ({ ...row, kind: 'runtime' })) ?? []),
      ...(quality?.agents.slice(0, 2).map((row) => ({ ...row, kind: 'agent' })) ?? []),
      ...(quality?.policies.slice(0, 2).map((row) => ({ ...row, kind: 'policy' })) ?? []),
    ];
  }, [quality]);
  const filteredEvents = useMemo(() => {
    return sourceFilter === 'all' ? events : events.filter((event) => event.source === sourceFilter);
  }, [events, sourceFilter]);
  const waitingApproval = filteredEvents.filter(
    (event) => event.type === 'approval_requested' || event.type === 'run_waiting' || event.type === 'remediation_waiting_approval' || event.type === 'runbook_reuse_recommended' || event.type === 'fix_run_needs_review' || event.type === 'resolution_ready' || event.type === 'resolution_needs_review',
  );
  const blocked = filteredEvents.filter(
    (event) =>
      event.type === 'blocked' ||
      event.type === 'run_failed' ||
      event.type === 'quality_failed' ||
      event.type === 'delivery_blocked' ||
      event.type === 'release_blocked' ||
      event.type === 'release_rollback_required' ||
      event.type === 'production_incident' ||
      event.type === 'production_rollback_recommended' ||
      event.type === 'remediation_waiting_approval' ||
      event.type === 'remediation_failed' ||
      event.type === 'incident_detected' ||
      event.type === 'runbook_reuse_blocked' ||
      event.type === 'fix_run_blocked' ||
      event.type === 'fix_run_failed' ||
      event.type === 'resolution_blocked',
  );

  const handleReEvaluate = async (event: OrchestrationControlEvent) => {
    if (event.source !== 'issue' && event.source !== 'task') return;
    setReEvaluating(event.id);
    try {
      await reEvaluate({ source: event.source, id: event.sourceId });
      const source = searchParams.get('source') as OrchestrationControlSource | null;
      const id = searchParams.get('id') || undefined;
      await loadControl({
        source: source === 'issue' || source === 'task' || source === 'agent_team' ? source : undefined,
        id,
        limit: 200,
      });
    } finally {
      setReEvaluating(null);
    }
  };

  return (
    <div className="min-h-full bg-background">
      <div className="mx-auto max-w-7xl space-y-6 px-4 py-6 lg:px-8 lg:py-8">
        <section className="relative overflow-hidden rounded-3xl border border-border bg-muted/20 p-6 lg:p-8">
          <div className="absolute inset-y-0 right-0 w-1/2 bg-gradient-to-l from-primary/10 to-transparent" />
          <div className="relative flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl space-y-3">
              <div className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
                <GitBranch className="size-3.5" />
                Stage 17–19 · Control Tower + Recovery + Quality Gates
              </div>
              <div>
                <h1 className="text-2xl font-bold tracking-tight text-foreground lg:text-3xl">编排控制台</h1>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  聚合 Issue、Scheduled Task 与 Agent Team 的策略执行、审批、阻断、运行恢复与质量门禁，让自治编排可观察、可审计、可学习。
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => void loadControl(orchestrationControlQuery(searchParams))}
              className="inline-flex items-center gap-2 rounded-xl border border-border bg-background px-4 py-2 text-sm text-muted-foreground shadow-sm hover:bg-muted/40"
            >
              <RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
        </section>

        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-7">
          <StatCard label="Total" value={control?.summary.total ?? 0} icon={GitBranch} />
          <StatCard label="Auto" value={control?.summary.autoExecuted ?? 0} icon={CheckCircle2} tone="good" />
          <StatCard label="Approval" value={control?.summary.waitingApproval ?? 0} icon={ShieldCheck} tone="warn" />
          <StatCard label="Blocked" value={control?.summary.blocked ?? 0} icon={AlertTriangle} tone="bad" />
          <StatCard label="Manual" value={control?.summary.manualReview ?? 0} icon={SlidersHorizontal} />
          <StatCard label="Recovered" value={control?.summary.recovered ?? 0} icon={TimerReset} tone="good" />
          <StatCard label="Failed" value={control?.summary.failed ?? 0} icon={TimerReset} tone="bad" />
        </section>

        {error ? <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-600">{error}</div> : null}

        <section className="grid gap-4 lg:grid-cols-[0.9fr_1.1fr_1fr]">
          <div className="rounded-3xl border border-border bg-card p-4 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-foreground">Quality Gates</h2>
                <p className="mt-1 text-xs text-muted-foreground">自动评估终态运行是否通过验证、是否需要人工复核。</p>
              </div>
              <Gauge className="size-5 text-primary" />
            </div>
            <div className="mt-4 grid grid-cols-3 gap-2 text-center">
              <div className="rounded-2xl border border-border bg-muted/20 p-3">
                <div className="text-[11px] text-muted-foreground">Avg Score</div>
                <div className="mt-1 text-xl font-semibold text-foreground">{quality?.summary.averageScore ?? 0}</div>
              </div>
              <div className="rounded-2xl border border-emerald-500/15 bg-emerald-500/5 p-3">
                <div className="text-[11px] text-muted-foreground">Passed</div>
                <div className="mt-1 text-xl font-semibold text-emerald-500">{quality?.summary.passed ?? 0}</div>
              </div>
              <div className="rounded-2xl border border-violet-500/15 bg-violet-500/5 p-3">
                <div className="text-[11px] text-muted-foreground">Review</div>
                <div className="mt-1 text-xl font-semibold text-violet-500">{quality?.summary.needsReview ?? 0}</div>
              </div>
            </div>
          </div>

          <div className="rounded-3xl border border-border bg-card p-4 shadow-sm">
            <h2 className="text-sm font-semibold text-foreground">Learning Insights</h2>
            <div className="mt-3 space-y-2">
              {(quality?.insights ?? []).slice(0, 4).map((insight) => (
                <div key={insight} className="rounded-2xl border border-border bg-muted/20 p-3 text-xs text-muted-foreground">{insight}</div>
              ))}
              {!(quality?.insights.length) ? <div className="text-sm text-muted-foreground">暂无质量洞察。</div> : null}
            </div>
          </div>

          <div className="rounded-3xl border border-border bg-card p-4 shadow-sm">
            <h2 className="text-sm font-semibold text-foreground">Reliability Scorecards</h2>
            <div className="mt-3 space-y-2">
              {topReliabilityRows.map((row) => (
                <div key={`${row.kind}:${row.id}`} className="rounded-2xl border border-border bg-muted/20 p-3 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium text-foreground">{row.id}</span>
                    <span className="text-muted-foreground">{Math.round(row.reliability * 100)}%</span>
                  </div>
                  <div className="mt-1 flex justify-between text-[11px] text-muted-foreground">
                    <span>{row.kind}</span>
                    <span>{row.total} runs · {row.needsReview} review · {row.failed} failed</span>
                  </div>
                </div>
              ))}
              {!topReliabilityRows.length ? <div className="text-sm text-muted-foreground">暂无可靠性数据。</div> : null}
            </div>
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(320px,0.9fr)]">
          <div className="rounded-3xl border border-border bg-card shadow-sm">
            <div className="flex flex-col gap-3 border-b border-border p-4 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <h2 className="text-sm font-semibold text-foreground">Decision Feed</h2>
                <p className="mt-1 text-xs text-muted-foreground">按时间倒序展示所有可操作的编排策略事件。</p>
              </div>
              <select
                value={sourceFilter}
                onChange={(event) => setSourceFilter(event.target.value as OrchestrationControlSource | 'all')}
                className="rounded-lg border border-border bg-background px-3 py-2 text-xs text-foreground"
              >
                <option value="all">all sources</option>
                <option value="issue">issue</option>
                <option value="task">task</option>
                <option value="agent_team">agent_team</option>
              </select>
            </div>
            <div className="divide-y divide-border">
              {filteredEvents.map((event) => {
                const EventIcon = EVENT_ICON[event.type] ?? Gauge;
                const eventLabel = EVENT_LABEL[event.type] ?? event.type;
                return (
                <div key={event.id} className="grid gap-3 p-4 lg:grid-cols-[minmax(0,1fr)_auto]">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] ${EVENT_TONE[event.type]}`}>
                        <EventIcon className="h-3 w-3" />{eventLabel}
                      </span>
                      <span className="rounded-full border border-border bg-muted/40 px-2.5 py-1 text-[11px] text-muted-foreground">{event.source}</span>
                      {event.riskLevel ? <span className="rounded-full border border-amber-500/20 bg-amber-500/10 px-2.5 py-1 text-[11px] text-amber-600">risk {event.riskLevel}</span> : null}
                    </div>
                    <div className="mt-2 truncate text-sm font-semibold text-foreground">{event.title}</div>
                    <div className="mt-1 truncate text-xs text-muted-foreground">{event.summary || event.detail || event.sourceId}</div>
                    <div className="mt-2 flex flex-wrap gap-3 font-mono text-[11px] text-muted-foreground">
                      <span>{event.sourceId}</span>
                      {event.runId ? <span>run {event.runId}</span> : null}
                      <span>{eventActionLabel(event)}</span>
                      <span>{formatTime(event.createdAt)}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 lg:justify-end">
                    <Link to={event.href} className="rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground hover:bg-muted/40">Open</Link>
                    {(event.source === 'issue' || event.source === 'task') ? (
                      <button
                        type="button"
                        onClick={() => void handleReEvaluate(event)}
                        disabled={reEvaluating === event.id}
                        className="rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-xs text-primary hover:bg-primary/15 disabled:opacity-60"
                      >
                        {reEvaluating === event.id ? 'Evaluating…' : 'Re-evaluate'}
                      </button>
                    ) : null}
                  </div>
                </div>
                );
              })}
              {!filteredEvents.length ? <div className="p-8 text-center text-sm text-muted-foreground">暂无编排事件。</div> : null}
            </div>
          </div>

          <div className="space-y-4">
            <div className="rounded-3xl border border-border bg-card p-4 shadow-sm">
              <h2 className="text-sm font-semibold text-foreground">Approval Queue</h2>
              <div className="mt-3 space-y-2">
                {waitingApproval.slice(0, 6).map((event) => (
                  <Link key={`${event.id}:approval`} to={event.href} className="block rounded-2xl border border-border bg-muted/20 p-3 text-xs hover:bg-muted/35">
                    <div className="font-medium text-foreground">{event.title}</div>
                    <div className="mt-1 truncate text-muted-foreground">{event.summary || event.sourceId}</div>
                  </Link>
                ))}
                {!waitingApproval.length ? <div className="text-sm text-muted-foreground">暂无等待审批。</div> : null}
              </div>
            </div>
            <div className="rounded-3xl border border-border bg-card p-4 shadow-sm">
              <h2 className="text-sm font-semibold text-foreground">Blocked / Failed</h2>
              <div className="mt-3 space-y-2">
                {blocked.slice(0, 6).map((event) => (
                  <Link key={`${event.id}:blocked`} to={event.href} className="block rounded-2xl border border-red-500/15 bg-red-500/5 p-3 text-xs hover:bg-red-500/10">
                    <div className="font-medium text-foreground">{event.title}</div>
                    <div className="mt-1 truncate text-muted-foreground">{event.detail || event.summary || event.sourceId}</div>
                  </Link>
                ))}
                {!blocked.length ? <div className="text-sm text-muted-foreground">暂无阻断或失败。</div> : null}
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
