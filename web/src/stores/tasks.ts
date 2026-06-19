import { create } from 'zustand';
import { api } from '../api/client';
import { extractErrorMessage } from '../utils/error';

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  execution_type?: 'agent' | 'script';
  script_command?: string | null;
  next_run: string | null;
  last_run?: string | null;
  last_result?: string | null;
  status: 'active' | 'paused' | 'completed' | 'parsing';
  created_at: string;
  notify_channels?: string[] | null;
  runtime_profile?: 'server-agent' | 'server-agent-device-tools' | 'device-cli-agent' | null;
  agent_client_id?: string | null;
  backend?: string | null;
  agent_model?: string | null;
  execution_mode?: 'host' | 'container' | null;
  execution_node?: string | null;
  workspace_jid?: string | null;
  workspace_folder?: string | null;
}

export interface TaskRunLog {
  id: number;
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'running' | 'success' | 'error';
  result?: string | null;
  error?: string | null;
}

export interface AgentTaskLedgerRow {
  id: string;
  source_type: 'issue_run' | 'scheduled_task' | 'agent_team_run' | 'agent_team_task';
  source_ref: string;
  run_ref?: string | null;
  status: 'queued' | 'running' | 'awaiting_input' | 'waiting_approval' | 'paused' | 'success' | 'error' | 'canceled' | 'lost' | 'skipped';
  workspace_jid?: string | null;
  workspace_folder?: string | null;
  actor_user_id?: string | null;
  agent_link_id?: string | null;
  agent_client_id?: string | null;
  execution_node?: string | null;
  backend?: string | null;
  result?: string | null;
  error?: string | null;
  context?: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  started_at?: string | null;
  completed_at?: string | null;
}

interface TasksState {
  tasks: ScheduledTask[];
  logs: Record<string, TaskRunLog[]>;
  agentRunsByTask: Record<string, AgentTaskLedgerRow[]>;
  loading: boolean;
  error: string | null;
  runningTaskIds: Set<string>;
  groupNames: Record<string, string>;
  loadTasks: () => Promise<void>;
  createTask: (
    prompt: string,
    scheduleType: 'cron' | 'interval' | 'once',
    scheduleValue: string,
    executionType?: 'agent' | 'script',
    executionMode?: 'host' | 'container',
    executionNode?: string,
    scriptCommand?: string,
    notifyChannels?: string[] | null,
    chatJid?: string,
    contextMode?: 'group' | 'isolated',
    runtimeProfile?: 'server-agent' | 'server-agent-device-tools' | 'device-cli-agent',
    agentClientId?: string,
    backend?: string,
    agentModel?: string,
  ) => Promise<void>;
  updateTaskStatus: (id: string, status: 'active' | 'paused') => Promise<void>;
  updateTask: (id: string, fields: Record<string, unknown>) => Promise<void>;
  deleteTask: (id: string) => Promise<void>;
  loadLogs: (taskId: string) => Promise<void>;
  loadAgentRunsForTask: (taskId: string) => Promise<AgentTaskLedgerRow[]>;
  runTaskNow: (id: string) => Promise<void>;
}

function normalizeOnceScheduleValue(value: string): string {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const parsed = Number.parseInt(trimmed, 10);
    return new Date(parsed).toISOString();
  }
  return new Date(trimmed).toISOString();
}

export const useTasksStore = create<TasksState>((set, get) => ({
  tasks: [],
  logs: {},
  agentRunsByTask: {},
  loading: false,
  error: null,
  runningTaskIds: new Set<string>(),
  groupNames: {},

  loadTasks: async () => {
    set({ loading: true });
    try {
      const data = await api.get<{ tasks: ScheduledTask[]; runningTaskIds?: string[]; groupNames?: Record<string, string> }>('/api/tasks');
      set({
        tasks: data.tasks,
        runningTaskIds: new Set(data.runningTaskIds || []),
        groupNames: data.groupNames || {},
        loading: false,
        error: null,
      });
    } catch (err) {
      set({ loading: false, error: extractErrorMessage(err) });
    }
  },

  createTask: async (
    prompt: string,
    scheduleType: 'cron' | 'interval' | 'once',
    scheduleValue: string,
    executionType?: 'agent' | 'script',
    executionMode?: 'host' | 'container',
    executionNode?: string,
    scriptCommand?: string,
    notifyChannels?: string[] | null,
    chatJid?: string,
    contextMode?: 'group' | 'isolated',
    runtimeProfile?: 'server-agent' | 'server-agent-device-tools' | 'device-cli-agent',
    agentClientId?: string,
    backend?: string,
    agentModel?: string,
  ) => {
    try {
      const normalizedScheduleValue =
        scheduleType === 'once'
          ? normalizeOnceScheduleValue(scheduleValue)
          : scheduleValue.trim();

      const body: Record<string, unknown> = {
        prompt: prompt.trim(),
        schedule_type: scheduleType,
        schedule_value: normalizedScheduleValue,
      };
      if (executionType) {
        body.execution_type = executionType;
      }
      if (executionMode) {
        body.execution_mode = executionMode;
      }
      if (executionNode) {
        body.execution_node = executionNode;
      }
      if (scriptCommand) {
        body.script_command = scriptCommand;
      }
      if (notifyChannels !== undefined) {
        body.notify_channels = notifyChannels;
      }
      if (chatJid) {
        body.chat_jid = chatJid;
      }
      if (contextMode) {
        body.context_mode = contextMode;
      }
      if (runtimeProfile) {
        body.runtime_profile = runtimeProfile;
      }
      if (agentClientId) {
        body.agent_client_id = agentClientId;
      }
      if (backend) {
        body.backend = backend;
      }
      if (agentModel?.trim()) {
        body.agent_model = agentModel.trim();
      }
      await api.post('/api/tasks', body);
      set({ error: null });
      await get().loadTasks();
    } catch (err) {
      set({ error: extractErrorMessage(err) });
    }
  },

  updateTaskStatus: async (id: string, status: 'active' | 'paused') => {
    try {
      await api.patch(`/api/tasks/${id}`, { status });
      set({ error: null });
      await get().loadTasks();
    } catch (err) {
      set({ error: extractErrorMessage(err) });
    }
  },

  updateTask: async (id: string, fields: Record<string, unknown>) => {
    try {
      await api.patch(`/api/tasks/${id}`, fields);
      set({ error: null });
      await get().loadTasks();
    } catch (err) {
      set({ error: extractErrorMessage(err) });
    }
  },

  deleteTask: async (id: string) => {
    try {
      await api.delete(`/api/tasks/${id}`);
      set({ error: null });
      await get().loadTasks();
    } catch (err) {
      set({ error: extractErrorMessage(err) });
    }
  },

  loadLogs: async (taskId: string) => {
    try {
      const data = await api.get<{ logs: TaskRunLog[] }>(`/api/tasks/${taskId}/logs`);
      set((s) => ({
        logs: { ...s.logs, [taskId]: data.logs },
        error: null,
      }));
    } catch (err) {
      set({ error: extractErrorMessage(err) });
    }
  },

  loadAgentRunsForTask: async (taskId: string) => {
    try {
      const data = await api.get<{ tasks: AgentTaskLedgerRow[] }>(
        `/api/tasks/agent-runs?source_type=scheduled_task&source_ref=${encodeURIComponent(taskId)}`,
      );
      const rows = data.tasks ?? [];
      set((s) => ({
        agentRunsByTask: { ...s.agentRunsByTask, [taskId]: rows },
        error: null,
      }));
      return rows;
    } catch (err) {
      set({ error: extractErrorMessage(err) });
      return [];
    }
  },

  runTaskNow: async (id: string) => {
    try {
      await api.post(`/api/tasks/${id}/run`);
      set({ error: null });
      // Refresh immediately to pick up runningTaskIds from backend
      await get().loadTasks();
    } catch (err) {
      set({ error: extractErrorMessage(err) });
    }
  },
}));
