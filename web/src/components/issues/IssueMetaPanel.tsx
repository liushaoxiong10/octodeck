import { useState, useEffect, type KeyboardEvent } from 'react';
import {
  Edit2,
  Check,
  X,
  User,
  CalendarClock,
  FolderGit2,
  Bot,
  Puzzle,
  Folder,
  Clock,
  Hash,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { Link } from 'react-router-dom';
import { IssueStatusBar } from './IssueStatusBar';
import { formatOptionalDate, PRIORITIES, priorityClass, priorityLabel } from './shared';
import type { IssuePriority, WorkspaceIssue } from '@/stores/issues';

function PriorityInlineEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: IssuePriority) => void | Promise<void>;
}) {
  const [localValue, setLocalValue] = useState(value);
  return (
    <Select
      value={localValue}
      onValueChange={(v) => {
        setLocalValue(v);
        void onChange(v as IssuePriority);
      }}
    >
      <SelectTrigger className="h-8 text-xs flex-1">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {PRIORITIES.map((p) => (
          <SelectItem key={p.value} value={p.value}>
            <Badge variant="outline" className={priorityClass(p.value)}>{p.label}</Badge>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export interface IssueMetaPanelProps {
  issue: WorkspaceIssue;
  onPatch: (patch: Partial<WorkspaceIssue>) => Promise<void>;
  usersMap?: Record<string, { username: string; avatar_color?: string; display_name?: string }>;
  loading?: boolean;
}

function InlineEditField({
  label,
  icon: Icon,
  value,
  displayValue,
  onSave,
  type = 'text',
  placeholder,
  disabled,
  children,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  value: string;
  displayValue?: React.ReactNode;
  onSave: (next: string) => Promise<void> | void;
  type?: string;
  placeholder?: string;
  disabled?: boolean;
  children?: React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  const commit = async () => {
    if (draft === value) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await onSave(draft);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const cancel = () => {
    setDraft(value);
    setEditing(false);
  };

  const handleKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') commit();
    else if (e.key === 'Escape') cancel();
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        <span>{label}</span>
      </div>
      {editing ? (
        <div className="flex items-center gap-1">
          {children ?? (
            <Input
              type={type}
              value={draft}
              placeholder={placeholder}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKey}
              onBlur={commit}
              autoFocus
              className="h-8 text-xs"
              disabled={saving || disabled}
            />
          )}
          <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => void commit()} disabled={saving}>
            <Check className="h-3 w-3 text-green-600" />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={cancel} disabled={saving}>
            <X className="h-3 w-3" />
          </Button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => !disabled && setEditing(true)}
          className={cn(
            'w-full rounded-md px-2 py-1 text-left text-sm transition-colors',
            disabled ? 'cursor-default opacity-80' : 'hover:bg-muted/50 group',
          )}
          disabled={disabled}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate">{displayValue ?? (value || <span className="text-muted-foreground italic">Not set</span>)}</span>
            {!disabled && (
              <Edit2 className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
            )}
          </div>
        </button>
      )}
    </div>
  );
}

export function IssueMetaPanel({ issue, onPatch, usersMap, loading }: IssueMetaPanelProps) {
  return (
    <div className="space-y-4 rounded-xl border bg-card p-4 shadow-sm">
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Status</h3>
        </div>
        <IssueStatusBar
          current={issue.status}
          onChange={(s) => onPatch({ status: s })}
          disabled={loading}
        />
      </div>

      <div className="h-px bg-border" />

      <InlineEditField
        label="Priority"
        icon={BadgePriorityIcon}
        value={issue.priority}
        displayValue={<Badge variant="outline" className={priorityClass(issue.priority)}>{priorityLabel(issue.priority)}</Badge>}
        onSave={(v) => onPatch({ priority: v as IssuePriority })}
        disabled={loading}
      >
        <PriorityInlineEditor
          value={issue.priority}
          onChange={(v) => onPatch({ priority: v as IssuePriority })}
        />
      </InlineEditField>

      <InlineEditField
        label="Assignee"
        icon={User}
        value={issue.assignee_user_id || ''}
        displayValue={
          issue.assignee_user_id
            ? usersMap?.[issue.assignee_user_id]
              ? <Badge variant="secondary">{usersMap[issue.assignee_user_id].display_name || usersMap[issue.assignee_user_id].username}</Badge>
              : <Badge variant="outline">{issue.assignee_user_id.slice(0, 10)}</Badge>
            : undefined
        }
        onSave={(v) => onPatch({ assignee_user_id: v || null })}
        placeholder="User ID or username"
        disabled={loading}
      />

      <InlineEditField
        label="Due date"
        icon={CalendarClock}
        value={issue.due_date || ''}
        displayValue={issue.due_date ? formatOptionalDate(issue.due_date) : undefined}
        onSave={(v) => onPatch({ due_date: v || null })}
        type="date"
        disabled={loading}
      />

      <div className="h-px bg-border" />

      <div className="space-y-3">
        <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <Folder className="h-3.5 w-3.5" />
          <span>Context</span>
        </div>

        <div className="space-y-1 rounded-md bg-muted/30 p-2 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">Workspace</span>
            <Link
              to={`/chat/${issue.workspace_folder}`}
              className="text-foreground hover:text-primary truncate font-medium"
              title={issue.workspace_jid}
            >
              {issue.workspace_folder || issue.workspace_jid.slice(0, 16)}
            </Link>
          </div>
          {issue.project_repo_id && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground flex items-center gap-1"><FolderGit2 className="h-3 w-3" />Project</span>
              <span className="truncate font-medium" title={issue.project_repo_id}>{issue.project_repo_id.slice(0, 16)}</span>
            </div>
          )}
          {issue.agent_link_id && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground flex items-center gap-1"><Bot className="h-3 w-3" />Agent link</span>
              <span className="truncate font-mono" title={issue.agent_link_id}>{issue.agent_link_id.slice(0, 10)}…</span>
            </div>
          )}
          {issue.execution_node && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground flex items-center gap-1"><CpuIcon className="h-3 w-3" />Execution</span>
              <span className="truncate font-mono" title={issue.execution_node}>{issue.execution_node.slice(0, 14)}…</span>
            </div>
          )}
          {issue.selected_skills && issue.selected_skills.length > 0 && (
            <div className="flex items-start justify-between gap-2">
              <span className="text-muted-foreground flex items-center gap-1 shrink-0"><Puzzle className="h-3 w-3" />Skills</span>
              <div className="flex flex-wrap gap-1 justify-end">
                {issue.selected_skills.map((s) => (
                  <Badge key={s} variant="outline" className="text-[10px] h-4 px-1.5">{s}</Badge>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="h-px bg-border" />

      <div className="space-y-2 text-xs">
        <div className="flex items-center gap-1.5 font-medium uppercase tracking-wide text-muted-foreground">
          <Clock className="h-3.5 w-3.5" />
          <span>Timestamps</span>
        </div>
        <div className="grid gap-1 rounded-md bg-muted/30 p-2">
          <div className="flex justify-between gap-2">
            <span className="text-muted-foreground">ID</span>
            <span className="font-mono flex items-center gap-1"><Hash className="h-3 w-3" />{issue.id.slice(0, 12)}</span>
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-muted-foreground">Created</span>
            <span>{formatOptionalDate(issue.created_at)}</span>
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-muted-foreground">Updated</span>
            <span>{formatOptionalDate(issue.updated_at)}</span>
          </div>
          {issue.closed_at && (
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground">Closed</span>
              <span>{formatOptionalDate(issue.closed_at)}</span>
            </div>
          )}
          {issue.last_run_at && (
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground">Last run</span>
              <span>{formatOptionalDate(issue.last_run_at)}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// --- inline helper icon components ---
function BadgePriorityIcon({ className }: { className?: string }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}><path d="M12 20l-6-4V8l6-4 6 4v8l-6 4z"/></svg>;
}

function CpuIcon({ className }: { className?: string }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/></svg>;
}
