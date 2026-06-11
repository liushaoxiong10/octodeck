import { create } from 'zustand';
import { api } from '../api/client';

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  tools: string[];
  updatedAt: string;
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
}));
