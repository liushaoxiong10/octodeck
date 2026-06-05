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
}

interface ReposState {
  repos: ManagedRepoInfo[];
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
  deleteRepo: (id: string) => Promise<boolean>;
}

export const useReposStore = create<ReposState>((set, get) => ({
  repos: [],
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
