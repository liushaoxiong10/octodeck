import { create } from 'zustand';
import { api } from '../api/client';

export type AgentTeamShape =
  | 'auto'
  | 'pipeline'
  | 'parallel'
  | 'leader-worker'
  | 'judge-route';

export interface AgentTeamRole {
  id: string;
  name: string;
  responsibility: string;
  parallelGroup?: string;
  inputs?: string[];
  outputs?: string[];
  skills?: string[];
  guardrails?: string[];
  requiredSkills?: string[];
  preferredAgentMd?: string[];
  policy?: {
    permissionLevel?: 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5';
    workspacePolicy?: 'none' | 'read-only' | 'sandbox' | 'worktree' | 'device';
    requiresApproval?: boolean;
  };
  budget?: {
    maxDurationMs?: number;
    maxTokens?: number;
    maxOutputBytes?: number;
  };
}

export interface AgentTeamRoleAssignment {
  runnerAgentId: string;
  linkId?: string;
  agentClientId?: string;
}

export interface AgentTeamWorkflowAction {
  roleId: string;
  phase?: string;
  instructions?: string;
  outputKey?: string;
}

export interface AgentTeamWorkflowApprovalPolicy {
  mode: 'single' | 'any_of' | 'all_of' | 'quorum';
  approverRoleIds: string[];
  quorum?: number;
  timeoutMs?: number;
  onTimeout?: 'reject' | 'approve' | 'fallback';
}

export interface AgentTeamWorkflowVerify {
  verifierRoleId: string;
  subjectKeys: string[];
  rubric?: string;
}

export interface AgentTeamWorkflowVote {
  voterRoleIds: string[];
  subjectKeys: string[];
  threshold?: number;
}

export interface AgentTeamWorkflowStep {
  id: string;
  type: 'role' | 'parallel' | 'route' | 'verify' | 'vote';
  roleId?: string;
  phase?: string;
  instructions?: string;
  inputKeys?: string[];
  outputKey?: string;
  dependsOn?: string[];
  parallel?: AgentTeamWorkflowAction[][];
  route?: {
    judgeRoleId: string;
    candidateRoleIds: string[];
    fallbackRoleId?: string;
    finalRoleId?: string;
  };
  verify?: AgentTeamWorkflowVerify;
  vote?: AgentTeamWorkflowVote;
  approvalPolicy?: AgentTeamWorkflowApprovalPolicy;
  onFailure?: {
    action: 'continue' | 'abort' | 'run_role' | 'retry';
    targetRoleId?: string;
    phase?: string;
    maxIterations?: number;
    instructions?: string;
  };
}

export interface AgentTeam {
  id: string;
  name: string;
  goal: string;
  shape: AgentTeamShape;
  description: string;
  roles: AgentTeamRole[];
  workflow: string;
  workflowSteps?: AgentTeamWorkflowStep[];
  successCriteria: string[];
  createdByAgentId: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentMdDefinition {
  id: string;
  name: string;
  summary: string;
  content: string;
  createdByAgentId: string;
  createdByTeamId?: string;
  createdByTeamName?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentMdReference {
  kind: 'team' | 'agent';
  id: string;
  name: string;
  detail?: string;
  agentMdId?: string;
  agentMdName?: string;
}

export interface AgentMdStoreEntry {
  id: string;
  sourceId: AgentMdStoreSourceId;
  sourceName: string;
  path: string;
  name: string;
  summary: string;
  category: string;
  size: number;
  sourceUrl: string;
}

export interface AgentMdStorePreview extends AgentMdStoreEntry {
  content: string;
}

interface JsDelivrFlatResponse {
  files?: Array<{
    name?: string;
    size?: number;
  }>;
}

type AgentMdStoreSourceId = 'agency-agents' | 'agency-agents-zh';

interface AgentMdStoreSource {
  id: AgentMdStoreSourceId;
  owner: string;
  repo: string;
  branch: string;
  name: string;
}

const AGENT_MD_STORE_SOURCES: AgentMdStoreSource[] = [
  {
    id: 'agency-agents',
    owner: 'msitarzewski',
    repo: 'agency-agents',
    branch: 'main',
    name: 'msitarzewski/agency-agents',
  },
  {
    id: 'agency-agents-zh',
    owner: 'jnMetaCode',
    repo: 'agency-agents-zh',
    branch: 'main',
    name: 'jnMetaCode/agency-agents-zh',
  },
];
const AGENT_MD_STORE_CACHE_TTL_MS = 60_000;
const AGENT_TEAM_GENERATION_SUBMIT_TIMEOUT_MS = 30_000;
const AGENCY_AGENTS_CATEGORIES = new Set([
  'academic',
  'design',
  'engineering',
  'finance',
  'game-development',
  'hr',
  'legal',
  'marketing',
  'paid-media',
  'product',
  'project-management',
  'sales',
  'security',
  'spatial-computing',
  'specialized',
  'strategy',
  'supply-chain',
  'support',
  'testing',
]);

let agentMdStoreEntriesCache: AgentMdStoreEntry[] | null = null;
let agentMdStoreEntriesCacheExpiresAt = 0;

function isAgencyAgentMarkdownPath(filePath: string): boolean {
  if (!filePath.endsWith('.md')) return false;
  const segments = filePath.split('/');
  const [category, fileName] = segments;
  if (!category || !fileName) return false;
  if (fileName.toLowerCase() === 'readme.md') return false;
  if (AGENCY_AGENTS_CATEGORIES.has(category)) return true;
  return (
    filePath === 'integrations/mcp-memory/backend-architect-with-memory.md'
  );
}

function titleFromAgentPath(filePath: string): string {
  const fileName = filePath.split('/').pop()?.replace(/\.md$/i, '') || 'agent';
  return fileName
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

async function fetchJsonWithTimeout<T>(
  url: string,
  timeoutMs = 15_000,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) {
      throw new Error(`failed to fetch ${url}: ${response.status}`);
    }
    return response.json() as Promise<T>;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchTextWithTimeout(
  url: string,
  timeoutMs = 15_000,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) {
      throw new Error(`failed to fetch ${url}: ${response.status}`);
    }
    return response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function agentMdStoreIndexUrl(source: AgentMdStoreSource): string {
  return `https://data.jsdelivr.com/v1/package/gh/${source.owner}/${source.repo}@${source.branch}/flat`;
}

function agentMdStoreRawUrl(source: AgentMdStoreSource, filePath: string): string {
  return `https://cdn.jsdelivr.net/gh/${source.owner}/${source.repo}@${source.branch}/${filePath
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')}`;
}

function agentMdStoreSourceUrl(source: AgentMdStoreSource, filePath: string): string {
  return `https://github.com/${source.owner}/${source.repo}/blob/${source.branch}/${filePath}`;
}

function agentMdStoreSourceById(sourceId: AgentMdStoreSourceId): AgentMdStoreSource {
  return AGENT_MD_STORE_SOURCES.find((source) => source.id === sourceId) ?? AGENT_MD_STORE_SOURCES[0];
}

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const item = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!item) continue;
    result[item[1]] = item[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return result;
}

function firstContentSentence(content: string): string {
  return (
    content
      .replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '')
      .split('\n')
      .map((line) => line.replace(/^#+\s*/, '').trim())
      .find(Boolean)
      ?.slice(0, 300) || '来自 agency-agents 商店的 agent.md 定义。'
  );
}

async function loadAgentMdStoreEntries(): Promise<AgentMdStoreEntry[]> {
  const now = Date.now();
  if (agentMdStoreEntriesCache && agentMdStoreEntriesCacheExpiresAt > now) {
    return agentMdStoreEntriesCache;
  }
  const cacheKey = Math.floor(now / AGENT_MD_STORE_CACHE_TTL_MS);
  const results = await Promise.allSettled(
    AGENT_MD_STORE_SOURCES.map(async (source) => {
      const data = await fetchJsonWithTimeout<JsDelivrFlatResponse>(
        `${agentMdStoreIndexUrl(source)}?_=${cacheKey}`,
      );
      return (data.files ?? [])
        .map((item) => ({
          path: (item.name || '').replace(/^\/+/, ''),
          size: item.size ?? 0,
        }))
        .filter((item) => isAgencyAgentMarkdownPath(item.path))
        .map((item) => {
          const filePath = item.path;
          const category = filePath.split('/')[0] || source.repo;
          return {
            id: `${source.id}-${filePath.replace(/\.md$/i, '').replace(/[^a-zA-Z0-9]+/g, '-')}`,
            sourceId: source.id,
            sourceName: source.name,
            path: filePath,
            name: titleFromAgentPath(filePath),
            summary: `${source.name} / ${category} / ${filePath.split('/').pop()}`,
            category,
            size: item.size,
            sourceUrl: agentMdStoreSourceUrl(source, filePath),
          } satisfies AgentMdStoreEntry;
        });
    }),
  );
  const entries = results.flatMap((result) =>
    result.status === 'fulfilled' ? result.value : [],
  );
  if (entries.length === 0) {
    const firstError = results.find((result) => result.status === 'rejected');
    throw firstError?.status === 'rejected'
      ? firstError.reason
      : new Error('agent.md 商店暂无可用条目');
  }
  agentMdStoreEntriesCache = entries.sort((a, b) =>
    `${a.sourceName}/${a.path}`.localeCompare(`${b.sourceName}/${b.path}`),
  );
  agentMdStoreEntriesCacheExpiresAt = now + AGENT_MD_STORE_CACHE_TTL_MS;
  return agentMdStoreEntriesCache;
}

function filterAgentMdStoreEntries(
  entries: AgentMdStoreEntry[],
  query = '',
): AgentMdStoreEntry[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return entries;
  return entries.filter((entry) =>
    [entry.name, entry.path, entry.category, entry.sourceName]
      .join(' ')
      .toLowerCase()
      .includes(normalizedQuery),
  );
}

export interface AgentTeamExecutionResult {
  status: 'success' | 'error' | 'waiting_approval';
  finalResult: string;
  runId?: string;
  traceId?: string;
  roleResults: Array<{
    roleId: string;
    roleName: string;
    phase: string;
    status: 'success' | 'error';
    result: string;
    error?: string;
  }>;
  events: Array<{
    kind: 'role' | 'edge' | 'feedback' | 'route';
    roleId?: string;
    fromRoleId?: string;
    toRoleId?: string;
    phase?: string;
    label?: string;
  }>;
  traceEvents?: Array<{
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    sessionId?: string;
    runId: string;
    taskId?: string;
    actor: string;
    type: string;
    payload: unknown;
    timestamp: string;
    schemaVersion: 1;
  }>;
  busMessages?: Array<{
    id: string;
    runId: string;
    stepId?: string;
    from: string;
    to?: string;
    kind: 'control' | 'artifact' | 'context' | 'status';
    type: string;
    payload: unknown;
    timestamp: string;
  }>;
  error?: string;
}

export interface AgentTeamRun {
  id: string;
  teamId: string;
  userId: string;
  prompt: string;
  status:
    | 'running'
    | 'waiting_approval'
    | 'paused'
    | 'success'
    | 'error'
    | 'cancelled';
  traceId: string;
  workflowShape: string;
  roleAssignments: unknown;
  finalResult?: string;
  error?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
}

export interface AgentTeamApproval {
  id: string;
  runId: string;
  taskId?: string;
  requestedBy: string;
  status: 'pending' | 'approved' | 'rejected';
  riskLevel: string;
  title: string;
  description: string;
  payload: unknown;
  resolvedBy?: string;
  resolvedAt?: string;
  createdAt: string;
}

export interface AgentTeamCheckpoint {
  id: string;
  runId: string;
  taskId?: string;
  nodeId: string;
  state: unknown;
  blackboardCursor?: number;
  createdAt?: string;
}

export interface AgentTeamArtifact {
  id: string;
  runId: string;
  key: string;
  version: number;
  contentType: string;
  value: string;
  sourceStepId?: string;
  sourceTaskId?: string;
  sourceRoleId?: string;
  confidence?: number;
  visibility: 'run' | 'role' | 'system';
  parentArtifactIds: string[];
  createdAt: string;
}

export interface AgentTeamMetricsSummary {
  totalRuns: number;
  successfulRuns: number;
  failedRuns: number;
  cancelledRuns: number;
  activeRuns: number;
  successRate: number;
  averageDurationMs: number | null;
  failedTaskCount: number;
  approvalLatency: {
    resolvedCount: number;
    averageMs: number | null;
  };
}

export interface AgentTeamRunResponse {
  run: AgentTeamRun;
  execution?: AgentTeamExecutionResult;
  approval?: AgentTeamApproval;
  checkpoint?: AgentTeamCheckpoint;
}

export interface AgentTeamTaskView {
  id: string;
  runId: string;
  roleId?: string;
  phase?: string;
  actorId?: string;
  status: string;
  attempt: number;
  input?: string;
  output?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt?: string;
}

export interface AgentTeamBlackboardEntry {
  id: string;
  runId: string;
  taskId?: string;
  roleId?: string;
  kind: string;
  key: string;
  contentType: string;
  value: string;
  visibility: string;
  createdAt: string;
}

export interface AgentTeamGenerationJob {
  id: string;
  userId: string;
  generatorAgentId: string;
  goal: string;
  shape: AgentTeamShape;
  status: 'running' | 'success' | 'error';
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  team?: AgentTeam;
  agentMdDefinitions?: AgentMdDefinition[];
  error?: string;
}

export type AgentTeamInput = Omit<AgentTeam, 'id' | 'createdAt' | 'updatedAt'>;
export type AgentTeamPatch = Partial<AgentTeamInput>;
export type AgentMdDefinitionInput = Omit<
  AgentMdDefinition,
  'id' | 'createdAt' | 'updatedAt'
>;
export type AgentMdDefinitionPatch = Partial<AgentMdDefinitionInput>;

interface AgentTeamsState {
  teams: AgentTeam[];
  agentMdDefinitions: AgentMdDefinition[];
  generationJobs: AgentTeamGenerationJob[];
  loading: boolean;
  saving: boolean;
  error: string | null;
  load: () => Promise<void>;
  generate: (input: {
    generatorAgentId: string;
    goal: string;
    shape: AgentTeamShape;
  }) => Promise<AgentTeamGenerationJob>;
  loadGenerationJobs: () => Promise<AgentTeamGenerationJob[]>;
  loadGenerationJob: (jobId: string) => Promise<AgentTeamGenerationJob>;
  execute: (
    id: string,
    prompt: string,
    runnerAgentId?: string,
    roleAssignments?: Record<string, AgentTeamRoleAssignment>,
  ) => Promise<AgentTeamExecutionResult>;
  createRun: (
    id: string,
    prompt: string,
    runnerAgentId?: string,
    roleAssignments?: Record<string, AgentTeamRoleAssignment>,
  ) => Promise<AgentTeamRunResponse>;
  listRuns: (filters?: {
    teamId?: string;
    status?: AgentTeamRun['status'];
    limit?: number;
  }) => Promise<AgentTeamRun[]>;
  loadRun: (runId: string) => Promise<AgentTeamRun>;
  loadRunTasks: (runId: string) => Promise<AgentTeamTaskView[]>;
  loadRunEvents: (
    runId: string,
  ) => Promise<NonNullable<AgentTeamExecutionResult['traceEvents']>>;
  loadRunBlackboard: (runId: string) => Promise<AgentTeamBlackboardEntry[]>;
  loadRunApprovals: (runId: string) => Promise<AgentTeamApproval[]>;
  loadRunCheckpoints: (runId: string) => Promise<AgentTeamCheckpoint[]>;
  loadRunArtifacts: (runId: string) => Promise<AgentTeamArtifact[]>;
  loadMetrics: (params?: {
    teamId?: string;
    since?: string;
    until?: string;
    limit?: number;
  }) => Promise<AgentTeamMetricsSummary>;
  decideRunApproval: (
    runId: string,
    approvalId: string,
    decision: 'approved' | 'rejected',
  ) => Promise<AgentTeamRunResponse>;
  cancelRun: (runId: string) => Promise<{ run: AgentTeamRun }>;
  update: (id: string, patch: AgentTeamPatch) => Promise<AgentTeam>;
  remove: (id: string, options?: { deleteLinkedAgentMd?: boolean }) => Promise<void>;
  loadAgentMdDefinitions: () => Promise<void>;
  createAgentMdDefinition: (
    input: AgentMdDefinitionInput,
  ) => Promise<AgentMdDefinition>;
  listAgentMdStoreEntries: (query?: string) => Promise<AgentMdStoreEntry[]>;
  previewAgentMdStoreEntry: (entry: AgentMdStoreEntry) => Promise<AgentMdStorePreview>;
  importAgentMdFromStore: (
    path: string,
    createdByAgentId: string,
    sourceId?: AgentMdStoreSourceId,
  ) => Promise<AgentMdDefinition>;
  updateAgentMdDefinition: (
    id: string,
    patch: AgentMdDefinitionPatch,
  ) => Promise<AgentMdDefinition>;
  removeAgentMdDefinition: (id: string) => Promise<void>;
}

export const useAgentTeamsStore = create<AgentTeamsState>((set, get) => ({
  teams: [],
  agentMdDefinitions: [],
  generationJobs: [],
  loading: false,
  saving: false,
  error: null,

  load: async () => {
    set({ loading: true });
    try {
      const data = await api.get<{ teams: AgentTeam[] }>('/api/agent-teams');
      set({ teams: data.teams ?? [], loading: false, error: null });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  generate: async (input) => {
    set({ saving: true, error: null });
    try {
      const data = await api.post<{
        job: AgentTeamGenerationJob;
      }>(
        '/api/agent-teams/generate',
        input,
        AGENT_TEAM_GENERATION_SUBMIT_TIMEOUT_MS,
      );
      set((state) => ({
        generationJobs: [
          data.job,
          ...state.generationJobs.filter((job) => job.id !== data.job.id),
        ],
      }));
      return data.job;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      set({ saving: false });
    }
  },

  loadGenerationJobs: async () => {
    const data = await api.get<{ jobs: AgentTeamGenerationJob[] }>(
      '/api/agent-teams/generation-jobs',
    );
    set({ generationJobs: data.jobs ?? [] });
    return data.jobs ?? [];
  },

  loadGenerationJob: async (jobId) => {
    const data = await api.get<{ job: AgentTeamGenerationJob }>(
      `/api/agent-teams/generation-jobs/${encodeURIComponent(jobId)}`,
    );
    set((state) => ({
      generationJobs: [
        data.job,
        ...state.generationJobs.filter((job) => job.id !== data.job.id),
      ],
    }));
    return data.job;
  },

  execute: async (id, prompt, runnerAgentId, roleAssignments) => {
    set({ saving: true, error: null });
    try {
      const data = await api.post<{ execution: AgentTeamExecutionResult }>(
        `/api/agent-teams/${encodeURIComponent(id)}/execute`,
        { prompt, runnerAgentId, roleAssignments },
        600_000,
      );
      return data.execution;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      set({ saving: false });
    }
  },

  createRun: async (id, prompt, runnerAgentId, roleAssignments) => {
    set({ saving: true, error: null });
    try {
      return await api.post<AgentTeamRunResponse>(
        `/api/agent-teams/${encodeURIComponent(id)}/runs`,
        { prompt, runnerAgentId, roleAssignments },
        600_000,
      );
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      set({ saving: false });
    }
  },

  listRuns: async (filters = {}) => {
    const params = new URLSearchParams();
    if (filters.teamId) params.set('teamId', filters.teamId);
    if (filters.status) params.set('status', filters.status);
    if (filters.limit) params.set('limit', String(filters.limit));
    const suffix = params.toString() ? `?${params.toString()}` : '';
    const data = await api.get<{ runs: AgentTeamRun[] }>(
      `/api/agent-teams/runs${suffix}`,
    );
    return data.runs ?? [];
  },

  loadRun: async (runId) => {
    const data = await api.get<{ run: AgentTeamRun }>(
      `/api/agent-teams/runs/${encodeURIComponent(runId)}`,
    );
    return data.run;
  },

  loadRunTasks: async (runId) => {
    const data = await api.get<{ tasks: AgentTeamTaskView[] }>(
      `/api/agent-teams/runs/${encodeURIComponent(runId)}/tasks`,
    );
    return data.tasks ?? [];
  },

  loadRunEvents: async (runId) => {
    const data = await api.get<{
      events: NonNullable<AgentTeamExecutionResult['traceEvents']>;
    }>(`/api/agent-teams/runs/${encodeURIComponent(runId)}/events`);
    return data.events ?? [];
  },

  loadRunBlackboard: async (runId) => {
    const data = await api.get<{ entries: AgentTeamBlackboardEntry[] }>(
      `/api/agent-teams/runs/${encodeURIComponent(runId)}/blackboard`,
    );
    return data.entries ?? [];
  },

  loadRunApprovals: async (runId) => {
    const data = await api.get<{ approvals: AgentTeamApproval[] }>(
      `/api/agent-teams/runs/${encodeURIComponent(runId)}/approvals`,
    );
    return data.approvals ?? [];
  },

  loadRunCheckpoints: async (runId) => {
    const data = await api.get<{ checkpoints: AgentTeamCheckpoint[] }>(
      `/api/agent-teams/runs/${encodeURIComponent(runId)}/checkpoints`,
    );
    return data.checkpoints ?? [];
  },

  loadRunArtifacts: async (runId) => {
    const data = await api.get<{ artifacts: AgentTeamArtifact[] }>(
      `/api/agent-teams/runs/${encodeURIComponent(runId)}/artifacts`,
    );
    return data.artifacts ?? [];
  },

  loadMetrics: async (params = {}) => {
    const query = new URLSearchParams();
    if (params.teamId) query.set('teamId', params.teamId);
    if (params.since) query.set('since', params.since);
    if (params.until) query.set('until', params.until);
    if (params.limit) query.set('limit', String(params.limit));
    const suffix = query.toString() ? `?${query.toString()}` : '';
    const data = await api.get<{ metrics: AgentTeamMetricsSummary }>(
      `/api/agent-teams/metrics${suffix}`,
    );
    return data.metrics;
  },

  decideRunApproval: async (runId, approvalId, decision) => {
    set({ saving: true, error: null });
    try {
      return await api.post<AgentTeamRunResponse>(
        `/api/agent-teams/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(approvalId)}`,
        { decision },
        600_000,
      );
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      set({ saving: false });
    }
  },

  cancelRun: async (runId) => {
    set({ saving: true, error: null });
    try {
      return await api.post<{ run: AgentTeamRun }>(
        `/api/agent-teams/runs/${encodeURIComponent(runId)}/cancel`,
      );
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      set({ saving: false });
    }
  },

  update: async (id, patch) => {
    set({ saving: true, error: null });
    try {
      const data = await api.patch<{ team: AgentTeam }>(
        `/api/agent-teams/${encodeURIComponent(id)}`,
        patch,
      );
      await get().load();
      return data.team;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      set({ saving: false });
    }
  },

  remove: async (id, options = {}) => {
    set({ saving: true, error: null });
    try {
      const params = new URLSearchParams();
      if (options.deleteLinkedAgentMd) params.set('deleteLinkedAgentMd', 'true');
      const suffix = params.toString() ? `?${params.toString()}` : '';
      await api.delete(`/api/agent-teams/${encodeURIComponent(id)}${suffix}`);
      await get().load();
      if (options.deleteLinkedAgentMd) await get().loadAgentMdDefinitions();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      set({ saving: false });
    }
  },

  loadAgentMdDefinitions: async () => {
    set({ loading: true });
    try {
      const data = await api.get<{ definitions: AgentMdDefinition[] }>(
        '/api/agent-teams/agent-md',
      );
      set({
        agentMdDefinitions: data.definitions ?? [],
        loading: false,
        error: null,
      });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  createAgentMdDefinition: async (input) => {
    set({ saving: true, error: null });
    try {
      const data = await api.post<{ definition: AgentMdDefinition }>(
        '/api/agent-teams/agent-md',
        input,
      );
      await get().loadAgentMdDefinitions();
      return data.definition;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      set({ saving: false });
    }
  },

  listAgentMdStoreEntries: async (query = '') => {
    const entries = await loadAgentMdStoreEntries();
    return filterAgentMdStoreEntries(entries, query);
  },

  previewAgentMdStoreEntry: async (entry) => {
    const pathToPreview = entry.path.trim();
    if (!isAgencyAgentMarkdownPath(pathToPreview)) {
      throw new Error('unsupported agency-agents store path');
    }
    const source = agentMdStoreSourceById(entry.sourceId);
    const content = (await fetchTextWithTimeout(
      agentMdStoreRawUrl(source, pathToPreview),
      30_000,
    )).trim();
    return { ...entry, content };
  },

  importAgentMdFromStore: async (path, createdByAgentId, sourceId = 'agency-agents') => {
    set({ saving: true, error: null });
    try {
      const pathToImport = path.trim();
      if (!isAgencyAgentMarkdownPath(pathToImport)) {
        throw new Error('unsupported agency-agents store path');
      }
      const source = agentMdStoreSourceById(sourceId);
      const content = (await fetchTextWithTimeout(
        agentMdStoreRawUrl(source, pathToImport),
        30_000,
      )).trim();
      const frontmatter = parseFrontmatter(content);
      const data = await api.post<{ definition: AgentMdDefinition }>(
        '/api/agent-teams/agent-md',
        {
          name: frontmatter.name || titleFromAgentPath(pathToImport),
          summary: frontmatter.description || firstContentSentence(content),
          content,
          createdByAgentId,
        },
        30_000,
      );
      await get().loadAgentMdDefinitions();
      return data.definition;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      set({ saving: false });
    }
  },

  updateAgentMdDefinition: async (id, patch) => {
    set({ saving: true, error: null });
    try {
      const data = await api.patch<{ definition: AgentMdDefinition }>(
        `/api/agent-teams/agent-md/${encodeURIComponent(id)}`,
        patch,
      );
      await get().loadAgentMdDefinitions();
      return data.definition;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      set({ saving: false });
    }
  },

  removeAgentMdDefinition: async (id) => {
    set({ saving: true, error: null });
    try {
      await api.delete(`/api/agent-teams/agent-md/${encodeURIComponent(id)}`);
      await get().loadAgentMdDefinitions();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      set({ saving: false });
    }
  },
}));
