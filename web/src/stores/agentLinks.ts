import { create } from 'zustand';
import { api } from '../api/client';

export interface AgentLink {
  id: string;
  displayName: string;
  capabilities: string[];
  agentClients: Array<{
    id: string;
    displayName: string;
    binary: string;
    version?: string;
    permissionModes?: string[];
    capabilities?: string[];
  }>;
  resources: {
    cpuCount?: number;
    cpuUsedPercent?: number;
    load1?: number;
    load5?: number;
    load15?: number;
    memoryTotalBytes?: number;
    memoryUsedBytes?: number;
    memoryUsedPercent?: number;
    diskTotalBytes?: number;
    diskUsedBytes?: number;
    diskUsedPercent?: number;
    collectedAt?: string;
  } | null;
  os: string | null;
  arch: string | null;
  hostname: string | null;
  clientVersion: string | null;
  lastConnectedAt: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  online: boolean;
  builtin?: boolean;
}

interface AgentLinkCreateResponse {
  id: string;
  displayName: string;
  token: string;
}

interface AgentLinkRotateResponse {
  id: string;
  token: string;
}

interface AgentLinksState {
  links: AgentLink[];
  loading: boolean;
  error: string | null;

  load: () => Promise<void>;
  create: (displayName: string) => Promise<AgentLinkCreateResponse>;
  rotate: (id: string) => Promise<AgentLinkRotateResponse>;
  remove: (id: string) => Promise<void>;
}

export const useAgentLinksStore = create<AgentLinksState>((set, get) => ({
  links: [],
  loading: false,
  error: null,

  load: async () => {
    set({ loading: true });
    try {
      const data = await api.get<{ links: AgentLink[] }>('/api/devices');
      set({ links: data.links ?? [], loading: false, error: null });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  create: async (displayName) => {
    const res = await api.post<AgentLinkCreateResponse>('/api/devices', {
      displayName,
    });
    await get().load();
    return res;
  },

  rotate: async (id) => {
    const res = await api.post<AgentLinkRotateResponse>(
      `/api/devices/${encodeURIComponent(id)}/rotate`,
    );
    await get().load();
    return res;
  },

  remove: async (id) => {
    await api.delete(`/api/devices/${encodeURIComponent(id)}`);
    await get().load();
  },
}));
