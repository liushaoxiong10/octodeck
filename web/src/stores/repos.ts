import { create } from 'zustand';
import { api } from '../api/client';

export interface ManagedRepoInfo {
  id: string;
  name: string;
  kind: 'git' | 'device_path';
  git_url?: string;
  main_branch?: string;
  device_path?: string;
  device_link_id?: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  knowledge?: RepoKnowledgeIndex | null;
}

export interface RepoKnowledgeIndex {
  repoId: string;
  userId: string;
  status: 'none' | 'indexing' | 'ready' | 'error';
  sourceRevision?: string;
  summary?: string;
  stats: Record<string, unknown>;
  error?: string;
  generatedAt?: string;
  updatedAt: string;
}

export type RepoKnowledgeRunStatus = 'queued' | 'running' | 'uploading' | 'ready' | 'error';

export interface RepoKnowledgeRunMilestone {
  t: string;
  kind: 'milestone' | 'tool_start' | 'tool_end' | 'thinking' | 'agent_event' | 'upload' | 'warn' | 'error';
  label: string;
  detail?: Record<string, unknown>;
}

export interface RepoKnowledgeRun {
  id: string;
  repoId: string;
  userId: string;
  status: RepoKnowledgeRunStatus;
  sourceKind?: string;
  executionDeviceLinkId?: string;
  agentClientId?: string;
  filesUploadedAt?: string;
  enabledSkills?: string[];
  stats: Record<string, unknown>;
  timeline?: RepoKnowledgeRunMilestone[];
  error?: string;
  queuedAt: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
}

export interface RepoKnowledgeChunk {
  id: string;
  repoId: string;
  path: string;
  kind: 'overview' | 'file' | 'symbol' | 'dependency' | 'doc' | 'graph';
  name?: string;
  language?: string;
  startLine?: number;
  endLine?: number;
  content?: string;
}

export interface RepoKnowledgeHit extends RepoKnowledgeChunk {
  score: number;
  snippet: string;
  related?: RepoKnowledgeGraphEdge[];
}

export interface RepoKnowledgeGraphEdge {
  id: string;
  repoId: string;
  fromPath: string;
  toPath?: string;
  edgeKind: 'imports' | 'imported_by' | 'depends_on' | 'exports' | 'documents' | 'references';
  symbol?: string;
  packageName?: string;
}

export interface RepoKnowledgeContextPackage {
  anchor?: RepoKnowledgeChunk;
  sameFileChunks: RepoKnowledgeChunk[];
  relatedChunks: RepoKnowledgeChunk[];
  edges: RepoKnowledgeGraphEdge[];
  dependencies: RepoKnowledgeChunk[];
  docs: RepoKnowledgeChunk[];
}

export interface RepoKnowledgePluginStatus {
  id: 'builtin' | 'graphify' | 'codegraph' | 'agent';
  displayName: string;
  available: boolean;
  bundled: boolean;
  selected: boolean;
  capabilities: string[];
  reason?: string;
}

export interface RepoKnowledgeSearchBackendStatus {
  id: 'sqlite' | 'postgres' | 'mongo';
  displayName: string;
  available: boolean;
  selected: boolean;
  reason?: string;
  mode: string;
}

interface ReposState {
  repos: ManagedRepoInfo[];
  knowledgePlugins: RepoKnowledgePluginStatus[];
  searchBackends: RepoKnowledgeSearchBackendStatus[];
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
  createRepo: (input: {
    name: string;
    kind: 'git' | 'device_path';
    git_url?: string;
    main_branch?: string;
    device_path?: string;
    device_link_id?: string;
  }) => Promise<ManagedRepoInfo | null>;
  loadKnowledgePlugins: () => Promise<void>;
  loadSearchBackends: () => Promise<void>;
  generateKnowledge: (id: string, options?: Record<string, unknown>) => Promise<RepoKnowledgeIndex | null>;
  loadKnowledgeRuns: (id: string, limit?: number) => Promise<RepoKnowledgeRun[]>;
  loadKnowledgeRun: (runId: string) => Promise<RepoKnowledgeRun | null>;
  searchKnowledge: (input: { repo_id?: string; query: string; limit?: number; kind?: string; language?: string; path_prefix?: string; include_related?: boolean }) => Promise<RepoKnowledgeHit[]>;
  loadKnowledgeGraph: (repoId: string, input?: { path?: string; edge_kind?: string; limit?: number }) => Promise<RepoKnowledgeGraphEdge[]>;
  loadKnowledgeContext: (repoId: string, input?: { chunk_id?: string; path?: string; query?: string; limit?: number }) => Promise<RepoKnowledgeContextPackage | null>;
  deleteRepo: (id: string) => Promise<boolean>;
}

export const useReposStore = create<ReposState>((set, get) => ({
  repos: [],
  knowledgePlugins: [],
  searchBackends: [],
  loading: false,
  error: null,
  load: async () => {
    set({ loading: true, error: null });
    try {
      const data = await api.get<{ repos: ManagedRepoInfo[] }>('/api/repos');
      set({ repos: data.repos, loading: false });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), loading: false });
    }
  },
  createRepo: async (input) => {
    try {
      const data = await api.post<{ repo: ManagedRepoInfo }>('/api/repos', input);
      set({ repos: [data.repo, ...get().repos], error: null });
      return data.repo;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },
  loadKnowledgePlugins: async () => {
    try {
      const data = await api.get<{ plugins: RepoKnowledgePluginStatus[] }>('/api/repos/knowledge/plugins');
      set({ knowledgePlugins: data.plugins, error: null });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },
  loadSearchBackends: async () => {
    try {
      const data = await api.get<{ backends: RepoKnowledgeSearchBackendStatus[] }>('/api/repos/knowledge/search-backends');
      set({ searchBackends: data.backends, error: null });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },
  generateKnowledge: async (id, options = {}) => {
    try {
      const data = await api.post<{ index: RepoKnowledgeIndex; task?: { id: string; status: 'queued' | 'running' } }>(`/api/repos/${encodeURIComponent(id)}/knowledge/generate`, options);
      set({
        repos: get().repos.map((repo) => repo.id === id ? { ...repo, knowledge: data.index } : repo),
        error: null,
      });
      return data.index;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },
  loadKnowledgeRuns: async (id, limit = 20) => {
    try {
      const data = await api.get<{ runs: RepoKnowledgeRun[] }>(`/api/repos/${encodeURIComponent(id)}/knowledge/runs?limit=${encodeURIComponent(String(limit))}`);
      set({ error: null });
      return data.runs ?? [];
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return [];
    }
  },
  loadKnowledgeRun: async (runId) => {
    try {
      const data = await api.get<{ run: RepoKnowledgeRun }>(`/api/repos/knowledge/runs/${encodeURIComponent(runId)}`);
      set({ error: null });
      return data.run ?? null;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },
  searchKnowledge: async (input) => {
    try {
      const data = await api.post<{ hits: RepoKnowledgeHit[] }>('/api/repos/knowledge/search', input);
      set({ error: null });
      return data.hits;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return [];
    }
  },
  loadKnowledgeGraph: async (repoId, input = {}) => {
    try {
      const params = new URLSearchParams();
      if (input.path) params.set('path', input.path);
      if (input.edge_kind) params.set('edge_kind', input.edge_kind);
      if (input.limit) params.set('limit', String(input.limit));
      const suffix = params.toString() ? `?${params.toString()}` : '';
      const data = await api.get<{ edges: RepoKnowledgeGraphEdge[] }>(`/api/repos/${encodeURIComponent(repoId)}/knowledge/graph${suffix}`);
      set({ error: null });
      return data.edges;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return [];
    }
  },
  loadKnowledgeContext: async (repoId, input = {}) => {
    try {
      const params = new URLSearchParams();
      if (input.chunk_id) params.set('chunk_id', input.chunk_id);
      if (input.path) params.set('path', input.path);
      if (input.query) params.set('query', input.query);
      if (input.limit) params.set('limit', String(input.limit));
      const suffix = params.toString() ? `?${params.toString()}` : '';
      const data = await api.get<{ context: RepoKnowledgeContextPackage }>(`/api/repos/${encodeURIComponent(repoId)}/knowledge/context${suffix}`);
      set({ error: null });
      return data.context;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },
  deleteRepo: async (id) => {
    try {
      await api.delete<{ ok: boolean }>(`/api/repos/${encodeURIComponent(id)}`);
      set({ repos: get().repos.filter((repo) => repo.id !== id), error: null });
      return true;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  },
}));
