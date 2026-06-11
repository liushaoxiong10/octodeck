import { create } from 'zustand';
import { api } from '../api/client';

export type IssueStatus = 'todo' | 'in_progress' | 'waiting_for_human' | 'review' | 'done' | 'canceled';
export type IssuePriority = 'low' | 'medium' | 'high' | 'urgent';
export type IssueViewMode = 'board' | 'list';
export type IssueSortField = 'status' | 'updated' | 'created' | 'priority' | 'due_date';

export interface WorkspaceIssue {
  id: string;
  workspace_jid: string;
  workspace_folder: string;
  title: string;
  description: string;
  status: IssueStatus;
  priority: IssuePriority;
  assignee_user_id?: string | null;
  due_date?: string | null;
  project_repo_id?: string | null;
  project_git_url?: string | null;
  project_device_path?: string | null;
  project_device_link_id?: string | null;
  agent_link_id?: string | null;
  agent_client_id?: string | null;
  execution_node?: string | null;
  backend?: string | null;
  selected_skills?: string[] | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  last_run_id?: string | null;
  last_run_status?: string | null;
  last_run_at?: string | null;
}

export interface IssueAgentRun {
  id: string;
  issue_id: string;
  status:
    | 'queued'
    | 'running'
    | 'awaiting_input'
    | 'paused'
    | 'success'
    | 'error'
    | 'canceled'
    | 'lost';
  result?: string | null;
  error?: string | null;
  session_id?: string | null;
  parent_run_id?: string | null;
  awaiting_kind?: 'permission' | 'clarification' | null;
  awaiting_payload_id?: string | null;
  last_seen_at?: string | null;
  heartbeat_deadline_at?: string | null;
  created_at: string;
  run_started_at?: string | null;
  run_completed_at?: string | null;
}

export interface IssueAgentRequest {
  id: string;
  issue_id: string;
  run_id: string;
  kind: 'permission' | 'clarification';
  correlation_id?: string | null;
  title?: string | null;
  summary?: string | null;
  detail?: string | null;
  payload?: Record<string, unknown> | null;
  status: 'pending' | 'answered' | 'expired' | 'canceled';
  decision?: 'approve' | 'reject' | 'reply' | null;
  answer?: string | null;
  answered_at?: string | null;
  answered_by?: string | null;
  consumed_at?: string | null;
  expires_at?: string | null;
  created_at: string;
}

export interface IssueAgentRunEvent {
  id: string;
  issue_id: string;
  run_id: string;
  event_type: string;
  title?: string | null;
  summary?: string | null;
  detail?: string | null;
  payload?: Record<string, unknown> | null;
  created_at: string;
}

export interface IssueAttachment {
  id: string;
  issue_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  data_url: string;
  created_by: string;
  created_at: string;
}

// --- Comment system ---
export type IssueCommentSourceType = 'user' | 'agent' | 'system';

export interface IssueComment {
  id: string;
  issue_id: string;
  workspace_jid: string;
  body: string;
  created_by: string | null;
  source_type: IssueCommentSourceType;
  source_meta?: Record<string, unknown> | null;
  created_at: string;
  updated_at?: string | null;
  deleted_at?: string | null;
}

// --- Generalized event timeline ---
export type IssueEventType =
  | 'created' | 'updated' | 'title_changed' | 'description_changed'
  | 'status_changed' | 'priority_changed' | 'assignee_changed' | 'due_date_changed'
  | 'project_changed' | 'agent_changed' | 'skills_changed'
  | 'comment_created' | 'comment_updated' | 'comment_deleted'
  | 'attachment_added' | 'attachment_removed'
  | 'run_created' | 'run_status_changed' | 'run_started' | 'run_succeeded'
  | 'run_failed' | 'run_canceled' | 'run_event' | 'run_delta' | 'run_result';

export interface IssueEvent {
  id: string;
  issue_id: string;
  run_id?: string | null;
  event_type: IssueEventType;
  actor_id?: string | null;
  actor_type: 'user' | 'agent' | 'system';
  title?: string | null;
  summary?: string | null;
  detail?: Record<string, unknown> | null;
  payload?: Record<string, unknown> | null;
  reference_id?: string | null;
  created_at: string;
}

export interface IssueFilters {
  statuses: IssueStatus[];
  priorities: IssuePriority[];
  project?: string;
  assignee?: string;
  showDone: boolean;
}

export interface IssueDisplayOptions {
  priority: boolean;
  assignee: boolean;
  description: boolean;
  dueDate: boolean;
}

export interface CreateIssueInput {
  workspace_jid?: string;
  workspace_folder?: string;
  title: string;
  description: string;
  status: IssueStatus;
  priority: IssuePriority;
  assignee_user_id?: string | null;
  due_date?: string | null;
  project_repo_id?: string | null;
  agent_link_id?: string | null;
  agent_client_id?: string | null;
  execution_node?: string | null;
  selected_skills?: string[];
  start_agent?: boolean;
  create_more?: boolean;
}

interface IssuesState {
  issues: WorkspaceIssue[];
  total: number;
  loading: boolean;
  error: string | null;
  query: string;
  view: IssueViewMode;
  filters: IssueFilters;
  order: { field: IssueSortField; direction: 'asc' | 'desc' };
  display: IssueDisplayOptions;
  runsByIssue: Record<string, IssueAgentRun[]>;
  runEventsByRun: Record<string, IssueAgentRunEvent[]>;
  attachmentsByIssue: Record<string, IssueAttachment[]>;
  // Single-issue detail cache
  issueById: Record<string, WorkspaceIssue>;
  // Timeline events by issue id
  eventsByIssue: Record<string, IssueEvent[]>;
  // Comments by issue id
  commentsByIssue: Record<string, IssueComment[]>;
  // Pending / answered agent requests (permission / clarification) by issue id
  requestsByIssue: Record<string, IssueAgentRequest[]>;
  setQuery: (query: string) => void;
  setView: (view: IssueViewMode) => void;
  setFilters: (filters: Partial<IssueFilters>) => void;
  setOrder: (order: Partial<IssuesState['order']>) => void;
  setDisplay: (display: Partial<IssueDisplayOptions>) => void;
  loadIssues: () => Promise<void>;
  createIssue: (input: CreateIssueInput) => Promise<WorkspaceIssue | null>;
  updateIssue: (id: string, patch: Partial<WorkspaceIssue>) => Promise<WorkspaceIssue | null>;
  deleteIssue: (id: string) => Promise<void>;
  runIssueAgent: (id: string) => Promise<IssueAgentRun | null>;
  loadIssueRuns: (id: string) => Promise<IssueAgentRun[]>;
  loadIssueRunEvents: (issueId: string, runId: string) => Promise<IssueAgentRunEvent[]>;
  cancelIssueRun: (issueId: string, runId: string) => Promise<IssueAgentRun | null>;
  loadIssueAttachments: (id: string) => Promise<IssueAttachment[]>;
  uploadIssueAttachment: (id: string, input: Omit<IssueAttachment, 'id' | 'issue_id' | 'created_by' | 'created_at'>) => Promise<IssueAttachment | null>;
  deleteIssueAttachment: (issueId: string, attachmentId: string) => Promise<void>;
  loadIssueById: (id: string) => Promise<WorkspaceIssue | null>;
  loadIssueEvents: (id: string, filters?: { sinceId?: string; sinceAt?: string; runId?: string }) => Promise<IssueEvent[]>;
  prependIssueEvent: (id: string, event: IssueEvent) => void;
  loadIssueComments: (id: string, filters?: { sinceAt?: string; includeDeleted?: boolean }) => Promise<IssueComment[]>;
  createIssueComment: (id: string, body: string) => Promise<IssueComment | null>;
  updateIssueComment: (issueId: string, commentId: string, body: string) => Promise<IssueComment | null>;
  deleteIssueComment: (issueId: string, commentId: string) => Promise<void>;
  // Agent requests
  loadIssueRequests: (id: string, opts?: { status?: IssueAgentRequest['status'] }) => Promise<IssueAgentRequest[]>;
  answerIssueRequest: (
    issueId: string,
    runId: string,
    requestId: string,
    payload: { decision: 'approve' | 'reject' | 'reply'; message?: string; answer?: string },
  ) => Promise<IssueAgentRequest | null>;
  upsertIssueRequest: (issueId: string, request: IssueAgentRequest) => void;
}

const defaultFilters: IssueFilters = {
  statuses: [],
  priorities: [],
  showDone: false,
};

const defaultDisplay: IssueDisplayOptions = {
  priority: true,
  assignee: true,
  description: true,
  dueDate: true,
};

function loadDisplay(): IssueDisplayOptions {
  try {
    const raw = localStorage.getItem('octodeck.issue.display');
    return raw ? { ...defaultDisplay, ...JSON.parse(raw) } : defaultDisplay;
  } catch {
    return defaultDisplay;
  }
}

function loadView(): IssueViewMode {
  return localStorage.getItem('octodeck.issue.view') === 'list' ? 'list' : 'board';
}

export const useIssuesStore = create<IssuesState>((set, get) => ({
  issues: [],
  total: 0,
  loading: false,
  error: null,
  query: '',
  view: loadView(),
  filters: defaultFilters,
  order: { field: 'updated', direction: 'desc' },
  display: loadDisplay(),
  runsByIssue: {},
  runEventsByRun: {},
  attachmentsByIssue: {},
  issueById: {},
  eventsByIssue: {},
  commentsByIssue: {},
  requestsByIssue: {},

  setQuery: (query) => set({ query }),
  setView: (view) => {
    localStorage.setItem('octodeck.issue.view', view);
    set({ view });
  },
  setFilters: (filters) => set((state) => ({ filters: { ...state.filters, ...filters } })),
  setOrder: (order) => set((state) => ({ order: { ...state.order, ...order } })),
  setDisplay: (display) =>
    set((state) => {
      const next = { ...state.display, ...display };
      localStorage.setItem('octodeck.issue.display', JSON.stringify(next));
      return { display: next };
    }),

  loadIssues: async () => {
    const { query, filters, order } = get();
    set({ loading: true, error: null });
    try {
      const params = new URLSearchParams();
      if (query.trim()) params.set('q', query.trim());
      if (filters.statuses.length) params.set('status', filters.statuses.join(','));
      if (filters.priorities.length) params.set('priority', filters.priorities.join(','));
      if (filters.project) params.set('project', filters.project);
      if (filters.assignee) params.set('assignee', filters.assignee);
      if (filters.showDone) params.set('show_done', 'true');
      params.set('sort', order.field);
      params.set('direction', order.direction);
      const data = await api.get<{ issues: WorkspaceIssue[]; total: number }>(`/api/issues?${params.toString()}`);
      const cache: Record<string, WorkspaceIssue> = {};
      for (const issue of data.issues) cache[issue.id] = issue;
      set({ issues: data.issues, total: data.total, loading: false, issueById: { ...get().issueById, ...cache } });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  createIssue: async (input) => {
    try {
      const data = await api.post<{ issue: WorkspaceIssue }>('/api/issues', input);
      await get().loadIssues();
      return data.issue;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  updateIssue: async (id, patch) => {
    try {
      const data = await api.patch<{ issue: WorkspaceIssue }>(`/api/issues/${encodeURIComponent(id)}`, patch);
      set((state) => ({
        issues: state.issues.map((issue) => (issue.id === id ? data.issue : issue)),
        issueById: { ...state.issueById, [id]: data.issue },
        error: null,
      }));
      return data.issue;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  deleteIssue: async (id) => {
    try {
      await api.delete(`/api/issues/${encodeURIComponent(id)}`);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
    set((state) => {
      const { [id]: _removedIssue, ...issueById } = state.issueById;
      const { [id]: _removedRuns, ...runsByIssue } = state.runsByIssue;
      const { [id]: _removedAttachments, ...attachmentsByIssue } = state.attachmentsByIssue;
      const { [id]: _removedEvents, ...eventsByIssue } = state.eventsByIssue;
      const { [id]: _removedComments, ...commentsByIssue } = state.commentsByIssue;
      const { [id]: _removedRequests, ...requestsByIssue } = state.requestsByIssue;
      return {
        issues: state.issues.filter((issue) => issue.id !== id),
        total: Math.max(0, state.total - 1),
        issueById,
        runsByIssue,
        attachmentsByIssue,
        eventsByIssue,
        commentsByIssue,
        requestsByIssue,
      };
    });
  },

  runIssueAgent: async (id) => {
    try {
      const data = await api.post<{ run: IssueAgentRun }>(`/api/issues/${encodeURIComponent(id)}/run`, {});
      await get().loadIssues();
      await get().loadIssueRuns(id);
      await get().loadIssueEvents(id);
      return data.run;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  loadIssueRuns: async (id) => {
    try {
      const data = await api.get<{ runs: IssueAgentRun[] }>(`/api/issues/${encodeURIComponent(id)}/runs`);
      set((state) => ({ runsByIssue: { ...state.runsByIssue, [id]: data.runs } }));
      return data.runs;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return [];
    }
  },

  loadIssueRunEvents: async (issueId, runId) => {
    try {
      const data = await api.get<{ events: IssueAgentRunEvent[] }>(`/api/issues/${encodeURIComponent(issueId)}/runs/${encodeURIComponent(runId)}/events`);
      set((state) => ({ runEventsByRun: { ...state.runEventsByRun, [runId]: data.events } }));
      return data.events;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return [];
    }
  },

  cancelIssueRun: async (issueId, runId) => {
    try {
      const data = await api.post<{ run: IssueAgentRun }>(`/api/issues/${encodeURIComponent(issueId)}/runs/${encodeURIComponent(runId)}/cancel`, {});
      await get().loadIssues();
      await get().loadIssueRuns(issueId);
      return data.run;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  loadIssueAttachments: async (id) => {
    try {
      const data = await api.get<{ attachments: IssueAttachment[] }>(`/api/issues/${encodeURIComponent(id)}/attachments`);
      set((state) => ({ attachmentsByIssue: { ...state.attachmentsByIssue, [id]: data.attachments } }));
      return data.attachments;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return [];
    }
  },

  uploadIssueAttachment: async (id, input) => {
    try {
      const data = await api.post<{ attachment: IssueAttachment }>(`/api/issues/${encodeURIComponent(id)}/attachments`, input);
      set((state) => ({
        attachmentsByIssue: {
          ...state.attachmentsByIssue,
          [id]: [data.attachment, ...(state.attachmentsByIssue[id] ?? [])],
        },
      }));
      return data.attachment;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  deleteIssueAttachment: async (issueId, attachmentId) => {
    await api.delete(`/api/issues/${encodeURIComponent(issueId)}/attachments/${encodeURIComponent(attachmentId)}`);
    set((state) => ({
      attachmentsByIssue: {
        ...state.attachmentsByIssue,
        [issueId]: (state.attachmentsByIssue[issueId] ?? []).filter((item) => item.id !== attachmentId),
      },
    }));
  },

  loadIssueById: async (id) => {
    try {
      const data = await api.get<{ issue: WorkspaceIssue }>(`/api/issues/${encodeURIComponent(id)}`);
      set((state) => {
        const issueExists = state.issues.some((i) => i.id === id);
        return {
          issueById: { ...state.issueById, [id]: data.issue },
          issues: issueExists
            ? state.issues.map((issue) => (issue.id === id ? data.issue : issue))
            : state.issues,
        };
      });
      return data.issue;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  loadIssueEvents: async (id, filters) => {
    try {
      const params = new URLSearchParams();
      if (filters?.sinceId) params.set('since_id', filters.sinceId);
      if (filters?.sinceAt) params.set('since_at', filters.sinceAt);
      if (filters?.runId) params.set('run_id', filters.runId);
      const qs = params.toString();
      const data = await api.get<{ events: IssueEvent[] }>(
        `/api/issues/${encodeURIComponent(id)}/events${qs ? `?${qs}` : ''}`,
      );
      set((state) => {
        const existing = state.eventsByIssue[id] ?? [];
        const map = new Map<string, IssueEvent>();
        for (const ev of existing) map.set(ev.id, ev);
        for (const ev of data.events) map.set(ev.id, ev);
        const merged = Array.from(map.values()).sort(
          (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
        );
        return { eventsByIssue: { ...state.eventsByIssue, [id]: merged } };
      });
      return data.events;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return [];
    }
  },

  prependIssueEvent: (id, event) => {
    set((state) => {
      const existing = state.eventsByIssue[id] ?? [];
      if (existing.some((ev) => ev.id === event.id)) return state;
      return {
        eventsByIssue: {
          ...state.eventsByIssue,
          [id]: [event, ...existing],
        },
      };
    });
  },

  loadIssueComments: async (id, filters) => {
    try {
      const params = new URLSearchParams();
      if (filters?.sinceAt) params.set('since_at', filters.sinceAt);
      if (filters?.includeDeleted) params.set('include_deleted', 'true');
      const qs = params.toString();
      const data = await api.get<{ comments: IssueComment[] }>(
        `/api/issues/${encodeURIComponent(id)}/comments${qs ? `?${qs}` : ''}`,
      );
      set((state) => ({
        commentsByIssue: { ...state.commentsByIssue, [id]: data.comments },
      }));
      return data.comments;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return [];
    }
  },

  createIssueComment: async (id, body) => {
    try {
      const data = await api.post<{ comment: IssueComment }>(
        `/api/issues/${encodeURIComponent(id)}/comments`,
        { body },
      );
      set((state) => ({
        commentsByIssue: {
          ...state.commentsByIssue,
          [id]: [...(state.commentsByIssue[id] ?? []), data.comment],
        },
      }));
      await get().loadIssueEvents(id);
      return data.comment;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  updateIssueComment: async (issueId, commentId, body) => {
    try {
      const data = await api.patch<{ comment: IssueComment }>(
        `/api/issues/${encodeURIComponent(issueId)}/comments/${encodeURIComponent(commentId)}`,
        { body },
      );
      set((state) => ({
        commentsByIssue: {
          ...state.commentsByIssue,
          [issueId]: (state.commentsByIssue[issueId] ?? []).map((c) =>
            c.id === commentId ? data.comment : c,
          ),
        },
      }));
      await get().loadIssueEvents(issueId);
      return data.comment;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  deleteIssueComment: async (issueId, commentId) => {
    await api.delete(
      `/api/issues/${encodeURIComponent(issueId)}/comments/${encodeURIComponent(commentId)}`,
    );
    set((state) => ({
      commentsByIssue: {
        ...state.commentsByIssue,
        [issueId]: (state.commentsByIssue[issueId] ?? []).filter((c) => c.id !== commentId),
      },
    }));
    await get().loadIssueEvents(issueId);
  },

  loadIssueRequests: async (id, opts = {}) => {
    try {
      const url = new URL(
        `/api/issues/${encodeURIComponent(id)}/requests`,
        window.location.origin,
      );
      if (opts.status) url.searchParams.set('status', opts.status);
      const data = await api.get<{ requests: IssueAgentRequest[] }>(
        url.pathname + url.search,
      );
      set((state) => ({
        requestsByIssue: { ...state.requestsByIssue, [id]: data.requests },
      }));
      return data.requests;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return [];
    }
  },

  answerIssueRequest: async (issueId, runId, requestId, payload) => {
    try {
      const data = await api.post<{ request: IssueAgentRequest }>(
        `/api/issues/${encodeURIComponent(issueId)}/runs/${encodeURIComponent(runId)}/decision`,
        { request_id: requestId, ...payload },
      );
      get().upsertIssueRequest(issueId, data.request);
      await get().loadIssueRuns(issueId);
      return data.request;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  upsertIssueRequest: (issueId, request) => {
    set((state) => {
      const existing = state.requestsByIssue[issueId] ?? [];
      const filtered = existing.filter((r) => r.id !== request.id);
      return {
        requestsByIssue: {
          ...state.requestsByIssue,
          [issueId]: [request, ...filtered],
        },
      };
    });
  },
}));
