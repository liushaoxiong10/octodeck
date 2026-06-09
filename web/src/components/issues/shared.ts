import type { IssueAgentRun, IssuePriority, IssueStatus } from '@/stores/issues';

export const STATUSES: Array<{ value: IssueStatus; label: string }> = [
  { value: 'todo', label: 'Todo' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'review', label: 'Review' },
  { value: 'done', label: 'Done' },
  { value: 'canceled', label: 'Canceled' },
];

export const PRIORITIES: Array<{ value: IssuePriority; label: string }> = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' },
];

export function formatOptionalDate(value?: string | null): string {
  return value ? new Date(value).toLocaleString() : '—';
}

export function formatRunDuration(run: IssueAgentRun): string {
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

export function priorityClass(priority: IssuePriority) {
  if (priority === 'urgent') return 'border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300';
  if (priority === 'high') return 'border-orange-500/40 bg-orange-500/10 text-orange-700 dark:text-orange-300';
  if (priority === 'low') return 'border-slate-500/30 bg-slate-500/10 text-slate-600 dark:text-slate-300';
  return 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300';
}

export function statusLabel(status: IssueStatus) {
  return STATUSES.find((item) => item.value === status)?.label ?? status;
}

export function priorityLabel(priority: IssuePriority) {
  return PRIORITIES.find((item) => item.value === priority)?.label ?? priority;
}

export function formatEventPayload(event: { payload?: Record<string, unknown> | null }): string | null {
  if (!event.payload) return null;
  try {
    return JSON.stringify(event.payload, null, 2);
  } catch {
    return String(event.payload);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function formatAuditValue(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function nestedAuditValue(source: Record<string, unknown> | null | undefined, keys: string[]): unknown {
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

export function toolAuditFromEvent(streamEvent: Record<string, unknown>): Record<string, unknown> | null {
  const type = String(streamEvent.eventType || '');
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

export function isToolAuditEventType(eventType: string): boolean {
  return eventType.startsWith('tool_') || eventType.includes('tool_call') || eventType.includes('tool_result');
}
