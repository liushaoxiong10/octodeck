import { useEffect, useMemo, useState } from 'react';
import {
  Bot,
  CheckCircle2,
  Cpu,
  KeyRound,
  Layers3,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Settings2,
  Sparkles,
  TerminalSquare,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { api } from '../api/client';
import { useAuthStore } from '../stores/auth';
import { useAgentLinksStore, type AgentLink } from '../stores/agentLinks';
import {
  useCustomBackendsStore,
  type CustomBackendDef,
} from '../stores/customBackends';
import { useTasksStore, type ScheduledTask } from '../stores/tasks';
import { useAgentTeamsStore, type AgentTeam, type AgentTeamShape } from '../stores/agentTeams';
import CustomBackendFormDialog from '../components/settings/CustomBackendFormDialog';
import type { BackendInfo, SystemSettings } from '../components/settings/types';
import { getErrorMessage } from '../components/settings/types';
import { MarkdownRenderer } from '../components/chat/MarkdownRenderer';
import { groupSkillsByPackage } from '../utils/skillsGrouping';

type AgentRuntime = 'builtin' | 'server-side' | 'local-device';

interface AgentListItem extends BackendInfo {
  custom?: CustomBackendDef;
  runtime: AgentRuntime;
  model: string | null;
  status: 'default' | 'enabled' | 'disabled';
}

interface AgentSkillInfo {
  id: string;
  name?: string;
  description?: string;
  source: 'workspace' | 'cli';
  enabled?: boolean;
  packageName?: string;
  content?: string;
}

interface AgentSkillsResponse {
  workspaceSkills: AgentSkillInfo[];
  cliSkills: AgentSkillInfo[];
  durationMs?: number;
}

const AGENT_SECTIONS = ['Agent 管理', 'Agent.md', 'Agent Team'] as const;
type AgentSectionName = (typeof AGENT_SECTIONS)[number];

const MODULES = ['Instructions', 'Skills', 'Tasks', 'Args', 'ENV', 'Settings'] as const;
type AgentModuleName = (typeof MODULES)[number];

const TEAM_SHAPES: Array<{ value: AgentTeamShape; label: string; description: string }> = [
  { value: 'auto', label: 'Let AI decide', description: 'Main agent picks the shape from your goal.' },
  { value: 'pipeline', label: 'Pipeline', description: 'Agents take turns, one after another.' },
  { value: 'parallel', label: 'Parallel', description: 'All agents fan out at once; results merge.' },
  { value: 'leader-worker', label: 'Leader-worker', description: 'A lead coordinates worker contributions.' },
  { value: 'judge-route', label: 'Judge route', description: 'A judge reviews and routes the next step.' },
];

export function AgentsPage() {
  const { hasPermission } = useAuthStore();
  const canManage = hasPermission('manage_system_config');
  const [settings, setSettings] = useState<SystemSettings | null>(null);
  const [defaultBackend, setDefaultBackend] = useState('claude-sdk');
  const [allowedBackends, setAllowedBackends] = useState<string[]>(['claude-sdk']);
  const [availableBackends, setAvailableBackends] = useState<BackendInfo[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeSection, setActiveSection] = useState<AgentSectionName>('Agent 管理');
  const [activeModule, setActiveModule] = useState<AgentModuleName>('Instructions');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<CustomBackendDef | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [agentSkills, setAgentSkills] = useState<AgentSkillsResponse | null>(null);
  const [agentSkillsLoading, setAgentSkillsLoading] = useState(false);
  const [agentSkillsError, setAgentSkillsError] = useState<string | null>(null);

  const { backends: customBackends, loading: customLoading, load: loadCustomBackends, remove } =
    useCustomBackendsStore();
  const { links: devices, load: loadDevices } = useAgentLinksStore();
  const { tasks, loading: tasksLoading, loadTasks } = useTasksStore();

  const load = async () => {
    setLoading(true);
    try {
      const [system, backendList] = await Promise.all([
        api.get<SystemSettings>('/api/config/system'),
        api.get<{ backends: BackendInfo[] }>('/api/config/backends'),
        loadCustomBackends(),
        loadDevices(),
        loadTasks(),
      ]);
      setSettings(system);
      setDefaultBackend(system.defaultBackend ?? 'claude-sdk');
      setAllowedBackends(system.allowedBackends ?? ['claude-sdk']);
      setAvailableBackends(backendList.backends ?? []);
    } catch (err) {
      toast.error(getErrorMessage(err, '加载 Agent 配置失败'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const backendOptions: BackendInfo[] = availableBackends.length
    ? availableBackends
    : allowedBackends.map((id) => ({
        id,
        displayName: id,
        usesProviderPool: false,
        supportsHost: true,
        supportsContainer: true,
      }));

  const customById = useMemo(
    () => new Map(customBackends.map((backend) => [backend.id, backend])),
    [customBackends],
  );

  const agents = useMemo<AgentListItem[]>(() => {
    const fromConfig: AgentListItem[] = backendOptions.map((backend) => {
      const custom = customById.get(backend.id);
      const runtime: AgentRuntime = custom
        ? custom.runtime ?? (custom.deviceLinkId ? 'local-device' : 'server-side')
        : 'builtin';
      const status: AgentListItem['status'] = backend.id === defaultBackend
        ? 'default'
        : allowedBackends.includes(backend.id)
          ? 'enabled'
          : 'disabled';
      return {
        ...backend,
        custom,
        runtime,
        model: custom?.model ?? null,
        status,
      };
    });

    for (const custom of customBackends) {
      if (fromConfig.some((agent) => agent.id === custom.id)) continue;
      fromConfig.push({
        id: custom.id,
        displayName: custom.displayName,
        usesProviderPool: custom.usesProviderPool,
        supportsHost: custom.supportsHost,
        supportsContainer: custom.supportsContainer,
        kind: 'custom',
        custom,
        runtime: custom.runtime ?? (custom.deviceLinkId ? 'local-device' : 'server-side'),
        model: custom.model ?? null,
        status: allowedBackends.includes(custom.id) ? 'enabled' : 'disabled' as AgentListItem['status'],
      });
    }

    return fromConfig.sort((a, b) => {
      if (a.status === 'default') return -1;
      if (b.status === 'default') return 1;
      if (a.kind === 'custom' && b.kind !== 'custom') return -1;
      if (a.kind !== 'custom' && b.kind === 'custom') return 1;
      return a.displayName.localeCompare(b.displayName);
    });
  }, [allowedBackends, backendOptions, customBackends, customById, defaultBackend]);

  useEffect(() => {
    if (agents.length === 0) {
      setSelectedAgentId(null);
      return;
    }
    if (!selectedAgentId || !agents.some((agent) => agent.id === selectedAgentId)) {
      setSelectedAgentId(defaultBackend || agents[0].id);
    }
  }, [agents, defaultBackend, selectedAgentId]);

  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId) ?? agents[0] ?? null;
  const selectedDevice = selectedAgent?.custom?.deviceLinkId
    ? devices.find((device) => device.id === selectedAgent.custom?.deviceLinkId)
    : null;
  const selectedDeviceOrNull = selectedDevice ?? null;
  const selectedClient = selectedDevice?.agentClients.find(
    (client) => client.id === selectedAgent?.custom?.agentClientId,
  );
  const relatedTasks = selectedAgent ? getRelatedTasks(selectedAgent, tasks) : [];

  const loadAgentSkills = async (agent = selectedAgent) => {
    if (!agent?.custom?.deviceLinkId || !agent.custom.agentClientId || agent.runtime !== 'local-device') {
      setAgentSkills(null);
      setAgentSkillsError(null);
      return;
    }
    setAgentSkillsLoading(true);
    setAgentSkillsError(null);
    try {
      const cwd = agent.custom.workdirMode === 'custom' ? (agent.custom.workdir ?? '') : '';
      const data = await api.get<AgentSkillsResponse>(
        `/api/agent-links/${encodeURIComponent(agent.custom.deviceLinkId)}/providers/${encodeURIComponent(agent.custom.agentClientId)}/skills?cwd=${encodeURIComponent(cwd)}`,
      );
      setAgentSkills({
        workspaceSkills: data.workspaceSkills ?? [],
        cliSkills: data.cliSkills ?? [],
        durationMs: data.durationMs,
      });
    } catch (err) {
      setAgentSkills(null);
      setAgentSkillsError(getErrorMessage(err, '加载 Agent Skills 失败'));
    } finally {
      setAgentSkillsLoading(false);
    }
  };

  useEffect(() => {
    if (activeModule !== 'Skills') return;
    void loadAgentSkills(selectedAgent);
  }, [activeModule, selectedAgent?.id, selectedAgent?.custom?.deviceLinkId, selectedAgent?.custom?.agentClientId, selectedAgent?.custom?.workdirMode, selectedAgent?.custom?.workdir]);

  const handleSave = async (nextDefaultBackend = defaultBackend, nextAllowedBackends = allowedBackends) => {
    if (!settings) return;
    setSaving(true);
    try {
      const nextAllowed = nextAllowedBackends.includes(nextDefaultBackend)
        ? nextAllowedBackends
        : [nextDefaultBackend, ...nextAllowedBackends];
      const updated = await api.put<SystemSettings>('/api/config/system', {
        defaultBackend: nextDefaultBackend,
        allowedBackends: nextAllowed,
      });
      setSettings(updated);
      setDefaultBackend(updated.defaultBackend ?? nextDefaultBackend);
      setAllowedBackends(updated.allowedBackends ?? nextAllowed);
      toast.success('Agent 配置已保存');
    } catch (err) {
      toast.error(getErrorMessage(err, '保存 Agent 配置失败'));
    } finally {
      setSaving(false);
    }
  };

  const handleSetDefaultAgent = async (agentId: string) => {
    const nextAllowed = allowedBackends.includes(agentId) ? allowedBackends : [agentId, ...allowedBackends];
    setDefaultBackend(agentId);
    setAllowedBackends(nextAllowed);
    await handleSave(agentId, nextAllowed);
  };

  const handleCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };

  const handleEdit = (backend: CustomBackendDef) => {
    setEditing(backend);
    setDialogOpen(true);
  };

  const handleDelete = async (backend: CustomBackendDef) => {
    if (!window.confirm(`确认删除 Agent "${backend.id}"？`)) return;
    setRemoving(backend.id);
    try {
      await remove(backend.id);
      toast.success(`已删除 ${backend.id}`);
      if (selectedAgentId === backend.id) setSelectedAgentId(null);
    } catch (err) {
      toast.error(getErrorMessage(err, '删除失败'));
    } finally {
      setRemoving(null);
    }
  };

  const toggleAllowed = (id: string, checked: boolean) => {
    if (id === defaultBackend) return;
    setAllowedBackends((prev) => {
      if (checked) return prev.includes(id) ? prev : [...prev, id];
      return prev.filter((x) => x !== id);
    });
  };

  return (
    <div className="min-h-full bg-[radial-gradient(circle_at_top_left,hsl(var(--primary)/0.12),transparent_34%),linear-gradient(180deg,hsl(var(--background)),hsl(var(--muted)/0.32))]">
      <div className="mx-auto max-w-7xl px-4 py-6 lg:px-8 lg:py-8 space-y-6">
        <div className="relative overflow-hidden rounded-[2rem] border border-border/80 bg-background/80 p-6 shadow-sm backdrop-blur lg:p-8">
          <div className="absolute inset-y-0 right-0 w-2/3 bg-[linear-gradient(135deg,transparent,hsl(var(--primary)/0.12)),repeating-linear-gradient(90deg,transparent,transparent_16px,hsl(var(--border)/0.35)_17px)]" />
          <div className="relative flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-2xl space-y-3">
              <div className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
                <Bot className="size-3.5" />
                Agent Console
              </div>
              <div>
                <h1 className="text-2xl font-bold tracking-tight text-foreground lg:text-3xl">
                  {activeSection}
                </h1>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  Agent 管理、agent.md 角色说明和 Agent Team 定义是同级能力；agent.md 和 Team 不隶属于某个 Agent 详情。
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={load} disabled={loading || saving}>
                <RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} />
                刷新
              </Button>
              {canManage && activeSection === 'Agent 管理' ? (
                <Button size="sm" onClick={handleCreate}>
                  <Plus className="size-4" />
                  新增 Agent
                </Button>
              ) : null}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 rounded-2xl border border-border/80 bg-background/80 p-2 shadow-sm backdrop-blur">
          {AGENT_SECTIONS.map((section) => {
            const active = activeSection === section;
            return (
              <button
                key={section}
                type="button"
                onClick={() => setActiveSection(section)}
                className={`rounded-xl px-4 py-2 text-sm font-medium transition ${active ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
              >
                {section}
              </button>
            );
          })}
        </div>

        {!canManage ? (
          <Card>
            <CardContent>
              <div className="text-sm text-muted-foreground">需要系统配置权限才能管理 Agent。</div>
            </CardContent>
          </Card>
        ) : loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : activeSection === 'Agent 管理' ? (
          <AgentManagementSection>
          <div className="grid gap-5 lg:grid-cols-[minmax(280px,1fr)_minmax(0,2fr)]">
            <aside className="space-y-3">
              <Card className="overflow-hidden border-border/80 bg-background/90">
                <CardContent className="p-0">
                  <div className="border-b border-border/70 p-4">
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <h2 className="text-sm font-semibold text-foreground">Agent 后端列表</h2>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {agents.length} 个 Agent · {allowedBackends.length} 个已允许
                        </p>
                      </div>
                      {customLoading ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : null}
                    </div>
                  </div>
                  <div className="max-h-[calc(100vh-19rem)] divide-y divide-border/60 overflow-y-auto">
                    {agents.length === 0 ? (
                      <div className="p-5 text-center text-xs text-muted-foreground">
                        还没有可用 Agent，点击「新增 Agent」开始添加。
                      </div>
                    ) : (
                      agents.map((agent) => (
                        <button
                          type="button"
                          key={agent.id}
                          onClick={() => setSelectedAgentId(agent.id)}
                          className={`group w-full px-4 py-3 text-left transition ${
                            selectedAgent?.id === agent.id
                              ? 'bg-primary/10'
                              : 'hover:bg-muted/70'
                          }`}
                        >
                          <div className="flex items-start gap-3">
                            <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-2xl border border-border bg-background text-muted-foreground group-hover:text-foreground">
                              {agent.runtime === 'local-device' ? (
                                <Cpu className="size-4" />
                              ) : agent.kind === 'custom' ? (
                                <TerminalSquare className="size-4" />
                              ) : (
                                <Bot className="size-4" />
                              )}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center gap-2">
                                <span className="truncate text-sm font-medium text-foreground">
                                  {agent.displayName}
                                </span>
                                {agent.status === 'default' ? (
                                  <span className="rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground">
                                    默认
                                  </span>
                                ) : null}
                              </span>
                              <span className="mt-1 block truncate font-mono text-[11px] text-muted-foreground">
                                {agent.id}
                              </span>
                              <span className="mt-2 flex flex-wrap gap-1">
                                <Pill>{runtimeLabel(agent.runtime)}</Pill>
                                <Pill tone={agent.status === 'disabled' ? 'muted' : 'green'}>
                                  {statusLabel(agent.status)}
                                </Pill>
                              </span>
                            </span>
                          </div>
                        </button>
                      ))
                    )}
                  </div>
                </CardContent>
              </Card>
            </aside>

            <main className="min-w-0 space-y-4">
              {selectedAgent ? (
                <>
                  <AgentSummary
                    agent={selectedAgent}
                    selectedDevice={selectedDeviceOrNull}
                    selectedClient={selectedClient}
                    defaultBackend={defaultBackend}
                    allowedBackends={allowedBackends}
                    toggleAllowed={toggleAllowed}
                    onSetDefault={handleSetDefaultAgent}
                    onEdit={handleEdit}
                    onDelete={handleDelete}
                    removing={removing}
                  />

                  <AgentModuleTabs
                    activeModule={activeModule}
                    setActiveModule={setActiveModule}
                    agent={selectedAgent}
                    selectedDevice={selectedDeviceOrNull}
                    selectedClient={selectedClient}
                    tasks={relatedTasks}
                    tasksLoading={tasksLoading}
                    agentSkills={agentSkills}
                    agentSkillsLoading={agentSkillsLoading}
                    agentSkillsError={agentSkillsError}
                    onReloadAgentSkills={() => loadAgentSkills(selectedAgent)}
                    defaultBackend={defaultBackend}
                    allowedBackends={allowedBackends}
                    toggleAllowed={toggleAllowed}
                    onSetDefault={handleSetDefaultAgent}
                    saving={saving}
                    onSave={() => handleSave()}
                  />
                </>
              ) : (
                <Card>
                  <CardContent>
                    <div className="py-10 text-center text-sm text-muted-foreground">
                      选择左侧 Agent 查看详情。
                    </div>
                  </CardContent>
                </Card>
              )}
            </main>
          </div>
          </AgentManagementSection>
        ) : activeSection === 'Agent.md' ? (
          <AgentMdPanel generatorAgent={selectedAgent ?? agents[0] ?? null} />
        ) : (
          <AgentTeamWorkspace agents={agents} defaultGeneratorId={selectedAgent?.id ?? defaultBackend} />
        )}

        <CustomBackendFormDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          backend={editing}
        />
      </div>
    </div>
  );
}

function AgentSummary({
  agent,
  selectedDevice,
  selectedClient,
  defaultBackend,
  allowedBackends,
  toggleAllowed,
  onSetDefault,
  onEdit,
  onDelete,
  removing,
}: {
  agent: AgentListItem;
  selectedDevice: AgentLink | null;
  selectedClient: AgentLink['agentClients'][number] | undefined;
  defaultBackend: string;
  allowedBackends: string[];
  toggleAllowed: (id: string, checked: boolean) => void;
  onSetDefault: (id: string) => void;
  onEdit: (backend: CustomBackendDef) => void;
  onDelete: (backend: CustomBackendDef) => void;
  removing: string | null;
}) {
  const creator = agent.custom ? 'System Admin' : 'OctoDeck';
  const backendLabel = agent.custom?.agentClientId ?? (agent.usesProviderPool ? 'provider-pool' : agent.id);
  const model = agent.model ?? (agent.usesProviderPool ? 'Provider Pool' : '默认模型');
  const online = agent.runtime !== 'local-device' || selectedDevice?.online;

  return (
    <Card className="overflow-hidden border-border/80 bg-background/95">
      <CardContent className="p-0">
        <div className="border-b border-border/70 bg-muted/20 p-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Pill tone={online ? 'green' : 'red'}>{online ? 'Online' : 'Offline'}</Pill>
                <Pill>{runtimeLabel(agent.runtime)}</Pill>
                {agent.kind === 'custom' ? <Pill tone="blue">Custom</Pill> : <Pill>Built-in</Pill>}
              </div>
              <div>
                <h2 className="truncate text-2xl font-semibold tracking-tight text-foreground">
                  {agent.displayName}
                </h2>
                <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{agent.id}</p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {agent.custom ? (
                <>
                  <Button variant="outline" size="sm" onClick={() => onEdit(agent.custom!)}>
                    <Pencil className="size-4" />
                    编辑
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={removing === agent.id}
                    onClick={() => onDelete(agent.custom!)}
                  >
                    {removing === agent.id ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Trash2 className="size-4" />
                    )}
                    删除
                  </Button>
                </>
              ) : null}
            </div>
          </div>
        </div>
        <div className="grid gap-px bg-border/70 md:grid-cols-5">
          <SummaryCell label="名称" value={agent.displayName} />
          <SummaryCell label="后端" value={backendLabel} />
          <SummaryCell label="模型" value={model} />
          <SummaryCell label="状态" value={agent.status === 'default' ? '默认 / 已启用' : statusLabel(agent.status)} />
          <SummaryCell label="创建人" value={creator} />
        </div>
        <div className="flex flex-col gap-3 p-5 md:flex-row md:items-center md:justify-between">
          <div className="text-xs text-muted-foreground">
            {agent.runtime === 'local-device'
              ? `运行设备：${selectedDevice ? `${selectedDevice.displayName} (${selectedDevice.hostname ?? selectedDevice.id})` : agent.custom?.deviceLinkId ?? '未绑定'}`
              : agent.runtime === 'server-side'
                ? '运行位置：Server Side Provider Pool'
                : '运行位置：OctoDeck 内置后端'}
            {selectedClient?.version ? ` · Client ${selectedClient.version}` : ''}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 rounded-full border border-border px-3 py-1.5 text-xs">
              <input
                type="checkbox"
                checked={allowedBackends.includes(agent.id)}
                disabled={agent.id === defaultBackend}
                onChange={(event) => toggleAllowed(agent.id, event.target.checked)}
              />
              允许使用
            </label>
            <Button
              variant={agent.id === defaultBackend ? 'secondary' : 'outline'}
              size="sm"
              onClick={() => onSetDefault(agent.id)}
            >
              <CheckCircle2 className="size-4" />
              {agent.id === defaultBackend ? '当前默认' : '设为默认'}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function AgentModuleTabs({
  activeModule,
  setActiveModule,
  agent,
  selectedDevice,
  selectedClient,
  tasks,
  tasksLoading,
  agentSkills,
  agentSkillsLoading,
  agentSkillsError,
  onReloadAgentSkills,
  defaultBackend,
  allowedBackends,
  toggleAllowed,
  onSetDefault,
  saving,
  onSave,
}: {
  activeModule: AgentModuleName;
  setActiveModule: (module: AgentModuleName) => void;
  agent: AgentListItem;
  selectedDevice: AgentLink | null;
  selectedClient: AgentLink['agentClients'][number] | undefined;
  tasks: ScheduledTask[];
  tasksLoading: boolean;
  agentSkills: AgentSkillsResponse | null;
  agentSkillsLoading: boolean;
  agentSkillsError: string | null;
  onReloadAgentSkills: () => void;
  defaultBackend: string;
  allowedBackends: string[];
  toggleAllowed: (id: string, checked: boolean) => void;
  onSetDefault: (id: string) => void;
  saving: boolean;
  onSave: () => void;
}) {
  return (
    <Card className="overflow-hidden border-border/80 bg-background/95">
      <CardContent className="p-0">
        <div className="border-b border-border/70 bg-muted/20 p-2">
          <div
            role="tablist"
            aria-label="Agent detail modules"
            className="grid grid-cols-2 gap-1 sm:grid-cols-4 xl:grid-cols-8"
          >
            {MODULES.map((module) => {
              const active = module === activeModule;
              return (
                <button
                  key={module}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setActiveModule(module)}
                  className={`group flex items-center justify-center gap-2 rounded-xl px-3 py-2 text-xs font-medium transition ${
                    active
                      ? 'bg-background text-foreground shadow-sm ring-1 ring-border'
                      : 'text-muted-foreground hover:bg-background/60 hover:text-foreground'
                  }`}
                >
                  <span className={`transition ${active ? 'text-primary' : 'group-hover:text-foreground'}`}>
                    {moduleIcon(module)}
                  </span>
                  {module}
                </button>
              );
            })}
          </div>
        </div>
        <div className="p-5">
          <div className="mb-4 flex items-center gap-2">
            <span className="flex size-8 items-center justify-center rounded-xl bg-muted text-primary">
              {moduleIcon(activeModule)}
            </span>
            <div>
              <h3 className="text-sm font-semibold text-foreground">{activeModule}</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">{moduleDescription(activeModule)}</p>
            </div>
          </div>
          <div role="tabpanel" className="min-h-[18rem] rounded-2xl border border-border/70 bg-muted/10 p-4">
            {renderModuleContent({
              module: activeModule,
              agent,
              selectedDevice,
              selectedClient,
              tasks,
              tasksLoading,
              agentSkills,
              agentSkillsLoading,
              agentSkillsError,
              onReloadAgentSkills,
              defaultBackend,
              allowedBackends,
              toggleAllowed,
              onSetDefault,
              saving,
              onSave,
            })}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function renderModuleContent(args: {
  module: AgentModuleName;
  agent: AgentListItem;
  selectedDevice: AgentLink | null;
  selectedClient: AgentLink['agentClients'][number] | undefined;
  tasks: ScheduledTask[];
  tasksLoading: boolean;
  agentSkills: AgentSkillsResponse | null;
  agentSkillsLoading: boolean;
  agentSkillsError: string | null;
  onReloadAgentSkills: () => void;
  defaultBackend: string;
  allowedBackends: string[];
  toggleAllowed: (id: string, checked: boolean) => void;
  onSetDefault: (id: string) => void;
  saving: boolean;
  onSave: () => void;
}) {
  const { module, agent, selectedDevice, selectedClient, tasks, tasksLoading, agentSkills, agentSkillsLoading, agentSkillsError, onReloadAgentSkills } = args;
  const custom = agent.custom;
  switch (module) {
    case 'Instructions':
      return (
        <div className="space-y-3 text-sm text-muted-foreground">
          <p>
            {custom
              ? custom.runtime === 'local-device'
                ? '通过 Agent Link 把请求发送到所选 Device，由该设备上的 octodeck-daemon 启动 CLI 并回传输出。'
                : '通过服务端 provider pool 运行，适合无需绑定设备的 Agent。'
              : '内置 Agent 由系统提供，主要用于兼容默认运行链路。'}
          </p>
          <MetaRow label="工作目录" value={custom?.workdirMode === 'custom' ? custom.workdir : '自动按 Workspace 推导'} />
          <MetaRow label="输出协议" value={custom?.outputProtocol ?? '系统默认'} />
        </div>
      );
    case 'Skills': {
      if (agent.runtime === 'local-device') {
        return (
          <AgentSkillsPanel
            skills={agentSkills}
            loading={agentSkillsLoading}
            error={agentSkillsError}
            onRetry={onReloadAgentSkills}
          />
        );
      }
      const skills = selectedClient?.capabilities?.length
        ? selectedClient.capabilities
        : [
            agent.supportsHost ? 'device/native execution' : null,
            agent.supportsContainer ? 'container execution' : null,
            agent.usesProviderPool ? 'provider failover' : null,
          ].filter(Boolean) as string[];
      return skills.length ? (
        <div className="flex flex-wrap gap-2">
          {skills.map((skill) => <Pill key={skill} tone="blue">{skill}</Pill>)}
        </div>
      ) : (
        <EmptyText>该 Agent 暂未上报额外 Skills。</EmptyText>
      );
    }
    case 'Tasks':
      if (tasksLoading) return <Loader2 className="size-4 animate-spin text-muted-foreground" />;
      return tasks.length ? (
        <div className="space-y-2">
          {tasks.slice(0, 5).map((task) => (
            <div key={task.id} className="rounded-xl border border-border bg-muted/20 p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-xs font-medium text-foreground">{task.prompt}</span>
                <Pill tone={task.status === 'active' ? 'green' : 'muted'}>{task.status}</Pill>
              </div>
              <div className="mt-1 text-[11px] text-muted-foreground">
                {task.schedule_type} · {task.schedule_value}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyText>暂无直接关联任务；当前任务主要按 Workspace / Device 绑定。</EmptyText>
      );
    case 'Args':
      return custom?.argvTemplate?.length ? (
        <div className="flex flex-wrap gap-2">
          {[custom.binary, ...custom.argvTemplate].map((arg, index) => (
            <code key={`${arg}-${index}`} className="rounded-lg border border-border bg-muted/40 px-2 py-1 text-xs">
              {arg}
            </code>
          ))}
        </div>
      ) : (
        <EmptyText>内置 Agent 的启动参数由系统管理。</EmptyText>
      );
    case 'ENV': {
      const entries = Object.entries(custom?.env ?? {});
      return entries.length ? (
        <div className="space-y-2">
          {entries.map(([key, value]) => (
            <MetaRow key={key} label={key} value={maskEnvValue(value)} />
          ))}
        </div>
      ) : (
        <EmptyText>未配置额外环境变量。</EmptyText>
      );
    }
    case 'Settings':
      return (
        <div className="space-y-4">
          <div className="grid gap-2 text-sm">
            <MetaRow label="Runtime" value={runtimeLabel(agent.runtime)} />
            <MetaRow label="Device" value={selectedDevice ? `${selectedDevice.displayName} (${selectedDevice.id})` : custom?.deviceLinkId ?? '—'} />
            <MetaRow label="Client" value={selectedClient ? `${selectedClient.displayName} (${selectedClient.id})` : custom?.agentClientId ?? '—'} />
            <MetaRow label="Timeout" value={formatDuration(custom?.timeoutMs)} />
            <MetaRow label="Max Output" value={formatBytes(custom?.maxOutputBytes)} />
          </div>
          <div className="space-y-3 rounded-2xl border border-border bg-muted/20 p-3">
            <div className="space-y-1.5">
              <Label className="text-xs">默认 Agent</Label>
              <Button
                variant={agent.id === args.defaultBackend ? 'secondary' : 'outline'}
                size="sm"
                className="w-full justify-start"
                onClick={() => args.onSetDefault(agent.id)}
              >
                <CheckCircle2 className="size-4" />
                {agent.id === args.defaultBackend ? '当前默认 Agent' : '设为默认 Agent'}
              </Button>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={args.allowedBackends.includes(agent.id)}
                disabled={agent.id === args.defaultBackend}
                onChange={(event) => args.toggleAllowed(agent.id, event.target.checked)}
              />
              加入允许列表
            </label>
            <Button size="sm" onClick={args.onSave} disabled={args.saving} className="w-full">
              {args.saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
              保存全局 Agent 设置
            </Button>
          </div>
        </div>
      );
  }
}

function AgentManagementSection({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

function SummaryCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 bg-background p-4">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 truncate text-sm font-medium text-foreground">{value}</div>
    </div>
  );
}

function MetaRow({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-border/60 pb-2 last:border-0 last:pb-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="max-w-[70%] break-words text-right text-xs font-medium text-foreground">{value || '—'}</span>
    </div>
  );
}

function Pill({
  children,
  tone = 'muted',
}: {
  children: React.ReactNode;
  tone?: 'muted' | 'green' | 'red' | 'blue';
}) {
  const toneClass = {
    muted: 'bg-muted text-muted-foreground',
    green: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    red: 'bg-red-500/10 text-red-600 dark:text-red-400',
    blue: 'bg-primary/10 text-primary',
  }[tone];
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${toneClass}`}>{children}</span>;
}

function EmptyText({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-border bg-muted/20 px-4 py-6 text-center text-xs text-muted-foreground">
      {children}
    </div>
  );
}

function AgentTeamWorkspace({ agents, defaultGeneratorId }: { agents: AgentListItem[]; defaultGeneratorId: string }) {
  const { teams, loading, saving, error, load, loadAgentMdDefinitions, update, remove } = useAgentTeamsStore();
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editingJson, setEditingJson] = useState('');
  const selectedTeam = teams.find((team) => team.id === selectedTeamId) ?? teams[0] ?? null;
  const defaultGenerator = agents.find((agent) => agent.id === defaultGeneratorId) ?? agents[0] ?? null;
  const openCreateDialog = () => setCreateOpen(true);

  useEffect(() => {
    void load().then(() => loadAgentMdDefinitions());
  }, [load, loadAgentMdDefinitions]);

  useEffect(() => {
    if (!selectedTeam) {
      setSelectedTeamId(null);
      setEditingJson('');
      return;
    }
    if (!selectedTeamId || selectedTeam.id !== selectedTeamId) {
      setSelectedTeamId(selectedTeam.id);
    }
    setEditingJson(JSON.stringify(toEditableTeam(selectedTeam), null, 2));
  }, [selectedTeam?.id, selectedTeam?.updatedAt]);

  const handleSave = async () => {
    if (!selectedTeam) return;
    try {
      const parsed = JSON.parse(editingJson) as Partial<AgentTeam>;
      const team = await update(selectedTeam.id, parsed);
      setSelectedTeamId(team.id);
      toast.success('Agent Team 已保存');
    } catch (err) {
      toast.error(err instanceof SyntaxError ? 'JSON 格式不正确' : getErrorMessage(err, '保存 Agent Team 失败'));
    }
  };

  const handleDelete = async () => {
    if (!selectedTeam) return;
    if (!confirm(`确认删除 Agent Team「${selectedTeam.name}」？`)) return;
    try {
      await remove(selectedTeam.id);
      setSelectedTeamId(null);
      toast.success('Agent Team 已删除');
    } catch (err) {
      toast.error(getErrorMessage(err, '删除 Agent Team 失败'));
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(260px,1fr)_minmax(0,2fr)]">
        <aside className="rounded-2xl border border-border bg-background/80 p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-foreground">Team 列表</h3>
              <p className="mt-1 text-xs text-muted-foreground">{teams.length} 个已保存 Team</p>
            </div>
            <Button size="sm" onClick={openCreateDialog} disabled={!defaultGenerator}>
              <Plus className="size-4" />
              创建 Team
            </Button>
          </div>
          {loading ? <div className="mb-2 text-xs text-muted-foreground">正在加载 Team…</div> : null}
          {teams.length === 0 ? (
            <EmptyText>还没有 Agent Team。点击「创建 Team」开始生成。</EmptyText>
          ) : (
            <div className="space-y-2">
              {teams.map((team) => (
                <button
                  key={team.id}
                  type="button"
                  onClick={() => setSelectedTeamId(team.id)}
                  className={`w-full rounded-xl border p-3 text-left transition ${selectedTeam?.id === team.id ? 'border-primary bg-primary/5' : 'border-border bg-background/80 hover:bg-muted/40'}`}
                >
                  <div className="truncate text-sm font-medium text-foreground">{team.name}</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    <Pill tone="blue">{shapeLabel(team.shape)}</Pill>
                    <Pill>{team.roles.length} roles</Pill>
                  </div>
                  <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">{team.goal}</div>
                </button>
              ))}
            </div>
          )}
          {error ? <div className="mt-3 text-xs text-red-600 dark:text-red-400">{error}</div> : null}
        </aside>

        <AgentTeamPanel
          selectedTeam={selectedTeam}
          editingJson={editingJson}
          saving={saving}
          onEditingJsonChange={setEditingJson}
          onSave={handleSave}
          onDelete={handleDelete}
        />
      </div>

      <AgentTeamCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        agents={agents}
        defaultGeneratorId={defaultGenerator?.id ?? defaultGeneratorId}
        onCreated={(team) => setSelectedTeamId(team.id)}
      />
    </div>
  );
}

function AgentTeamPanel({
  selectedTeam,
  editingJson,
  saving,
  onEditingJsonChange,
  onSave,
  onDelete,
}: {
  selectedTeam: AgentTeam | null;
  editingJson: string;
  saving: boolean;
  onEditingJsonChange: (value: string) => void;
  onSave: () => void;
  onDelete: () => void;
}) {
  return (
    <section className="rounded-2xl border border-border bg-background/80 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Team 详情</h3>
          <p className="mt-1 text-xs text-muted-foreground">查看角色拆分、编辑 JSON 或删除 Team。</p>
        </div>
        {selectedTeam ? (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onSave} disabled={saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
              保存
            </Button>
            <Button variant="outline" size="sm" onClick={onDelete} disabled={saving}>
              <Trash2 className="size-4" />
              删除
            </Button>
          </div>
        ) : null}
      </div>
      {selectedTeam ? (
        <div className="space-y-3">
          <div className="rounded-xl border border-border bg-muted/20 p-3">
            <h4 className="text-base font-semibold text-foreground">{selectedTeam.name}</h4>
            <p className="mt-1 text-xs text-muted-foreground">由 {selectedTeam.createdByAgentId} 生成 · {shapeLabel(selectedTeam.shape)}</p>
            <p className="mt-2 text-sm text-muted-foreground">{selectedTeam.description}</p>
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            {selectedTeam.roles.map((role) => (
              <div key={role.id} className="rounded-xl border border-border bg-muted/20 p-3">
                <div className="text-sm font-medium text-foreground">{role.name}</div>
                <div className="mt-1 text-xs text-muted-foreground">{role.responsibility}</div>
              </div>
            ))}
          </div>
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">编辑 Team JSON</span>
            <textarea
              value={editingJson}
              onChange={(event) => onEditingJsonChange(event.target.value)}
              className="min-h-96 rounded-xl border border-border bg-background px-3 py-2 font-mono text-xs outline-none focus:ring-2 focus:ring-ring"
            />
          </label>
        </div>
      ) : (
        <EmptyText>选择左侧 Agent Team 查看详情，或点击「创建 Team」生成新的 Team。</EmptyText>
      )}
    </section>
  );
}

function AgentTeamCreateDialog({
  open,
  onOpenChange,
  agents,
  defaultGeneratorId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agents: AgentListItem[];
  defaultGeneratorId: string;
  onCreated: (team: AgentTeam) => void;
}) {
  const { saving, generate } = useAgentTeamsStore();
  const [generatorAgentId, setGeneratorAgentId] = useState(defaultGeneratorId);
  const [goal, setGoal] = useState('');
  const [shape, setShape] = useState<AgentTeamShape>('auto');
  const [generatedPreviewTeam, setGeneratedPreviewTeam] = useState<AgentTeam | null>(null);
  const generatorAgent = agents.find((agent) => agent.id === generatorAgentId) ?? agents[0] ?? null;
  const shapeMeta = TEAM_SHAPES.find((item) => item.value === shape) ?? TEAM_SHAPES[0];

  useEffect(() => {
    if (!open) return;
    setGeneratorAgentId(defaultGeneratorId);
    setGeneratedPreviewTeam(null);
  }, [open, defaultGeneratorId]);

  if (!open) return null;

  const handleGenerate = async () => {
    if (!generatorAgent) {
      toast.error('请先选择生成器 Agent');
      return;
    }
    const trimmedGoal = goal.trim();
    if (!trimmedGoal) {
      toast.error('请输入希望这个 team 能够完成的事情');
      return;
    }
    try {
      const team = await generate({ generatorAgentId: generatorAgent.id, goal: trimmedGoal, shape });
      setGeneratedPreviewTeam(team);
      onCreated(team);
      toast.success('Agent Team 已生成，右侧已展示 Agent 返回结果');
    } catch (err) {
      toast.error(getErrorMessage(err, '生成 Agent Team 失败'));
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
      <div className="max-h-[90vh] w-full max-w-6xl overflow-y-auto rounded-3xl border border-border bg-background p-5 shadow-2xl">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-foreground">创建 Team</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              左侧填写生成参数，右侧展示 Agent 返回后的 Team 结果。现有 agent.md 简介会提供给模型。
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>关闭</Button>
        </div>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,1fr)]">
          <section className="space-y-4 rounded-2xl border border-border bg-muted/10 p-4">
            <div>
              <h4 className="text-sm font-semibold text-foreground">生成参数</h4>
              <p className="mt-1 text-xs text-muted-foreground">选择生成器 Agent、描述目标，并指定协作形态。</p>
            </div>
            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">选择生成器 Agent</span>
              <select
                value={generatorAgent?.id ?? ''}
                onChange={(event) => {
                  setGeneratorAgentId(event.target.value);
                  setGeneratedPreviewTeam(null);
                }}
                className="rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              >
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>{agent.displayName}</option>
                ))}
              </select>
            </label>
            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">希望这个 team 能够完成的事情</span>
              <textarea
                value={goal}
                onChange={(event) => {
                  setGoal(event.target.value);
                  setGeneratedPreviewTeam(null);
                }}
                className="min-h-36 rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                placeholder="例如：完成一个从需求分析、前端实现到上线验证的功能开发团队"
              />
            </label>
            <div>
              <div className="mb-2 text-xs font-medium text-muted-foreground">Interaction shape (optional)</div>
              <div className="grid gap-2 sm:grid-cols-2">
                {TEAM_SHAPES.map((item) => (
                  <label key={item.value} className={`rounded-xl border p-3 text-left transition ${shape === item.value ? 'border-primary bg-primary/5' : 'border-border bg-background/80 hover:bg-muted/40'}`}>
                    <div className="flex items-center gap-2">
                      <input type="radio" checked={shape === item.value} onChange={() => {
                        setShape(item.value);
                        setGeneratedPreviewTeam(null);
                      }} />
                      <span className="text-sm font-medium text-foreground">{item.label}</span>
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">{item.description}</div>
                  </label>
                ))}
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-border pt-4">
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>取消</Button>
              <Button onClick={handleGenerate} disabled={saving || !generatorAgent}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
                生成 Team
              </Button>
            </div>
          </section>

          <aside className="space-y-4 rounded-2xl border border-border bg-background/80 p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h4 className="text-sm font-semibold text-foreground">Team 预览</h4>
                <p className="mt-1 text-xs text-muted-foreground">生成完成后这里会展示真实的 Team pipeline、角色、工作流和验收标准。</p>
              </div>
              <Pill tone="blue">{generatedPreviewTeam ? shapeLabel(generatedPreviewTeam.shape) : shapeMeta.label}</Pill>
            </div>
            {saving ? (
              <div className="rounded-2xl border border-primary/30 bg-primary/5 p-4 text-sm text-foreground">
                <div className="flex items-center gap-2 font-semibold">
                  <Loader2 className="size-4 animate-spin" />
                  正在等待 Agent 返回 Team 定义…
                </div>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">不会使用本地草稿兜底；返回后会在这里展示真实生成结果。</p>
              </div>
            ) : generatedPreviewTeam ? (
              <GeneratedTeamPreview team={generatedPreviewTeam} requestedShape={shape} />
            ) : (
              <div className="space-y-3 rounded-2xl border border-dashed border-border bg-muted/10 p-4">
                <div className="text-sm font-semibold text-foreground">等待 Agent 生成结果</div>
                <p className="text-xs leading-5 text-muted-foreground">
                  点击「生成 Team」后，系统会等待生成器 Agent 返回完整 Team 定义；这里不会显示内置角色或本地模拟流程。
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="rounded-xl border border-border bg-background/80 p-3">
                    <div className="text-xs font-medium text-muted-foreground">生成器 Agent</div>
                    <div className="mt-1 truncate text-sm font-semibold text-foreground">{generatorAgent?.displayName ?? '未选择'}</div>
                  </div>
                  <div className="rounded-xl border border-border bg-background/80 p-3">
                    <div className="text-xs font-medium text-muted-foreground">请求的 Interaction shape</div>
                    <div className="mt-1 text-sm font-semibold text-foreground">{shapeMeta.label}</div>
                  </div>
                </div>
              </div>
            )}
            <div className="rounded-xl border border-dashed border-border bg-muted/10 p-3 text-xs text-muted-foreground">
              生成时会把已保存的 agent.md 简介提供给模型；如果现有定义不足，模型可以返回新的 agent.md 并由系统自动保存。
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

function AgentMdPanel({ generatorAgent }: { generatorAgent: AgentListItem | null }) {
  const {
    agentMdDefinitions,
    saving,
    createAgentMdDefinition,
    updateAgentMdDefinition,
    removeAgentMdDefinition,
  } = useAgentTeamsStore();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = selectedId ? agentMdDefinitions.find((definition) => definition.id === selectedId) ?? null : null;
  const [draft, setDraft] = useState({
    name: '',
    summary: '',
    content: '',
  });
  const generatorName = generatorAgent?.displayName ?? 'Agent';
  const generatorId = generatorAgent?.id ?? 'manual';

  useEffect(() => {
    if (!selected) {
      setSelectedId(null);
      setDraft({ name: '', summary: '', content: defaultAgentMdContent(generatorName) });
      return;
    }
    if (!selectedId || selected.id !== selectedId) {
      setSelectedId(selected.id);
    }
    setDraft({ name: selected.name, summary: selected.summary, content: selected.content });
  }, [selected?.id, selected?.updatedAt, selectedId, generatorName]);

  const handleNew = () => {
    setSelectedId(null);
    setDraft({ name: '', summary: '', content: defaultAgentMdContent(generatorName) });
  };

  const handleSave = async () => {
    const name = draft.name.trim();
    const summary = draft.summary.trim();
    const content = draft.content.trim();
    if (!name || !summary || !content) {
      toast.error('请填写 agent.md 的名称、简介和内容');
      return;
    }
    try {
      const payload = { name, summary, content, createdByAgentId: generatorId };
      const saved = selected
        ? await updateAgentMdDefinition(selected.id, payload)
        : await createAgentMdDefinition(payload);
      setSelectedId(saved.id);
      toast.success('agent.md 已保存');
    } catch (err) {
      toast.error(getErrorMessage(err, '保存 agent.md 失败'));
    }
  };

  const handleDelete = async () => {
    if (!selected) return;
    if (!confirm(`确认删除 agent.md「${selected.name}」？`)) return;
    try {
      await removeAgentMdDefinition(selected.id);
      setSelectedId(null);
      toast.success('agent.md 已删除');
    } catch (err) {
      toast.error(getErrorMessage(err, '删除 agent.md 失败'));
    }
  };

  return (
    <div className="rounded-2xl border border-border bg-background/80 p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-foreground">agent.md 管理</h4>
          <p className="mt-1 text-xs text-muted-foreground">
            用户可以自行定义 agent.md。现有 agent.md 简介会在生成 Team 时提供给模型，用于辅助拆分角色；不合适时模型可返回新的 agent.md 定义。
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={handleNew}>
          <Plus className="size-4" />
          新建
        </Button>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(220px,0.8fr)_minmax(0,1.2fr)]">
        <div className="space-y-2">
          <div className="text-xs font-semibold text-muted-foreground">已有 agent.md</div>
          {agentMdDefinitions.length === 0 ? (
            <EmptyText>还没有 agent.md。可以手动创建，或在生成 Team 时由 Agent 自动补充。</EmptyText>
          ) : (
            agentMdDefinitions.map((definition) => (
              <button
                key={definition.id}
                type="button"
                onClick={() => setSelectedId(definition.id)}
                className={`w-full rounded-xl border p-3 text-left transition ${selected?.id === definition.id ? 'border-primary bg-primary/5' : 'border-border bg-background/80 hover:bg-muted/40'}`}
              >
                <div className="truncate text-sm font-medium text-foreground">{definition.name}</div>
                <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">{definition.summary}</div>
              </button>
            ))
          )}
        </div>

        <div className="space-y-3 rounded-2xl border border-border bg-muted/10 p-4">
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">名称</span>
            <input
              value={draft.name}
              onChange={(event) => setDraft((prev) => ({ ...prev, name: event.target.value }))}
              className="rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              placeholder="例如：Frontend Implementer"
            />
          </label>
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">简介（会提供给 Agent Team 生成模型）</span>
            <textarea
              value={draft.summary}
              onChange={(event) => setDraft((prev) => ({ ...prev, summary: event.target.value }))}
              className="min-h-20 rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              placeholder="简要说明这个 agent.md 擅长什么、适合什么角色。"
            />
          </label>
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">agent.md 内容</span>
            <textarea
              value={draft.content}
              onChange={(event) => setDraft((prev) => ({ ...prev, content: event.target.value }))}
              className="min-h-64 rounded-xl border border-border bg-background px-3 py-2 font-mono text-xs outline-none focus:ring-2 focus:ring-ring"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={handleSave} disabled={saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
              保存 agent.md
            </Button>
            {selected ? (
              <Button variant="outline" size="sm" onClick={handleDelete} disabled={saving}>
                <Trash2 className="size-4" />
                删除
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function defaultAgentMdContent(agentName: string): string {
  return `# ${agentName} Role\n\n## Responsibility\n\n描述这个 agent.md 对应角色应该负责的事情。\n\n## Working Style\n\n描述它如何分析问题、产出结果和与其他角色交接。\n\n## Guardrails\n\n- 保持角色边界清晰\n- 不绑定具体 Agent CLI / provider / device\n`;
}

function toEditableTeam(team: AgentTeam): Omit<AgentTeam, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    name: team.name,
    goal: team.goal,
    shape: team.shape,
    description: team.description,
    roles: team.roles,
    workflow: team.workflow,
    successCriteria: team.successCriteria,
    createdByAgentId: team.createdByAgentId,
  };
}

function shapeLabel(shape: AgentTeamShape): string {
  return TEAM_SHAPES.find((item) => item.value === shape)?.label ?? shape;
}

function GeneratedTeamPreview({ team, requestedShape }: { team: AgentTeam; requestedShape: AgentTeamShape }) {
  return (
    <div className="space-y-4">
      <ShapeDecisionNotice team={team} requestedShape={requestedShape} />
      <div className="rounded-2xl border border-green-500/30 bg-green-500/5 p-4">
        <div className="flex items-center gap-2 text-xs font-semibold text-green-700 dark:text-green-300">
          <CheckCircle2 className="size-4" />
          Agent 返回结果
        </div>
        <h5 className="mt-2 text-base font-semibold text-foreground">{team.name}</h5>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">{team.description}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Pill tone="blue">{shapeLabel(team.shape)}</Pill>
          <Pill>{team.roles.length} roles</Pill>
          <Pill>by {team.createdByAgentId}</Pill>
        </div>
      </div>

      <div className="rounded-2xl border border-border bg-muted/20 p-4">
        <div className="text-xs font-medium text-muted-foreground">目标</div>
        <p className="mt-2 text-sm leading-6 text-foreground">{team.goal}</p>
      </div>

      <div>
        <div className="mb-2 text-xs font-medium text-muted-foreground">角色定义</div>
        <div className="space-y-2">
          {team.roles.map((role, index) => (
            <div key={role.id || `${role.name}-${index}`} className="rounded-xl border border-border bg-muted/10 p-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-sm font-medium text-foreground">{role.name}</div>
                  <div className="mt-1 font-mono text-[11px] text-muted-foreground">{role.id}</div>
                </div>
                <Pill>Role {index + 1}</Pill>
              </div>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">{role.responsibility}</p>
              <RoleList title="Inputs" values={role.inputs} />
              <RoleList title="Outputs" values={role.outputs} />
              <RoleList title="Skills / agent.md 建议" values={role.skills} />
              <RoleList title="Guardrails" values={role.guardrails} />
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-2xl border border-border bg-muted/20 p-4">
        <div className="text-xs font-medium text-muted-foreground">Workflow / pipeline</div>
        <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-foreground">{team.workflow}</p>
      </div>

      <div className="rounded-2xl border border-border bg-muted/20 p-4">
        <div className="text-xs font-medium text-muted-foreground">验收标准</div>
        <ul className="mt-2 space-y-1 text-sm leading-6 text-foreground">
          {team.successCriteria.map((criterion, index) => (
            <li key={`${criterion}-${index}`} className="flex gap-2">
              <span className="text-muted-foreground">{index + 1}.</span>
              <span>{criterion}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function ShapeDecisionNotice({ team, requestedShape }: { team: AgentTeam; requestedShape: AgentTeamShape }) {
  const actualShape = shapeLabel(team.shape);
  if (requestedShape === 'auto') {
    return (
      <div className="rounded-2xl border border-blue-500/30 bg-blue-500/5 p-4">
        <div className="text-xs font-medium text-muted-foreground">AI 选择的 Interaction shape</div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Pill tone="blue">{actualShape}</Pill>
          <span className="text-sm text-foreground">这次 Let AI decide 生成的是 {actualShape} Team。</span>
        </div>
      </div>
    );
  }
  return (
    <div className="rounded-2xl border border-border bg-muted/20 p-4">
      <div className="text-xs font-medium text-muted-foreground">Interaction shape</div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Pill tone="blue">{actualShape}</Pill>
        {team.shape !== requestedShape ? (
          <span className="text-sm text-foreground">Agent 返回的实际形态与请求不同：请求 {shapeLabel(requestedShape)}，返回 {actualShape}。</span>
        ) : (
          <span className="text-sm text-foreground">Agent 按请求生成了 {actualShape} Team。</span>
        )}
      </div>
    </div>
  );
}

function RoleList({ title, values }: { title: string; values?: string[] }) {
  if (!values?.length) return null;
  return (
    <div className="mt-2">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</div>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {values.map((value, index) => (
          <span key={`${value}-${index}`} className="rounded-full border border-border bg-background/80 px-2 py-1 text-[11px] text-muted-foreground">
            {value}
          </span>
        ))}
      </div>
    </div>
  );
}

function AgentSkillsPanel({
  skills,
  loading,
  error,
  onRetry,
}: {
  skills: AgentSkillsResponse | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  if (loading && !skills) {
    return <Loader2 className="size-4 animate-spin text-muted-foreground" />;
  }

  if (error) {
    return (
      <div className="space-y-3 rounded-2xl border border-red-500/30 bg-red-500/5 p-4">
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        <Button variant="outline" size="sm" onClick={onRetry} disabled={loading}>
          {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          重试加载 Skills
        </Button>
      </div>
    );
  }

  const workspaceSkills = skills?.workspaceSkills ?? [];
  const cliSkills = skills?.cliSkills ?? [];
  if (!loading && workspaceSkills.length === 0 && cliSkills.length === 0) {
    return <EmptyText>该后端 CLI 未发现 Workspace Skills 或 CLI Skills。</EmptyText>;
  }

  return (
    <div className="space-y-4">
      <SkillGroup title="Workspace Skills" skills={workspaceSkills} empty="当前工作区没有 .claude/skills 技能。" />
      <SkillGroup title="CLI Skills" skills={cliSkills} empty="当前 CLI Home 没有全局 skills。" />
      {loading ? <div className="text-xs text-muted-foreground">正在刷新 Skills…</div> : null}
    </div>
  );
}

function SkillGroup({ title, skills, empty }: { title: string; skills: AgentSkillInfo[]; empty: string }) {
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const packageGroups = groupSkillsByPackage(skills);

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-foreground">{title}</h4>
        <Pill tone="blue">{skills.length}</Pill>
      </div>
      {skills.length ? (
        <div className="space-y-3">
          {packageGroups.map((group) => (
            <div key={group.packageName} className="rounded-2xl border border-border/80 bg-background/60 p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="truncate font-mono text-xs font-semibold text-foreground">{group.packageName}</div>
                <Pill>{group.skills.length}</Pill>
              </div>
              <div className="grid gap-2">
                {group.skills.map((skill) => {
                  const key = `${skill.source}:${skill.id}:${group.packageName}`;
                  const expanded = expandedKey === key;
                  return (
                    <div key={key} className="rounded-xl border border-border bg-background/80 p-3">
                      <button
                        type="button"
                        onClick={() => setExpandedKey(expanded ? null : key)}
                        className="w-full text-left"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium text-foreground">{skill.name || skill.id}</div>
                            <div className="truncate font-mono text-[11px] text-muted-foreground">{skill.id}</div>
                          </div>
                          {skill.enabled === false ? <Pill>disabled</Pill> : <Pill tone="green">enabled</Pill>}
                        </div>
                        {skill.description ? (
                          <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">{skill.description}</p>
                        ) : null}
                      </button>
                      {expanded ? (
                        <div className="mt-3 rounded-lg border border-border/70 bg-muted/20 p-3">
                          {skill.content ? (
                            <MarkdownRenderer content={skill.content} variant="docs" />
                          ) : (
                            <p className="text-xs text-muted-foreground">该 skill 未上报 SKILL.md 详情内容。</p>
                          )}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyText>{empty}</EmptyText>
      )}
    </section>
  );
}

function moduleIcon(module: AgentModuleName) {
  switch (module) {
    case 'Instructions': return <Sparkles className="size-4" />;
    case 'Skills': return <Layers3 className="size-4" />;
    case 'Tasks': return <CheckCircle2 className="size-4" />;
    case 'Args': return <TerminalSquare className="size-4" />;
    case 'ENV': return <KeyRound className="size-4" />;
    case 'Settings': return <Settings2 className="size-4" />;
  }
}

function moduleDescription(module: AgentModuleName) {
  switch (module) {
    case 'Instructions': return '查看 Agent 的运行说明和工作目录策略';
    case 'Skills': return '查看 Agent 或 Device client 上报的能力';
    case 'Tasks': return '查看当前 Agent 关联的调度任务';
    case 'Args': return '查看 CLI 二进制与启动参数模板';
    case 'ENV': return '查看额外注入的环境变量';
    case 'Settings': return '调整默认 Agent、允许列表与运行配置';
  }
}

function runtimeLabel(runtime: AgentRuntime) {
  if (runtime === 'local-device') return 'Device';
  if (runtime === 'server-side') return 'Server Side';
  return 'Built-in';
}

function statusLabel(status: AgentListItem['status']) {
  if (status === 'default') return '默认';
  if (status === 'enabled') return '已启用';
  return '未允许';
}

function getRelatedTasks(agent: AgentListItem, tasks: ScheduledTask[]) {
  if (agent.runtime === 'local-device' && agent.custom?.deviceLinkId) {
    return tasks.filter((task) => task.execution_node === agent.custom?.deviceLinkId);
  }
  if (agent.runtime === 'builtin' || agent.runtime === 'server-side') {
    return tasks.filter((task) => !task.execution_node && task.execution_type !== 'script');
  }
  return [];
}

function formatDuration(ms?: number) {
  if (!ms) return '系统默认';
  if (ms < 60_000) return `${Math.round(ms / 1000)} 秒`;
  return `${Math.round(ms / 60_000)} 分钟`;
}

function formatBytes(bytes?: number) {
  if (!bytes) return '系统默认';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

function maskEnvValue(value: string) {
  if (!value) return '';
  if (value.length <= 6) return '••••';
  return `${value.slice(0, 2)}••••${value.slice(-2)}`;
}

export default AgentsPage;
