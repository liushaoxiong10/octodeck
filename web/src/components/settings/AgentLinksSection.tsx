import { useEffect, useState } from 'react';
import type { ComponentType, ReactNode } from 'react';
import {
  Activity,
  Boxes,
  Check,
  ChevronDown,
  CircleDot,
  Copy,
  FolderKanban,
  HardDrive,
  Layers3,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import {
  useAgentLinksStore,
  type AgentLink,
  type AgentRuntimeSession,
} from '../../stores/agentLinks';
import { getErrorMessage } from './types';
import {
  buildDaemonInstallCommand,
  buildDaemonUninstallCommand,
  buildDaemonUpdateCommand,
  getCurrentServerOrigin,
} from '../../utils/devicesInstall';
import {
  useCustomBackendsStore,
  type CustomBackendDef,
} from '../../stores/customBackends';

function formatTime(t: string | null): string {
  if (!t) return '—';
  try {
    return new Date(t).toLocaleString();
  } catch {
    return t;
  }
}

function formatDurationSince(t: string | null, enabled: boolean): string {
  if (!enabled || !t) return '—';
  const start = new Date(t).getTime();
  if (!Number.isFinite(start)) return '—';
  const diff = Math.max(0, Date.now() - start);
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days} 天 ${hours % 24} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes % 60} 分钟`;
  return `${Math.max(1, minutes)} 分钟`;
}

function formatBytes(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
}

function clampPercent(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function statusTone(link: AgentLink): string {
  if (!link.online || link.status === 'offline')
    return 'border-zinc-500/20 bg-zinc-500/10 text-muted-foreground';
  if (link.status === 'busy')
    return 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300';
  if (link.status === 'draining')
    return 'border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300';
  return 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
}

function statusLabel(
  status: AgentLink['status'] | undefined,
  online: boolean,
): string {
  if (!online || status === 'offline') return 'offline';
  if (status === 'busy') return 'busy';
  if (status === 'draining') return 'draining';
  return 'idle';
}

function runtimeTone(status: string | undefined): string {
  if (status === 'busy')
    return 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300';
  if (status === 'draining')
    return 'border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300';
  if (status === 'offline')
    return 'border-zinc-500/20 bg-zinc-500/10 text-muted-foreground';
  return 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
}

function DetailRow({
  label,
  value,
}: {
  label: string;
  value: string | number | null | undefined;
}) {
  return (
    <div className="rounded-xl border border-border/70 bg-background/70 px-3 py-2">
      <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 break-all text-xs font-medium text-foreground">
        {value || '—'}
      </div>
    </div>
  );
}

function Pill({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-border bg-background/80 px-2.5 py-1 text-xs text-foreground shadow-sm">
      {children}
    </span>
  );
}

function ResourceMeter({
  label,
  used,
  total,
  percent,
  detail,
}: {
  label: string;
  used?: number;
  total?: number;
  percent?: number;
  detail?: string;
}) {
  const value = clampPercent(percent);
  return (
    <div className="rounded-xl border border-border/70 bg-background/70 p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          {label}
        </div>
        <div className="text-xs font-semibold text-foreground">
          {percent == null ? '—' : `${value.toFixed(1)}%`}
        </div>
      </div>
      <Progress
        className="mt-2 h-2"
        value={value}
        role="progressbar"
        aria-label={`${label} usage`}
      />
      <div className="mt-2 text-[11px] text-muted-foreground">
        {detail ?? `${formatBytes(used)} / ${formatBytes(total)}`}
      </div>
    </div>
  );
}

function DiskResourceList({ resources }: { resources: AgentLink['resources'] }) {
  const disks = resources?.disks?.length
    ? resources.disks
    : resources
      ? [
          {
            mountPoint: '/',
            diskUsedBytes: resources.diskUsedBytes,
            diskTotalBytes: resources.diskTotalBytes,
            diskUsedPercent: resources.diskUsedPercent,
          },
        ]
      : [];

  if (disks.length === 0) {
    return <ResourceMeter label="Disk" />;
  }

  return (
    <div className="space-y-2">
      {disks.map((disk, index) => (
        <ResourceMeter
          key={`${disk.mountPoint}-${disk.filesystem ?? index}`}
          label={`Disk ${disk.mountPoint}`}
          used={disk.diskUsedBytes}
          total={disk.diskTotalBytes}
          percent={disk.diskUsedPercent}
          detail={disk.filesystem ? `${disk.filesystem} · ${formatBytes(disk.diskUsedBytes)} / ${formatBytes(disk.diskTotalBytes)}` : undefined}
        />
      ))}
    </div>
  );
}

function StatTile({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-border/70 bg-background/80 p-3">
      <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-sm font-semibold text-foreground">{value}</div>
      {hint ? <div className="mt-1 text-[11px] text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

function uniqueValues(values: Array<string[] | undefined>): string[] {
  return [...new Set(values.flatMap((v) => v ?? []).filter(Boolean))];
}

function DeviceInfoSection({
  icon: Icon,
  title,
  children,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-border bg-card/80 p-4 shadow-sm">
      <div className="mb-3 flex items-center gap-2">
        <span className="flex size-8 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Icon className="size-4" />
        </span>
        <h4 className="text-sm font-semibold text-foreground">{title}</h4>
      </div>
      {children}
    </section>
  );
}

function ActionButton({
  icon: Icon,
  children,
  ...props
}: React.ComponentProps<typeof Button> & {
  icon: ComponentType<{ className?: string }>;
}) {
  return (
    <Button size="sm" variant="outline" {...props}>
      <Icon className="size-4" />
      {children}
    </Button>
  );
}

function EmptyBlock({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-border bg-muted/20 px-3 py-4 text-center text-xs text-muted-foreground">
      {children}
    </div>
  );
}

function ServingAgents({ agents }: { agents: CustomBackendDef[] }) {
  if (agents.length === 0) {
    return (
      <EmptyBlock>
        暂无绑定到该设备的 Agent。可在 Agents 页面基于该设备创建 Agent。
      </EmptyBlock>
    );
  }
  return (
    <div className="space-y-2">
      {agents.map((agent) => (
        <div
          key={agent.id}
          className="rounded-xl border border-border bg-background/80 p-3"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-foreground">
                {agent.displayName}
              </div>
              <div className="mt-0.5 truncate text-xs text-muted-foreground">
                {agent.id} · {agent.agentClientId ?? 'manual'} ·{' '}
                {agent.outputProtocol}
              </div>
            </div>
            <span className="rounded-full bg-primary/10 px-2 py-1 text-[10px] font-medium text-primary">
              serving
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

function RunningRuns({ link }: { link: AgentLink }) {
  const runs = link.runningRuns ?? [];
  if (runs.length === 0)
    return <EmptyBlock>当前没有正在执行的远端 run。</EmptyBlock>;
  return (
    <div className="space-y-2">
      {runs.map((run) => (
        <div
          key={run.runId}
          className="rounded-xl border border-border bg-background/80 p-3 text-xs"
        >
          <div className="font-medium text-foreground">
            {run.backendId ?? 'unknown backend'} · {run.status ?? 'running'}
          </div>
          <div className="mt-1 break-all text-muted-foreground">
            {run.runId}
          </div>
          {run.cwd ? (
            <div className="mt-1 break-all text-muted-foreground">
              cwd: {run.cwd}
            </div>
          ) : null}
          <div className="mt-1 text-muted-foreground">
            last activity:{' '}
            {run.lastActivityAt ? formatTime(run.lastActivityAt) : '—'}
          </div>
        </div>
      ))}
    </div>
  );
}

function RuntimeSessions({
  sessions,
  loading,
  onDelete,
}: {
  sessions: AgentRuntimeSession[];
  loading: boolean;
  onDelete: (session: AgentRuntimeSession) => void;
}) {
  if (loading) return <EmptyBlock>正在加载 runtime sessions...</EmptyBlock>;
  if (sessions.length === 0)
    return (
      <EmptyBlock>
        暂无已发现的 provider session。点击上方刷新 sessions。
      </EmptyBlock>
    );
  return (
    <div className="space-y-2">
      {sessions.slice(0, 12).map((session) => (
        <div
          key={`${session.agentId}:${session.workspace}:${session.id}`}
          className="rounded-xl border border-border bg-background/80 p-3 text-xs"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate font-medium text-foreground">
                {session.title || session.id}
              </div>
              <div className="mt-1 break-all text-muted-foreground">
                {session.agentId} · {session.workspace}
              </div>
              <div className="mt-1 break-all text-muted-foreground">
                {session.path}
              </div>
              <div className="mt-1 text-muted-foreground">
                {formatTime(session.updatedAt ?? null)} ·{' '}
                {formatBytes(session.sizeBytes)}
              </div>
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => onDelete(session)}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}

function ProvidersPanel({ link }: { link: AgentLink }) {
  const permissionModes = uniqueValues(
    link.agentClients.map((c) => c.permissionModes),
  );
  const runtimesByAgentClient = new Map(
    (link.runtimes ?? []).map((runtime) => [runtime.agentClientId, runtime]),
  );
  const onlineRuntimes = (link.runtimes ?? []).filter(
    (runtime) => runtime.status !== 'offline',
  );
  const runningCount = (link.runtimes ?? []).reduce(
    (sum, runtime) => sum + (runtime.runningRuns?.length ?? 0),
    0,
  );

  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-3">
        <StatTile label="Providers" value={link.agentClients.length} />
        <StatTile label="Online runtimes" value={onlineRuntimes.length} />
        <StatTile label="运行中" value={runningCount} />
      </div>

      {link.agentClients.length > 0 ? (
        <div className="overflow-x-auto rounded-2xl border border-border bg-background/80 shadow-sm">
          <div className="min-w-[960px]">
            <div className="grid grid-cols-[minmax(180px,1.3fr)_minmax(280px,2fr)_112px_96px_minmax(150px,1fr)_minmax(220px,1.2fr)] gap-3 border-b border-border bg-muted/30 px-4 py-2 text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
              <div>Provider</div>
              <div>Runtime</div>
              <div>运行中</div>
              <div>Caps</div>
              <div>Slots</div>
              <div>Binary</div>
            </div>
            {link.agentClients.map((client) => {
              const runtime = runtimesByAgentClient.get(client.id);
              const runningRuns = runtime?.runningRuns ?? [];
              return (
                <div
                  key={client.id}
                  className="grid grid-cols-[minmax(180px,1.3fr)_minmax(280px,2fr)_112px_96px_minmax(150px,1fr)_minmax(220px,1.2fr)] items-center gap-3 border-b border-border/70 px-4 py-3 text-xs last:border-b-0"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-foreground">
                      {client.displayName}
                    </div>
                    <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                      {client.id}
                    </div>
                    <div className="mt-1 truncate text-[11px] text-muted-foreground">
                      Provider / Transport · {client.provider ?? runtime?.provider ?? 'local'} / {client.transport ?? runtime?.transport ?? 'stdio'}
                    </div>
                  </div>

                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                      {runtime ? (
                        <span
                          className={`shrink-0 rounded-full border px-2.5 py-1 text-[11px] ${runtimeTone(runtime.status)}`}
                        >
                          {runtime.status}
                        </span>
                      ) : (
                        <span className="shrink-0 rounded-full border border-border bg-background px-2.5 py-1 text-[11px] text-muted-foreground">
                          no runtime
                        </span>
                      )}
                      <span className="truncate font-mono text-[11px] text-muted-foreground">
                        {runtime?.runtimeId ?? 'daemon 尚未上报'}
                      </span>
                    </div>
                    <div className="mt-1 truncate text-[11px] text-muted-foreground">
                      Device link · {runtime?.deviceLinkId ?? link.id}
                    </div>
                  </div>

                  <div className="font-semibold text-foreground">
                    {runningRuns.length}
                    {runningRuns.length > 0 ? (
                      <div className="mt-1 truncate text-[11px] font-normal text-muted-foreground">
                        {runningRuns
                          .slice(0, 2)
                          .map((run) => run.backendId ?? run.runId.slice(0, 8))
                          .join('、')}
                        {runningRuns.length > 2 ? ` +${runningRuns.length - 2}` : ''}
                      </div>
                    ) : null}
                  </div>

                  <div className="font-semibold text-foreground">
                    {client.capabilities?.length ?? 0}
                    {(client.capabilities?.length ?? 0) > 0 ? (
                      <div className="mt-1 truncate text-[11px] font-normal text-muted-foreground">
                        {client.capabilities!.slice(0, 2).join('、')}
                        {client.capabilities!.length > 2
                          ? ` +${client.capabilities!.length - 2}`
                          : ''}
                      </div>
                    ) : null}
                  </div>

                  <div className="font-semibold text-foreground">
                    {runtime?.availableSlots ?? '—'}
                    <div className="mt-1 truncate text-[11px] font-normal text-muted-foreground">
                      max {runtime?.maxConcurrentRuns ?? '—'}
                    </div>
                  </div>

                  <div className="min-w-0">
                    <div className="truncate font-mono text-[11px] text-foreground">
                      {client.binary}
                    </div>
                    <div className="mt-1 truncate text-[11px] text-muted-foreground">
                      {client.version ?? '—'}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <EmptyBlock>未发现 runtime。</EmptyBlock>
      )}

      <div className="grid gap-2">
        <div className="rounded-xl border border-border/70 bg-background/70 p-3">
          <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            Permission modes
          </div>
          {permissionModes.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {permissionModes.map((mode) => (
                <Pill key={mode}>{mode}</Pill>
              ))}
            </div>
          ) : (
            <div className="mt-2 text-xs text-muted-foreground">尚未上报</div>
          )}
        </div>
      </div>
    </div>
  );
}

function DeviceDetails({
  link,
  servingAgents,
  onRotate,
  onRemove,
  onCopyUpdateCommand,
  onCopyUninstallCommand,
  onDiscoverAgents,
  onRefreshSessions,
  onDeleteSession,
  sessions,
  sessionsLoading,
  busy,
}: {
  link: AgentLink;
  servingAgents: CustomBackendDef[];
  onRotate: (link: AgentLink) => void;
  onRemove: (link: AgentLink) => void;
  onCopyUpdateCommand: (link: AgentLink) => void;
  onCopyUninstallCommand: (link: AgentLink) => void;
  onDiscoverAgents: (link: AgentLink) => void;
  onRefreshSessions: (link: AgentLink) => void;
  onDeleteSession: (link: AgentLink, session: AgentRuntimeSession) => void;
  sessions: AgentRuntimeSession[];
  sessionsLoading: boolean;
  busy: boolean;
}) {
  const uptime = formatDurationSince(link.lastConnectedAt, link.online);
  const agentClientNames = link.agentClients
    .map((c) => c.displayName)
    .join('、');
  return (
    <div className="space-y-4">
      <div className="relative overflow-hidden rounded-3xl border border-border bg-gradient-to-br from-card via-card to-muted/30 p-5 shadow-sm">
        <div className="absolute right-0 top-0 h-28 w-28 rounded-bl-full bg-primary/10" />
        <div className="relative flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="mb-2 flex items-center gap-2">
              <span
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${statusTone(link)}`}
              >
                <CircleDot
                  className={`size-3 ${link.online ? 'fill-emerald-500 text-emerald-500' : 'fill-muted-foreground/40 text-muted-foreground/40'}`}
                />
                {statusLabel(link.status, link.online)}
              </span>
              {link.clientVersion ? (
                <Pill>octodeck-daemon v{link.clientVersion}</Pill>
              ) : null}
              {link.updateAvailable ? (
                <Pill>可更新到 {link.latestVersion ?? 'latest'}</Pill>
              ) : null}
            </div>
            <h3 className="truncate text-2xl font-semibold tracking-tight text-foreground">
              {link.displayName}
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {link.hostname ?? 'unknown host'} · {link.os ?? '?'} /{' '}
              {link.arch ?? '?'}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:min-w-64">
            <StatTile label="在线时长" value={uptime} />
            <StatTile label="Agents" value={servingAgents.length} />
            <StatTile label="运行中" value={link.runningRuns?.length ?? 0} />
            <StatTile label="Runtimes" value={link.runtimes?.length ?? 0} />
          </div>
        </div>
        <div className="relative mt-4 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => onRotate(link)}
            disabled={busy}
          >
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
            重置 token
          </Button>
          {link.updateAvailable ? (
            <ActionButton
              icon={Copy}
              onClick={() => onCopyUpdateCommand(link)}
              disabled={busy}
            >
              复制更新命令
            </ActionButton>
          ) : null}
          <ActionButton
            icon={Copy}
            onClick={() => onCopyUninstallCommand(link)}
            disabled={busy}
          >
            复制卸载命令
          </ActionButton>
          <ActionButton
            icon={RefreshCw}
            onClick={() => onDiscoverAgents(link)}
            disabled={busy || !link.online}
          >
            Rediscover agents
          </ActionButton>
          <ActionButton
            icon={Layers3}
            onClick={() => onRefreshSessions(link)}
            disabled={busy || !link.online}
          >
            刷新 sessions
          </ActionButton>
          <Button
            size="sm"
            variant="outline"
            onClick={() => onRemove(link)}
            disabled={busy}
            className="text-destructive hover:text-destructive"
          >
            <Trash2 className="size-4" />
            删除设备
          </Button>
        </div>
      </div>

      <details className="group rounded-2xl border border-border bg-card shadow-sm">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-medium text-foreground">
          <span className="flex items-center gap-2">
            <HardDrive className="size-4 text-primary" />
            基础信息与命令
          </span>
          <ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
        </summary>
        <div className="grid gap-2 border-t border-border p-4 md:grid-cols-2 xl:grid-cols-3">
          <DetailRow label="Device ID" value={link.id} />
          <DetailRow label="Created at" value={formatTime(link.createdAt)} />
          <DetailRow label="Hostname" value={link.hostname} />
          <DetailRow label="Platform" value={`${link.os ?? '?'} / ${link.arch ?? '?'}`} />
          <DetailRow label="Reported clients" value={agentClientNames || '—'} />
          <DetailRow label="Latest daemon" value={link.latestVersion ?? 'unknown'} />
          {link.updateAvailable ? (
            <DetailRow
              label="Update command"
              value={link.updateCommand ?? buildDaemonUpdateCommand()}
            />
          ) : null}
          <DetailRow
            label="Uninstall command"
            value={link.uninstallCommand ?? buildDaemonUninstallCommand()}
          />
        </div>
      </details>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
        <div className="space-y-4">
          <DeviceInfoSection icon={FolderKanban} title="Serving Agents">
            <ServingAgents agents={servingAgents} />
          </DeviceInfoSection>

          <DeviceInfoSection icon={Activity} title="运行与会话">
            <div className="grid gap-4 lg:grid-cols-2">
              <div>
                <div className="mb-2 text-xs font-medium text-muted-foreground">
                  正在执行的 Run
                </div>
                <RunningRuns link={link} />
              </div>
              <div>
                <div className="mb-2 text-xs font-medium text-muted-foreground">
                  Provider sessions
                </div>
                <RuntimeSessions
                  sessions={sessions}
                  loading={sessionsLoading}
                  onDelete={(session) => onDeleteSession(link, session)}
                />
              </div>
            </div>
          </DeviceInfoSection>

          <DeviceInfoSection icon={Layers3} title="Runtime">
            <ProvidersPanel link={link} />
          </DeviceInfoSection>
        </div>

        <aside className="space-y-4">
          <DeviceInfoSection icon={Boxes} title="资源状态">
            <div className="grid gap-2">
              <ResourceMeter
                label="CPU"
                percent={link.resources?.cpuUsedPercent}
                detail={`${link.resources?.cpuCount ?? '—'} cores`}
              />
              <ResourceMeter
                label="Memory"
                used={link.resources?.memoryUsedBytes}
                total={link.resources?.memoryTotalBytes}
                percent={link.resources?.memoryUsedPercent}
              />
              <DiskResourceList resources={link.resources} />
            </div>
          </DeviceInfoSection>
        </aside>
      </div>
    </div>
  );
}

export function DevicesSection() {
  const {
    links,
    loading,
    load,
    create,
    rotate,
    remove,
    discoverAgents,
    listAgentSessions,
    deleteAgentSession,
  } = useAgentLinksStore();
  const { backends, load: loadBackends } = useCustomBackendsStore();
  const [createOpen, setCreateOpen] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [tokenDialog, setTokenDialog] = useState<{
    id: string;
    token: string;
    title: string;
    installCommand: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [sessionDeviceId, setSessionDeviceId] = useState<string | null>(null);
  const [runtimeSessions, setRuntimeSessions] = useState<AgentRuntimeSession[]>(
    [],
  );
  const [sessionsLoading, setSessionsLoading] = useState(false);

  useEffect(() => {
    load();
    void loadBackends();
  }, [load, loadBackends]);

  useEffect(() => {
    if (links.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !links.some((l) => l.id === selectedId)) {
      setSelectedId(links[0]?.id ?? null);
    }
  }, [links, selectedId]);

  const handleCreate = async () => {
    const name = displayName.trim();
    if (!name) {
      toast.error('请填写显示名称');
      return;
    }
    setSubmitting(true);
    try {
      const res = await create(name);
      setCreateOpen(false);
      setDisplayName('');
      setTokenDialog({
        id: res.id,
        token: res.token,
        title: '已创建设备',
        installCommand: buildDaemonInstallCommand({
          deviceId: res.id,
          apiKey: res.token,
          server: getCurrentServerOrigin(),
        }),
      });
    } catch (err) {
      toast.error(getErrorMessage(err, '创建失败'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleRotate = async (link: AgentLink) => {
    if (
      !window.confirm(
        `确认重置 "${link.displayName}" 的接入 token？旧 token 将立即失效。`,
      )
    )
      return;
    setBusyId(link.id);
    try {
      const res = await rotate(link.id);
      setTokenDialog({
        id: res.id,
        token: res.token,
        title: `已重置 ${link.displayName} 的接入 token`,
        installCommand: buildDaemonInstallCommand({
          deviceId: res.id,
          apiKey: res.token,
          server: getCurrentServerOrigin(),
        }),
      });
    } catch (err) {
      toast.error(getErrorMessage(err, '重置失败'));
    } finally {
      setBusyId(null);
    }
  };

  const handleRemove = async (link: AgentLink) => {
    if (
      !window.confirm(
        `确认移除 "${link.displayName}"？该设备将立即断连且无法重连。`,
      )
    )
      return;
    setBusyId(link.id);
    try {
      await remove(link.id);
      if (selectedId === link.id) {
        setSelectedId(null);
      }
      toast.success('已移除');
    } catch (err) {
      toast.error(getErrorMessage(err, '移除失败'));
    } finally {
      setBusyId(null);
    }
  };

  const handleCopyUpdateCommand = async (link: AgentLink) => {
    const command = link.updateCommand || buildDaemonUpdateCommand();
    try {
      await navigator.clipboard.writeText(command);
      toast.success('已复制 daemon 更新命令');
    } catch {
      toast.error('复制失败');
    }
  };

  const handleCopyUninstallCommand = async (link: AgentLink) => {
    const command = link.uninstallCommand || buildDaemonUninstallCommand();
    try {
      await navigator.clipboard.writeText(command);
      toast.success('已复制 daemon 卸载命令');
    } catch {
      toast.error('复制失败');
    }
  };

  const handleDiscoverAgents = async (link: AgentLink) => {
    setBusyId(link.id);
    try {
      const agents = await discoverAgents(link.id);
      toast.success(`已刷新 ${agents.length} 个 agent runtime`);
    } catch (err) {
      toast.error(getErrorMessage(err, 'Agent discover 失败'));
    } finally {
      setBusyId(null);
    }
  };

  const handleRefreshSessions = async (link: AgentLink) => {
    setSessionsLoading(true);
    setSessionDeviceId(link.id);
    try {
      const sessions = await listAgentSessions(link.id);
      setRuntimeSessions(sessions);
      toast.success(`已加载 ${sessions.length} 个 provider session`);
    } catch (err) {
      toast.error(getErrorMessage(err, 'Sessions 查询失败'));
    } finally {
      setSessionsLoading(false);
    }
  };

  const handleDeleteRuntimeSession = async (
    link: AgentLink,
    session: AgentRuntimeSession,
  ) => {
    if (
      !window.confirm(
        `确认删除 ${session.agentId}/${session.workspace} 的 session ${session.id}？`,
      )
    )
      return;
    setBusyId(link.id);
    try {
      const deleted = await deleteAgentSession(
        link.id,
        session.agentId,
        session.id,
        session.workspace,
      );
      if (deleted) {
        setRuntimeSessions((prev) =>
          prev.filter(
            (s) =>
              !(
                s.id === session.id &&
                s.agentId === session.agentId &&
                s.workspace === session.workspace
              ),
          ),
        );
        toast.success('Session 已删除');
      } else {
        toast.info('Session 不存在或已被删除');
      }
    } catch (err) {
      toast.error(getErrorMessage(err, 'Session 删除失败'));
    } finally {
      setBusyId(null);
    }
  };

  const handleCopy = async () => {
    if (!tokenDialog) return;
    try {
      await navigator.clipboard.writeText(tokenDialog.installCommand);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('复制失败');
    }
  };

  const selected = links.find((l) => l.id === selectedId) ?? links[0] ?? null;
  const selectedServingAgents = selected
    ? backends.filter((backend) => backend.deviceLinkId === selected.id)
    : [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Devices</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            管理接入 OctoDeck 的本地设备。设备在线后可以承接工作区执行节点，
            让服务端 Agent 把命令与本地工具安全转发到你的机器执行。
          </p>
        </div>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="size-4" />
          新增设备
        </Button>
      </div>

      {loading && links.length === 0 ? (
        <div className="flex items-center justify-center py-6">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        </div>
      ) : links.length === 0 ? (
        <div className="text-xs text-muted-foreground border border-dashed border-border rounded-md py-6 text-center">
          还没有设备。点右上角「新增设备」创建第一个 octodeck-daemon 客户端。
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          <aside className="lg:col-span-1">
            <div className="overflow-hidden rounded-3xl border border-border bg-muted/20">
              <div className="border-b border-border px-3 py-2.5">
                <div className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  Device 列表
                </div>
              </div>
              <div className="max-h-[72vh] space-y-1 overflow-y-auto p-2">
                {links.map((l) => {
                  const active = selected?.id === l.id;
                  return (
                    <button
                      key={l.id}
                      type="button"
                      onClick={() => setSelectedId(l.id)}
                      className={`group w-full rounded-2xl border px-3 py-3 text-left transition ${
                        active
                          ? 'border-primary/35 bg-primary/10 shadow-sm'
                          : 'border-transparent hover:border-border hover:bg-background/80'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span
                              className={`size-2 rounded-full ${l.online ? 'bg-emerald-500 shadow-[0_0_0_4px_rgba(16,185,129,0.12)]' : 'bg-muted-foreground/35'}`}
                              aria-label={l.online ? 'online' : 'offline'}
                            />
                            <span className="truncate text-sm font-medium text-foreground">
                              {l.displayName}
                            </span>
                          </div>
                          <div className="mt-1 truncate text-xs text-muted-foreground">
                            {l.hostname ?? '—'} · {l.os ?? '?'} /{' '}
                            {l.arch ?? '?'}
                          </div>
                          <div className="mt-1 text-[11px] text-muted-foreground">
                            {l.online
                              ? `在线 ${formatDurationSince(l.lastConnectedAt, true)}`
                              : `心跳 ${formatTime(l.lastSeenAt)}`}
                          </div>
                        </div>
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] ${l.online ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' : 'bg-muted text-muted-foreground'}`}
                        >
                          {statusLabel(l.status, l.online)}
                        </span>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] text-muted-foreground">
                        <span className="rounded-full bg-background/80 px-2 py-0.5">
                          runs {l.runningRuns?.length ?? 0}
                        </span>
                        <span className="rounded-full bg-background/80 px-2 py-0.5">
                          runtimes {l.runtimes?.length ?? 0}
                        </span>
                        {l.updateAvailable ? (
                          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-amber-700 dark:text-amber-300">
                            可更新
                          </span>
                        ) : null}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </aside>

          <main className="lg:col-span-2">
            {selected ? (
              <DeviceDetails
                link={selected}
                servingAgents={selectedServingAgents}
                onRotate={handleRotate}
                onRemove={handleRemove}
                onCopyUpdateCommand={handleCopyUpdateCommand}
                onCopyUninstallCommand={handleCopyUninstallCommand}
                onDiscoverAgents={handleDiscoverAgents}
                onRefreshSessions={handleRefreshSessions}
                onDeleteSession={handleDeleteRuntimeSession}
                sessions={
                  sessionDeviceId === selected.id ? runtimeSessions : []
                }
                sessionsLoading={
                  sessionsLoading && sessionDeviceId === selected.id
                }
                busy={busyId === selected.id}
              />
            ) : (
              <EmptyBlock>请选择左侧设备查看详情。</EmptyBlock>
            )}
          </main>
        </div>
      )}

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建设备</DialogTitle>
            <DialogDescription>
              为你的 octodeck-daemon 客户端起一个易识别的名字（例如 "MacBook
              Pro"）。创建后会生成一次性接入 token。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="agent-link-name">显示名称</Label>
            <Input
              id="agent-link-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="MacBook Pro"
              maxLength={64}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCreateOpen(false)}
              disabled={submitting}
            >
              取消
            </Button>
            <Button onClick={handleCreate} disabled={submitting}>
              {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* One-time token dialog */}
      <Dialog
        open={!!tokenDialog}
        onOpenChange={(open) => {
          if (!open) setTokenDialog(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{tokenDialog?.title}</DialogTitle>
            <DialogDescription>
              复制下面的一键安装命令，在需要接入的机器上执行即可安装并启动
              octodeck-daemon。 接入 token 只会在本窗口展示一次。
            </DialogDescription>
          </DialogHeader>
          {tokenDialog && (
            <div className="space-y-2">
              <div className="text-xs text-muted-foreground">Device ID</div>
              <code className="block px-2 py-1.5 text-xs bg-muted rounded break-all">
                {tokenDialog.id}
              </code>
              <div className="text-xs text-muted-foreground mt-3">Token</div>
              <code className="block px-2 py-1.5 text-xs bg-muted rounded break-all">
                {tokenDialog.token}
              </code>
              <div className="text-xs text-muted-foreground mt-3">
                一键安装命令
              </div>
              <div className="flex items-start gap-2">
                <code className="flex-1 px-2 py-1.5 text-xs bg-muted rounded break-all leading-5">
                  {tokenDialog.installCommand}
                </code>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCopy}
                  aria-label="复制安装命令"
                >
                  {copied ? (
                    <Check className="size-4" />
                  ) : (
                    <Copy className="size-4" />
                  )}
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground leading-5">
                命令格式为 curl -fsSL &quot;{getCurrentServerOrigin()}
                /api/daemon/install-script?...&quot; | bash。
                请只在你信任的机器上执行。
              </p>
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setTokenDialog(null)}>我已保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export const AgentLinksSection = DevicesSection;
