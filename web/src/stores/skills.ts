import { create } from 'zustand';
import { api } from '../api/client';

export interface Skill {
  id: string;
  name: string;
  description: string;
  source: 'cloud' | 'user' | 'project' | 'external' | 'cli' | 'workspace';
  enabled: boolean;
  packageName?: string;
  packageSource?: string;
  sourceProvider?: string;
  level?: 'package' | 'skill';
  levelKey?: string;
  installedAt?: string;
  content?: string;
  deviceId?: string;
  workspacePath?: string;
  userInvocable: boolean;
  allowedTools: string[];
  argumentHint: string | null;
  updatedAt: string;
  files: Array<{ name: string; type: 'file' | 'directory'; size: number }>;
}

export interface SkillDetail extends Skill {
  content: string;
}

export interface SearchResult {
  package: string;
  url: string;
  description?: string;
  installs?: number;
  skillId?: string;
  source?: string;
}

export interface SearchResultDetail {
  description: string;
  skillName?: string;
  readme?: string;
  installs: string;
  age: string;
  features: string[];
}

export interface InstallSkillOptions {
  target?: 'cloud' | 'device' | 'device-agent-workspace';
  deviceLinkId?: string;
  agentId?: string;
  sourceProvider?: 'claude' | 'codex' | 'traecli';
  selectedSkillIds?: string[];
}

interface SkillsState {
  skills: Skill[];
  loading: boolean;
  error: string | null;
  installing: boolean;
  searching: boolean;
  searchResults: SearchResult[];
  searchDetails: Record<string, SearchResultDetail | null>;
  searchDetailLoading: Record<string, boolean>;

  loadSkills: () => Promise<void>;
  toggleSkill: (id: string, enabled: boolean) => Promise<void>;
  deleteSkill: (id: string) => Promise<void>;
  installSkill: (pkg: string, options?: InstallSkillOptions) => Promise<void>;
  reinstallSkill: (id: string) => Promise<void>;
  deleteAllUserSkills: () => Promise<number>;
  getSkillDetail: (id: string) => Promise<SkillDetail>;
  searchSkills: (query: string) => Promise<void>;
  fetchSearchDetail: (result: SearchResult) => Promise<void>;
}

export const useSkillsStore = create<SkillsState>((set, get) => ({
  skills: [],
  loading: false,
  error: null,
  installing: false,
  searching: false,
  searchResults: [],
  searchDetails: {},
  searchDetailLoading: {},

  loadSkills: async () => {
    set({ loading: true });
    try {
      const data = await api.get<{ skills: Skill[] }>('/api/skills');
      set({ skills: data.skills, loading: false, error: null });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  toggleSkill: async (id: string, enabled: boolean) => {
    try {
      await api.patch(`/api/skills/${id}`, { enabled });
      set({ error: null });
      await get().loadSkills();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  deleteSkill: async (id: string) => {
    try {
      await api.delete(`/api/skills/${id}`);
      set({ error: null });
      await get().loadSkills();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  installSkill: async (pkg: string, options?: InstallSkillOptions) => {
    set({ installing: true, error: null });
    try {
      await api.post('/api/skills/install', { package: pkg, ...options }, 120_000);
      await get().loadSkills();
    } catch (err: any) {
      set({ error: err?.message || (err instanceof Error ? err.message : '安装失败，请稍后重试') });
      throw err;
    } finally {
      set({ installing: false });
    }
  },

  reinstallSkill: async (id: string) => {
    set({ installing: true, error: null });
    try {
      await api.post(`/api/skills/${id}/reinstall`, {}, 60_000);
      await get().loadSkills();
    } catch (err: any) {
      set({ error: err?.message || '重新安装失败，请稍后重试' });
      throw err;
    } finally {
      set({ installing: false });
    }
  },

  deleteAllUserSkills: async () => {
    const result = await api.delete<{ deleted: number }>('/api/skills/user-all');
    await get().loadSkills();
    return result.deleted;
  },

  getSkillDetail: async (id: string) => {
    const data = await api.get<{ skill: SkillDetail }>(`/api/skills/${id}`);
    return data.skill;
  },

  searchSkills: async (query: string) => {
    set({ searching: true, searchResults: [], searchDetails: {}, searchDetailLoading: {} });
    try {
      const data = await api.get<{ results: SearchResult[] }>(
        `/api/skills/search?q=${encodeURIComponent(query)}`,
      );
      set({ searching: false, searchResults: data.results });
    } catch {
      set({ searching: false, searchResults: [] });
    }
  },

  fetchSearchDetail: async (result: SearchResult) => {
    const key = result.package;
    const { searchDetails, searchDetailLoading } = get();
    if (key in searchDetails || searchDetailLoading[key]) return;

    set({ searchDetailLoading: { ...get().searchDetailLoading, [key]: true } });
    try {
      // Use source/skillId params if available (new API), fallback to url
      const params = result.source && result.skillId
        ? `source=${encodeURIComponent(result.source)}&skillId=${encodeURIComponent(result.skillId)}`
        : result.url
          ? `url=${encodeURIComponent(result.url)}`
          : '';

      if (!params) {
        set({
          searchDetails: { ...get().searchDetails, [key]: null },
          searchDetailLoading: { ...get().searchDetailLoading, [key]: false },
        });
        return;
      }

      const data = await api.get<{ detail: SearchResultDetail | null }>(
        `/api/skills/search/detail?${params}`,
      );
      set({
        searchDetails: { ...get().searchDetails, [key]: data.detail },
        searchDetailLoading: { ...get().searchDetailLoading, [key]: false },
      });
    } catch {
      set({
        searchDetails: { ...get().searchDetails, [key]: null },
        searchDetailLoading: { ...get().searchDetailLoading, [key]: false },
      });
    }
  },
}));
