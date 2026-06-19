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
    provider?: string;
    transport?: 'stdio' | 'acp' | 'a2a' | 'http';
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
    disks?: Array<{
      filesystem?: string;
      mountPoint: string;
      diskTotalBytes?: number;
      diskUsedBytes?: number;
      diskUsedPercent?: number;
    }>;
    collectedAt?: string;
  } | null;
  os: string | null;
  arch: string | null;
  hostname: string | null;
  clientVersion: string | null;
  lastConnectedAt: string | null;
  lastSeenAt: string | null;
  lastHeartbeatAt?: string | null;
  createdAt: string;
  online: boolean;
  status?: 'idle' | 'busy' | 'draining' | 'offline';
  runningRuns?: Array<{
    runId: string;
    backendId?: string;
    cwd?: string;
    status?: string;
    startedAt?: string;
    lastActivityAt?: string;
  }>;
  maxConcurrentRuns?: number | null;
  availableSlots?: number | null;
  runtimes?: Array<{
    runtimeId: string;
    deviceLinkId: string;
    agentClientId: string;
    displayName?: string;
    provider?: string;
    transport?: 'stdio' | 'acp' | 'a2a' | 'http';
    status: 'idle' | 'busy' | 'draining' | 'offline';
    maxConcurrentRuns?: number;
    availableSlots?: number;
    runningRuns?: AgentLink['runningRuns'];
  }>;
  builtin?: boolean;
  updateAvailable?: boolean;
  latestVersion?: string | null;
  updateCommand?: string;
  uninstallCommand?: string;
}

export interface RuntimePoolSnapshot {
  summary: {
    totalRuntimes: number;
    onlineRuntimes: number;
    busyRuntimes: number;
    degradedRuntimes: number;
    recoverableRuntimes: number;
    availableSlots: number;
    admissibleSlots: number;
    runningRuns: number;
  };
  quota?: {
    userId?: string;
    maxConcurrentRuns: number;
    runningRuns: number;
    remainingRuns: number;
    saturated: boolean;
  };
  assignment?: {
    recommendedRuntimeId: string | null;
    executionNode: string | null;
    deviceLinkId?: string;
    agentClientId?: string;
    backendId?: string;
    reason: 'matched_preferred_agent' | 'best_available' | 'no_eligible_runtime';
  };
  runtimes: Array<{
    runtimeId: string;
    kind: 'server' | 'device';
    deviceLinkId?: string;
    deviceName?: string;
    backendId?: string;
    agentClientId: string;
    displayName: string;
    provider?: string;
    transport?: 'stdio' | 'acp' | 'a2a' | 'http';
    status: 'idle' | 'busy' | 'draining' | 'offline';
    health: 'available' | 'busy' | 'draining' | 'offline' | 'full' | 'degraded';
    scheduling: {
      eligible: boolean;
      blockedReason?: 'runtime_offline' | 'runtime_draining' | 'runtime_full' | 'runtime_degraded' | 'quota_exhausted';
    };
    recovery: {
      action: 'none' | 'wait_for_reconnect' | 'respect_drain' | 'wait_for_heartbeat' | 'wait_for_capacity' | 'wait_for_quota';
      retryable: boolean;
      failoverEligible: boolean;
      reason: string;
    };
    maxConcurrentRuns?: number;
    availableSlots?: number;
    lastHeartbeatAt?: string;
    heartbeatAgeMs?: number;
    runningRuns: NonNullable<AgentLink['runningRuns']>;
  }>;
}

export interface DaemonVersionInfo {
  version: string;
  updateCommand: string;
  uninstallCommand: string;
  installCommand: string;
}

export interface AgentRuntimeSession {
  id: string;
  agentId: string;
  workspace: string;
  title?: string;
  provider?: string;
  path: string;
  updatedAt?: string;
  sizeBytes?: number;
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
  runtimePool: RuntimePoolSnapshot | null;
  loading: boolean;
  error: string | null;

  load: () => Promise<void>;
  loadRuntimePool: () => Promise<RuntimePoolSnapshot | null>;
  create: (displayName: string) => Promise<AgentLinkCreateResponse>;
  rotate: (id: string) => Promise<AgentLinkRotateResponse>;
  remove: (id: string) => Promise<void>;
  getDaemonVersion: () => Promise<DaemonVersionInfo>;
  discoverAgents: (id: string) => Promise<AgentLink['agentClients']>;
  listAgentSessions: (
    id: string,
    opts?: { agentId?: string; workspace?: string },
  ) => Promise<AgentRuntimeSession[]>;
  deleteAgentSession: (
    id: string,
    agentId: string,
    sessionId: string,
    workspace: string,
  ) => Promise<boolean>;
}

export const useAgentLinksStore = create<AgentLinksState>((set, get) => ({
  links: [],
  runtimePool: null,
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

  loadRuntimePool: async () => {
    try {
      const data = await api.get<{ runtimePool: RuntimePoolSnapshot }>('/api/devices/runtime-pool');
      set({ runtimePool: data.runtimePool, error: null });
      return data.runtimePool;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
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

  getDaemonVersion: async () =>
    api.get<DaemonVersionInfo>('/api/daemon/version'),

  discoverAgents: async (id) => {
    const res = await api.post<{ agents: AgentLink['agentClients'] }>(
      `/api/devices/${encodeURIComponent(id)}/agents/discover`,
      undefined,
      20_000,
    );
    await get().load();
    return res.agents ?? [];
  },

  listAgentSessions: async (id, opts) => {
    const params = new URLSearchParams();
    if (opts?.agentId) params.set('agentId', opts.agentId);
    if (opts?.workspace) params.set('workspace', opts.workspace);
    const query = params.toString();
    const res = await api.get<{ sessions: AgentRuntimeSession[] }>(
      `/api/devices/${encodeURIComponent(id)}/agents/sessions${query ? `?${query}` : ''}`,
    );
    return res.sessions ?? [];
  },

  deleteAgentSession: async (id, agentId, sessionId, workspace) => {
    const res = await api.delete<{ deleted: boolean }>(
      `/api/devices/${encodeURIComponent(id)}/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}?workspace=${encodeURIComponent(workspace)}`,
      20_000,
    );
    return !!res.deleted;
  },
}));
