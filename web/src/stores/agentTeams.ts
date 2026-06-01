import { create } from 'zustand';
import { api } from '../api/client';

export type AgentTeamShape = 'auto' | 'pipeline' | 'parallel' | 'leader-worker' | 'judge-route';

export interface AgentTeamRole {
  id: string;
  name: string;
  responsibility: string;
  inputs?: string[];
  outputs?: string[];
  skills?: string[];
  guardrails?: string[];
}

export interface AgentTeam {
  id: string;
  name: string;
  goal: string;
  shape: AgentTeamShape;
  description: string;
  roles: AgentTeamRole[];
  workflow: string;
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
  update: (id: string, patch: AgentTeamPatch) => Promise<AgentTeam>;
  remove: (id: string) => Promise<void>;
  loadAgentMdDefinitions: () => Promise<void>;
  createAgentMdDefinition: (input: AgentMdDefinitionInput) => Promise<AgentMdDefinition>;
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
