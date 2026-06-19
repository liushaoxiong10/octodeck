import { create } from 'zustand';

import { api } from '../api/client';
import type { RuntimePoolSnapshot } from './agentLinks';

export type RegistryRiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type RegistryItemKind = 'agent' | 'skill' | 'runtime';

export interface RegistryCapabilityItem {
  id: string;
  kind: RegistryItemKind;
  source: 'builtin' | 'local' | 'cloud' | 'device' | 'server' | 'marketplace';
  sourceId: string;
  displayName: string;
  description: string;
  version: string | null;
  capabilities: string[];
  permissionScopes: string[];
  riskLevel: RegistryRiskLevel;
  compatibleRuntimeIds: string[];
  runtimeCompatibility: {
    compatible: number;
    total: number;
    blockedRuntimeIds: string[];
  };
  minimumOctodeckVersion?: string | null;
  updatedAt: string;
}

export interface RegistrySnapshot {
  summary: {
    totalAgents: number;
    totalSkillPackages: number;
    unresolvedSkillDependencies: number;
    dependencyConflicts: number;
    totalRegistryItems: number;
    highRiskItems: number;
    compatibleRuntimeLinks: number;
  };
  capabilityCatalog: RegistryCapabilityItem[];
  dependencyConflicts: Array<{
    agentId: string;
    skillId: string;
    requestedVersion: string | null;
    installedVersion: string | null;
    packageId: string | null;
  }>;
}

interface RegistryState {
  registry: RegistrySnapshot | null;
  runtimePool: RuntimePoolSnapshot | null;
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
}

export const useRegistryStore = create<RegistryState>((set) => ({
  registry: null,
  runtimePool: null,
  loading: false,
  error: null,
  load: async () => {
    set({ loading: true, error: null });
    try {
      const data = await api.get<{ registry: RegistrySnapshot; runtimePool: RuntimePoolSnapshot }>('/api/registry');
      set({ registry: data.registry, runtimePool: data.runtimePool, loading: false });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },
}));
