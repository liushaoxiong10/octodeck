import { create } from 'zustand';
import {
  groupOctoDeckEventsForNotificationInbox,
  type OctoDeckEvent,
  type OctoDeckNotificationInboxItem,
} from '../octodeck-event.types';
import { createOctoDeckEvent } from '../realtime-events';
import { api } from '../api/client';

interface ApprovalCenterItem {
  id: string;
  source: 'issue' | 'agent_team';
  sourceId: string;
  runId?: string | null;
  status: 'pending' | 'answered' | 'expired' | 'canceled' | 'approved' | 'rejected';
  title: string;
  summary?: string;
  createdAt: string;
  updatedAt: string;
  href: string;
  decisionUrl: string;
  payload: unknown;
}

interface NotificationsState {
  events: OctoDeckEvent[];
  inbox: OctoDeckNotificationInboxItem[];
  unreadIds: Set<string>;
  unreadCount: number;
  loadApprovalRequests: () => Promise<void>;
  recordEvent: (event: OctoDeckEvent) => void;
  markRead: (id: string) => void;
  markAllRead: () => void;
}

function rebuildInbox(events: OctoDeckEvent[], unreadIds: Set<string>) {
  const inbox = groupOctoDeckEventsForNotificationInbox(events);
  return {
    inbox,
    unreadCount: inbox.filter((item) => unreadIds.has(item.id) && (item.status === 'pending' || item.status === 'unread')).length,
  };
}

export const useNotificationsStore = create<NotificationsState>((set) => ({
  events: [],
  inbox: [],
  unreadIds: new Set<string>(),
  unreadCount: 0,

  loadApprovalRequests: async () => {
    const response = await api.get<{ approvals: ApprovalCenterItem[] }>('/api/approval-requests?status=pending');
    set((state) => {
      const events = [...state.events];
      const unreadIds = new Set(state.unreadIds);
      for (const approval of response.approvals) {
        const event = createOctoDeckEvent({
          id: `evt_approval_snapshot_${approval.source}_${approval.id}`,
          type: `approval.${approval.source}.snapshot`,
          domain: 'approval',
          action: approval.status === 'pending' ? 'created' : 'answered',
          issueId: approval.source === 'issue' ? approval.sourceId : undefined,
          runId: approval.runId,
          taskId: approval.source === 'agent_team' ? approval.sourceId : undefined,
          timestamp: approval.updatedAt,
          correlationId: approval.id,
          payload: approval,
        });
        if (!events.some((item) => item.id === event.id)) events.unshift(event);
        if (approval.status === 'pending') unreadIds.add(approval.id);
      }
      const sliced = events.slice(0, 500);
      return { events: sliced, unreadIds, ...rebuildInbox(sliced, unreadIds) };
    });
  },

  recordEvent: (event) => set((state) => {
    if (state.events.some((item) => item.id === event.id)) return state;
    const events = [event, ...state.events].slice(0, 500);
    const unreadIds = new Set(state.unreadIds);
    if (event.domain === 'approval') {
      const payload = event.payload as { id?: unknown; status?: unknown };
      const requestId = typeof payload.id === 'string' ? payload.id : event.correlationId;
      if (requestId) {
        if (event.action === 'created' || payload.status === 'pending') unreadIds.add(requestId);
        if (event.action === 'answered' || event.action === 'expired') unreadIds.delete(requestId);
      }
    }
    if (event.domain === 'autopilot' && (event.action === 'error' || event.action === 'skipped')) {
      const payload = event.payload as { autopilotId?: unknown; run?: { id?: unknown } };
      const autopilotId = typeof payload.autopilotId === 'string' ? payload.autopilotId : event.correlationId;
      const runId = typeof payload.run?.id === 'string' ? payload.run.id : event.runId;
      if (autopilotId && runId) unreadIds.add(`autopilot:${autopilotId}:${runId}`);
    }
    return { events, unreadIds, ...rebuildInbox(events, unreadIds) };
  }),

  markRead: (id) => set((state) => {
    const unreadIds = new Set(state.unreadIds);
    unreadIds.delete(id);
    return { unreadIds, ...rebuildInbox(state.events, unreadIds) };
  }),

  markAllRead: () => set((state) => {
    const unreadIds = new Set<string>();
    return { unreadIds, ...rebuildInbox(state.events, unreadIds) };
  }),
}));
