import { create } from 'zustand';
import { api } from '../api/client';

export interface CustomBackendDef {
  id: string;
  displayName: string;
  binary: string;
  argvTemplate: string[];
  outputProtocol: 'jsonline-stream-json' | 'plain-text';
  supportsHost: boolean;
  supportsContainer: boolean;
  usesProviderPool: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: Record<string, string>;
  runtime?: 'local-device' | 'server-side';
  model?: string;
  supportsNativeSessions?: boolean;
  sessionArgvTemplate?: string[];
  resumeArgvTemplate?: string[];
  workdirMode?: 'auto' | 'custom';
  workdir?: string;
  deviceLinkId?: string | null;
  agentClientId?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export type CustomBackendCreateInput = Omit<
  CustomBackendDef,
  | 'createdAt'
  | 'updatedAt'
  | 'supportsContainer'
  | 'binary'
  | 'argvTemplate'
  | 'outputProtocol'
  | 'usesProviderPool'
> & {
  binary?: string;
  argvTemplate?: string[];
  outputProtocol?: CustomBackendDef['outputProtocol'];
  usesProviderPool?: boolean;
  supportsContainer?: false;
};

export type CustomBackendPatchInput = Partial<
  Omit<CustomBackendDef, 'id' | 'createdAt' | 'updatedAt' | 'supportsContainer'>
> & {
  supportsContainer?: false;
};

interface CustomBackendsState {
  backends: CustomBackendDef[];
  loading: boolean;
  error: string | null;

  load: () => Promise<void>;
  create: (input: CustomBackendCreateInput) => Promise<CustomBackendDef>;
  update: (id: string, patch: CustomBackendPatchInput) => Promise<CustomBackendDef>;
  remove: (id: string) => Promise<void>;
}

export const useCustomBackendsStore = create<CustomBackendsState>((set, get) => ({
  backends: [],
  loading: false,
  error: null,

  load: async () => {
    set({ loading: true });
    try {
      const data = await api.get<{ backends: CustomBackendDef[] }>(
        '/api/config/custom-backends',
      );
      set({ backends: data.backends ?? [], loading: false, error: null });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  create: async (input) => {
    const def = await api.post<CustomBackendDef>(
      '/api/config/custom-backends',
      input,
    );
    await get().load();
    return def;
  },

  update: async (id, patch) => {
    const def = await api.patch<CustomBackendDef>(
      `/api/config/custom-backends/${encodeURIComponent(id)}`,
      patch,
    );
    await get().load();
    return def;
  },

  remove: async (id) => {
    await api.delete(`/api/config/custom-backends/${encodeURIComponent(id)}`);
    await get().load();
  },
}));
