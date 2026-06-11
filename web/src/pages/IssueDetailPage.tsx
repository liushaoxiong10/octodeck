import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  useNavigate,
  useParams,
  useSearchParams,
  Link as RouterLink,
} from 'react-router-dom';
import {
  ChevronLeft,
  Edit2,
  Trash2,
  Save,
  PlayCircle,
  History,
  RefreshCw,
  FileText,
  ArrowLeft,
  Sparkles,
  AlertTriangle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PageHeader } from '@/components/common/PageHeader';
import { showToast } from '@/utils/toast';
import { wsManager } from '@/api/ws';
import {
  useIssuesStore,
  type IssueAgentRequest,
  type IssueAgentRun,
  type IssueEvent,
  type WorkspaceIssue,
} from '@/stores/issues';
import { useAuthStore } from '@/stores/auth';
import { useUsersStore } from '@/stores/users';
import { IssueStatusBar } from '@/components/issues/IssueStatusBar';
import { IssueMarkdownViewer } from '@/components/issues/IssueMarkdownViewer';
import { IssueCommentComposer } from '@/components/issues/IssueCommentComposer';
import { IssueTimeline } from '@/components/issues/IssueTimeline';
import { IssueMetaPanel } from '@/components/issues/IssueMetaPanel';
import {
  IssueRunLivePanel,
  RunHistoryRow,
} from '@/components/issues/IssueRunLivePanel';
import { AgentRequestCard } from '@/components/issues/AgentRequestCard';
import { IssueAttachmentsGrid } from '@/components/issues/IssueAttachmentsGrid';
import {
  formatOptionalDate,
  formatRunDuration,
  priorityClass,
  priorityLabel,
  statusLabel,
} from '@/components/issues/shared';

type PendingAttachment = Omit<
  import('@/stores/issues').IssueAttachment,
  'id' | 'issue_id' | 'created_by' | 'created_at'
>;

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

function shortId(id: string): string {
  return id.startsWith('iss_') ? id.slice(4, 12) : id.slice(0, 12);
}

export function IssueDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const issueId = id ?? '';

  // --- Store selectors ---
  const currentUser = useAuthStore((s) => s.user);
  const issueById = useIssuesStore((s) => s.issueById);
  const runsByIssue = useIssuesStore((s) => s.runsByIssue);
  const runEventsByRun = useIssuesStore((s) => s.runEventsByRun);
  const attachmentsByIssue = useIssuesStore((s) => s.attachmentsByIssue);
  const eventsByIssue = useIssuesStore((s) => s.eventsByIssue);
  const commentsByIssue = useIssuesStore((s) => s.commentsByIssue);
  const requestsByIssue = useIssuesStore((s) => s.requestsByIssue);
  const loadIssueById = useIssuesStore((s) => s.loadIssueById);
  const loadIssueEvents = useIssuesStore((s) => s.loadIssueEvents);
  const loadIssueRuns = useIssuesStore((s) => s.loadIssueRuns);
  const loadIssueRunEvents = useIssuesStore((s) => s.loadIssueRunEvents);
  const loadIssueAttachments = useIssuesStore((s) => s.loadIssueAttachments);
  const loadIssueComments = useIssuesStore((s) => s.loadIssueComments);
  const loadIssueRequests = useIssuesStore((s) => s.loadIssueRequests);
  const upsertIssueRequest = useIssuesStore((s) => s.upsertIssueRequest);
  const updateIssue = useIssuesStore((s) => s.updateIssue);
  const deleteIssue = useIssuesStore((s) => s.deleteIssue);
  const runIssueAgent = useIssuesStore((s) => s.runIssueAgent);
  const cancelIssueRun = useIssuesStore((s) => s.cancelIssueRun);
  const uploadIssueAttachment = useIssuesStore((s) => s.uploadIssueAttachment);
  const deleteIssueAttachment = useIssuesStore((s) => s.deleteIssueAttachment);
  const createIssueComment = useIssuesStore((s) => s.createIssueComment);
  const updateIssueComment = useIssuesStore((s) => s.updateIssueComment);
  const deleteIssueComment = useIssuesStore((s) => s.deleteIssueComment);
  const prependIssueEvent = useIssuesStore((s) => s.prependIssueEvent);

  // --- Users ---
  const users = useUsersStore((s) => s.users);
  const fetchUsers = useUsersStore((s) => s.fetchUsers);
  const usersMap = useMemo(() => {
    const m: Record<string, { username: string; avatar_color?: string; display_name?: string }> = {};
    for (const u of users) {
      m[u.id] = { username: u.username, avatar_color: u.avatar_color || undefined, display_name: u.display_name || undefined };
    }
    return m;
  }, [users]);

  // --- Resolve data ---
  const issue: WorkspaceIssue | undefined = issueById[issueId];
  const runs: IssueAgentRun[] = runsByIssue[issueId] ?? [];
  const attachments = attachmentsByIssue[issueId] ?? [];
  const events: IssueEvent[] = eventsByIssue[issueId] ?? [];
  const comments = commentsByIssue[issueId] ?? [];
  const requests: IssueAgentRequest[] = requestsByIssue[issueId] ?? [];
  const pendingRequests = useMemo(
    () => requests.filter((r) => r.status === 'pending'),
    [requests],
  );
  const pendingClarification = useMemo(
    () => pendingRequests.find((r) => r.kind === 'clarification') ?? null,
    [pendingRequests],
  );

  // --- UI state ---
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [editingDescription, setEditingDescription] = useState(false);
  const [descriptionDraft, setDescriptionDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [mobileTab, setMobileTab] = useState<'meta' | 'runs' | 'attachments'>('meta');
  const [expandedRunId, setExpandedRunId] = useState<string | null>(() => searchParams.get('run'));
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const hasActiveRun = useMemo(
    () => runs.some((r) => r.status === 'queued' || r.status === 'running'),
    [runs],
  );
  const activeRun = useMemo(
    () => runs.find((r) => r.status === 'running' || r.status === 'queued') ?? null,
    [runs],
  );
  const selectedRun = useMemo(() => {
    if (expandedRunId) return runs.find((r) => r.id === expandedRunId) ?? null;
    return activeRun ?? runs[0] ?? null;
  }, [runs, expandedRunId, activeRun]);
  const selectedRunEvents = selectedRun ? runEventsByRun[selectedRun.id] ?? [] : [];

  // --- Initial load ---
  useEffect(() => {
    if (!issueId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const [loadedIssue] = await Promise.all([
          loadIssueById(issueId),
          loadIssueEvents(issueId),
          loadIssueRuns(issueId),
          loadIssueAttachments(issueId),
          loadIssueComments(issueId),
          loadIssueRequests(issueId),
          fetchUsers({ status: 'active' }).catch(() => {}),
        ] as const);
        if (cancelled) return;
        if (!loadedIssue) {
          setLoadError('Issue not found');
        }
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issueId]);

  // --- Load run events for the first run that has none ---
  useEffect(() => {
    if (!issue || runs.length === 0) return;
    // Auto-expand to active or first run if no explicit run param
    if (!expandedRunId) {
      const next = activeRun ?? runs[0];
      if (next) setExpandedRunId(next.id);
      return; // expandedRunId change will re-trigger this effect for loading
    }
    // Load events for the selected run
    if (selectedRun && runEventsByRun[selectedRun.id] === undefined) {
      loadIssueRunEvents(issue.id, selectedRun.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issue?.id, runs.length, expandedRunId, activeRun?.id]);

  // --- Active run polling ---
  useEffect(() => {
    if (!issue || !hasActiveRun) return;
    const timer = window.setInterval(() => {
      loadIssueRuns(issue.id);
      loadIssueEvents(issue.id);
      const runIds = runs
        .filter((run) => run.status === 'queued' || run.status === 'running' || run.id === expandedRunId)
        .map((r) => r.id);
      for (const rid of runIds) {
        loadIssueRunEvents(issue.id, rid);
      }
    }, 3000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issue?.id, hasActiveRun, runs.map((r) => r.id).join(','), expandedRunId]);

  // --- Real-time WebSocket push ---
  useEffect(() => {
    if (!issueId) return;
    const unsub = wsManager.on('issue_event', (data: any) => {
      if (data.issueId !== issueId) return;
      const evt: IssueEvent | undefined = data.event;
      if (!evt) return;
      prependIssueEvent(issueId, evt);
      // If it's a run_* event, also refresh runs
      if (evt.event_type.startsWith('run_')) {
        loadIssueRuns(issueId);
        if (evt.run_id && (evt.event_type === 'run_event' || evt.event_type === 'run_delta')) {
          loadIssueRunEvents(issueId, evt.run_id);
        }
      }
      // If comment event, refresh comments
      if (evt.event_type.startsWith('comment_')) {
        loadIssueComments(issueId);
      }
      // If agent_request_* event, refresh issue (status may have changed)
      if (evt.event_type.startsWith('agent_request_')) {
        loadIssueById(issueId);
      }
    });
    const handleRequest = (data: any) => {
      if (!data || data.issueId !== issueId) return;
      const req: IssueAgentRequest | undefined = data.request;
      if (!req) return;
      upsertIssueRequest(issueId, req);
      loadIssueById(issueId);
      loadIssueRuns(issueId);
    };
    const unsubCreated = wsManager.on('issue_request_created', handleRequest);
    const unsubAnswered = wsManager.on('issue_request_answered', handleRequest);
    const unsubExpired = wsManager.on('issue_request_expired', handleRequest);
    return () => {
      unsub && unsub();
      unsubCreated && unsubCreated();
      unsubAnswered && unsubAnswered();
      unsubExpired && unsubExpired();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issueId]);

  // --- Sync ?run= query param with expandedRunId ---
  useEffect(() => {
    const urlRun = searchParams.get('run');
    if (urlRun && urlRun !== expandedRunId) {
      setExpandedRunId(urlRun);
    }
  }, [searchParams]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleToggleRun = useCallback((runId: string) => {
    const next = expandedRunId === runId ? null : runId;
    setExpandedRunId(next);
    if (next) {
      setSearchParams((prev) => {
        prev.set('run', runId);
        return prev;
      }, { replace: true });
      if (issue && runEventsByRun[runId] === undefined) {
        loadIssueRunEvents(issue.id, runId);
      }
    } else {
      setSearchParams((prev) => {
        prev.delete('run');
        return prev;
      }, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedRunId, issue?.id, runEventsByRun, setSearchParams]);

  // --- Title edit ---
  const startEditTitle = () => {
    if (!issue) return;
    setTitleDraft(issue.title);
    setEditingTitle(true);
  };
  const saveTitle = async () => {
    if (!issue || !titleDraft.trim() || titleDraft.trim() === issue.title) {
      setEditingTitle(false);
      return;
    }
    setSaving(true);
    try {
      const r = await updateIssue(issue.id, { title: titleDraft.trim() });
      if (r) showToast('Title updated');
    } finally {
      setSaving(false);
      setEditingTitle(false);
    }
  };

  // --- Description edit ---
  const startEditDescription = () => {
    if (!issue) return;
    setDescriptionDraft(issue.description);
    setEditingDescription(true);
  };
  const saveDescription = async () => {
    if (!issue) {
      setEditingDescription(false);
      return;
    }
    setSaving(true);
    try {
      const r = await updateIssue(issue.id, { description: descriptionDraft });
      if (r) showToast('Description updated');
    } finally {
      setSaving(false);
      setEditingDescription(false);
    }
  };

  // --- Meta patch wrapper ---
  const handlePatch = async (patch: Partial<WorkspaceIssue>) => {
    if (!issue) return;
    setSaving(true);
    try {
      const r = await updateIssue(issue.id, patch);
      if (r) showToast('Updated');
    } finally {
      setSaving(false);
    }
  };

  // --- Run agent ---
  const handleRunAgent = async () => {
    if (!issue) return;
    const r = await runIssueAgent(issue.id);
    if (r) {
      showToast('Agent run started');
      setExpandedRunId(r.id);
      setSearchParams((prev) => {
        prev.set('run', r.id);
        return prev;
      }, { replace: true });
    }
  };

  // --- Delete issue ---
  const handleDelete = async () => {
    if (!issue) return;
    setDeleting(true);
    try {
      await deleteIssue(issue.id);
      showToast('Issue deleted');
      navigate('/issues', { replace: true });
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to delete issue');
    } finally {
      setDeleting(false);
    }
  };

  // --- Attachments ---
  const addAttachments = async (files: FileList | null) => {
    if (!issue || !files?.length) return;
    const pending = await readImageFiles(files);
    await Promise.all(pending.map((a) => uploadIssueAttachment(issue.id, a)));
    showToast('Attachment added');
  };

  // --- Comments ---
  const handleSubmitComment = async (body: string) => {
    if (!issue) return;
    const c = await createIssueComment(issue.id, body);
    if (!c) showToast('Failed to post comment', 'Please try again');
  };
  const handleUpdateComment = async (commentId: string, body: string) => {
    if (!issue) return;
    const c = await updateIssueComment(issue.id, commentId, body);
    if (c) showToast('Comment updated');
    else showToast('Failed to update comment', 'Please try again');
  };
  const handleDeleteComment = async (commentId: string) => {
    if (!issue) return;
    await deleteIssueComment(issue.id, commentId);
    showToast('Comment deleted');
  };

  // --- Render loading / not found ---
  if (loading && !issue) {
    return (
      <div className="h-full overflow-y-auto bg-background">
        <div className="mx-auto max-w-7xl p-6">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <RefreshCw className="h-4 w-4 animate-spin" />Loading issue…
          </div>
        </div>
      </div>
    );
  }

  if (!loading && !issue) {
    return (
      <div className="h-full overflow-y-auto bg-background">
        <div className="mx-auto max-w-3xl p-6">
          <Button variant="ghost" onClick={() => navigate(-1)} className="mb-4">
            <ArrowLeft className="mr-2 h-4 w-4" />Back
          </Button>
          <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-8 text-center">
            <AlertTriangle className="mx-auto mb-3 h-10 w-10 text-destructive" />
            <h1 className="text-lg font-semibold">Issue not found</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {loadError || 'This issue may have been deleted or the link is incorrect.'}
            </p>
            <Button className="mt-4" onClick={() => navigate('/issues')}>
              Back to issues
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (!issue) return null;

  // --- Assemble ---
  const assigneeName =
    issue.assignee_user_id && usersMap[issue.assignee_user_id]
      ? usersMap[issue.assignee_user_id].display_name || usersMap[issue.assignee_user_id].username
      : issue.assignee_user_id;

  const headerSubtitle = [
    assigneeName ? `Assignee: ${assigneeName}` : null,
    statusLabel(issue.status),
    priorityLabel(issue.priority),
    `Updated ${formatOptionalDate(issue.updated_at)}`,
  ].filter(Boolean).join(' · ');

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="mx-auto max-w-7xl p-4 md:p-6 space-y-4">
        {/* Breadcrumb + title */}
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <RouterLink to="/issues" className="inline-flex items-center gap-1 hover:text-foreground hover:underline">
            <ChevronLeft className="h-3 w-3" />Issues
          </RouterLink>
          <span>/</span>
          <span className="font-mono text-foreground">#{shortId(issue.id)}</span>
        </div>

        <PageHeader
          title={
            editingTitle ? (
              <div className="flex items-center gap-2 min-w-0">
                <Input
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onBlur={saveTitle}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveTitle();
                    if (e.key === 'Escape') { setEditingTitle(false); }
                  }}
                  className="text-base md:text-lg font-semibold h-9"
                  autoFocus
                />
                <Button size="sm" variant="ghost" className="h-8 px-2 text-xs shrink-0" onClick={saveTitle} disabled={saving}>
                  <Save className="mr-1 h-3 w-3" />Save
                </Button>
              </div>
            ) : (
              <button
                type="button"
                className="text-left group min-w-0"
                onClick={startEditTitle}
                title="Click to edit"
              >
                <span className="truncate">{issue.title}</span>
                <Edit2 className="ml-2 inline h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity align-middle" />
              </button>
            )
          }
          subtitle={headerSubtitle}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => {
                loadIssueById(issue.id);
                loadIssueEvents(issue.id);
                loadIssueRuns(issue.id);
                loadIssueComments(issue.id);
              }}>
                <RefreshCw className="mr-1 h-3.5 w-3.5" />Refresh
              </Button>
              <Button
                size="sm"
                onClick={handleRunAgent}
                disabled={hasActiveRun}
                variant={hasActiveRun ? 'outline' : 'default'}
              >
                {hasActiveRun ? (
                  <><Sparkles className="mr-1 h-3.5 w-3.5" />Running…</>
                ) : (
                  <><PlayCircle className="mr-1 h-3.5 w-3.5" />Run agent</>
                )}
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="destructive" size="sm">
                    <Trash2 className="mr-1 h-3.5 w-3.5" />Delete
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete this issue?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will permanently remove the issue, its comments, attachments, and run history. This action cannot be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={handleDelete} disabled={deleting} className="bg-destructive hover:bg-destructive/90">
                      {deleting ? 'Deleting…' : 'Delete issue'}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          }
        />

        {/* Status bar */}
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-3 shadow-sm">
          <IssueStatusBar
            current={issue.status}
            onChange={(s) => updateIssue(issue.id, { status: s }).then((r) => r && showToast('Status updated'))}
            disabled={saving}
          />
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge variant="outline" className={priorityClass(issue.priority)}>
              {priorityLabel(issue.priority)}
            </Badge>
            {issue.last_run_status && (
              <Badge variant="outline">Agent {issue.last_run_status}</Badge>
            )}
            {hasActiveRun && activeRun && (
              <Badge variant="outline" className="border-primary/40 text-primary animate-pulse">
                Running · {formatRunDuration(activeRun)}
              </Badge>
            )}
          </div>
        </div>

        {/* Main grid: desktop 2-col, mobile 1-col with tabbed sidebar */}
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_max-w-sm] xl:grid-cols-[minmax(0,2fr)_minmax(320px,380px)]">
          {/* LEFT / MAIN column */}
          <div className="space-y-4 min-w-0">
            {/* Pending agent requests (permission / clarification) */}
            {pendingRequests.length > 0 && (
              <section className="space-y-2">
                {pendingRequests.map((req) => (
                  <AgentRequestCard key={req.id} issueId={issue.id} request={req} />
                ))}
              </section>
            )}

            {/* Description section */}
            <section className="rounded-xl border bg-card p-4 shadow-sm">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="flex items-center gap-1.5 text-sm font-semibold">
                  <FileText className="h-4 w-4" />Description
                </h3>
                {!editingDescription && (
                  <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={startEditDescription}>
                    <Edit2 className="mr-1 h-3 w-3" />Edit
                  </Button>
                )}
              </div>
              {editingDescription ? (
                <div className="space-y-2">
                  <Textarea
                    value={descriptionDraft}
                    onChange={(e) => setDescriptionDraft(e.target.value)}
                    rows={10}
                    placeholder="Describe the issue, context, or acceptance criteria… (Markdown supported)"
                    className="resize-y min-h-[200px] text-sm"
                    autoFocus
                  />
                  <div className="flex items-center justify-end gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={() => setEditingDescription(false)}
                      disabled={saving}
                    >
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={saveDescription}
                      disabled={saving}
                    >
                      <Save className="mr-1 h-3 w-3" />{saving ? 'Saving…' : 'Save description'}
                    </Button>
                  </div>
                </div>
              ) : issue.description.trim() ? (
                <div onDoubleClick={startEditDescription} className="cursor-default select-text">
                  <IssueMarkdownViewer>{issue.description}</IssueMarkdownViewer>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={startEditDescription}
                  className="w-full rounded-lg border border-dashed p-4 text-left text-sm text-muted-foreground hover:bg-muted/30"
                >
                  No description yet. Click to add context, requirements, or notes.
                </button>
              )}
            </section>

            {/* Attachments */}
            <section className="rounded-xl border bg-card p-4 shadow-sm lg:hidden">
              <IssueAttachmentsGrid
                attachments={attachments}
                uploadRef={attachmentInputRef}
                addAttachments={addAttachments}
                onDelete={(id) => deleteIssueAttachment(issue.id, id)}
              />
            </section>
            <section className="rounded-xl border bg-card p-4 shadow-sm hidden lg:block">
              <IssueAttachmentsGrid
                attachments={attachments}
                uploadRef={attachmentInputRef}
                addAttachments={addAttachments}
                onDelete={(id) => deleteIssueAttachment(issue.id, id)}
              />
            </section>

            {/* Timeline */}
            <section className="rounded-xl border bg-card p-4 shadow-sm">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="flex items-center gap-1.5 text-sm font-semibold">
                  <History className="h-4 w-4" />
                  Activity
                  <Badge variant="outline" className="h-4 px-1.5 text-[10px] ml-1">
                    {events.length + comments.length}
                  </Badge>
                </h3>
              </div>
              <IssueTimeline
                events={events}
                comments={comments}
                runs={runs}
                attachments={attachments}
                usersMap={usersMap}
                onUpdateComment={handleUpdateComment}
                onDeleteComment={handleDeleteComment}
                currentUserId={currentUser?.id}
                onOpenRun={(runId) => handleToggleRun(runId)}
              />
            </section>

            {/* Comment composer */}
            <IssueCommentComposer
              onSubmit={handleSubmitComment}
              agentQuestion={
                pendingClarification
                  ? (((pendingClarification.payload as Record<string, unknown> | null)?.question as string | undefined) ??
                    pendingClarification.summary ??
                    null)
                  : null
              }
            />
          </div>

          {/* RIGHT column (desktop) or tab (mobile) */}
          <div className="space-y-4 hidden lg:block lg:sticky lg:top-4 lg:self-start">
            {selectedRun && (
              <IssueRunLivePanel
                run={selectedRun}
                events={selectedRunEvents}
                isActive={selectedRun.status === 'queued' || selectedRun.status === 'running'}
                onRefresh={() => {
                  loadIssueRuns(issue.id);
                  loadIssueRunEvents(issue.id, selectedRun.id);
                }}
                onCancel={() => cancelIssueRun(issue.id, selectedRun.id)}
              />
            )}
            <IssueMetaPanel issue={issue} onPatch={handlePatch} usersMap={usersMap} loading={saving} />

            {/* Run history */}
            <div className="rounded-xl border bg-card p-4 shadow-sm">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="flex items-center gap-1.5 text-sm font-semibold">
                  <History className="h-4 w-4" />Run history
                </h3>
                <div className="flex items-center gap-1">
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => loadIssueRuns(issue.id)}>
                    <RefreshCw className="mr-1 h-3 w-3" />Refresh
                  </Button>
                  <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={handleRunAgent} disabled={hasActiveRun}>
                    <PlayCircle className="mr-1 h-3 w-3" />New run
                  </Button>
                </div>
              </div>
              {runs.length === 0 ? (
                <p className="rounded-lg border border-dashed p-3 text-center text-xs text-muted-foreground">
                  No agent runs yet. Click "Run agent" to start.
                </p>
              ) : (
                <div className="space-y-2 max-h-[55vh] overflow-auto pr-1">
                  {runs.map((run) => (
                    <RunHistoryRow
                      key={run.id}
                      run={run}
                      events={runEventsByRun[run.id] ?? []}
                      expanded={expandedRunId === run.id}
                      onToggle={() => handleToggleRun(run.id)}
                      onCancel={() => cancelIssueRun(issue.id, run.id)}
                      onRefreshEvents={() => loadIssueRunEvents(issue.id, run.id)}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* MOBILE tabs */}
          <div className="lg:hidden">
            <Tabs value={mobileTab} onValueChange={(v) => setMobileTab(v as any)}>
              <TabsList className="w-full">
                <TabsTrigger value="meta" className="flex-1">Meta</TabsTrigger>
                <TabsTrigger value="runs" className="flex-1">Runs</TabsTrigger>
                <TabsTrigger value="attachments" className="flex-1">Files</TabsTrigger>
              </TabsList>
              <TabsContent value="meta" className="mt-3">
                {selectedRun && (
                  <div className="mb-3">
                    <IssueRunLivePanel
                      compact
                      run={selectedRun}
                      events={selectedRunEvents}
                      isActive={selectedRun.status === 'queued' || selectedRun.status === 'running'}
                      onRefresh={() => {
                        loadIssueRuns(issue.id);
                        loadIssueRunEvents(issue.id, selectedRun.id);
                      }}
                      onCancel={() => cancelIssueRun(issue.id, selectedRun.id)}
                    />
                  </div>
                )}
                <IssueMetaPanel issue={issue} onPatch={handlePatch} usersMap={usersMap} loading={saving} />
              </TabsContent>
              <TabsContent value="runs" className="mt-3">
                <div className="rounded-xl border bg-card p-3 shadow-sm">
                  <div className="mb-2 flex items-center justify-between">
                    <h3 className="text-sm font-semibold">Runs ({runs.length})</h3>
                    <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={handleRunAgent} disabled={hasActiveRun}>
                      <PlayCircle className="mr-1 h-3 w-3" />New
                    </Button>
                  </div>
                  {runs.length === 0 ? (
                    <p className="rounded-lg border border-dashed p-3 text-center text-xs text-muted-foreground">No runs yet.</p>
                  ) : (
                    <div className="space-y-2 max-h-[70vh] overflow-auto">
                      {runs.map((run) => (
                        <RunHistoryRow
                          key={run.id}
                          run={run}
                          events={runEventsByRun[run.id] ?? []}
                          expanded={expandedRunId === run.id}
                          onToggle={() => handleToggleRun(run.id)}
                          onCancel={() => cancelIssueRun(issue.id, run.id)}
                          onRefreshEvents={() => loadIssueRunEvents(issue.id, run.id)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              </TabsContent>
              <TabsContent value="attachments" className="mt-3">
                <div className="rounded-xl border bg-card p-3 shadow-sm">
                  <IssueAttachmentsGrid
                    attachments={attachments}
                    uploadRef={attachmentInputRef}
                    addAttachments={addAttachments}
                    onDelete={(id) => deleteIssueAttachment(issue.id, id)}
                  />
                </div>
              </TabsContent>
            </Tabs>
          </div>
        </div>
      </div>
    </div>
  );
}
