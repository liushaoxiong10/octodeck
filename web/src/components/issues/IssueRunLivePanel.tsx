import { RefreshCw, Square, Bot } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatAuditValue, formatEventPayload, formatOptionalDate, formatRunDuration, isRecord, isToolAuditEventType, toolAuditFromEvent } from './shared';
import type { IssueAgentRun, IssueAgentRunEvent } from '@/stores/issues';

function eventDisplayText(event: IssueAgentRunEvent): string | null {
  const streamEvent = event.payload?.streamEvent;
  if (isRecord(streamEvent)) {
    const text = streamEvent.text || streamEvent.detail || streamEvent.summary || streamEvent.statusText || streamEvent.toolInputSummary;
    if (typeof text === 'string' && text.trim()) return text;
  }
  return event.detail || event.summary || event.title || null;
}

function isToolAuditEvent(event: IssueAgentRunEvent): boolean {
  const se = event.payload?.streamEvent;
  if (isRecord(se)) {
    const type = String(se.eventType || '');
    if (type.startsWith('tool_') || type === 'permission_denied' || type === 'permission_request') return true;
  }
  return isToolAuditEventType(event.event_type) || event.event_type.includes('permission');
}

function toolAudit(event: IssueAgentRunEvent): Record<string, unknown> | null {
  const se = event.payload?.streamEvent;
  if (isRecord(se)) return toolAuditFromEvent(se);
  return null;
}

export interface IssueRunLivePanelProps {
  run: IssueAgentRun;
  events: IssueAgentRunEvent[];
  isActive: boolean;
  onRefresh: () => void;
  onCancel: () => void;
  compact?: boolean;
}

export function IssueRunLivePanel({ run, events, isActive, onRefresh, onCancel, compact = false }: IssueRunLivePanelProps) {
  const recentEvents = events.slice(-8).reverse();
  const latestDetail = recentEvents.map(eventDisplayText).find((text): text is string => !!text?.trim());

  return (
    <div className={cn('rounded-xl border bg-card shadow-sm', compact ? 'p-3' : 'p-4', isActive && 'border-primary/40 bg-primary/5')}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold"><Bot className="h-4 w-4" />Run details</h3>
            <Badge variant="outline">{run.status}</Badge>
            {isActive && <Badge variant="outline" className="border-primary/40 text-primary animate-pulse">Live</Badge>}
          </div>
          <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{run.id}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={onRefresh}>
            <RefreshCw className={cn('mr-1 h-3 w-3', isActive && 'animate-spin')} />Refresh
          </Button>
          {isActive && (
            <Button size="sm" variant="destructive" className="h-7 px-2 text-xs" onClick={onCancel}>
              <Square className="mr-1 h-3 w-3" />Stop
            </Button>
          )}
        </div>
      </div>

      <div className={cn('grid gap-1 text-[11px] text-muted-foreground', compact ? 'mt-2' : 'mt-3')}>
        <div>Created: {formatOptionalDate(run.created_at)}</div>
        <div>Started: {formatOptionalDate(run.run_started_at)}</div>
        <div>Completed: {formatOptionalDate(run.run_completed_at)}</div>
        {isActive && <div>Elapsed: {formatRunDuration(run)}</div>}
      </div>

      {run.error && (
        <p className={cn('whitespace-pre-wrap rounded-md border border-destructive/30 bg-destructive/10 text-xs text-destructive', compact ? 'mt-2 p-2' : 'mt-3 p-2')}>
          {run.error}
        </p>
      )}
      {run.result && (
        <p className={cn('max-h-40 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 text-xs', compact ? 'mt-2 p-2' : 'mt-3 p-2')}>
          {run.result}
        </p>
      )}
      {!run.result && !run.error && latestDetail && (
        <p className={cn('max-h-32 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 text-xs', compact ? 'mt-2 p-2' : 'mt-3 p-2')}>
          {latestDetail}
        </p>
      )}

      <div className={cn('space-y-2', compact ? 'mt-2' : 'mt-3')}>
        <div className="flex items-center justify-between text-xs">
          <span className="font-medium">Recent events</span>
          <span className="text-muted-foreground">{events.length} total</span>
        </div>
        {recentEvents.length === 0 ? (
          <p className="rounded-md border border-dashed p-2 text-xs text-muted-foreground">
            No events yet. Events will appear as the agent runs.
          </p>
        ) : (
          <div className={cn('space-y-1.5 overflow-auto pr-1', compact ? 'max-h-60' : 'max-h-72')}>
            {recentEvents.map((event) => {
              const text = eventDisplayText(event);
              const audit = toolAudit(event);
              return (
                <div
                  key={event.id}
                  className={cn(
                    'rounded-md border bg-muted/20 p-2 text-[11px]',
                    isToolAuditEvent(event) && 'border-blue-200 bg-blue-50/40 dark:border-blue-900/60 dark:bg-blue-950/20',
                  )}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant="outline" className="h-4 px-1.5 text-[9px]">{event.event_type}</Badge>
                      {isToolAuditEvent(event) && <Badge variant="outline" className="h-4 px-1.5 text-[9px] border-blue-300 text-blue-700">Tool</Badge>}
                    </div>
                    <span className="text-[9px] text-muted-foreground">{formatOptionalDate(event.created_at)}</span>
                  </div>
                  {text && <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{text}</p>}
                  {audit && <IssueToolAuditPanel audit={audit} />}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export interface IssueToolAuditPanelProps {
  audit: Record<string, unknown>;
}

export function IssueToolAuditPanel({ audit }: IssueToolAuditPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const input = formatAuditValue(audit.input);
  const response = formatAuditValue(audit.response);
  const rawEvent = formatAuditValue(audit.rawEvent);
  const hasDetails = input || response || rawEvent;

  return (
    <div className="mt-1.5 rounded border border-blue-200 bg-background p-1.5 text-[10px] dark:border-blue-900/60">
      <div className="grid gap-1 md:grid-cols-3">
        <div><span className="text-muted-foreground">Tool: </span><span className="font-medium">{String(audit.toolName || 'unknown')}</span></div>
        <div><span className="text-muted-foreground">ID: </span><span className="font-mono">{String(audit.toolUseId || '—').slice(0, 8)}</span></div>
        <div><span className="text-muted-foreground">Status: </span><span>{String(audit.status || '—')}</span></div>
      </div>
      {hasDetails && !expanded && (
        <button
          type="button"
          className="mt-1 text-[10px] text-muted-foreground hover:underline"
          onClick={() => setExpanded(true)}
        >
          Show details
        </button>
      )}
      {expanded && (
        <>
          {input && (
            <details className="mt-1.5" open>
              <summary className="cursor-pointer text-[10px] font-medium hover:text-foreground">Tool input</summary>
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-1.5 text-muted-foreground">{input}</pre>
            </details>
          )}
          {response && (
            <details className="mt-1.5" open>
              <summary className="cursor-pointer text-[10px] font-medium hover:text-foreground">Tool response</summary>
              <pre className="mt-1 max-h-52 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-1.5 text-muted-foreground">{response}</pre>
            </details>
          )}
          {!input && !response && rawEvent && (
            <details className="mt-1.5">
              <summary className="cursor-pointer text-[10px] font-medium hover:text-foreground">Raw event</summary>
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-1.5 text-muted-foreground">{rawEvent}</pre>
            </details>
          )}
          <button
            type="button"
            className="mt-1.5 text-[10px] text-muted-foreground hover:underline"
            onClick={() => setExpanded(false)}
          >
            Hide details
          </button>
        </>
      )}
    </div>
  );
}

export interface RunHistoryRowProps {
  run: IssueAgentRun;
  events: IssueAgentRunEvent[];
  expanded: boolean;
  onToggle: () => void;
  onCancel: () => void;
  onRefreshEvents: () => void;
}

export function RunHistoryRow({ run, events, expanded, onToggle, onCancel, onRefreshEvents }: RunHistoryRowProps) {
  const isActive = run.status === 'queued' || run.status === 'running';
  return (
    <div className="rounded-lg border bg-card p-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <button type="button" className="min-w-0 flex-1 text-left" onClick={onToggle}>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className="h-4 px-1.5 text-[10px]">{run.status}</Badge>
            <span className="font-mono text-[10px] text-muted-foreground">{run.id.slice(0, 8)}…</span>
            {isActive && <span className="text-muted-foreground text-[10px]">{formatRunDuration(run)}</span>}
          </div>
        </button>
        {isActive && (
          <Button size="sm" variant="destructive" className="h-6 px-2 text-[10px]" onClick={onCancel}>
            <Square className="mr-1 h-3 w-3" />Stop
          </Button>
        )}
      </div>

      <div className="mt-2 grid gap-0.5 text-[10px] text-muted-foreground">
        <div>Created: {formatOptionalDate(run.created_at)}</div>
        <div>Started: {formatOptionalDate(run.run_started_at)}</div>
        <div>Completed: {formatOptionalDate(run.run_completed_at)}</div>
      </div>

      {run.error && <p className="mt-1.5 text-destructive text-[11px] whitespace-pre-wrap line-clamp-4">{run.error}</p>}
      {run.result && (
        <p className={cn('mt-1.5 whitespace-pre-wrap text-muted-foreground text-[11px]', expanded ? 'max-h-80 overflow-auto' : 'line-clamp-4')}>
          {run.result}
        </p>
      )}

      {expanded && (
        <div className="mt-3 space-y-2 border-t pt-2">
          <div className="flex items-center justify-between">
            <p className="font-medium text-[11px]">Audit timeline ({events.length})</p>
            <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px]" onClick={onRefreshEvents}>
              <RefreshCw className="mr-1 h-3 w-3" />Refresh
            </Button>
          </div>
          {events.length === 0 ? (
            <p className="text-muted-foreground text-[11px]">No audit events yet.</p>
          ) : (
            <div className="max-h-80 space-y-1.5 overflow-auto pr-1">
              {events.map((event) => {
                const payload = formatEventPayload(event);
                const audit = toolAudit(event);
                return (
                  <div
                    key={event.id}
                    className={cn(
                      'rounded border bg-muted/20 p-1.5 text-[10px]',
                      isToolAuditEvent(event) && 'border-blue-200 bg-blue-50/40 dark:border-blue-900/60 dark:bg-blue-950/20',
                    )}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-1.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge variant="outline" className="h-4 px-1.5 text-[9px]">{event.event_type}</Badge>
                        {isToolAuditEvent(event) && <Badge variant="outline" className="h-4 px-1.5 text-[9px] border-blue-300 text-blue-700">Tool</Badge>}
                      </div>
                      <span className="text-[9px] text-muted-foreground">{formatOptionalDate(event.created_at)}</span>
                    </div>
                    {event.title && <p className="mt-0.5 font-medium">{event.title}</p>}
                    {event.summary && <p className="mt-0.5 text-muted-foreground">{event.summary}</p>}
                    {audit && <IssueToolAuditPanel audit={audit} />}
                    {event.detail && (
                      <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-background p-1 text-[10px] text-muted-foreground">{String(event.detail)}</pre>
                    )}
                    {payload && (
                      <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-background p-1 text-[10px] text-muted-foreground">{payload}</pre>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
