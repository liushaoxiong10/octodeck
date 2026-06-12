import { useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Wrench } from 'lucide-react';

/**
 * ToolActivityCard — structured mini-card for active tool calls.
 * Replaces the tiny pill rendering in StreamingDisplay for better readability.
 */

interface ToolInfo {
  toolName: string;
  toolUseId: string;
  startTime: number;
  elapsedSeconds?: number;
  parentToolUseId?: string | null;
  isNested?: boolean;
  skillName?: string;
  toolInputSummary?: string;
  toolInput?: Record<string, unknown>;
}

export interface ToolFlowEvent {
  id: string;
  title: string;
  summary?: string | null;
  detail?: string | null;
  timestamp?: number | string | null;
  status?: string | null;
  kind?: string | null;
  toolName?: string | null;
  skillName?: string | null;
  toolUseId?: string | null;
  elapsedSeconds?: number | null;
  toolInputSummary?: string | null;
  toolInput?: Record<string, unknown> | null;
}

interface ToolActivityCardProps {
  tool: ToolInfo;
  localElapsed?: number;
}

/** Extract the most relevant param from toolInputSummary for structured display. */
function parseToolParam(
  toolName: string,
  summary?: string,
): { label: string; value: string } | null {
  if (!summary) return null;

  switch (toolName) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'Glob':
      return { label: 'path', value: summary };
    case 'Bash':
      return { label: 'cmd', value: summary };
    case 'Grep':
      return { label: 'pattern', value: summary };
    case 'Agent':
      return { label: 'task', value: summary };
    default:
      return summary.length > 0 ? { label: 'input', value: summary } : null;
  }
}

function formatToolInput(input?: Record<string, unknown>): string | null {
  if (!input || Object.keys(input).length === 0) return null;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

function formatToolFlowTime(timestamp?: number | string | null): string | null {
  if (!timestamp) return null;
  const date = typeof timestamp === 'number' ? new Date(timestamp) : new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function summarizeText(text?: string | null, max = 140): string | null {
  const normalized = text?.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

function toolDisplayName(item: ToolFlowEvent | ToolInfo): string {
  if (item.toolName === 'Skill') return item.skillName || 'unknown';
  return item.toolName || ('title' in item ? item.title : 'unknown');
}

function statusLabel(status?: string | null): string {
  switch (status) {
    case 'tool_call':
      return '开始';
    case 'tool_progress':
      return '进行中';
    case 'tool_result':
      return '完成';
    case 'running':
      return '运行中';
    default:
      return status || '';
  }
}

interface ToolFlowCardProps {
  events?: ToolFlowEvent[];
  activeTools?: ToolInfo[];
  localElapsed?: Record<string, number>;
  title?: string;
  defaultExpanded?: boolean;
  className?: string;
}

type ToolFlowItem = ToolFlowEvent & {
  isActive?: boolean;
  order?: number;
};

/**
 * Collapsible tool-call flow card.
 * The outer card behaves like the reasoning block: one compact row by default,
 * expanding to a timeline where each tool row can reveal its raw details.
 */
export function ToolFlowCard({
  events = [],
  activeTools = [],
  localElapsed = {},
  title = '工具调用流',
  defaultExpanded = false,
  className = '',
}: ToolFlowCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [expandedItems, setExpandedItems] = useState<Set<string>>(() => new Set());

  const items = useMemo(() => {
    const activeById = new Map(activeTools.map((tool) => [tool.toolUseId, tool]));
    const usedActiveIds = new Set<string>();
    const fromEvents: ToolFlowItem[] = events.map((event, index) => {
      const active = event.toolUseId ? activeById.get(event.toolUseId) : undefined;
      if (active?.toolUseId) usedActiveIds.add(active.toolUseId);
      return {
        ...event,
        id: event.id || event.toolUseId || `event-${index}`,
        title: event.title || toolDisplayName(active || event),
        toolName: active?.toolName || event.toolName,
        skillName: active?.skillName || event.skillName,
        toolInputSummary: active?.toolInputSummary || event.toolInputSummary,
        toolInput: active?.toolInput || event.toolInput,
        elapsedSeconds: active?.elapsedSeconds ?? event.elapsedSeconds ?? (active ? localElapsed[active.toolUseId] : undefined),
        status: active ? 'running' : event.status,
        isActive: !!active,
        order: typeof event.timestamp === 'number' ? event.timestamp : index,
      };
    });
    const fromActive: ToolFlowItem[] = activeTools
      .filter((tool) => !usedActiveIds.has(tool.toolUseId))
      .map((tool, index) => ({
        id: tool.toolUseId || `active-${index}`,
        title: toolDisplayName(tool),
        summary: tool.toolInputSummary,
        timestamp: tool.startTime,
        status: 'running',
        kind: tool.toolName === 'Skill' ? 'skill' : 'tool',
        toolName: tool.toolName,
        skillName: tool.skillName,
        toolUseId: tool.toolUseId,
        elapsedSeconds: tool.elapsedSeconds ?? localElapsed[tool.toolUseId],
        toolInputSummary: tool.toolInputSummary,
        toolInput: tool.toolInput,
        isActive: true,
        order: tool.startTime,
      }));
    return [...fromEvents, ...fromActive].sort((a, b) => (a.order || 0) - (b.order || 0));
  }, [activeTools, events, localElapsed]);

  if (items.length === 0) return null;

  const activeCount = items.filter((item) => item.isActive).length;
  const latest = items[items.length - 1];
  const latestSummary = summarizeText(latest.summary || latest.toolInputSummary || latest.detail);

  const toggleItem = (id: string) => {
    setExpandedItems((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className={`mb-3 rounded-xl border border-blue-200/70 bg-blue-50/45 dark:border-blue-900/60 dark:bg-blue-950/25 overflow-hidden ${className}`}>
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-blue-50/70 dark:hover:bg-blue-900/30 transition-colors"
        aria-expanded={expanded}
      >
        <Wrench className="w-4 h-4 text-blue-500 flex-shrink-0" />
        <span className="text-xs font-medium text-blue-700 dark:text-blue-300">{title}</span>
        <span className="text-[11px] text-blue-700/70 dark:text-blue-300/70">
          {items.length} 条{activeCount ? ` · ${activeCount} 个运行中` : ''}
        </span>
        {latestSummary && (
          <span className="min-w-0 flex-1 truncate text-[11px] text-blue-950/60 dark:text-blue-100/60">
            {latestSummary}
          </span>
        )}
        {!latestSummary && <span className="flex-1" />}
        {expanded ? (
          <ChevronUp className="w-3.5 h-3.5 text-blue-400" />
        ) : (
          <ChevronDown className="w-3.5 h-3.5 text-blue-400" />
        )}
      </button>

      {expanded && (
        <div className="border-t border-blue-200/70 dark:border-blue-900/60 px-3 py-2 space-y-1.5 max-h-96 overflow-y-auto">
          {items.map((item, index) => {
            const itemExpanded = expandedItems.has(item.id);
            const inputText = formatToolInput(item.toolInput || undefined);
            const param = parseToolParam(item.toolName || '', item.toolInputSummary || item.summary || undefined);
            const hasDetails = Boolean(inputText || item.detail || param || item.toolUseId);
            const itemStatus = statusLabel(item.status);
            const time = formatToolFlowTime(item.timestamp);
            const summary = summarizeText(item.summary || item.toolInputSummary || item.detail, 180);
            return (
              <div key={item.id} className="rounded-lg border border-blue-200/60 bg-background/65 dark:border-blue-900/50 dark:bg-background/40 overflow-hidden">
                <button
                  type="button"
                  onClick={() => hasDetails && toggleItem(item.id)}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-blue-50/60 dark:hover:bg-blue-950/35 transition-colors"
                  aria-expanded={itemExpanded}
                >
                  <span className={`h-1.5 w-1.5 rounded-full flex-shrink-0 ${item.isActive ? 'bg-blue-500 animate-pulse' : item.status === 'tool_result' ? 'bg-emerald-500' : 'bg-blue-300'}`} />
                  <span className="text-[11px] tabular-nums text-muted-foreground">#{index + 1}</span>
                  <span className="text-[13px] font-medium text-foreground truncate">{item.title}</span>
                  {itemStatus && <span className="text-[11px] text-blue-700/70 dark:text-blue-300/70 shrink-0">{itemStatus}</span>}
                  {item.elapsedSeconds != null && (
                    <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">{Math.round(item.elapsedSeconds)}s</span>
                  )}
                  {summary && <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">{summary}</span>}
                  {!summary && <span className="flex-1" />}
                  {time && <span className="text-[11px] text-muted-foreground shrink-0">{time}</span>}
                  {hasDetails && (itemExpanded ? <ChevronUp className="h-3 w-3 text-blue-400" /> : <ChevronDown className="h-3 w-3 text-blue-400" />)}
                </button>
                {itemExpanded && hasDetails && (
                  <div className="border-t border-blue-100 dark:border-blue-900/50 px-2.5 py-2 space-y-2 text-[12px]">
                    {item.toolUseId && (
                      <div className="text-muted-foreground break-all">
                        <span className="text-muted-foreground/60">toolUseId: </span>{item.toolUseId}
                      </div>
                    )}
                    {param && (
                      <div className={`${item.toolName === 'Bash' ? 'font-mono' : ''} text-foreground/80 break-words`}>
                        <span className="text-muted-foreground/60">{param.label}: </span>{param.value}
                      </div>
                    )}
                    {inputText && (
                      <pre className="max-h-56 overflow-auto rounded-md border border-border/60 bg-muted/30 px-2 py-1.5 text-[12px] leading-relaxed text-foreground/80 whitespace-pre-wrap break-words">
                        {inputText}
                      </pre>
                    )}
                    {item.detail && (
                      <pre className="max-h-56 overflow-auto rounded-md border border-border/60 bg-background/70 px-2 py-1.5 text-[12px] leading-relaxed text-foreground/80 whitespace-pre-wrap break-words">
                        {item.detail}
                      </pre>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function ToolActivityCard({
  tool,
  localElapsed,
}: ToolActivityCardProps) {
  const [expanded, setExpanded] = useState(false);
  const elapsed = tool.elapsedSeconds ?? localElapsed;
  const isNested = tool.isNested === true;
  const displayName =
    tool.toolName === 'Skill' ? tool.skillName || 'unknown' : tool.toolName;

  const param = parseToolParam(tool.toolName, tool.toolInputSummary);
  const isBash = tool.toolName === 'Bash';
  const details = useMemo(
    () => formatToolInput(tool.toolInput),
    [tool.toolInput],
  );
  const hasDetails = Boolean(param || details);

  return (
    <div
      className={`${isNested ? 'ml-4 border-l-2 border-brand-200 pl-2' : ''}`}
    >
      <div className="rounded-lg border border-brand-200 bg-brand-50/50 text-[13px] font-sans overflow-hidden">
        <div className="flex min-h-8 items-center gap-1.5 px-2.5 py-1.5">
          <svg
            className="w-3 h-3 animate-spin text-primary flex-shrink-0"
            viewBox="0 0 24 24"
            fill="none"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
          <span className="font-medium text-primary flex-shrink-0">
            {displayName}
          </span>
          {param ? (
            <span
              className={`min-w-0 flex-1 truncate text-muted-foreground ${isBash ? 'font-mono' : ''}`}
              title={`${param.label}: ${param.value}`}
            >
              <span className="text-muted-foreground/60">{param.label}: </span>
              {param.value}
            </span>
          ) : (
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              调用中
            </span>
          )}
          {elapsed != null && (
            <span className="text-muted-foreground tabular-nums flex-shrink-0">
              {Math.round(elapsed)}s
            </span>
          )}
          {hasDetails && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="inline-flex h-6 items-center gap-0.5 rounded px-1.5 text-[11px] text-muted-foreground hover:bg-brand-100 hover:text-primary transition-colors flex-shrink-0"
              aria-expanded={expanded}
            >
              {expanded ? '收起' : '详情'}
              {expanded ? (
                <ChevronUp className="h-3 w-3" />
              ) : (
                <ChevronDown className="h-3 w-3" />
              )}
            </button>
          )}
        </div>

        {expanded && hasDetails && (
          <div className="border-t border-brand-200/70 px-2.5 py-2 space-y-2">
            {param && (
              <div
                className={`text-muted-foreground break-words ${isBash ? 'font-mono' : ''}`}
              >
                <span className="text-muted-foreground/60">
                  {param.label}:{' '}
                </span>
                {param.value}
              </div>
            )}
            {details && (
              <pre className="max-h-56 overflow-auto rounded-md bg-background/70 border border-border/60 px-2 py-1.5 text-[12px] leading-relaxed text-foreground/80 whitespace-pre-wrap break-words">
                {details}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
