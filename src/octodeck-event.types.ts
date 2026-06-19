export type OctoDeckEventDomain =
  | 'issue'
  | 'agent_task'
  | 'runtime'
  | 'repo_knowledge'
  | 'autopilot'
  | 'approval'
  | 'device'
  | 'memory'
  | 'chat'
  | 'billing'
  | 'system';

export interface OctoDeckEvent<TPayload = unknown> {
  id: string;
  version: 1;
  type: string;
  domain: OctoDeckEventDomain;
  action: string;
  timestamp: string;
  userId?: string;
  workspaceJid?: string;
  chatJid?: string;
  issueId?: string;
  runId?: string | null;
  repoId?: string;
  taskId?: string;
  deviceLinkId?: string;
  correlationId?: string;
  payload: TPayload;
}

export interface OctoDeckNotificationInboxItem {
  id: string;
  kind: 'approval' | 'notification';
  status: 'pending' | 'answered' | 'expired' | 'read' | 'unread';
  title: string;
  summary?: string;
  href?: string;
  decisionUrl?: string;
  issueId?: string;
  runId?: string | null;
  workspaceJid?: string;
  createdAt: string;
  updatedAt: string;
  event: OctoDeckEvent;
}

export function groupOctoDeckEventsForNotificationInbox(
  events: OctoDeckEvent[],
): OctoDeckNotificationInboxItem[] {
  const byId = new Map<string, OctoDeckNotificationInboxItem>();
  for (const event of events) {
    if (event.domain === 'autopilot') {
      const item = autopilotNotificationInboxItem(event);
      if (item) byId.set(item.id, item);
      continue;
    }
    if (event.domain !== 'approval') continue;
    const payload = event.payload as {
      id?: unknown;
      status?: unknown;
      title?: unknown;
      summary?: unknown;
      href?: unknown;
      decisionUrl?: unknown;
    };
    const id = typeof payload.id === 'string' ? payload.id : event.correlationId;
    if (!id) continue;
    const existing = byId.get(id);
    const title =
      typeof payload.title === 'string' && payload.title.trim()
        ? payload.title
        : existing?.title ?? '审批请求';
    const status = approvalInboxStatus(event.action, payload.status);
    byId.set(id, {
      id,
      kind: 'approval',
      status,
      title,
      summary: typeof payload.summary === 'string' ? payload.summary : existing?.summary,
      href: typeof payload.href === 'string' ? payload.href : existing?.href,
      decisionUrl: typeof payload.decisionUrl === 'string' ? payload.decisionUrl : existing?.decisionUrl,
      issueId: event.issueId ?? existing?.issueId,
      runId: event.runId ?? existing?.runId,
      workspaceJid: event.workspaceJid ?? existing?.workspaceJid,
      createdAt: existing?.createdAt ?? event.timestamp,
      updatedAt: event.timestamp,
      event,
    });
  }
  return [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function autopilotNotificationInboxItem(event: OctoDeckEvent): OctoDeckNotificationInboxItem | null {
  if (event.action !== 'error' && event.action !== 'skipped') return null;
  const payload = event.payload as {
    autopilotId?: unknown;
    autopilotName?: unknown;
    run?: {
      id?: unknown;
      error?: unknown;
      skip_reason?: unknown;
    };
  };
  const autopilotId = typeof payload.autopilotId === 'string' ? payload.autopilotId : event.correlationId;
  const runId = typeof payload.run?.id === 'string' ? payload.run.id : event.runId;
  if (!autopilotId || !runId) return null;
  const autopilotName = typeof payload.autopilotName === 'string' && payload.autopilotName.trim()
    ? payload.autopilotName.trim()
    : autopilotId;
  const failed = event.action === 'error';
  const summaryValue = failed ? payload.run?.error : payload.run?.skip_reason;
  return {
    id: `autopilot:${autopilotId}:${runId}`,
    kind: 'notification',
    status: 'unread',
    title: `Autopilot ${failed ? 'failed' : 'skipped'}: ${autopilotName}`,
    summary: typeof summaryValue === 'string' ? summaryValue : undefined,
    runId,
    createdAt: event.timestamp,
    updatedAt: event.timestamp,
    event,
  };
}

function approvalInboxStatus(action: string, payloadStatus: unknown): OctoDeckNotificationInboxItem['status'] {
  if (action === 'answered') return 'answered';
  if (action === 'expired') return 'expired';
  if (payloadStatus === 'answered') return 'answered';
  if (payloadStatus === 'expired') return 'expired';
  return 'pending';
}
