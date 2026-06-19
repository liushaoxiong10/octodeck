import { create } from 'zustand';
import { api } from '../api/client';

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  tools: string[];
  requiredSkills?: AgentRegistryRequiredSkill[];
  version?: string;
  visibility?: string;
  defaultModel?: string | null;
  updatedAt: string;
}

export interface AgentRegistryRequiredSkill {
  id: string;
  requestedVersion: string | null;
  raw?: string;
  installed: boolean;
  installedVersion: string | null;
  versionSatisfied: boolean | null;
  packageId: string | null;
}

export interface AgentRegistrySnapshot {
  summary: {
    totalAgents: number;
    totalSkillPackages: number;
    unresolvedSkillDependencies: number;
    dependencyConflicts: number;
  };
  agents: Array<AgentDefinition & { requiredSkills: AgentRegistryRequiredSkill[] }>;
  dependencyConflicts: Array<{
    agentId: string;
    skillId: string;
    requestedVersion: string | null;
    installedVersion: string | null;
    packageId: string | null;
  }>;
  skillPackages: Array<{
    id: string;
    name: string;
    source: string | null;
    skillIds: string[];
    version: string | null;
    author: string | null;
    checksum: string;
    fileCount: number;
    totalBytes: number;
    fileManifest: Array<{
      skillId: string;
      name: string;
      type: 'file' | 'directory';
      size: number;
    }>;
    providerTargets: string[];
    installRecords: Array<{
      skillId: string;
      target: 'cloud' | 'device' | string;
      provider: string | null;
      installedAt: string;
    }>;
    updatedAt: string;
  }>;
}

export interface AgentDefinitionGovernance {
  agentId: string;
  versions: Array<{
    id: string;
    agentId: string;
    version: string;
    checksum: string;
    createdAt: string;
    createdBy: string;
    sourceAction: 'create' | 'update' | 'delete' | 'rollback' | string;
  }>;
  auditEvents: Array<{
    id: string;
    agentId: string;
    action: 'create' | 'update' | 'delete' | 'rollback' | string;
    actorUserId: string;
    actorUsername: string;
    fromVersion: string | null;
    toVersion: string | null;
    rollbackVersionId?: string;
    approval: {
      status: 'approved' | string;
      approvedBy: string;
      approvedAt: string;
    };
    createdAt: string;
  }>;
}

export interface AgentDefinitionDetail extends AgentDefinition {
  content: string;
}

export interface MarketplaceAgent {
  id: string;
  dept: string;
  name: string;
  path: string;
  description: string;
  installed: boolean;
}

export interface MarketplaceAgentDetail extends MarketplaceAgent {
  content: string | null;
  readme?: string | null;
}

export interface InstallMarketplaceResult {
  success: boolean;
  id?: string;
  conflict?: boolean;
  overwrote?: boolean;
  error?: string;
}

interface AgentDefinitionsState {
  agents: AgentDefinition[];
  loading: boolean;
  error: string | null;

  marketplaceAgents: MarketplaceAgent[];
  marketplaceDepartments: string[];
  marketplaceLoading: boolean;
  marketplaceError: string | null;
  marketplaceDetailLoading: Record<string, boolean>;
  marketplaceDetails: Record<string, MarketplaceAgentDetail>;
  marketplaceInstalling: Record<string, boolean>;

  registry: AgentRegistrySnapshot | null;
  registryLoading: boolean;
  registryError: string | null;
  agentGovernance: Record<string, AgentDefinitionGovernance>;
  governanceLoading: Record<string, boolean>;

  loadAgents: () => Promise<void>;
  getAgentDetail: (id: string) => Promise<AgentDefinitionDetail>;
  updateAgent: (id: string, content: string) => Promise<void>;
  createAgent: (name: string, content: string) => Promise<string>;
  deleteAgent: (id: string) => Promise<void>;

  loadMarketplaceCatalog: (q?: string, dept?: string) => Promise<void>;
  getMarketplaceDetail: (agentId: string) => Promise<MarketplaceAgentDetail>;
  installMarketplaceAgent: (
    agentId: string,
    opts?: { force?: boolean; keepOriginalId?: boolean },
  ) => Promise<InstallMarketplaceResult>;
  loadRegistry: () => Promise<void>;
  loadAgentGovernance: (id: string) => Promise<AgentDefinitionGovernance>;
  rollbackAgentDefinition: (id: string, versionId: string) => Promise<void>;
}

export const useAgentDefinitionsStore = create<AgentDefinitionsState>((set, get) => ({
  agents: [],
  loading: false,
  error: null,

  marketplaceAgents: [],
  marketplaceDepartments: [],
  marketplaceLoading: false,
  marketplaceError: null,
  marketplaceDetailLoading: {},
  marketplaceDetails: {},
  marketplaceInstalling: {},

  registry: null,
  registryLoading: false,
  registryError: null,
  agentGovernance: {},
  governanceLoading: {},

  loadAgents: async () => {
    set({ loading: true });
    try {
      const data = await api.get<{ agents: AgentDefinition[] }>('/api/agent-definitions');
      set({ agents: data.agents, loading: false, error: null });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  getAgentDetail: async (id: string) => {
    const data = await api.get<{ agent: AgentDefinitionDetail }>(`/api/agent-definitions/${id}`);
    return data.agent;
  },

  updateAgent: async (id: string, content: string) => {
    try {
      await api.put(`/api/agent-definitions/${id}`, { content });
      set({ error: null });
      await get().loadAgents();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  createAgent: async (name: string, content: string) => {
    try {
      const data = await api.post<{ success: boolean; id: string }>('/api/agent-definitions', { name, content });
      set({ error: null });
      await get().loadAgents();
      return data.id;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  deleteAgent: async (id: string) => {
    try {
      await api.delete(`/api/agent-definitions/${id}`);
      set({ error: null });
      await get().loadAgents();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  loadMarketplaceCatalog: async (q = '', dept = '') => {
    set({ marketplaceLoading: true, marketplaceError: null });
    try {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (dept) params.set('dept', dept);
      const qs = params.toString();
      const data = await api.get<{
        total: number;
        departments: string[];
        agents: MarketplaceAgent[];
      }>(`/api/agent-definitions/marketplace/catalog${qs ? `?${qs}` : ''}`);
      set({
        marketplaceAgents: data.agents,
        marketplaceDepartments: data.departments,
        marketplaceLoading: false,
      });
    } catch (err) {
      set({
        marketplaceLoading: false,
        marketplaceError: err instanceof Error ? err.message : String(err),
      });
    }
  },

  getMarketplaceDetail: async (agentId: string) => {
    set((s) => ({
      marketplaceDetailLoading: { ...s.marketplaceDetailLoading, [agentId]: true },
    }));
    try {
      const data = await api.get<{ agent: MarketplaceAgentDetail }>(
        `/api/agent-definitions/marketplace/${encodeURIComponent(agentId)}`,
      );
      set((s) => ({
        marketplaceDetails: { ...s.marketplaceDetails, [agentId]: data.agent },
        marketplaceDetailLoading: { ...s.marketplaceDetailLoading, [agentId]: false },
      }));
      return data.agent;
    } catch (err) {
      set((s) => ({
        marketplaceDetailLoading: { ...s.marketplaceDetailLoading, [agentId]: false },
      }));
      throw err;
    }
  },

  installMarketplaceAgent: async (agentId, opts = {}) => {
    set((s) => ({
      marketplaceInstalling: { ...s.marketplaceInstalling, [agentId]: true },
    }));
    try {
      const result = await api.post<InstallMarketplaceResult>(
        '/api/agent-definitions/marketplace/install',
        { agentId, force: !!opts.force, keepOriginalId: !!opts.keepOriginalId },
      );
      // Refresh installed state of both lists
      await get().loadAgents();
      void get().loadMarketplaceCatalog();
      return result;
    } finally {
      set((s) => {
        const next = { ...s.marketplaceInstalling };
        delete next[agentId];
        return { marketplaceInstalling: next };
      });
    }
  },

  loadRegistry: async () => {
    set({ registryLoading: true, registryError: null });
    try {
      const data = await api.get<{ registry: AgentRegistrySnapshot }>('/api/agent-definitions/registry');
      set({ registry: data.registry, registryLoading: false });
    } catch (err) {
      set({ registryLoading: false, registryError: err instanceof Error ? err.message : String(err) });
    }
  },

  loadAgentGovernance: async (id: string) => {
    set((s) => ({ governanceLoading: { ...s.governanceLoading, [id]: true } }));
    try {
      const data = await api.get<{ governance: AgentDefinitionGovernance }>(
        `/api/agent-definitions/${encodeURIComponent(id)}/governance`,
      );
      set((s) => ({
        agentGovernance: { ...s.agentGovernance, [id]: data.governance },
        governanceLoading: { ...s.governanceLoading, [id]: false },
      }));
      return data.governance;
    } catch (err) {
      set((s) => ({ governanceLoading: { ...s.governanceLoading, [id]: false } }));
      throw err;
    }
  },

  rollbackAgentDefinition: async (id: string, versionId: string) => {
    await api.post(`/api/agent-definitions/${encodeURIComponent(id)}/rollback`, { versionId });
    await get().loadAgents();
    await get().loadRegistry();
    await get().loadAgentGovernance(id);
  },
}));
