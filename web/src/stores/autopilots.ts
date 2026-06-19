import { create } from 'zustand';
import { api } from '../api/client';

export type AutopilotTriggerType = 'schedule' | 'webhook' | 'manual' | 'api';
export type AutopilotActionType = 'create_issue' | 'run_agent' | 'run_agent_team';
export type AutopilotStatus = 'active' | 'paused' | 'deleted';
export type AutopilotRunStatus = 'running' | 'success' | 'error' | 'skipped';

export interface Autopilot {
  id: string;
  name: string;
  description?: string | null;
  trigger: Record<string, unknown> & { type?: AutopilotTriggerType; next_run?: string | null };
  action: Record<string, unknown> & { type?: AutopilotActionType };
  status: AutopilotStatus;
  created_by: string;
  created_at: string;
  updated_at: string;
  last_run_id?: string | null;
  last_run_status?: AutopilotRunStatus | null;
  last_run_at?: string | null;
}

export interface AutopilotRun {
  id: string;
  autopilot_id: string;
  trigger_type: AutopilotTriggerType;
  status: AutopilotRunStatus;
  retry_of?: string | null;
  attempt: number;
  payload?: Record<string, unknown> | null;
  result?: Record<string, unknown> | null;
  error?: string | null;
  skip_reason?: string | null;
  created_by: string;
  created_at: string;
  completed_at?: string | null;
}

export interface AutopilotTemplate {
  id: string;
  name: string;
  description: string;
  triggerType: AutopilotTriggerType;
  actionType: AutopilotActionType;
  trigger: Record<string, unknown>;
  action: Record<string, unknown>;
}

interface AutopilotsState {
  autopilots: Autopilot[];
  templates: AutopilotTemplate[];
  runs: Record<string, AutopilotRun[]>;
  loading: boolean;
  error: string | null;
  loadAutopilots: () => Promise<void>;
  loadTemplates: () => Promise<void>;
  loadRuns: (autopilotId: string) => Promise<void>;
  installTemplate: (templateId: string, name?: string) => Promise<Autopilot>;
  retryRun: (autopilotId: string, runId: string) => Promise<AutopilotRun>;
}

export const useAutopilotsStore = create<AutopilotsState>((set, get) => ({
  autopilots: [],
  templates: [],
  runs: {},
  loading: false,
  error: null,

  loadAutopilots: async () => {
    set({ loading: true, error: null });
    try {
      const data = await api.get<{ autopilots: Autopilot[] }>('/api/autopilots');
      set({ autopilots: data.autopilots, loading: false });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  loadTemplates: async () => {
    set({ error: null });
    try {
      const data = await api.get<{ templates: AutopilotTemplate[] }>('/api/autopilots/templates');
      set({ templates: data.templates });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  loadRuns: async (autopilotId: string) => {
    const data = await api.get<{ runs: AutopilotRun[] }>(
      `/api/autopilots/${encodeURIComponent(autopilotId)}/runs`,
    );
    set((s) => ({ runs: { ...s.runs, [autopilotId]: data.runs } }));
  },

  installTemplate: async (templateId: string, name?: string) => {
    const data = await api.post<{ autopilot: Autopilot }>(
      `/api/autopilots/templates/${encodeURIComponent(templateId)}/install`,
      { name },
    );
    await get().loadAutopilots();
    return data.autopilot;
  },

  retryRun: async (autopilotId: string, runId: string) => {
    try {
      const data = await api.post<{ run: AutopilotRun }>(
        `/api/autopilots/${encodeURIComponent(autopilotId)}/runs/${encodeURIComponent(runId)}/retry`,
      );
      await get().loadRuns(autopilotId);
      await get().loadAutopilots();
      return data.run;
    } catch (err) {
      const body = typeof err === 'object' && err && 'body' in err
        ? (err as { body?: { run?: AutopilotRun; error?: string } }).body
        : undefined;
      if (body?.run) {
        await get().loadRuns(autopilotId);
        await get().loadAutopilots();
        set({ error: body.error ?? null });
        return body.run;
      }
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },
}));
