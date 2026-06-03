import { create } from 'zustand';
import { api } from '../api/client';

export type IssueStatus = 'todo' | 'in_progress' | 'review' | 'done' | 'canceled';
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
  status: 'queued' | 'running' | 'success' | 'error' | 'canceled';
  result?: string | null;
  error?: string | null;
  created_at: string;
  run_started_at?: string | null;
  run_completed_at?: string | null;
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
  attachmentsByIssue: Record<string, IssueAttachment[]>;
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
  loadIssueAttachments: (id: string) => Promise<IssueAttachment[]>;
  uploadIssueAttachment: (id: string, input: Omit<IssueAttachment, 'id' | 'issue_id' | 'created_by' | 'created_at'>) => Promise<IssueAttachment | null>;
  deleteIssueAttachment: (issueId: string, attachmentId: string) => Promise<void>;
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
  attachmentsByIssue: {},

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
      set({ issues: data.issues, total: data.total, loading: false });
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
        error: null,
      }));
      return data.issue;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  deleteIssue: async (id) => {
    await api.delete(`/api/issues/${encodeURIComponent(id)}`);
    set((state) => ({ issues: state.issues.filter((issue) => issue.id !== id) }));
  },

  runIssueAgent: async (id) => {
    try {
      const data = await api.post<{ run: IssueAgentRun }>(`/api/issues/${encodeURIComponent(id)}/run`, {});
      await get().loadIssues();
      await get().loadIssueRuns(id);
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
}));
