import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, Bot, CircleDot, Clock4, GitBranch, MessageCircle, RefreshCw, Search } from 'lucide-react';

import { PageHeader } from '../components/common/PageHeader';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { api } from '../api/client';
import { cn } from '../lib/utils';

type HistoryFilterType = 'all' | 'task' | 'issue' | 'team' | 'message';
type FlowType = 'task' | 'issue' | 'team' | 'conversation';

interface HistoryStage {
  id: string;
  type: string;
  title: string;
  status?: string | null;
  at: string;
  summary?: string | null;
  detail?: string | null;
  payload?: Record<string, unknown> | null;
}

interface HistoryFlow {
  id: string;
  type: FlowType;
  title: string;
  status?: string | null;
  archivedAt?: string | null;
  actor?: string | null;
  workspace?: string | null;
  startedAt: string;
  updatedAt: string;
  summary?: string | null;
  targetUrl?: string | null;
  metrics: { stages: number; messages?: number; durationMs?: number | null };
  stages: HistoryStage[];
}

const filterOptions: Array<{ value: HistoryFilterType; label: string }> = [
  { value: 'all', label: '全部流' },
  { value: 'task', label: '任务流' },
  { value: 'issue', label: 'Issue 流' },
  { value: 'team', label: 'Team 流' },
  { value: 'message', label: '会话流' },
];

function flowIcon(type: FlowType) {
  if (type === 'task') return Clock4;
  if (type === 'issue') return CircleDot;
  if (type === 'team') return Bot;
  return MessageCircle;
}

function flowLabel(type: FlowType): string {
  if (type === 'task') return 'Task Flow';
  if (type === 'issue') return 'Issue Flow';
  if (type === 'team') return 'Team Flow';
  return 'Conversation Flow';
}

function formatDate(value?: string | null): string {
  return value ? new Date(value).toLocaleString() : '—';
}

function formatDuration(ms?: number | null): string | null {
  if (!ms || ms < 0) return null;
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function statusClass(status?: string | null): string {
  if (!status) return '';
  if (['success', 'done', 'review'].includes(status)) return 'border-emerald-300 text-emerald-700';
  if (['error', 'failed'].includes(status)) return 'border-destructive text-destructive';
  if (['running', 'queued', 'in_progress'].includes(status)) return 'border-blue-300 text-blue-700';
  return '';
}

function payloadText(payload?: Record<string, unknown> | null): string | null {
  if (!payload) return null;
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function formatAuditValue(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function toolAuditFromStage(stage: HistoryStage): Record<string, unknown> | null {
  const audit = stage.payload?.toolAudit;
  if (isRecord(audit)) return audit;
  const streamEvent = stage.payload?.streamEvent;
  if (!isRecord(streamEvent)) return null;
  const eventType = String(streamEvent.eventType || stage.type || '');
  if (!eventType.includes('tool_') && !eventType.includes('permission_denied')) return null;
  return {
    toolName: streamEvent.toolName,
    toolUseId: streamEvent.toolUseId,
    parentToolUseId: streamEvent.parentToolUseId,
    input: streamEvent.toolInput,
    response: streamEvent.detail,
    status: streamEvent.statusText,
    rawEvent: streamEvent.rawEvent,
  };
}

function isToolStage(stage: HistoryStage): boolean {
  return !!toolAuditFromStage(stage) || stage.type.includes('tool_') || stage.type.includes('tool_call') || stage.type.includes('tool_result');
}

export function HistoryPage() {
  const [flows, setFlows] = useState<HistoryFlow[]>([]);
  const [loading, setLoading] = useState(false);
  const [type, setType] = useState<HistoryFilterType>('all');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = flows.find((flow) => flow.id === selectedId) ?? flows[0] ?? null;

  const stats = useMemo(() => {
    const counts = { task: 0, issue: 0, team: 0, conversation: 0 };
    for (const flow of flows) counts[flow.type] += 1;
    return counts;
  }, [flows]);

  const load = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('type', type);
      params.set('limit', '80');
      if (query.trim()) params.set('q', query.trim());
      const data = await api.get<{ flows: HistoryFlow[] }>(`/api/history?${params.toString()}`);
      const next = data.flows ?? [];
      setFlows(next);
      setSelectedId((current) => (current && next.some((flow) => flow.id === current) ? current : next[0]?.id ?? null));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type]);

  return (
    <div className="mx-auto flex h-full max-w-7xl flex-col gap-4 p-4 md:p-6">
      <PageHeader
        title="History Flows"
        subtitle="按执行流/会话流聚合，而不是把所有事件打散成噪音列表"
        actions={<Button variant="outline" onClick={load} disabled={loading}><RefreshCw className={cn('mr-2 h-4 w-4', loading && 'animate-spin')} />刷新</Button>}
      />

      <div className="grid gap-3 md:grid-cols-4">
        <StatCard label="任务流" value={stats.task} />
        <StatCard label="Issue 流" value={stats.issue} />
        <StatCard label="Team 流" value={stats.team} />
        <StatCard label="会话流" value={stats.conversation} />
      </div>

      <div className="flex flex-col gap-2 rounded-xl border bg-card p-3 md:flex-row md:items-center">
        <Select value={type} onValueChange={(value) => setType(value as HistoryFilterType)}>
          <SelectTrigger className="md:w-44"><SelectValue /></SelectTrigger>
          <SelectContent>{filterOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
        </Select>
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') load(); }} placeholder="搜索流标题、阶段、工具调用、输出、工作区..." className="pl-9" />
        </div>
        <Button onClick={load} disabled={loading}>搜索</Button>
      </div>

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[360px_1fr]">
        <div className="min-h-0 overflow-auto rounded-xl border bg-card">
          {flows.length === 0 ? (
            <div className="flex h-64 flex-col items-center justify-center text-muted-foreground"><Activity className="mb-3 h-8 w-8" /><p>{loading ? '加载中...' : '暂无历史流'}</p></div>
          ) : (
            <div className="divide-y">
              {flows.map((flow) => <FlowListItem key={flow.id} flow={flow} active={selected?.id === flow.id} onClick={() => setSelectedId(flow.id)} />)}
            </div>
          )}
        </div>

        <div className="min-h-0 overflow-auto rounded-xl border bg-card p-4">
          {!selected ? (
            <div className="flex h-64 flex-col items-center justify-center text-muted-foreground"><GitBranch className="mb-3 h-8 w-8" /><p>选择一个流查看阶段</p></div>
          ) : (
            <FlowDetail flow={selected} />
          )}
        </div>
      </div>
    </div>
  );
}

function FlowListItem({ flow, active, onClick }: { flow: HistoryFlow; active: boolean; onClick: () => void }) {
  const Icon = flowIcon(flow.type);
  const duration = formatDuration(flow.metrics.durationMs);
  return (
    <button type="button" onClick={onClick} className={cn('w-full p-4 text-left transition-colors hover:bg-accent/40', active && 'bg-accent') }>
      <div className="flex gap-3">
        <div className="mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-muted"><Icon className="h-4 w-4" /></div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{flowLabel(flow.type)}</Badge>
            {flow.status && <Badge variant="outline" className={statusClass(flow.status)}>{flow.status}</Badge>}
            {flow.archivedAt && <Badge variant="outline" className="border-amber-300 text-amber-700">已归档</Badge>}
          </div>
          <h3 className="mt-1 line-clamp-2 font-medium">{flow.title}</h3>
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{flow.summary || '暂无摘要'}</p>
          <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
            <span>{formatDate(flow.updatedAt)}</span>
            <span>{flow.metrics.stages} steps</span>
            {flow.metrics.messages ? <span>{flow.metrics.messages} messages</span> : null}
            {duration ? <span>{duration}</span> : null}
          </div>
        </div>
      </div>
    </button>
  );
}

function FlowDetail({ flow }: { flow: HistoryFlow }) {
  const duration = formatDuration(flow.metrics.durationMs);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{flowLabel(flow.type)}</Badge>
            {flow.status && <Badge variant="outline" className={statusClass(flow.status)}>{flow.status}</Badge>}
            {flow.archivedAt && <Badge variant="outline" className="border-amber-300 text-amber-700">会话已归档</Badge>}
          </div>
          <h2 className="mt-2 text-lg font-semibold">{flow.title}</h2>
          {flow.summary && <p className="mt-1 text-sm text-muted-foreground">{flow.summary}</p>}
        </div>
        {flow.targetUrl && <Button asChild variant="outline"><Link to={flow.targetUrl}>打开来源</Link></Button>}
      </div>

      <div className="grid gap-3 text-sm md:grid-cols-4">
        <Info label="开始" value={formatDate(flow.startedAt)} />
        <Info label="更新" value={formatDate(flow.updatedAt)} />
        <Info label="阶段" value={`${flow.metrics.stages}`} />
        <Info label={flow.archivedAt ? '归档' : '耗时'} value={flow.archivedAt ? (flow.archivedAt === 'unknown' ? '来源已删除' : formatDate(flow.archivedAt)) : (duration || '—')} />
      </div>

      <div className="space-y-3">
        {flow.stages.length === 0 ? <p className="text-sm text-muted-foreground">这个流暂无阶段事件。</p> : flow.stages.map((stage, index) => <StageCard key={stage.id} stage={stage} index={index} />)}
      </div>
    </div>
  );
}

function StageCard({ stage, index }: { stage: HistoryStage; index: number }) {
  const [expanded, setExpanded] = useState(false);
  const payload = payloadText(stage.payload);
  const toolAudit = toolAuditFromStage(stage);
  return (
    <div className={cn('relative rounded-xl border bg-background p-3', isToolStage(stage) && 'border-blue-200 bg-blue-50/40 dark:border-blue-900/60 dark:bg-blue-950/20')}>
      <div className="flex gap-3">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">{index + 1}</div>
        <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setExpanded(!expanded)}>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{stage.type}</Badge>
            {isToolStage(stage) && <Badge variant="outline" className="border-blue-300 text-blue-700">工具审计</Badge>}
            {stage.status && <Badge variant="outline" className={statusClass(stage.status)}>{stage.status}</Badge>}
            <span className="text-xs text-muted-foreground">{formatDate(stage.at)}</span>
          </div>
          <h3 className="mt-1 font-medium">{stage.title}</h3>
          {stage.summary && <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{stage.summary}</p>}
        </button>
      </div>
      {expanded && (
        <div className="mt-3 space-y-2 pl-10">
          {toolAudit && <ToolAuditPanel audit={toolAudit} />}
          {stage.detail && <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-3 text-xs text-muted-foreground">{stage.detail}</pre>}
          {payload && <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-3 text-xs text-muted-foreground">{payload}</pre>}
        </div>
      )}
    </div>
  );
}

function ToolAuditPanel({ audit }: { audit: Record<string, unknown> }) {
  const input = formatAuditValue(audit.input);
  const response = formatAuditValue(audit.response);
  const rawEvent = formatAuditValue(audit.rawEvent);
  return (
    <div className="space-y-2 rounded-lg border border-blue-200 bg-background p-3 text-xs dark:border-blue-900/60">
      <div className="grid gap-2 md:grid-cols-3">
        <Info label="工具" value={String(audit.toolName || 'unknown')} />
        <Info label="调用 ID" value={String(audit.toolUseId || '—')} />
        <Info label="状态" value={String(audit.status || '—')} />
      </div>
      {input && (
        <div>
          <div className="mb-1 font-medium text-foreground">工具输入</div>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-3 text-muted-foreground">{input}</pre>
        </div>
      )}
      {response && (
        <div>
          <div className="mb-1 font-medium text-foreground">工具响应</div>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-3 text-muted-foreground">{response}</pre>
        </div>
      )}
      {!input && !response && rawEvent && (
        <div>
          <div className="mb-1 font-medium text-foreground">原始工具事件</div>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-3 text-muted-foreground">{rawEvent}</pre>
        </div>
      )}
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border bg-muted/20 p-3"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 truncate font-medium">{value}</p></div>;
}

function StatCard({ label, value }: { label: string; value: number }) {
  return <div className="rounded-xl border bg-card p-4"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 text-2xl font-semibold">{value}</p></div>;
}
