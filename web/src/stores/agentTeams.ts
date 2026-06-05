import { create } from 'zustand';
import { api } from '../api/client';

export type AgentTeamShape = 'auto' | 'pipeline' | 'parallel' | 'leader-worker' | 'judge-route';

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

export interface AgentTeamWorkflowStep {
  id: string;
  type: 'role' | 'parallel' | 'route';
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
  createdAt: string;
  updatedAt: string;
}

export interface AgentMdStoreEntry {
  id: string;
  path: string;
  name: string;
  summary: string;
  category: string;
  size: number;
  sourceUrl: string;
}

export interface AgentTeamExecutionResult {
  status: 'success' | 'error';
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
  status: 'running' | 'waiting_approval' | 'paused' | 'success' | 'error' | 'cancelled';
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

export type AgentTeamInput = Omit<AgentTeam, 'id' | 'createdAt' | 'updatedAt'>;
export type AgentTeamPatch = Partial<AgentTeamInput>;
export type AgentMdDefinitionInput = Omit<AgentMdDefinition, 'id' | 'createdAt' | 'updatedAt'>;
export type AgentMdDefinitionPatch = Partial<AgentMdDefinitionInput>;

interface AgentTeamsState {
  teams: AgentTeam[];
  agentMdDefinitions: AgentMdDefinition[];
  loading: boolean;
  saving: boolean;
  error: string | null;
  load: () => Promise<void>;
  generate: (input: { generatorAgentId: string; goal: string; shape: AgentTeamShape }) => Promise<AgentTeam>;
  execute: (id: string, prompt: string, runnerAgentId?: string, roleAssignments?: Record<string, AgentTeamRoleAssignment>) => Promise<AgentTeamExecutionResult>;
  createRun: (id: string, prompt: string, runnerAgentId?: string, roleAssignments?: Record<string, AgentTeamRoleAssignment>) => Promise<AgentTeamRunResponse>;
  listRuns: (filters?: { teamId?: string; status?: AgentTeamRun['status']; limit?: number }) => Promise<AgentTeamRun[]>;
  loadRun: (runId: string) => Promise<AgentTeamRun>;
  loadRunTasks: (runId: string) => Promise<AgentTeamTaskView[]>;
  loadRunEvents: (runId: string) => Promise<NonNullable<AgentTeamExecutionResult['traceEvents']>>;
  loadRunBlackboard: (runId: string) => Promise<AgentTeamBlackboardEntry[]>;
  loadRunApprovals: (runId: string) => Promise<AgentTeamApproval[]>;
  loadRunCheckpoints: (runId: string) => Promise<AgentTeamCheckpoint[]>;
  decideRunApproval: (runId: string, approvalId: string, decision: 'approved' | 'rejected') => Promise<AgentTeamRunResponse>;
  cancelRun: (runId: string) => Promise<{ run: AgentTeamRun }>;
  update: (id: string, patch: AgentTeamPatch) => Promise<AgentTeam>;
  remove: (id: string) => Promise<void>;
  loadAgentMdDefinitions: () => Promise<void>;
  createAgentMdDefinition: (input: AgentMdDefinitionInput) => Promise<AgentMdDefinition>;
  listAgentMdStoreEntries: (query?: string) => Promise<AgentMdStoreEntry[]>;
  importAgentMdFromStore: (path: string, createdByAgentId: string) => Promise<AgentMdDefinition>;
  updateAgentMdDefinition: (id: string, patch: AgentMdDefinitionPatch) => Promise<AgentMdDefinition>;
  removeAgentMdDefinition: (id: string) => Promise<void>;
}

export const useAgentTeamsStore = create<AgentTeamsState>((set, get) => ({
  teams: [],
  agentMdDefinitions: [],
  loading: false,
  saving: false,
  error: null,

  load: async () => {
    set({ loading: true });
    try {
      const data = await api.get<{ teams: AgentTeam[] }>('/api/agent-teams');
      set({ teams: data.teams ?? [], loading: false, error: null });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  generate: async (input) => {
    set({ saving: true, error: null });
    try {
      const data = await api.post<{ team: AgentTeam; agentMdDefinitions?: AgentMdDefinition[] }>('/api/agent-teams/generate', input, 600_000);
      await get().load();
      await get().loadAgentMdDefinitions();
      return data.team;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      set({ saving: false });
    }
  },

  execute: async (id, prompt, runnerAgentId, roleAssignments) => {
    set({ saving: true, error: null });
    try {
      const data = await api.post<{ execution: AgentTeamExecutionResult }>(`/api/agent-teams/${encodeURIComponent(id)}/execute`, { prompt, runnerAgentId, roleAssignments }, 600_000);
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
      return await api.post<AgentTeamRunResponse>(`/api/agent-teams/${encodeURIComponent(id)}/runs`, { prompt, runnerAgentId, roleAssignments }, 600_000);
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
    const data = await api.get<{ runs: AgentTeamRun[] }>(`/api/agent-teams/runs${suffix}`);
    return data.runs ?? [];
  },

  loadRun: async (runId) => {
    const data = await api.get<{ run: AgentTeamRun }>(`/api/agent-teams/runs/${encodeURIComponent(runId)}`);
    return data.run;
  },

  loadRunTasks: async (runId) => {
    const data = await api.get<{ tasks: AgentTeamTaskView[] }>(`/api/agent-teams/runs/${encodeURIComponent(runId)}/tasks`);
    return data.tasks ?? [];
  },

  loadRunEvents: async (runId) => {
    const data = await api.get<{ events: NonNullable<AgentTeamExecutionResult['traceEvents']> }>(`/api/agent-teams/runs/${encodeURIComponent(runId)}/events`);
    return data.events ?? [];
  },

  loadRunBlackboard: async (runId) => {
    const data = await api.get<{ entries: AgentTeamBlackboardEntry[] }>(`/api/agent-teams/runs/${encodeURIComponent(runId)}/blackboard`);
    return data.entries ?? [];
  },

  loadRunApprovals: async (runId) => {
    const data = await api.get<{ approvals: AgentTeamApproval[] }>(`/api/agent-teams/runs/${encodeURIComponent(runId)}/approvals`);
    return data.approvals ?? [];
  },

  loadRunCheckpoints: async (runId) => {
    const data = await api.get<{ checkpoints: AgentTeamCheckpoint[] }>(`/api/agent-teams/runs/${encodeURIComponent(runId)}/checkpoints`);
    return data.checkpoints ?? [];
  },

  decideRunApproval: async (runId, approvalId, decision) => {
    set({ saving: true, error: null });
    try {
      return await api.post<AgentTeamRunResponse>(`/api/agent-teams/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(approvalId)}`, { decision }, 600_000);
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
      return await api.post<{ run: AgentTeamRun }>(`/api/agent-teams/runs/${encodeURIComponent(runId)}/cancel`);
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
      const data = await api.patch<{ team: AgentTeam }>(`/api/agent-teams/${encodeURIComponent(id)}`, patch);
      await get().load();
      return data.team;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      set({ saving: false });
    }
  },

  remove: async (id) => {
    set({ saving: true, error: null });
    try {
      await api.delete(`/api/agent-teams/${encodeURIComponent(id)}`);
      await get().load();
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
      const data = await api.get<{ definitions: AgentMdDefinition[] }>('/api/agent-teams/agent-md');
      set({ agentMdDefinitions: data.definitions ?? [], loading: false, error: null });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  createAgentMdDefinition: async (input) => {
    set({ saving: true, error: null });
    try {
      const data = await api.post<{ definition: AgentMdDefinition }>('/api/agent-teams/agent-md', input);
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
    const params = new URLSearchParams();
    if (query.trim()) params.set('query', query.trim());
    const suffix = params.toString() ? `?${params.toString()}` : '';
    const data = await api.get<{ entries: AgentMdStoreEntry[] }>(`/api/agent-teams/agent-md-store${suffix}`);
    return data.entries ?? [];
  },

  importAgentMdFromStore: async (path, createdByAgentId) => {
    set({ saving: true, error: null });
    try {
      const data = await api.post<{ definition: AgentMdDefinition }>('/api/agent-teams/agent-md-store/import', { path, createdByAgentId }, 30_000);
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
      const data = await api.patch<{ definition: AgentMdDefinition }>(`/api/agent-teams/agent-md/${encodeURIComponent(id)}`, patch);
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
