import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  CheckCircle2,
  Bot,
  Columns3,
  Filter,
  FolderGit2,
  LayoutList,
  ListFilter,
  MessageSquare,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Sparkles,
  SlidersHorizontal,
  Upload,
  X,
} from 'lucide-react';
import { DndContext, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { useSearchParams, useNavigate } from 'react-router-dom';

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
import { Switch } from '../components/ui/switch';
import { Label } from '../components/ui/label';
import { useIssuesStore, type CreateIssueInput, type IssueAttachment, type IssuePriority, type IssueStatus, type WorkspaceIssue } from '../stores/issues';
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

type OptionEffect = {
  label: string;
  workspace: string;
  session: string;
  task: string;
  localDir: string;
};

const DEFAULT_CONTEXT_EFFECT: OptionEffect = {
  label: '默认工作区 · 稍后执行',
  workspace: '未指定时由后端落到当前用户 Home workspace，issue 与后续 run 都归属这个 workspace。',
  session: '创建 issue 不会复用现有会话；真正启动 agent 时会产生新的 issue run，并把 issue prompt 写入该 workspace 的消息流。',
  task: '不选择 agent 时只创建待办，不入队 task；选择 agent 并开启立即运行后会创建 issue run task。',
  localDir: '未选择项目时使用 workspace 自己的目录；容器模式使用 workspace folder，Host 模式使用远端设备/本机解析后的 cwd。',
};

function summarizePath(path?: string | null): string {
  if (!path) return '未绑定目录';
  return path.length > 52 ? `…${path.slice(-49)}` : path;
}

function parseAgentTarget(value?: string | null): { kind: 'none' | 'provider' | 'runtime' | 'device'; label: string } {
  if (!value) return { kind: 'none', label: 'No agent' };
  if (value.startsWith('provider:')) return { kind: 'provider', label: value.replace(/^provider:/, '') };
  if (value.startsWith('runtime:')) {
    const [, device, client] = value.split(':');
    return { kind: 'runtime', label: `${client || 'agent'} @ ${device || 'device'}` };
  }
  return { kind: 'device', label: value };
}

function buildCreationEffect(input: {
  workspaceName?: string;
  workspaceFolder?: string;
  repo?: { name: string; kind: 'git' | 'device_path'; git_url?: string; device_path?: string; device_link_id?: string } | null;
  executionNode?: string | null;
  startAgent: boolean;
}): OptionEffect {
  const agent = parseAgentTarget(input.executionNode);
  const repoText = input.repo
    ? input.repo.kind === 'device_path'
      ? `项目 ${input.repo.name} 使用设备目录 ${summarizePath(input.repo.device_path)}`
      : `项目 ${input.repo.name} 使用 Git URL${input.repo.git_url ? ` ${input.repo.git_url}` : ''}`
    : '未选择项目';
  return {
    label: `${input.workspaceName || '默认工作区'} · ${input.startAgent ? '创建后运行' : '仅创建 issue'}`,
    workspace: input.workspaceName
      ? `issue 固定写入「${input.workspaceName}」，后续 run 也会在同一个 workspace 队列中执行。`
      : DEFAULT_CONTEXT_EFFECT.workspace,
    session: input.startAgent
      ? `会新建一个 issue run；当前没有从创建页选择历史 session，后端会在 agent 返回 newSessionId 后记录到 run 上。`
      : '不会创建运行会话；稍后点击 Run 时才会新建 issue run/session。',
    task: input.startAgent
      ? `创建后立即 enqueue 一个 task，task id 形如 issue:<runId>，在目标 workspace 的队列里串行执行。`
      : '只保存 issue 记录，不创建 queue task，也不会占用 agent。',
    localDir: input.repo
      ? input.repo.kind === 'device_path'
        ? `${repoText}；运行时必须落到绑定设备，工作目录优先使用 project_device_path。`
        : `${repoText}；运行时把 repoGitUrl 注入 workspace，上下文目录仍以 workspace folder/容器目录为基准。`
      : `${repoText}；本地目录沿用 workspace folder：${summarizePath(input.workspaceFolder)}。${agent.kind === 'provider' ? ' Provider 会自动挑选同类在线 runtime。' : agent.kind === 'runtime' ? ` 固定使用 runtime ${agent.label}。` : ''}`,
  };
}

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
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { repos, load: loadRepos } = useReposStore();
  const backwardCompatIssueId = searchParams.get('issue');

  useEffect(() => {
    loadIssues();
  }, [loadIssues, query, filters, order]);

  useEffect(() => {
    loadRepos();
  }, [loadRepos]);

  // Backward compatibility: ?issue=<id> → navigate to detail page
  useEffect(() => {
    if (backwardCompatIssueId) {
      navigate('/issues/detail/' + encodeURIComponent(backwardCompatIssueId), { replace: true });
    }
  }, [backwardCompatIssueId, navigate]);

  const handleOpen = (issue: WorkspaceIssue) => {
    navigate('/issues/detail/' + encodeURIComponent(issue.id));
  };

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
          <IssuesBoard issues={issues} display={display} onOpen={handleOpen} onStatusChange={(issue, status) => updateIssue(issue.id, { status })} onRun={runIssueAgent} />
        ) : (
          <IssuesList issues={issues} display={display} onOpen={handleOpen} onStatusChange={(issue, status) => updateIssue(issue.id, { status })} onRun={runIssueAgent} />
        )}

        <CreateIssueDialog open={createOpen} onOpenChange={setCreateOpen} />
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
  const [startAgent, setStartAgent] = useState(false);
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
  const selectedWorkspace = form.workspace_jid ? groups[form.workspace_jid] : undefined;
  const selectedRepo = form.project_repo_id ? repos.find((repo) => repo.id === form.project_repo_id) : null;
  const selectedAgent = parseAgentTarget(form.execution_node);
  const contextEffect = buildCreationEffect({
    workspaceName: selectedWorkspace?.name,
    workspaceFolder: selectedWorkspace?.folder,
    repo: selectedRepo,
    executionNode: form.execution_node,
    startAgent: startAgent && !!form.execution_node,
  });
  const canSubmit = !!form.title.trim() && !submitting;

  const reset = () => {
    setForm({ title: '', description: '', status: 'todo', priority: 'medium', selected_skills: [] });
    setPendingAttachments([]);
    setStartAgent(false);
  };
  const addImages = async (files: FileList | null) => {
    const attachments = await readImageFiles(files);
    setPendingAttachments((prev) => [...attachments, ...prev]);
  };
  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    const issue = await createIssue({ ...form, create_more: createMore, start_agent: startAgent && !!form.execution_node });
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
      <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New issue</DialogTitle>
          <DialogDescription>先把工作上下文定清楚：workspace 决定队列与会话归属，project/agent 决定后续运行位置。</DialogDescription>
        </DialogHeader>
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="space-y-4">
            <div className="rounded-xl border bg-card p-4 shadow-sm">
              <div className="mb-3 flex items-center gap-2 text-sm font-semibold"><MessageSquare className="h-4 w-4" />基础信息</div>
              <div className="space-y-3">
                <div className="space-y-2"><Label>Title</Label><Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Issue title" autoFocus /></div>
                <div className="space-y-2"><Label>Description</Label><Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Describe the work, history, or follow-up needed" rows={7} /></div>
                <div className="grid gap-3 md:grid-cols-2">
                  <SelectField label="Status" value={form.status} onChange={(value) => setForm({ ...form, status: value as IssueStatus })} options={STATUSES} />
                  <SelectField label="Priority" value={form.priority} onChange={(value) => setForm({ ...form, priority: value as IssuePriority })} options={PRIORITIES} />
                </div>
              </div>
            </div>

            <div className="rounded-xl border bg-card p-4 shadow-sm">
              <div className="mb-3 flex items-center gap-2 text-sm font-semibold"><FolderGit2 className="h-4 w-4" />上下文与目录</div>
              <div className="grid gap-3 md:grid-cols-2">
                <SelectField
                  label="Workspace"
                  value={form.workspace_jid || 'default'}
                  onChange={(value) => setForm({ ...form, workspace_jid: value === 'default' ? undefined : value, workspace_folder: value === 'default' ? undefined : groups[value]?.folder })}
                  options={[{ value: 'default', label: 'Default workspace' }, ...workspaceOptions.map(([jid, group]) => ({ value: jid, label: `${group.name || jid} · ${summarizePath(group.folder)}` }))]}
                  description="决定 issue 归属、消息流、队列和默认工作目录。"
                />
                <SelectField
                  label="Project"
                  value={form.project_repo_id || 'none'}
                  onChange={(value) => setForm({ ...form, project_repo_id: value === 'none' ? null : value })}
                  options={[{ value: 'none', label: 'No project' }, ...repos.map((repo) => ({ value: repo.id, label: `${repo.name} · ${repo.kind === 'device_path' ? summarizePath(repo.device_path) : 'git'}` }))]}
                  description="Git 项目只注入 repo 信息；设备目录项目会绑定本地目录与设备。"
                />
              </div>
            </div>

            <div className="rounded-xl border bg-card p-4 shadow-sm">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-sm font-semibold"><Bot className="h-4 w-4" />Agent 执行</div>
                <div className="flex items-center gap-2 rounded-full border bg-muted/30 px-3 py-1.5 text-xs">
                  <Switch checked={startAgent} onCheckedChange={setStartAgent} size="sm" disabled={!form.execution_node} />
                  <span>{startAgent && form.execution_node ? '创建后立即运行' : '仅创建 issue'}</span>
                </div>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <SelectField
                  label="Agent"
                  value={form.execution_node || 'none'}
                  onChange={(value) => {
                    const next = value === 'none' ? null : value;
                    setForm({ ...form, execution_node: next });
                    if (!next) setStartAgent(false);
                  }}
                  options={[{ value: 'none', label: 'No agent' }, ...agentOptions]}
                  description="Provider 自动挑在线 runtime；Runtime 固定到某个设备和 agent client。"
                />
                <SelectField
                  label="Skill"
                  value={form.selected_skills?.[0] || 'none'}
                  onChange={(value) => setForm({ ...form, selected_skills: value === 'none' ? [] : [value] })}
                  options={[{ value: 'none', label: 'No skill' }, ...skills.map((skill) => ({ value: skill.id, label: skill.name || skill.id }))]}
                  description="随 issue prompt 一起传给 run，不改变 workspace 或目录。"
                />
              </div>
              {!form.execution_node && <p className="mt-3 text-xs text-muted-foreground">没有选择 Agent 时不会自动创建 run/task；后续可在 issue 详情里手动 Run。</p>}
            </div>

            {showMore && (
              <div className="grid gap-3 rounded-xl border bg-muted/30 p-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>Assignee</Label>
                  <Input value={form.assignee_user_id || ''} onChange={(e) => setForm({ ...form, assignee_user_id: e.target.value || null })} placeholder="User ID or username" />
                </div>
                <div className="space-y-2">
                  <Label>Due date</Label>
                  <Input type="date" value={form.due_date || ''} onChange={(e) => setForm({ ...form, due_date: e.target.value || null })} />
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <Button variant={showMore ? 'default' : 'outline'} size="sm" type="button" onClick={() => setShowMore(!showMore)}>More fields</Button>
              <Button variant="outline" size="sm" type="button" onClick={() => imageInputRef.current?.click()}><Upload className="mr-2 h-4 w-4" />Add image</Button>
              <input ref={imageInputRef} className="hidden" type="file" accept="image/*" multiple onChange={(event) => addImages(event.target.files)} />
              <Button variant={createMore ? 'default' : 'outline'} size="sm" type="button" onClick={() => setCreateMore(!createMore)}>Create more</Button>
            </div>
          </div>

          <div className="space-y-4">
            <div className="rounded-xl border bg-gradient-to-br from-primary/10 via-card to-card p-4 shadow-sm">
              <div className="flex items-center gap-2 text-sm font-semibold"><Sparkles className="h-4 w-4" />选项影响预览</div>
              <p className="mt-1 text-sm text-muted-foreground">{contextEffect.label}</p>
              <div className="mt-4 space-y-3">
                <EffectRow label="Workspace" value={contextEffect.workspace} />
                <EffectRow label="Session" value={contextEffect.session} />
                <EffectRow label="Task" value={contextEffect.task} />
                <EffectRow label="Local dir" value={contextEffect.localDir} />
              </div>
            </div>
            <div className="rounded-xl border bg-muted/20 p-4 text-sm">
              <div className="font-semibold">当前选择</div>
              <div className="mt-3 space-y-2 text-xs text-muted-foreground">
                <div>Workspace: {selectedWorkspace?.name || 'Default / Home'}</div>
                <div>Folder: {summarizePath(selectedWorkspace?.folder)}</div>
                <div>Project: {selectedRepo?.name || 'No project'}</div>
                <div>Agent: {selectedAgent.label}</div>
                <div>Start: {startAgent && form.execution_node ? 'yes' : 'no'}</div>
              </div>
            </div>
          </div>

          {pendingAttachments.length > 0 && (
            <div className="grid gap-2 rounded-lg border bg-muted/20 p-2 sm:grid-cols-2 lg:col-span-2">
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
          <Button onClick={submit} disabled={!canSubmit}>{submitting ? 'Creating…' : startAgent && form.execution_node ? 'Create & run' : 'Create issue'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EffectRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-background/70 p-3">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <p className="mt-1 text-sm leading-relaxed">{value}</p>
    </div>
  );
}

function SelectField({ label, value, onChange, options, description }: { label: string; value?: string; onChange: (value: string) => void; options: Array<{ value: string; label: string; disabled?: boolean }>; description?: string }) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          {options.map((option) => <SelectItem key={option.value} value={option.value} disabled={option.disabled}>{option.label}</SelectItem>)}
        </SelectContent>
      </Select>
      {description && <p className="text-xs text-muted-foreground">{description}</p>}
    </div>
  );
}
