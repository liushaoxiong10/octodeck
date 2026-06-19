import { Boxes, RefreshCw, ShieldAlert } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { useRegistryStore, type RegistryItemKind, type RegistryRiskLevel } from '../stores/registry';

type RegistryFilter = 'all' | RegistryItemKind;

const riskClass: Record<RegistryRiskLevel, string> = {
  low: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600',
  medium: 'border-blue-500/30 bg-blue-500/10 text-blue-600',
  high: 'border-amber-500/30 bg-amber-500/10 text-amber-600',
  critical: 'border-red-500/30 bg-red-500/10 text-red-600',
};

function RegistryStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-2 text-2xl font-semibold text-foreground">{value}</div>
    </div>
  );
}

export function RegistryPage() {
  const { registry, loading, error, load } = useRegistryStore();
  const [filter, setFilter] = useState<RegistryFilter>('all');

  useEffect(() => {
    void load();
  }, [load]);

  const items = registry?.capabilityCatalog ?? [];
  const filteredItems = useMemo(() => {
    if (filter === 'all') return items;
    return items.filter((item) => item.kind === filter);
  }, [filter, items]);
  const riskCounts = useMemo(() => {
    return items.reduce<Record<string, number>>((acc, item) => {
      acc[item.riskLevel] = (acc[item.riskLevel] ?? 0) + 1;
      return acc;
    }, {});
  }, [items]);

  return (
    <div className="min-h-full bg-background">
      <div className="mx-auto max-w-7xl space-y-6 px-4 py-6 lg:px-8 lg:py-8">
        <section className="relative overflow-hidden rounded-3xl border border-border bg-muted/20 p-6 lg:p-8">
          <div className="absolute inset-y-0 right-0 w-1/2 bg-gradient-to-l from-primary/10 to-transparent" />
          <div className="relative flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl space-y-3">
              <div className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
                <Boxes className="size-3.5" />
                Stage 14 · Registry Governance
              </div>
              <div>
                <h1 className="text-2xl font-bold tracking-tight text-foreground lg:text-3xl">Agent / Skill Registry</h1>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  统一治理 Agent、Skill 与 Runtime capability，集中展示来源、版本、permissionScopes、风险等级与 runtimeCompatibility。
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => void load()}
              className="inline-flex items-center gap-2 rounded-xl border border-border bg-background px-4 py-2 text-sm text-muted-foreground shadow-sm hover:bg-muted/40"
            >
              <RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
        </section>

        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <RegistryStat label="Registry Items" value={registry?.summary.totalRegistryItems ?? 0} />
          <RegistryStat label="Agents" value={registry?.summary.totalAgents ?? 0} />
          <RegistryStat label="Skill Packages" value={registry?.summary.totalSkillPackages ?? 0} />
          <RegistryStat label="High Risk" value={registry?.summary.highRiskItems ?? 0} />
          <RegistryStat label="Runtime Links" value={registry?.summary.compatibleRuntimeLinks ?? 0} />
          <RegistryStat label="Conflicts" value={registry?.summary.dependencyConflicts ?? 0} />
        </section>

        {error ? (
          <section className="rounded-2xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-600">
            {error}
          </section>
        ) : null}

        <section className="grid gap-4 lg:grid-cols-[280px_1fr]">
          <aside className="space-y-4 rounded-3xl border border-border bg-card p-4 shadow-sm">
            <div>
              <h2 className="text-sm font-semibold text-foreground">Catalog Filter</h2>
              <div className="mt-3 grid gap-2">
                {(['all', 'agent', 'skill', 'runtime'] as RegistryFilter[]).map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setFilter(option)}
                    className={`rounded-xl border px-3 py-2 text-left text-sm ${filter === option ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-background text-muted-foreground'}`}
                  >
                    {option}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <h2 className="text-sm font-semibold text-foreground">Risk Distribution</h2>
              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                {(['low', 'medium', 'high', 'critical'] as RegistryRiskLevel[]).map((risk) => (
                  <span key={risk} className={`rounded-full border px-2.5 py-1 ${riskClass[risk]}`}>
                    {risk}: {riskCounts[risk] ?? 0}
                  </span>
                ))}
              </div>
            </div>
            {registry?.dependencyConflicts?.length ? (
              <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700">
                <div className="flex items-center gap-2 font-semibold">
                  <ShieldAlert className="size-4" /> Skill 版本冲突
                </div>
                <div className="mt-2 space-y-1">
                  {registry.dependencyConflicts.slice(0, 4).map((conflict) => (
                    <div key={`${conflict.agentId}:${conflict.skillId}`} className="break-all">
                      {conflict.agentId} → {conflict.skillId}@{conflict.requestedVersion ?? 'any'} / current {conflict.installedVersion ?? 'unknown'}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </aside>

          <section className="space-y-3">
            {filteredItems.map((item) => (
              <article key={item.id} className="rounded-3xl border border-border bg-card p-4 shadow-sm">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full border border-border bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground">{item.kind}</span>
                      <span className="rounded-full border border-border bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground">{item.source}</span>
                      <span className={`rounded-full border px-2.5 py-1 text-xs ${riskClass[item.riskLevel]}`}>{item.riskLevel}</span>
                    </div>
                    <h2 className="mt-3 text-base font-semibold text-foreground">{item.displayName}</h2>
                    <p className="mt-1 text-sm text-muted-foreground">{item.description || item.id}</p>
                  </div>
                  <div className="text-right text-xs text-muted-foreground">
                    <div>{item.version ?? 'unversioned'}</div>
                    <div className="mt-1">min OctoDeck: {item.minimumOctodeckVersion ?? '—'}</div>
                  </div>
                </div>
                <div className="mt-4 grid gap-3 lg:grid-cols-3">
                  <div className="rounded-2xl border border-border bg-muted/20 p-3">
                    <div className="text-xs font-semibold text-foreground">Capabilities</div>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {item.capabilities.slice(0, 8).map((capability) => <span key={capability} className="rounded-full bg-background px-2 py-1 text-[11px] text-muted-foreground">{capability}</span>)}
                    </div>
                  </div>
                  <div className="rounded-2xl border border-border bg-muted/20 p-3">
                    <div className="text-xs font-semibold text-foreground">permissionScopes</div>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {item.permissionScopes.length ? item.permissionScopes.map((scope) => <span key={scope} className="rounded-full bg-background px-2 py-1 text-[11px] text-muted-foreground">{scope}</span>) : <span className="text-xs text-muted-foreground">none</span>}
                    </div>
                  </div>
                  <div className="rounded-2xl border border-border bg-muted/20 p-3">
                    <div className="text-xs font-semibold text-foreground">runtimeCompatibility</div>
                    <div className="mt-2 text-xs text-muted-foreground">
                      {item.runtimeCompatibility.compatible}/{item.runtimeCompatibility.total} compatible
                    </div>
                    <div className="mt-1 truncate font-mono text-[11px] text-foreground">
                      {item.compatibleRuntimeIds.join(', ') || 'no compatible runtime'}
                    </div>
                  </div>
                </div>
              </article>
            ))}
            {!filteredItems.length ? (
              <div className="rounded-3xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
                暂无 Registry items。
              </div>
            ) : null}
          </section>
        </section>
      </div>
    </div>
  );
}
