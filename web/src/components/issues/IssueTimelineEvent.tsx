import {
  Pencil,
  Bot,
  Paperclip,
  MessageSquare,
  Edit2,
  Trash2,
  Save,
  X,
  ChevronRight,
  User,
  Cpu,
  Settings,
  Tag,
  CalendarClock,
  FolderGit2,
  AlertCircle,
  CheckCircle2,
  Zap,
  UserPlus,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { formatAuditValue, formatEventPayload, formatOptionalDate, isRecord, isToolAuditEventType, priorityClass, priorityLabel, statusLabel, toolAuditFromEvent } from './shared';
import { IssueMarkdownViewer } from './IssueMarkdownViewer';
import type { IssueComment, IssueEvent, IssueAgentRun, IssueAttachment, IssuePriority, IssueStatus } from '@/stores/issues';

export type TimelineItem =
  | { kind: 'comment'; item: IssueComment }
  | { kind: 'event'; item: IssueEvent };

export function sortTimeline(events: IssueEvent[], comments: IssueComment[]): TimelineItem[] {
  const all: TimelineItem[] = [
    ...comments.filter((c) => !c.deleted_at).map((c) => ({ kind: 'comment' as const, item: c })),
    ...events.filter((e) => e.event_type !== 'comment_created').map((e) => ({ kind: 'event' as const, item: e })),
  ];
  all.sort((a, b) => new Date(a.item.created_at).getTime() - new Date(b.item.created_at).getTime());
  return all;
}

export function getAvatarColor(color?: string | null): string {
  if (color) return color;
  return 'hsl(var(--muted))';
}

export function renderUserLabel(
  id: string | null | undefined,
  type: 'user' | 'agent' | 'system',
  usersMap?: Record<string, { username: string; avatar_color?: string; display_name?: string }>,
): { name: string; color: string; icon: ReactNode } {
  if (type === 'agent') {
    return { name: 'Agent', color: 'hsl(var(--primary) / 0.15)', icon: <Bot className="h-3 w-3" /> };
  }
  if (type === 'system') {
    return { name: 'System', color: 'hsl(var(--muted))', icon: <Settings className="h-3 w-3" /> };
  }
  if (id && usersMap?.[id]) {
    const user = usersMap[id];
    return {
      name: user.display_name || user.username,
      color: user.avatar_color || 'hsl(var(--primary) / 0.15)',
      icon: <User className="h-3 w-3" />,
    };
  }
  if (id) {
    return { name: id.slice(0, 8), color: 'hsl(var(--muted))', icon: <User className="h-3 w-3" /> };
  }
  return { name: 'Unknown', color: 'hsl(var(--muted))', icon: <User className="h-3 w-3" /> };
}

function AvatarBubble({ labelInfo }: { labelInfo: ReturnType<typeof renderUserLabel> }) {
  return (
    <div
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-foreground border border-border shadow-sm"
      style={{ backgroundColor: labelInfo.color }}
    >
      {labelInfo.icon}
    </div>
  );
}

function ToolAuditPanel({ audit }: { audit: Record<string, unknown> }) {
  const input = formatAuditValue(audit.input);
  const response = formatAuditValue(audit.response);
  const rawEvent = formatAuditValue(audit.rawEvent);
  return (
    <div className="mt-1.5 space-y-1.5 rounded border border-blue-200 bg-background p-2 text-[10px] dark:border-blue-900/60">
      <div className="grid gap-1.5 md:grid-cols-3">
        <div><span className="text-muted-foreground">Tool: </span><span className="font-medium">{String(audit.toolName || 'unknown')}</span></div>
        <div><span className="text-muted-foreground">ID: </span><span className="font-mono">{String(audit.toolUseId || '—')}</span></div>
        <div><span className="text-muted-foreground">Status: </span><span>{String(audit.status || '—')}</span></div>
      </div>
      {input && <div><div className="mb-0.5 font-medium">Input</div><pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-1.5 text-muted-foreground">{input}</pre></div>}
      {response && <div><div className="mb-0.5 font-medium">Response</div><pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-1.5 text-muted-foreground">{response}</pre></div>}
      {!input && !response && rawEvent && <div><div className="mb-0.5 font-medium">Raw event</div><pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-1.5 text-muted-foreground">{rawEvent}</pre></div>}
    </div>
  );
}

function ChangeBadges({ from, to, format, cls }: { from: unknown; to: unknown; format: (v: any) => string; cls?: (v: any) => string }) {
  const fromStr = typeof from === 'string' || typeof from === 'number' ? format(from) : '—';
  const toStr = typeof to === 'string' || typeof to === 'number' ? format(to) : '—';
  return (
    <span className="inline-flex items-center gap-1 align-middle">
      <Badge variant="outline" className={cls && from && (typeof from === 'string' || typeof from === 'number') ? cls(from as any) : ''}>{fromStr}</Badge>
      <ChevronRight className="h-3 w-3 text-muted-foreground" />
      <Badge variant="outline" className={cls && to && (typeof to === 'string' || typeof to === 'number') ? cls(to as any) : ''}>{toStr}</Badge>
    </span>
  );
}

export interface TimelineCommentProps {
  comment: IssueComment;
  usersMap?: Record<string, { username: string; avatar_color?: string; display_name?: string }>;
  onUpdateComment?: (commentId: string, body: string) => Promise<void>;
  onDeleteComment?: (commentId: string) => Promise<void>;
  currentUserId?: string;
}

export function TimelineComment({ comment, usersMap, onUpdateComment, onDeleteComment, currentUserId }: TimelineCommentProps) {
  const [editing, setEditing] = useState(false);
  const [editBody, setEditBody] = useState(comment.body);
  const [submitting, setSubmitting] = useState(false);
  const labelInfo = renderUserLabel(comment.created_by, comment.source_type, usersMap);
  const canEdit = comment.source_type === 'user' && (currentUserId === undefined || comment.created_by === currentUserId);

  const handleSave = async () => {
    if (!onUpdateComment || !canEdit) return;
    setSubmitting(true);
    try {
      await onUpdateComment(comment.id, editBody.trim());
      setEditing(false);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!onDeleteComment || !canEdit) return;
    if (!window.confirm('Delete this comment?')) return;
    await onDeleteComment(comment.id);
  };

  return (
    <div className="group relative flex gap-3 pl-1">
      <AvatarBubble labelInfo={labelInfo} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-medium">{labelInfo.name}</span>
          <Badge variant="outline" className="h-4 px-1.5 text-[10px] normal-case">{comment.source_type}</Badge>
          <span className="text-muted-foreground">{formatOptionalDate(comment.created_at)}</span>
          {comment.updated_at && new Date(comment.updated_at).getTime() !== new Date(comment.created_at).getTime() && (
            <span className="text-muted-foreground italic">(edited {formatOptionalDate(comment.updated_at)})</span>
          )}
          {canEdit && !editing && (
            <div className="ml-auto flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => { setEditBody(comment.body); setEditing(true); }}>
                <Edit2 className="h-3 w-3" />
              </Button>
              {onDeleteComment && (
                <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive hover:text-destructive" onClick={handleDelete}>
                  <Trash2 className="h-3 w-3" />
                </Button>
              )}
            </div>
          )}
        </div>
        <div className="mt-1.5 rounded-lg border bg-card p-3">
          {editing ? (
            <div className="space-y-2">
              <Textarea
                value={editBody}
                onChange={(e) => setEditBody(e.target.value)}
                rows={6}
                className="resize-y text-sm min-h-[120px]"
                autoFocus
              />
              <div className="flex items-center justify-end gap-2">
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setEditing(false)} disabled={submitting}>
                  <X className="mr-1 h-3 w-3" />Cancel
                </Button>
                <Button size="sm" className="h-7 px-2 text-xs" onClick={handleSave} disabled={submitting || !editBody.trim()}>
                  <Save className="mr-1 h-3 w-3" />{submitting ? 'Saving...' : 'Save'}
                </Button>
              </div>
            </div>
          ) : (
            <IssueMarkdownViewer>{comment.body}</IssueMarkdownViewer>
          )}
        </div>
      </div>
    </div>
  );
}

export interface TimelineEventProps {
  event: IssueEvent;
  runs: IssueAgentRun[];
  attachments: IssueAttachment[];
  usersMap?: Record<string, { username: string; avatar_color?: string; display_name?: string }>;
  onOpenRun?: (runId: string) => void;
}

export function TimelineEvent({ event, runs, attachments, usersMap, onOpenRun }: TimelineEventProps) {
  const labelInfo = renderUserLabel(event.actor_id, event.actor_type, usersMap);
  const [expanded, setExpanded] = useState(false);

  const iconForEvent = (): ReactNode => {
    const t = event.event_type;
    if (t.startsWith('run_')) return <Zap className="h-3.5 w-3.5 text-primary" />;
    if (t.startsWith('comment_')) return <MessageSquare className="h-3.5 w-3.5 text-blue-500" />;
    if (t.startsWith('attachment_')) return <Paperclip className="h-3.5 w-3.5 text-purple-500" />;
    if (t === 'status_changed') return <Tag className="h-3.5 w-3.5 text-green-500" />;
    if (t === 'priority_changed') return <AlertCircle className="h-3.5 w-3.5 text-orange-500" />;
    if (t === 'assignee_changed') return <UserPlus className="h-3.5 w-3.5 text-teal-500" />;
    if (t === 'due_date_changed') return <CalendarClock className="h-3.5 w-3.5 text-indigo-500" />;
    if (t === 'project_changed') return <FolderGit2 className="h-3.5 w-3.5 text-cyan-500" />;
    if (t === 'title_changed' || t === 'description_changed' || t === 'updated') return <Pencil className="h-3.5 w-3.5 text-slate-500" />;
    if (t === 'agent_changed' || t === 'skills_changed') return <Cpu className="h-3.5 w-3.5 text-violet-500" />;
    if (t === 'created') return <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />;
    return <Pencil className="h-3.5 w-3.5 text-slate-500" />;
  };

  const renderDetail = (): ReactNode => {
    const t = event.event_type;
    const d = event.detail ?? {};

    if (t === 'status_changed') {
      return <ChangeBadges from={d.from} to={d.to} format={(v) => statusLabel(v as IssueStatus)} />;
    }
    if (t === 'priority_changed') {
      return <ChangeBadges from={d.from} to={d.to} format={(v) => priorityLabel(v as IssuePriority)} cls={(v) => priorityClass(v as IssuePriority)} />;
    }
    if (t === 'assignee_changed') {
      const from = typeof d.from === 'string' ? d.from : '—';
      const to = typeof d.to === 'string' ? d.to : 'Unassigned';
      return (
        <span className="inline-flex items-center gap-1">
          <Badge variant="outline">{from || 'Unassigned'}</Badge>
          <ChevronRight className="h-3 w-3 text-muted-foreground" />
          <Badge variant="secondary">{to}</Badge>
        </span>
      );
    }
    if (t === 'due_date_changed') {
      return (
        <span className="text-xs">
          {formatOptionalDate((d.from as string) || null)} → {formatOptionalDate((d.to as string) || null)}
        </span>
      );
    }
    if (t === 'attachment_added' && event.reference_id) {
      const att = attachments.find((a) => a.id === event.reference_id);
      if (att) {
        return (
          <div className="inline-flex items-center gap-2 rounded border bg-background p-1.5 text-xs">
            <Paperclip className="h-3 w-3 text-purple-500" />
            <span className="font-medium truncate max-w-[200px]">{att.filename}</span>
            <span className="text-muted-foreground">{Math.ceil(att.size_bytes / 1024)} KB</span>
          </div>
        );
      }
    }
    if (t === 'attachment_removed' && event.detail?.filename) {
      return <span className="text-xs italic text-muted-foreground">Removed: {String(event.detail.filename)}</span>;
    }
    if (t.startsWith('run_') && event.run_id) {
      const run = runs.find((r) => r.id === event.run_id);
      const runLabel = (
        <button
          type="button"
          onClick={() => onOpenRun?.(event.run_id!)}
          className={cn(
            'inline-flex items-center gap-1 font-mono text-[10px]',
            onOpenRun && 'text-primary hover:underline',
          )}
        >
          <Bot className="h-3 w-3" />
          {event.run_id.slice(0, 8)}…
          {run && <Badge variant="outline" className="ml-1 h-4 px-1 text-[9px]">{run.status}</Badge>}
        </button>
      );

      if (t === 'run_event' && isRecord(event.payload?.streamEvent)) {
        const se = event.payload.streamEvent as Record<string, unknown>;
        const text = (se.text || se.detail || se.summary || se.statusText || se.toolInputSummary) as string | undefined;
        const eventType = String(se.eventType || event.event_type);
        const toolAudit = isToolAuditEventType(eventType) ? toolAuditFromEvent(se) : null;
        return (
          <div className="ml-4 space-y-1">
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              {runLabel}
              <Badge variant="outline" className={cn('h-4 px-1.5 text-[10px]', isToolAuditEventType(eventType) && 'border-blue-300 text-blue-700')}>{eventType}</Badge>
              {se.toolName != null && se.toolName !== '' && <span className="font-medium text-[10px]">· {String(se.toolName)}</span>}
            </div>
            {text?.trim() && (
              <div className="ml-4 rounded border bg-muted/20 p-1.5 text-[11px] text-muted-foreground whitespace-pre-wrap max-h-40 overflow-auto">
                {text.trim()}
              </div>
            )}
            {toolAudit && <div className="ml-4"><ToolAuditPanel audit={toolAudit} /></div>}
          </div>
        );
      }
      if (t === 'run_result' && event.summary) {
        return (
          <div className="ml-4 space-y-1">
            {runLabel}
            {expanded ? (
              <div className="mt-1 rounded border bg-muted/20 p-2 text-[11px] whitespace-pre-wrap max-h-80 overflow-auto">
                {event.summary}
                <button type="button" className="block mt-1 text-[10px] text-muted-foreground hover:underline" onClick={() => setExpanded(false)}>Collapse</button>
              </div>
            ) : (
              <button type="button" onClick={() => setExpanded(true)} className="mt-1 block text-left rounded border bg-muted/20 p-1.5 text-[11px] text-muted-foreground line-clamp-3 hover:bg-muted/30 w-full">
                {event.summary}
                <span className="block text-[10px] text-muted-foreground/70 mt-0.5">Click to expand…</span>
              </button>
            )}
          </div>
        );
      }
      const summaryForRun = event.summary || event.title || t;
      return (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          {runLabel}
          <span className="text-muted-foreground">{summaryForRun}</span>
        </div>
      );
    }

    if (event.title) return <span className="text-xs font-medium">{event.title}</span>;
    if (event.summary) return <span className="text-xs text-muted-foreground">{event.summary}</span>;
    return <span className="text-[11px] text-muted-foreground">{t}</span>;
  };

  return (
    <div className="relative flex gap-3 pl-1">
      <div className="relative flex flex-col items-center">
        <div
          className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border"
          style={{ backgroundColor: labelInfo.color }}
        >
          {iconForEvent()}
        </div>
      </div>
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-medium text-muted-foreground">{labelInfo.name}</span>
          <Badge variant="outline" className="h-4 px-1.5 text-[10px] normal-case border-dashed">
            {event.event_type.replace(/_/g, ' ')}
          </Badge>
          <span className="text-muted-foreground">{formatOptionalDate(event.created_at)}</span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
          {renderDetail()}
        </div>
        {event.detail && Object.keys(event.detail).length > 0 &&
          ['title_changed', 'description_changed', 'project_changed', 'agent_changed', 'skills_changed'].includes(event.event_type) && (
            <button
              type="button"
              className="mt-1 ml-auto block text-[10px] text-muted-foreground hover:underline"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? 'Hide details' : 'Show details'}
            </button>
          )}
        {expanded && event.detail && Object.keys(event.detail).length > 0 && (
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted/30 p-1.5 text-[10px] text-muted-foreground border border-border/50">
            {formatEventPayload({ payload: event.detail })}
          </pre>
        )}
      </div>
    </div>
  );
}
