import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  CheckCircle2,
  Columns3,
  Filter,
  History,
  Image,
  LayoutList,
  ListFilter,
  MoreHorizontal,
  PlayCircle,
  Plus,
  RefreshCw,
  Square,
  SlidersHorizontal,
  Upload,
  X,
} from 'lucide-react';
import { DndContext, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { useSearchParams } from 'react-router-dom';

import { PageHeader } from '../components/common/PageHeader';
import { EmptyState } from '../components/common/EmptyState';
import { SearchInput } from '../components/common/SearchInput';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
import { Label } from '../components/ui/label';
import { useIssuesStore, type CreateIssueInput, type IssueAgentRun, type IssueAgentRunEvent, type IssueAttachment, type IssuePriority, type IssueStatus, type WorkspaceIssue } from '../stores/issues';
import { useGroupsStore } from '../stores/groups';
import { useAgentLinksStore, type AgentLink } from '../stores/agentLinks';
import { useReposStore } from '../stores/repos';
import { useSkillsStore } from '../stores/skills';
import { showToast } from '../utils/toast';
import { cn } from '../lib/utils';

const STATUSES: Array<{ value: IssueStatus; label: string }> = [
  { value: 'todo', label: 'Todo' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'review', label: 'Review' },
  { value: 'done', label: 'Done' },
  { value: 'canceled', label: 'Canceled' },
];

const PRIORITIES: Array<{ value: IssuePriority; label: string }> = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' },
];

function uniqueProviderIds(devices: AgentLink[]): string[] {
  return [
    ...new Set(
      devices
        .flatMap((device) => [
          ...(device.runtimes ?? []).map((runtime) => runtime.agentClientId),
          ...device.agentClients.map((client) => client.id),
        ])
        .filter(Boolean),
    ),
  ].sort();
}

function buildAgentOptions(devices: AgentLink[]) {
  return [
    ...uniqueProviderIds(devices).map((providerId) => {
      const online = devices
        .flatMap((device) => device.runtimes ?? [])
        .filter((runtime) => runtime.agentClientId === providerId && runtime.status !== 'offline');
      return {
        value: `provider:${providerId}`,
        label: `${providerId} · Provider · Local · ${online.length ? 'Online' : 'Offline'} · ${online.length ? 'Idle' : 'Unavailable'}`,
        disabled: online.length === 0,
      };
    }),
    ...devices.flatMap((device) => {
      const runtimes = device.runtimes?.length
        ? device.runtimes
        : device.agentClients.map((client) => ({
            deviceLinkId: device.id,
            agentClientId: client.id,
            displayName: client.displayName || client.id,
            status: device.online ? 'idle' : 'offline',
          }));
      return runtimes.map((runtime) => ({
        value: `runtime:${runtime.deviceLinkId}:${runtime.agentClientId}`,
        label: `${runtime.displayName ?? runtime.agentClientId} · ${runtime.agentClientId} · Local · ${runtime.status === 'offline' ? 'Offline' : 'Online'} · ${runtime.status}`,
        disabled: runtime.status === 'offline' || runtime.status === 'draining',
      }));
    }),
  ];
}

function formatOptionalDate(value?: string | null): string {
  return value ? new Date(value).toLocaleString() : '—';
}

function formatRunDuration(run: IssueAgentRun): string {
  const start = run.run_started_at || run.created_at;
  const end = run.run_completed_at || new Date().toISOString();
  const ms = Math.max(0, new Date(end).getTime() - new Date(start).getTime());
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return `${hours}h ${rest}m`;
  }
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatEventPayload(event: IssueAgentRunEvent): string | null {
  if (!event.payload) return null;
  try {
    return JSON.stringify(event.payload, null, 2);
  } catch {
    return String(event.payload);
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

function nestedAuditValue(source: Record<string, unknown> | null | undefined, keys: string[]): unknown {
  if (!source) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  const rawEvent = source.rawEvent;
  if (isRecord(rawEvent)) {
    for (const key of keys) {
      const value = rawEvent[key];
      if (value !== undefined && value !== null && value !== '') return value;
    }
  }
  return undefined;
}

function toolAuditFromEvent(event: IssueAgentRunEvent): Record<string, unknown> | null {
  const streamEvent = event.payload?.streamEvent;
  if (!isRecord(streamEvent)) return null;
  const type = String(streamEvent.eventType || event.event_type || '');
  if (!type.startsWith('tool_') && type !== 'permission_denied') return null;
  return {
    toolName: streamEvent.toolName,
    toolUseId: streamEvent.toolUseId,
    parentToolUseId: streamEvent.parentToolUseId,
    input: streamEvent.toolInput ?? nestedAuditValue(streamEvent, ['input', 'arguments', 'params']),
    response: streamEvent.detail ?? nestedAuditValue(streamEvent, ['content', 'result', 'output', 'text', 'error']),
    status: streamEvent.statusText,
    rawEvent: streamEvent.rawEvent,
  };
}

function isToolAuditEvent(event: IssueAgentRunEvent): boolean {
  return !!toolAuditFromEvent(event) || event.event_type.includes('tool_') || event.event_type.includes('tool_call') || event.event_type.includes('tool_result');
}

function priorityClass(priority: IssuePriority) {
  if (priority === 'urgent') return 'border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300';
  if (priority === 'high') return 'border-orange-500/40 bg-orange-500/10 text-orange-700 dark:text-orange-300';
  if (priority === 'low') return 'border-slate-500/30 bg-slate-500/10 text-slate-600 dark:text-slate-300';
  return 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300';
}

function statusLabel(status: IssueStatus) {
  return STATUSES.find((item) => item.value === status)?.label ?? status;
}

function priorityLabel(priority: IssuePriority) {
  return PRIORITIES.find((item) => item.value === priority)?.label ?? priority;
}

type PendingAttachment = Omit<IssueAttachment, 'id' | 'issue_id' | 'created_by' | 'created_at'>;

function readImageFiles(files: FileList | null): Promise<PendingAttachment[]> {
  if (!files?.length) return Promise.resolve([]);
  return Promise.all(
    Array.from(files).map(
      (file) =>
        new Promise<PendingAttachment>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () =>
            resolve({
              filename: file.name,
              mime_type: file.type || 'application/octet-stream',
              size_bytes: file.size,
              data_url: String(reader.result || ''),
            });
          reader.onerror = () => reject(reader.error ?? new Error(`Failed to read ${file.name}`));
          reader.readAsDataURL(file);
        }),
    ),
  );
}

export function IssuesPage() {
  const {
    issues,
    loading,
    error,
    query,
    view,
    filters,
    order,
    display,
    setQuery,
    setView,
    loadIssues,
    updateIssue,
    runIssueAgent,
  } = useIssuesStore();
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedIssue, setSelectedIssue] = useState<WorkspaceIssue | null>(null);
  const [searchParams] = useSearchParams();
  const { repos, load: loadRepos } = useReposStore();
  const targetIssueId = searchParams.get('issue');
  const targetRunId = searchParams.get('run');

  useEffect(() => {
    loadIssues();
  }, [loadIssues, query, filters, order]);

  useEffect(() => {
    loadRepos();
  }, [loadRepos]);

  useEffect(() => {
    if (!targetIssueId || selectedIssue?.id === targetIssueId) return;
    const target = issues.find((issue) => issue.id === targetIssueId);
    if (target) setSelectedIssue(target);
  }, [issues, selectedIssue?.id, targetIssueId]);

  const activeCount = issues.length;

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="mx-auto max-w-7xl p-6 space-y-5">
        <PageHeader
          title="Issues"
          subtitle={`${activeCount}`}
          actions={
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => loadIssues()} disabled={loading}>
                <RefreshCw className={cn('mr-2 h-4 w-4', loading && 'animate-spin')} />
                Refresh
              </Button>
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="mr-2 h-4 w-4" />
                New issue
              </Button>
            </div>
          }
        />

        <div className="flex flex-col gap-3 rounded-xl border bg-card p-3 shadow-sm md:flex-row md:items-center md:justify-between">
          <div className="min-w-0 flex-1 md:max-w-md">
            <SearchInput value={query} onChange={setQuery} placeholder="Search issues" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant={view === 'board' ? 'default' : 'outline'} size="sm" onClick={() => setView('board')}>
              <Columns3 className="mr-2 h-4 w-4" /> Board view
            </Button>
            <Button variant={view === 'list' ? 'default' : 'outline'} size="sm" onClick={() => setView('list')}>
              <LayoutList className="mr-2 h-4 w-4" /> List view
            </Button>
            <FiltersMenu repos={repos} issues={issues} />
            <OrderMenu />
            <DisplayMenu />
          </div>
        </div>

        {error && <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}

        {!loading && issues.length === 0 ? (
          <EmptyState
            icon={CheckCircle2}
            title="No issues yet"
            description="Create an issue when work needs assignment, history, or follow-up."
            action={<Button onClick={() => setCreateOpen(true)}>Create issue</Button>}
          />
        ) : view === 'board' ? (
          <IssuesBoard issues={issues} display={display} onOpen={setSelectedIssue} onStatusChange={(issue, status) => updateIssue(issue.id, { status })} onRun={runIssueAgent} />
        ) : (
          <IssuesList issues={issues} display={display} onOpen={setSelectedIssue} onStatusChange={(issue, status) => updateIssue(issue.id, { status })} onRun={runIssueAgent} />
        )}

        <CreateIssueDialog open={createOpen} onOpenChange={setCreateOpen} />
        <IssueDetailDialog issue={selectedIssue} initialRunId={targetRunId} onOpenChange={(open) => !open && setSelectedIssue(null)} />
      </div>
    </div>
  );
}

function FiltersMenu({ repos, issues }: { repos: Array<{ id: string; name: string }>; issues: WorkspaceIssue[] }) {
  const { filters, setFilters } = useIssuesStore();
  const assignees = Array.from(new Set(issues.map((issue) => issue.assignee_user_id).filter((value): value is string => !!value))).sort();
  const toggleStatus = (status: IssueStatus) => {
    setFilters({ statuses: filters.statuses.includes(status) ? filters.statuses.filter((item) => item !== status) : [...filters.statuses, status] });
  };
  const togglePriority = (priority: IssuePriority) => {
    setFilters({ priorities: filters.priorities.includes(priority) ? filters.priorities.filter((item) => item !== priority) : [...filters.priorities, priority] });
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm"><Filter className="mr-2 h-4 w-4" />Filters</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Status</DropdownMenuLabel>
        {STATUSES.map((status) => (
          <DropdownMenuCheckboxItem key={status.value} checked={filters.statuses.includes(status.value)} onCheckedChange={() => toggleStatus(status.value)}>
            {status.label}
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Project</DropdownMenuLabel>
        <DropdownMenuItem onClick={() => setFilters({ project: undefined })}>All projects</DropdownMenuItem>
        {repos.map((repo) => (
          <DropdownMenuCheckboxItem key={repo.id} checked={filters.project === repo.id} onCheckedChange={() => setFilters({ project: filters.project === repo.id ? undefined : repo.id })}>
            {repo.name}
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Priority</DropdownMenuLabel>
        {PRIORITIES.map((priority) => (
          <DropdownMenuCheckboxItem key={priority.value} checked={filters.priorities.includes(priority.value)} onCheckedChange={() => togglePriority(priority.value)}>
            {priority.label}
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Assignee</DropdownMenuLabel>
        <DropdownMenuItem onClick={() => setFilters({ assignee: undefined })}>All assignees</DropdownMenuItem>
        {assignees.length === 0 ? (
          <DropdownMenuItem disabled>No assignees yet</DropdownMenuItem>
        ) : assignees.map((assignee) => (
          <DropdownMenuCheckboxItem key={assignee} checked={filters.assignee === assignee} onCheckedChange={() => setFilters({ assignee: filters.assignee === assignee ? undefined : assignee })}>
            {assignee}
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem checked={filters.showDone} onCheckedChange={(value) => setFilters({ showDone: !!value })}>
          Show all done
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function OrderMenu() {
  const { order, setOrder } = useIssuesStore();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm"><ListFilter className="mr-2 h-4 w-4" />Order</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel>Order by</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={order.field} onValueChange={(value) => setOrder({ field: value as any })}>
          <DropdownMenuRadioItem value="status">Status</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="updated">Updated</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="created">Created</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="priority">Priority</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="due_date">Due date</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Direction</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={order.direction} onValueChange={(value) => setOrder({ direction: value as 'asc' | 'desc' })}>
          <DropdownMenuRadioItem value="asc">Ascending</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="desc">Descending</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DisplayMenu() {
  const { display, setDisplay } = useIssuesStore();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm"><SlidersHorizontal className="mr-2 h-4 w-4" />Display</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuCheckboxItem checked={display.priority} onCheckedChange={(value) => setDisplay({ priority: !!value })}>Priority</DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem checked={display.assignee} onCheckedChange={(value) => setDisplay({ assignee: !!value })}>Assignee</DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem checked={display.description} onCheckedChange={(value) => setDisplay({ description: !!value })}>Description</DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem checked={display.dueDate} onCheckedChange={(value) => setDisplay({ dueDate: !!value })}>Due date</DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function IssuesBoard({ issues, display, onOpen, onStatusChange, onRun }: { issues: WorkspaceIssue[]; display: any; onOpen: (issue: WorkspaceIssue) => void; onStatusChange: (issue: WorkspaceIssue, status: IssueStatus) => void; onRun: (id: string) => Promise<unknown> }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
  const byId = useMemo(() => new Map(issues.map((issue) => [issue.id, issue])), [issues]);
  const onDragEnd = (event: DragEndEvent) => {
    const issue = byId.get(String(event.active.id));
    const nextStatus = event.over?.id as IssueStatus | undefined;
    if (issue && nextStatus && STATUSES.some((status) => status.value === nextStatus) && issue.status !== nextStatus) {
      onStatusChange(issue, nextStatus);
    }
  };
  return (
    <DndContext sensors={sensors} onDragEnd={onDragEnd}>
      <div className="grid gap-4 lg:grid-cols-5">
        {STATUSES.map((column) => {
          const columnIssues = issues.filter((issue) => issue.status === column.value);
          return (
            <IssueColumn key={column.value} status={column.value} label={column.label} count={columnIssues.length}>
              {columnIssues.map((issue) => <IssueCard key={issue.id} issue={issue} display={display} onOpen={onOpen} onStatusChange={onStatusChange} onRun={onRun} draggable />)}
            </IssueColumn>
          );
        })}
      </div>
    </DndContext>
  );
}

function IssueColumn({ status, label, count, children }: { status: IssueStatus; label: string; count: number; children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  return (
    <div ref={setNodeRef} className={cn('min-h-40 rounded-xl border bg-muted/30 p-3 transition-colors', isOver && 'border-primary bg-primary/5')}>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold">{label}</h3>
        <Badge variant="outline">{count}</Badge>
      </div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function IssuesList({ issues, display, onOpen, onStatusChange, onRun }: { issues: WorkspaceIssue[]; display: any; onOpen: (issue: WorkspaceIssue) => void; onStatusChange: (issue: WorkspaceIssue, status: IssueStatus) => void; onRun: (id: string) => Promise<unknown> }) {
  return <div className="space-y-3">{issues.map((issue) => <IssueCard key={issue.id} issue={issue} display={display} onOpen={onOpen} onStatusChange={onStatusChange} onRun={onRun} wide />)}</div>;
}

function IssueCard({ issue, display, onOpen, onStatusChange, onRun, wide, draggable }: { issue: WorkspaceIssue; display: any; onOpen: (issue: WorkspaceIssue) => void; onStatusChange: (issue: WorkspaceIssue, status: IssueStatus) => void; onRun: (id: string) => Promise<unknown>; wide?: boolean; draggable?: boolean }) {
  const drag = useDraggable({ id: issue.id, disabled: !draggable });
  const style = draggable
    ? { transform: CSS.Translate.toString(drag.transform), opacity: drag.isDragging ? 0.6 : undefined }
    : undefined;
  return (
    <div ref={drag.setNodeRef} style={style} {...(draggable ? drag.attributes : {})} {...(draggable ? drag.listeners : {})} className={cn('cursor-pointer rounded-xl border bg-card p-4 shadow-sm transition-colors hover:bg-accent/30', drag.isDragging && 'z-50 shadow-lg', wide && 'flex items-start justify-between gap-4')} onClick={() => onOpen(issue)}>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h4 className="font-medium leading-tight">{issue.title}</h4>
            <p className="mt-1 text-xs text-muted-foreground">Updated {new Date(issue.updated_at).toLocaleString()}</p>
          </div>
          <IssueActions issue={issue} onStatusChange={onStatusChange} onRun={onRun} />
        </div>
        {display.description && issue.description && <p className="line-clamp-3 text-sm text-muted-foreground">{issue.description}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{statusLabel(issue.status)}</Badge>
          {display.priority && <Badge variant="outline" className={priorityClass(issue.priority)}>{priorityLabel(issue.priority)}</Badge>}
          {display.assignee && <Badge variant="secondary">{issue.assignee_user_id || 'Unassigned'}</Badge>}
          {display.dueDate && <Badge variant="outline">Due {issue.due_date || 'No due date'}</Badge>}
          {issue.project_repo_id && <Badge variant="outline">Project {issue.project_repo_id}</Badge>}
          {issue.last_run_status && <Badge variant="outline">Agent {issue.last_run_status}</Badge>}
        </div>
      </div>
    </div>
  );
}

function IssueActions({ issue, onStatusChange, onRun }: { issue: WorkspaceIssue; onStatusChange: (issue: WorkspaceIssue, status: IssueStatus) => void; onRun: (id: string) => Promise<unknown> }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={(event) => event.stopPropagation()}><MoreHorizontal className="h-4 w-4" /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => onRun(issue.id)}>Start agent</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Status</DropdownMenuLabel>
        {STATUSES.map((status) => <DropdownMenuItem key={status.value} onClick={() => onStatusChange(issue, status.value)}>{status.label}</DropdownMenuItem>)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CreateIssueDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const createIssue = useIssuesStore((s) => s.createIssue);
  const uploadIssueAttachment = useIssuesStore((s) => s.uploadIssueAttachment);
  const { groups, loadGroups } = useGroupsStore();
  const { links, load: loadDevices } = useAgentLinksStore();
  const { repos, load: loadRepos } = useReposStore();
  const { skills, loadSkills } = useSkillsStore();
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState<CreateIssueInput>({ title: '', description: '', status: 'todo', priority: 'medium', selected_skills: [] });
  const [createMore, setCreateMore] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const imageInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    loadGroups();
    loadDevices();
    loadRepos();
    loadSkills();
  }, [open, loadGroups, loadDevices, loadRepos, loadSkills]);

  const workspaceOptions = useMemo(() => Object.entries(groups).sort(([a], [b]) => a.localeCompare(b)), [groups]);
  const agentOptions = useMemo(() => buildAgentOptions(links), [links]);
  const canSubmit = !!form.title.trim() && !submitting;

  const reset = () => {
    setForm({ title: '', description: '', status: 'todo', priority: 'medium', selected_skills: [] });
    setPendingAttachments([]);
  };
  const addImages = async (files: FileList | null) => {
    const attachments = await readImageFiles(files);
    setPendingAttachments((prev) => [...attachments, ...prev]);
  };
  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    const issue = await createIssue({ ...form, create_more: createMore, start_agent: !!form.execution_node });
    if (issue && pendingAttachments.length) {
      await Promise.all(pendingAttachments.map((attachment) => uploadIssueAttachment(issue.id, attachment)));
    }
    setSubmitting(false);
    if (issue) {
      showToast('Issue created');
      if (createMore) reset();
      else onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>New issue</DialogTitle>
          <DialogDescription>Agent will start from this issue context.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2"><Label>Title</Label><Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Issue title" autoFocus /></div>
          <div className="space-y-2"><Label>Description</Label><Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Describe the work, history, or follow-up needed" rows={5} /></div>
          <div className="grid gap-3 md:grid-cols-2">
            <SelectField label="Status" value={form.status} onChange={(value) => setForm({ ...form, status: value as IssueStatus })} options={STATUSES} />
            <SelectField label="Priority" value={form.priority} onChange={(value) => setForm({ ...form, priority: value as IssuePriority })} options={PRIORITIES} />
            <SelectField label="Agent" value={form.execution_node || 'none'} onChange={(value) => setForm({ ...form, execution_node: value === 'none' ? null : value })} options={[{ value: 'none', label: 'No agent' }, ...agentOptions]} />
            <SelectField label="Project" value={form.project_repo_id || 'none'} onChange={(value) => setForm({ ...form, project_repo_id: value === 'none' ? null : value })} options={[{ value: 'none', label: 'No project' }, ...repos.map((repo) => ({ value: repo.id, label: repo.name }))]} />
            <SelectField label="Workspace" value={form.workspace_jid || 'default'} onChange={(value) => setForm({ ...form, workspace_jid: value === 'default' ? undefined : value, workspace_folder: value === 'default' ? undefined : groups[value]?.folder })} options={[{ value: 'default', label: 'Default workspace' }, ...workspaceOptions.map(([jid, group]) => ({ value: jid, label: group.name || jid }))]} />
            <SelectField label="Skill" value={form.selected_skills?.[0] || 'none'} onChange={(value) => setForm({ ...form, selected_skills: value === 'none' ? [] : [value] })} options={[{ value: 'none', label: 'No skill' }, ...skills.map((skill) => ({ value: skill.id, label: skill.name || skill.id }))]} />
          </div>
          {showMore && (
            <div className="grid gap-3 rounded-lg border bg-muted/30 p-3 md:grid-cols-2">
              <div className="space-y-2">
                <Label>Assignee</Label>
                <Input value={form.assignee_user_id || ''} onChange={(e) => setForm({ ...form, assignee_user_id: e.target.value || null })} placeholder="User ID or username" />
              </div>
              <div className="space-y-2">
                <Label>Due date</Label>
                <Input type="date" value={form.due_date || ''} onChange={(e) => setForm({ ...form, due_date: e.target.value || null })} />
              </div>
              <p className="md:col-span-2 text-xs text-muted-foreground">
                Selecting an online Agent starts the run immediately after creation. Offline agents stay selectable for planning, but server-side execution will fail until the device is available.
              </p>
            </div>
          )}
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Button variant={showMore ? 'default' : 'outline'} size="sm" type="button" onClick={() => setShowMore(!showMore)}>More</Button>
            <Button variant="outline" size="sm" type="button" onClick={() => imageInputRef.current?.click()}><Upload className="mr-2 h-4 w-4" />Add image</Button>
            <input ref={imageInputRef} className="hidden" type="file" accept="image/*" multiple onChange={(event) => addImages(event.target.files)} />
            <Button variant={createMore ? 'default' : 'outline'} size="sm" type="button" onClick={() => setCreateMore(!createMore)}>Create more</Button>
          </div>
          {pendingAttachments.length > 0 && (
            <div className="grid gap-2 rounded-lg border bg-muted/20 p-2 sm:grid-cols-2">
              {pendingAttachments.map((attachment, index) => (
                <div key={`${attachment.filename}-${index}`} className="flex items-center gap-2 rounded border bg-background p-2 text-xs">
                  <img src={attachment.data_url} alt={attachment.filename} className="h-10 w-10 rounded object-cover" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{attachment.filename}</p>
                    <p className="text-muted-foreground">{Math.ceil(attachment.size_bytes / 1024)} KB</p>
                  </div>
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setPendingAttachments((prev) => prev.filter((_, i) => i !== index))}><X className="h-3 w-3" /></Button>
                </div>
              ))}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}><X className="mr-2 h-4 w-4" />Cancel</Button>
          <Button onClick={submit} disabled={!canSubmit}>Create issue</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function IssueDetailDialog({ issue, initialRunId, onOpenChange }: { issue: WorkspaceIssue | null; initialRunId?: string | null; onOpenChange: (open: boolean) => void }) {
  const { updateIssue, runIssueAgent, cancelIssueRun, loadIssueRuns, loadIssueRunEvents, runsByIssue, runEventsByRun, loadIssueAttachments, attachmentsByIssue, uploadIssueAttachment, deleteIssueAttachment } = useIssuesStore();
  const [draft, setDraft] = useState<Partial<WorkspaceIssue>>({});
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const runs = issue ? runsByIssue[issue.id] ?? [] : [];
  const attachments = issue ? attachmentsByIssue[issue.id] ?? [] : [];
  const hasActiveRun = runs.some((run) => run.status === 'queued' || run.status === 'running');

  useEffect(() => {
    if (!issue) return;
    setDraft(issue);
    if (initialRunId) setExpandedRunId(initialRunId);
    loadIssueRuns(issue.id);
    loadIssueAttachments(issue.id);
  }, [issue, initialRunId, loadIssueRuns, loadIssueAttachments]);

  useEffect(() => {
    if (!issue || !expandedRunId) return;
    loadIssueRunEvents(issue.id, expandedRunId);
  }, [issue, expandedRunId, loadIssueRunEvents]);

  useEffect(() => {
    if (!issue || !hasActiveRun) return;
    const timer = window.setInterval(() => {
      loadIssueRuns(issue.id);
      for (const run of runs) {
        if (run.status === 'queued' || run.status === 'running' || run.id === expandedRunId) {
          loadIssueRunEvents(issue.id, run.id);
        }
      }
    }, 3000);
    return () => window.clearInterval(timer);
  }, [issue, hasActiveRun, runs, expandedRunId, loadIssueRuns, loadIssueRunEvents]);

  if (!issue) return null;
  const save = async () => {
    const updated = await updateIssue(issue.id, {
      title: draft.title,
      description: draft.description,
      status: draft.status,
      priority: draft.priority,
      assignee_user_id: draft.assignee_user_id,
      due_date: draft.due_date,
    });
    if (updated) showToast('Issue updated');
  };
  const addAttachments = async (files: FileList | null) => {
    const pending = await readImageFiles(files);
    await Promise.all(pending.map((attachment) => uploadIssueAttachment(issue.id, attachment)));
  };

  return (
    <Dialog open={!!issue} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Issue details</DialogTitle>
          <DialogDescription>Update fields, inspect agent run history, or start a new run.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 md:grid-cols-[1fr_280px]">
          <div className="space-y-3">
            <div className="space-y-2">
              <Label>Title</Label>
              <Input value={draft.title || ''} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>Description</Label>
              <Textarea value={draft.description || ''} onChange={(event) => setDraft({ ...draft, description: event.target.value })} rows={8} />
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <SelectField label="Status" value={draft.status || issue.status} onChange={(value) => setDraft({ ...draft, status: value as IssueStatus })} options={STATUSES} />
              <SelectField label="Priority" value={draft.priority || issue.priority} onChange={(value) => setDraft({ ...draft, priority: value as IssuePriority })} options={PRIORITIES} />
              <div className="space-y-2">
                <Label>Assignee</Label>
                <Input value={draft.assignee_user_id || ''} onChange={(event) => setDraft({ ...draft, assignee_user_id: event.target.value || null })} />
              </div>
              <div className="space-y-2">
                <Label>Due date</Label>
                <Input type="date" value={draft.due_date || ''} onChange={(event) => setDraft({ ...draft, due_date: event.target.value || null })} />
              </div>
            </div>
          </div>
          <div className="space-y-3 rounded-xl border bg-muted/20 p-3">
            <div className="flex items-center justify-between">
              <h3 className="flex items-center gap-2 text-sm font-semibold"><Image className="h-4 w-4" />Attachments</h3>
              <Button size="sm" variant="outline" onClick={() => attachmentInputRef.current?.click()}><Upload className="mr-2 h-4 w-4" />Add</Button>
              <input ref={attachmentInputRef} className="hidden" type="file" accept="image/*" multiple onChange={(event) => addAttachments(event.target.files)} />
            </div>
            {attachments.length === 0 ? (
              <p className="text-sm text-muted-foreground">No attachments.</p>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {attachments.map((attachment) => (
                  <div key={attachment.id} className="group relative overflow-hidden rounded-lg border bg-background">
                    <img src={attachment.data_url} alt={attachment.filename} className="h-24 w-full object-cover" />
                    <div className="p-2 text-xs">
                      <p className="truncate font-medium">{attachment.filename}</p>
                      <p className="text-muted-foreground">{Math.ceil(attachment.size_bytes / 1024)} KB</p>
                    </div>
                    <Button variant="destructive" size="icon" className="absolute right-1 top-1 h-7 w-7 opacity-0 transition-opacity group-hover:opacity-100" onClick={() => deleteIssueAttachment(issue.id, attachment.id)}>
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
            <div className="h-px bg-border" />
            <div className="flex items-center justify-between">
              <h3 className="flex items-center gap-2 text-sm font-semibold"><History className="h-4 w-4" />Run history</h3>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="ghost" onClick={() => loadIssueRuns(issue.id)}><RefreshCw className="mr-2 h-4 w-4" />Refresh</Button>
                <Button size="sm" variant="outline" onClick={() => runIssueAgent(issue.id)}><PlayCircle className="mr-2 h-4 w-4" />Run</Button>
              </div>
            </div>
            {runs.length === 0 ? (
              <p className="text-sm text-muted-foreground">No agent runs yet.</p>
            ) : (
              <div className="space-y-2">
                {runs.map((run) => (
                  <div key={run.id} className="rounded-lg border bg-background p-2 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setExpandedRunId(expandedRunId === run.id ? null : run.id)}>
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="outline">{run.status}</Badge>
                          <span className="font-mono text-[10px] text-muted-foreground">{run.id}</span>
                          {(run.status === 'queued' || run.status === 'running') && <span className="text-muted-foreground">Elapsed {formatRunDuration(run)}</span>}
                        </div>
                      </button>
                      {(run.status === 'queued' || run.status === 'running') && (
                        <Button size="sm" variant="destructive" className="h-7 px-2 text-xs" onClick={() => cancelIssueRun(issue.id, run.id)}><Square className="mr-1 h-3 w-3" />Stop</Button>
                      )}
                    </div>
                    <div className="mt-2 grid gap-1 text-muted-foreground">
                      <div>Created: {formatOptionalDate(run.created_at)}</div>
                      <div>Started: {formatOptionalDate(run.run_started_at)}</div>
                      <div>Completed: {formatOptionalDate(run.run_completed_at)}</div>
                    </div>
                    {run.error && <p className="mt-2 text-destructive">{run.error}</p>}
                    {run.result && <p className={cn('mt-2 whitespace-pre-wrap text-muted-foreground', expandedRunId === run.id ? 'max-h-80 overflow-auto' : 'line-clamp-4')}>{run.result}</p>}
                    {!run.result && !run.error && (run.status === 'queued' || run.status === 'running') && <p className="mt-2 text-muted-foreground">Agent is still running. This panel refreshes automatically while a run is active.</p>}
                    {expandedRunId === run.id && (
                      <div className="mt-3 space-y-2 border-t pt-2">
                        <div className="flex items-center justify-between">
                          <p className="font-semibold">Audit timeline</p>
                          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => loadIssueRunEvents(issue.id, run.id)}>Refresh events</Button>
                        </div>
                        {(runEventsByRun[run.id] ?? []).length === 0 ? (
                          <p className="text-muted-foreground">No audit events yet.</p>
                        ) : (
                          <div className="max-h-80 space-y-2 overflow-auto pr-1">
                            {(runEventsByRun[run.id] ?? []).map((event) => {
                              const payload = formatEventPayload(event);
                              const toolAudit = toolAuditFromEvent(event);
                              return (
                                <div key={event.id} className={cn('rounded border bg-muted/20 p-2', isToolAuditEvent(event) && 'border-blue-200 bg-blue-50/40 dark:border-blue-900/60 dark:bg-blue-950/20')}>
                                  <div className="flex flex-wrap items-center justify-between gap-2">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <Badge variant="outline">{event.event_type}</Badge>
                                      {isToolAuditEvent(event) && <Badge variant="outline" className="border-blue-300 text-blue-700">工具审计</Badge>}
                                    </div>
                                    <span className="text-[10px] text-muted-foreground">{formatOptionalDate(event.created_at)}</span>
                                  </div>
                                  {event.title && <p className="mt-1 font-medium">{event.title}</p>}
                                  {event.summary && <p className="mt-1 text-muted-foreground">{event.summary}</p>}
                                  {toolAudit && <IssueToolAuditPanel audit={toolAudit} />}
                                  {event.detail && <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-background p-2 text-[10px] text-muted-foreground">{event.detail}</pre>}
                                  {payload && <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-background p-2 text-[10px] text-muted-foreground">{payload}</pre>}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save}>Save changes</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function IssueToolAuditPanel({ audit }: { audit: Record<string, unknown> }) {
  const input = formatAuditValue(audit.input);
  const response = formatAuditValue(audit.response);
  const rawEvent = formatAuditValue(audit.rawEvent);
  return (
    <div className="mt-2 space-y-2 rounded border border-blue-200 bg-background p-2 text-[10px] dark:border-blue-900/60">
      <div className="grid gap-2 md:grid-cols-3">
        <div><span className="text-muted-foreground">工具：</span><span className="font-medium">{String(audit.toolName || 'unknown')}</span></div>
        <div><span className="text-muted-foreground">调用 ID：</span><span className="font-mono">{String(audit.toolUseId || '—')}</span></div>
        <div><span className="text-muted-foreground">状态：</span><span>{String(audit.status || '—')}</span></div>
      </div>
      {input && <div><div className="mb-1 font-medium">工具输入</div><pre className="max-h-52 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 text-muted-foreground">{input}</pre></div>}
      {response && <div><div className="mb-1 font-medium">工具响应</div><pre className="max-h-52 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 text-muted-foreground">{response}</pre></div>}
      {!input && !response && rawEvent && <div><div className="mb-1 font-medium">原始工具事件</div><pre className="max-h-52 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 text-muted-foreground">{rawEvent}</pre></div>}
    </div>
  );
}

function SelectField({ label, value, onChange, options }: { label: string; value?: string; onChange: (value: string) => void; options: Array<{ value: string; label: string; disabled?: boolean }> }) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          {options.map((option) => <SelectItem key={option.value} value={option.value} disabled={option.disabled}>{option.label}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}
