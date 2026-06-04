import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
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
  Workflow,
} from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { api } from '../api/client';
import { useAuthStore } from '../stores/auth';
import { useAgentLinksStore, type AgentLink } from '../stores/agentLinks';
import {
  useCustomBackendsStore,
  type CustomBackendDef,
} from '../stores/customBackends';
import { useTasksStore, type ScheduledTask } from '../stores/tasks';
import { useIssuesStore, type WorkspaceIssue } from '../stores/issues';
import {
  useAgentTeamsStore,
  type AgentTeam,
  type AgentTeamApproval,
  type AgentTeamCheckpoint,
  type AgentTeamExecutionResult,
  type AgentTeamRole,
  type AgentTeamRoleAssignment,
  type AgentTeamRun,
  type AgentTeamShape,
} from '../stores/agentTeams';
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
  sourceProvider?: string;
  level?: 'package' | 'skill';
  levelKey?: string;
  enabled?: boolean;
  packageName?: string;
  packageSource?: string;
  installedAt?: string;
  content?: string;
}

interface AgentSkillsResponse {
  workspaceSkills: AgentSkillInfo[];
  cliSkills: AgentSkillInfo[];
  durationMs?: number;
}

const AGENT_SECTIONS = ['Agent 管理', 'Agent.md', 'Agent Team'] as const;
type AgentSectionName = (typeof AGENT_SECTIONS)[number];

const AGENT_ADD_BUTTON_CLASS =
  'gap-1.5 rounded-xl bg-primary text-primary-foreground shadow-sm shadow-primary/20 transition hover:bg-primary/90 hover:shadow-md hover:shadow-primary/25';

const SECTION_ANCHORS: Record<AgentSectionName, string> = {
  'Agent 管理': 'agent',
  'Agent.md': 'agent-md',
  'Agent Team': 'agent-team',
};

const SECTION_BY_ANCHOR = Object.fromEntries(
  Object.entries(SECTION_ANCHORS).map(([section, anchor]) => [
    anchor,
    section as AgentSectionName,
  ]),
) as Record<string, AgentSectionName>;

interface AgentsAnchor {
  agentId?: string;
  agentMdId?: string;
  teamId?: string;
  section?: AgentSectionName;
}

interface TeamDagNode {
  id: string;
  label: string;
  subtitle: string;
  role: AgentTeamRole;
}

interface TeamDagEdge {
  from: string;
  to: string;
  label: string;
  kind?: 'primary' | 'feedback' | 'merge';
}

interface TeamDagModel {
  nodes: TeamDagNode[];
  edges: TeamDagEdge[];
  feedbackEdges: TeamDagEdge[];
  parallelChains: Array<{ group: string; nodes: TeamDagNode[] }>;
  summary: string;
  hint: string;
}

function parseAgentsAnchor(
  hash = typeof window === 'undefined' ? '' : window.location.hash,
): AgentsAnchor {
  const raw = hash.replace(/^#/, '').trim();
  if (!raw) return {};
  if (SECTION_BY_ANCHOR[raw]) return { section: SECTION_BY_ANCHOR[raw] };

  const params = new URLSearchParams(raw);
  const agentId = params.get('agent')?.trim() || undefined;
  const agentMdId = params.get('agentMd')?.trim() || undefined;
  const teamId = params.get('team')?.trim() || undefined;
  const sectionParam = params.get('section')?.trim() || undefined;
  const section = sectionParam
    ? (SECTION_BY_ANCHOR[sectionParam] ??
      (AGENT_SECTIONS.includes(sectionParam as AgentSectionName)
        ? (sectionParam as AgentSectionName)
        : undefined))
    : undefined;
  return { agentId, agentMdId, teamId, section };
}

function updateAgentsAnchor(anchor: AgentsAnchor): void {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams();
  if (anchor.agentId) params.set('agent', anchor.agentId);
  if (anchor.section) params.set('section', SECTION_ANCHORS[anchor.section]);
  if (anchor.agentMdId) params.set('agentMd', anchor.agentMdId);
  if (anchor.teamId) params.set('team', anchor.teamId);
  const nextHash = params.toString() ? `#${params.toString()}` : '';
  const nextUrl = `${window.location.pathname}${window.location.search}${nextHash}`;
  if (window.location.hash !== nextHash) {
    window.history.replaceState(null, '', nextUrl);
  }
}

function scrollAgentsAnchorSection(section?: AgentSectionName): void {
  if (!section || typeof document === 'undefined') return;
  window.requestAnimationFrame(() => {
    document
      .getElementById(SECTION_ANCHORS[section])
      ?.scrollIntoView({ block: 'start' });
  });
}

function buildTeamDag(team: AgentTeam): TeamDagModel {
  const nodes = team.roles.map((role, index) => ({
    id: role.id || `role_${index + 1}`,
    label: role.name || `Role ${index + 1}`,
    subtitle: role.responsibility,
    role,
  }));
  const edges: TeamDagEdge[] = [];
  const feedbackEdges: TeamDagEdge[] = [];
  const parallelChains = buildParallelChains(nodes);

  if (parallelChains.length > 0) {
    const previousNode = nodes.find(
      (node) =>
        !node.role.parallelGroup &&
        nodes.indexOf(node) <
          nodes.findIndex((candidate) => candidate.role.parallelGroup),
    );
    for (const chain of parallelChains) {
      if (chain.nodes[0])
        edges.push({
          from: previousNode?.id ?? 'Start',
          to: chain.nodes[0].id,
          label: `parallel-chain:${chain.group}`,
          kind: 'primary',
        });
      chain.nodes.slice(0, -1).forEach((node, index) => {
        const next = chain.nodes[index + 1];
        if (next)
          edges.push({
            from: node.id,
            to: next.id,
            label: '链路内顺序交付',
            kind: 'primary',
          });
      });
    }
    const mergeTarget = [...nodes]
      .reverse()
      .find((node) => !node.role.parallelGroup);
    if (mergeTarget) {
      for (const chain of parallelChains) {
        const tail = chain.nodes.at(-1);
        if (tail && tail.id !== mergeTarget.id)
          edges.push({
            from: tail.id,
            to: mergeTarget.id,
            label: '并行链路汇总',
            kind: 'merge',
          });
      }
    }
  } else if (team.shape === 'parallel') {
    const mergeNode = nodes[nodes.length - 1];
    for (const node of nodes.slice(0, -1)) {
      edges.push({
        from: 'Start',
        to: node.id,
        label: '并行启动',
        kind: 'primary',
      });
      if (mergeNode)
        edges.push({
          from: node.id,
          to: mergeNode.id,
          label: '汇总结果',
          kind: 'merge',
        });
    }
  } else if (team.shape === 'leader-worker') {
    const lead = nodes[0];
    for (const worker of nodes.slice(1)) {
      edges.push({
        from: lead?.id ?? 'Lead',
        to: worker.id,
        label: '分派任务',
        kind: 'primary',
      });
      edges.push({
        from: worker.id,
        to: lead?.id ?? 'Lead',
        label: '回收产出',
        kind: 'merge',
      });
    }
  } else if (team.shape === 'judge-route') {
    nodes.slice(0, -1).forEach((node, index) => {
      const next = nodes[index + 1];
      if (next)
        edges.push({
          from: node.id,
          to: next.id,
          label: index === 0 ? '判断并路由' : '继续推进',
          kind: 'primary',
        });
    });
  } else {
    nodes.slice(0, -1).forEach((node, index) => {
      const next = nodes[index + 1];
      if (next)
        edges.push({
          from: node.id,
          to: next.id,
          label: '交付下游',
          kind: 'primary',
        });
    });
  }

  const testIndex = nodes.findIndex((node) =>
    /测试|test|qa|quality/i.test(`${node.label} ${node.subtitle}`),
  );
  if (testIndex > 0) {
    const target =
      [...nodes.slice(0, testIndex)]
        .reverse()
        .find((node) =>
          /开发|implement|dev|engineer|编码/i.test(
            `${node.label} ${node.subtitle}`,
          ),
        ) ?? nodes[testIndex - 1];
    feedbackEdges.push({
      from: nodes[testIndex].id,
      to: target.id,
      label: '测试不通过 → 返工',
      kind: 'feedback',
    });
  }

  const flowNames = nodes.map((node) => node.label).join(' → ');
  return {
    nodes,
    edges,
    feedbackEdges,
    parallelChains,
    summary: flowNames || '等待角色定义',
    hint: shapeFlowHint(team.shape),
  };
}

function buildParallelChains(
  nodes: TeamDagNode[],
): Array<{ group: string; nodes: TeamDagNode[] }> {
  const groups = new Map<string, TeamDagNode[]>();
  for (const node of nodes) {
    const group = node.role.parallelGroup?.trim();
    if (!group) continue;
    groups.set(group, [...(groups.get(group) ?? []), node]);
  }
  return Array.from(groups.entries()).map(([group, groupNodes]) => ({
    group,
    nodes: groupNodes,
  }));
}

function shapeFlowHint(shape: AgentTeamShape): string {
  if (shape === 'parallel')
    return 'Parallel 最优展示为 fan-out / fan-in：多个角色同时展开，最后汇总为统一产出。';
  if (shape === 'leader-worker')
    return 'Leader-worker 最优展示为 Lead 分派、Worker 并行执行、再回收给 Lead 汇总。';
  if (shape === 'judge-route')
    return 'Judge route 最优展示为 Judge 选择路径，只激活被选中的分支并进入复核。';
  return 'Pipeline 最优展示为顺序 DAG：上游角色交付给下游，质量失败时通过 feedback edge 返工。';
}

const MODULES = [
  'Instructions',
  'Skills',
  'Tasks',
  'Args',
  'ENV',
  'Settings',
] as const;
type AgentModuleName = (typeof MODULES)[number];

const TEAM_SHAPES: Array<{
  value: AgentTeamShape;
  label: string;
  description: string;
}> = [
  {
    value: 'auto',
    label: 'Let AI decide',
    description: 'Main agent picks the shape from your goal.',
  },
  {
    value: 'pipeline',
    label: 'Pipeline',
    description: 'Agents take turns, one after another.',
  },
  {
    value: 'parallel',
    label: 'Parallel',
    description: 'All agents fan out at once; results merge.',
  },
  {
    value: 'leader-worker',
    label: 'Leader-worker',
    description: 'A lead coordinates worker contributions.',
  },
  {
    value: 'judge-route',
    label: 'Judge route',
    description: 'A judge reviews and routes the next step.',
  },
];

export function AgentsPage() {
  const [searchParams] = useSearchParams();
  const queryTeamId = searchParams.get('team')?.trim() || undefined;
  const queryRunId = searchParams.get('run')?.trim() || undefined;
  const { hasPermission } = useAuthStore();
  const canManage = hasPermission('manage_system_config');
  const [hashAnchor, setHashAnchor] = useState<AgentsAnchor>(() =>
    parseAgentsAnchor(),
  );
  const [settings, setSettings] = useState<SystemSettings | null>(null);
  const [defaultBackend, setDefaultBackend] = useState('claude-sdk');
  const [allowedBackends, setAllowedBackends] = useState<string[]>([
    'claude-sdk',
  ]);
  const [availableBackends, setAvailableBackends] = useState<BackendInfo[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(
    hashAnchor.agentId ?? defaultBackend,
  );
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeSection, setActiveSection] = useState<AgentSectionName>(
    queryTeamId || queryRunId ? 'Agent Team' : (hashAnchor.section ?? 'Agent 管理'),
  );
  const [activeModule, setActiveModule] =
    useState<AgentModuleName>('Instructions');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<CustomBackendDef | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [agentSkills, setAgentSkills] = useState<AgentSkillsResponse | null>(
    null,
  );
  const [agentSkillsLoading, setAgentSkillsLoading] = useState(false);
  const [agentSkillsError, setAgentSkillsError] = useState<string | null>(null);

  const {
    backends: customBackends,
    loading: customLoading,
    load: loadCustomBackends,
    remove,
  } = useCustomBackendsStore();
  const { links: devices, load: loadDevices } = useAgentLinksStore();
  const { tasks, loading: tasksLoading, loadTasks } = useTasksStore();
  const { issues, loading: issuesLoading, loadIssues } = useIssuesStore();

  const load = async () => {
    setLoading(true);
    try {
      const [system, backendList] = await Promise.all([
        api.get<SystemSettings>('/api/config/system'),
        api.get<{ backends: BackendInfo[] }>('/api/config/backends'),
        loadCustomBackends(),
        loadDevices(),
        loadTasks(),
        loadIssues(),
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

  useEffect(() => {
    if (queryTeamId || queryRunId) {
      setActiveSection('Agent Team');
      scrollAgentsAnchorSection('Agent Team');
    }
  }, [queryTeamId, queryRunId]);

  useEffect(() => {
    const handleHashChange = () => {
      const next = parseAgentsAnchor();
      setHashAnchor(next);
      if (next.section) {
        setActiveSection(next.section);
        scrollAgentsAnchorSection(next.section);
      }
      if (next.agentId) setSelectedAgentId(next.agentId);
    };
    window.addEventListener('hashchange', handleHashChange);
    handleHashChange();
    return () => window.removeEventListener('hashchange', handleHashChange);
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
        ? (custom.runtime ??
          (custom.deviceLinkId ? 'local-device' : 'server-side'))
        : 'builtin';
      const status: AgentListItem['status'] =
        backend.id === defaultBackend
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
        runtime:
          custom.runtime ??
          (custom.deviceLinkId ? 'local-device' : 'server-side'),
        model: custom.model ?? null,
        status: allowedBackends.includes(custom.id)
          ? 'enabled'
          : ('disabled' as AgentListItem['status']),
      });
    }

    return fromConfig.sort((a, b) => {
      if (a.status === 'default') return -1;
      if (b.status === 'default') return 1;
      if (a.kind === 'custom' && b.kind !== 'custom') return -1;
      if (a.kind !== 'custom' && b.kind === 'custom') return 1;
      return a.displayName.localeCompare(b.displayName);
    });
  }, [
    allowedBackends,
    backendOptions,
    customBackends,
    customById,
    defaultBackend,
  ]);

  useEffect(() => {
    if (agents.length === 0) {
      setSelectedAgentId(null);
      return;
    }
    if (
      !hashAnchor.agentId &&
      selectedAgentId !== defaultBackend &&
      agents.some((agent) => agent.id === defaultBackend)
    ) {
      setSelectedAgentId(defaultBackend);
      return;
    }
    if (
      !selectedAgentId ||
      !agents.some((agent) => agent.id === selectedAgentId)
    ) {
      const preferredAgentId = hashAnchor.agentId ?? defaultBackend;
      const nextAgentId = agents.some((agent) => agent.id === preferredAgentId)
        ? preferredAgentId
        : agents[0].id;
      setSelectedAgentId(nextAgentId);
    }
  }, [agents, defaultBackend, hashAnchor.agentId, selectedAgentId]);

  useEffect(() => {
    updateAgentsAnchor({
      agentId: selectedAgentId ?? undefined,
      agentMdId: hashAnchor.agentMdId,
      teamId: hashAnchor.teamId,
      section: activeSection,
    });
    scrollAgentsAnchorSection(activeSection);
  }, [activeSection, hashAnchor.agentMdId, hashAnchor.teamId, selectedAgentId]);

  const handleSelectAgent = (agentId: string) => {
    setSelectedAgentId(agentId);
    setHashAnchor((prev) => ({ ...prev, agentId }));
  };

  const selectedAgent =
    agents.find((agent) => agent.id === selectedAgentId) ?? agents[0] ?? null;
  const selectedDevice = selectedAgent?.custom?.deviceLinkId
    ? devices.find((device) => device.id === selectedAgent.custom?.deviceLinkId)
    : null;
  const selectedDeviceOrNull = selectedDevice ?? null;
  const selectedClient = selectedDevice?.agentClients.find(
    (client) => client.id === selectedAgent?.custom?.agentClientId,
  );
  const relatedTasks = selectedAgent
    ? getRelatedTasks(selectedAgent, tasks)
    : [];
  const relatedIssues = selectedAgent
    ? getRelatedIssues(selectedAgent, issues)
    : [];

  const loadAgentSkills = async (agent = selectedAgent) => {
    if (
      !agent?.custom?.deviceLinkId ||
      !agent.custom.agentClientId
    ) {
      setAgentSkills(null);
      setAgentSkillsError(null);
      return;
    }
    setAgentSkillsLoading(true);
    setAgentSkillsError(null);
    try {
      const cwd =
        agent.custom.workdirMode === 'custom'
          ? (agent.custom.workdir ?? '')
          : `octodeck-workspace://${agent.id}`;
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
  }, [
    activeModule,
    selectedAgent?.id,
    selectedAgent?.custom?.deviceLinkId,
    selectedAgent?.custom?.agentClientId,
    selectedAgent?.custom?.workdirMode,
    selectedAgent?.custom?.workdir,
  ]);

  const handleSave = async (
    nextDefaultBackend = defaultBackend,
    nextAllowedBackends = allowedBackends,
  ) => {
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
    const nextAllowed = allowedBackends.includes(agentId)
      ? allowedBackends
      : [agentId, ...allowedBackends];
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
                  Agent 管理、agent.md 角色说明和 Agent Team
                  定义是同级能力；agent.md 和 Team 不隶属于某个 Agent 详情。
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={load}
                disabled={loading || saving}
              >
                <RefreshCw
                  className={`size-4 ${loading ? 'animate-spin' : ''}`}
                />
                刷新
              </Button>
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
              <div className="text-sm text-muted-foreground">
                需要系统配置权限才能管理 Agent。
              </div>
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
                          <h2 className="text-sm font-semibold text-foreground">
                            Agent 后端列表
                          </h2>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {agents.length} 个 Agent · {allowedBackends.length}{' '}
                            个已允许
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {customLoading ? (
                            <Loader2 className="size-4 animate-spin text-muted-foreground" />
                          ) : null}
                          <Button
                            size="sm"
                            className={AGENT_ADD_BUTTON_CLASS}
                            onClick={handleCreate}
                          >
                            <Plus className="size-4" />
                            新增 Agent
                          </Button>
                        </div>
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
                            onClick={() => handleSelectAgent(agent.id)}
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
                                  <Pill
                                    tone={
                                      agent.status === 'disabled'
                                        ? 'muted'
                                        : 'green'
                                    }
                                  >
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
                      issues={relatedIssues}
                      issuesLoading={issuesLoading}
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
          <AgentMdPanel
            generatorAgent={selectedAgent ?? agents[0] ?? null}
            initialSelectedId={hashAnchor.agentMdId}
            onSelectedAgentMdIdChange={(agentMdId) =>
              setHashAnchor((prev) => ({ ...prev, agentMdId }))
            }
          />
        ) : (
          <AgentTeamWorkspace
            agents={agents}
            defaultGeneratorId={selectedAgent?.id ?? defaultBackend}
            initialSelectedTeamId={queryTeamId ?? hashAnchor.teamId}
            initialSelectedRunId={queryRunId}
            onSelectedTeamIdChange={(teamId) =>
              setHashAnchor((prev) => ({ ...prev, teamId }))
            }
          />
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
  const backendLabel =
    agent.custom?.agentClientId ??
    (agent.usesProviderPool ? 'provider-pool' : agent.id);
  const model =
    agent.model ?? (agent.usesProviderPool ? 'Provider Pool' : '默认模型');
  const online = agent.runtime !== 'local-device' || selectedDevice?.online;

  return (
    <Card className="overflow-hidden border-border/80 bg-background/95">
      <CardContent className="p-0">
        <div className="border-b border-border/70 bg-muted/20 p-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Pill tone={online ? 'green' : 'red'}>
                  {online ? 'Online' : 'Offline'}
                </Pill>
                <Pill>{runtimeLabel(agent.runtime)}</Pill>
                {agent.kind === 'custom' ? (
                  <Pill tone="blue">Custom</Pill>
                ) : (
                  <Pill>Built-in</Pill>
                )}
              </div>
              <div>
                <h2 className="truncate text-2xl font-semibold tracking-tight text-foreground">
                  {agent.displayName}
                </h2>
                <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                  {agent.id}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {agent.custom ? (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onEdit(agent.custom!)}
                  >
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
          <SummaryCell
            label="状态"
            value={
              agent.status === 'default'
                ? '默认 / 已启用'
                : statusLabel(agent.status)
            }
          />
          <SummaryCell label="创建人" value={creator} />
        </div>
        <div className="flex flex-col gap-3 p-5 md:flex-row md:items-center md:justify-between">
          <div className="text-xs text-muted-foreground">
            {agent.runtime === 'local-device'
              ? `运行设备：${selectedDevice ? `${selectedDevice.displayName} (${selectedDevice.hostname ?? selectedDevice.id})` : (agent.custom?.deviceLinkId ?? '未绑定')}`
              : agent.runtime === 'server-side'
                ? '运行位置：Server Side Provider Pool'
                : '运行位置：OctoDeck 内置后端'}
            {selectedClient?.version
              ? ` · Client ${selectedClient.version}`
              : ''}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 rounded-full border border-border px-3 py-1.5 text-xs">
              <input
                type="checkbox"
                checked={allowedBackends.includes(agent.id)}
                disabled={agent.id === defaultBackend}
                onChange={(event) =>
                  toggleAllowed(agent.id, event.target.checked)
                }
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
  issues,
  issuesLoading,
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
  issues: WorkspaceIssue[];
  issuesLoading: boolean;
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
                  <span
                    className={`transition ${active ? 'text-primary' : 'group-hover:text-foreground'}`}
                  >
                    {moduleIcon(module)}
                  </span>
                  {module}
                </button>
              );
            })}
          </div>
        </div>
        <div className="min-w-0 p-5">
          <div className="mb-4 flex min-w-0 items-center gap-2">
            <span className="flex size-8 items-center justify-center rounded-xl bg-muted text-primary">
              {moduleIcon(activeModule)}
            </span>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-foreground">
                {activeModule}
              </h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {moduleDescription(activeModule)}
              </p>
            </div>
          </div>
          <div
            role="tabpanel"
            className="min-w-0 overflow-hidden rounded-2xl border border-border/70 bg-muted/10 p-4"
          >
            {renderModuleContent({
              module: activeModule,
              agent,
              selectedDevice,
              selectedClient,
              tasks,
              tasksLoading,
              issues,
              issuesLoading,
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
  issues: WorkspaceIssue[];
  issuesLoading: boolean;
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
  const {
    module,
    agent,
    selectedDevice,
    selectedClient,
    tasks,
    tasksLoading,
    issues,
    issuesLoading,
    agentSkills,
    agentSkillsLoading,
    agentSkillsError,
    onReloadAgentSkills,
  } = args;
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
          <MetaRow
            label="工作目录"
            value={
              custom?.workdirMode === 'custom'
                ? custom.workdir
                : '自动按 Workspace 推导'
            }
          />
          <MetaRow
            label="输出协议"
            value={custom?.outputProtocol ?? '系统默认'}
          />
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
        : ([
            agent.supportsHost ? 'device/native execution' : null,
            agent.supportsContainer ? 'container execution' : null,
            agent.usesProviderPool ? 'provider failover' : null,
          ].filter(Boolean) as string[]);
      return skills.length ? (
        <div className="flex flex-wrap gap-2">
          {skills.map((skill) => (
            <Pill key={skill} tone="blue">
              {skill}
            </Pill>
          ))}
        </div>
      ) : (
        <EmptyText>该 Agent 暂未上报额外 Skills。</EmptyText>
      );
    }
    case 'Tasks':
      if (tasksLoading || issuesLoading)
        return (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        );
      return tasks.length || issues.length ? (
        <div className="space-y-4">
          {issues.length > 0 ? (
            <div className="space-y-2">
              <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
                Issue runs
              </div>
              {issues.slice(0, 5).map((issue) => (
                <a
                  key={issue.id}
                  href="/issues"
                  className="block rounded-xl border border-border bg-muted/20 p-3 transition hover:border-primary/50 hover:bg-muted/30"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs font-medium text-foreground">
                      {issue.title}
                    </span>
                    <Pill
                      tone={
                        issue.last_run_status === 'success'
                          ? 'green'
                          : issue.last_run_status === 'error'
                            ? 'red'
                            : issue.last_run_status === 'running'
                              ? 'blue'
                              : 'muted'
                      }
                    >
                      {issue.last_run_status ?? issue.status}
                    </Pill>
                  </div>
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    Issue · {issue.status} · {issue.priority}
                    {issue.last_run_at ? ` · ${formatDateTime(issue.last_run_at)}` : ''}
                  </div>
                </a>
              ))}
              {issues.length > 5 ? (
                <div className="text-[11px] text-muted-foreground">
                  还有 {issues.length - 5} 个关联 Issue，可到 Issues 页面查看。
                </div>
              ) : null}
            </div>
          ) : null}

          {tasks.length > 0 ? (
            <div className="space-y-2">
              <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
                Scheduled tasks
              </div>
              {tasks.slice(0, 5).map((task) => (
                <div
                  key={task.id}
                  className="rounded-xl border border-border bg-muted/20 p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs font-medium text-foreground">
                      {task.prompt}
                    </span>
                    <Pill tone={task.status === 'active' ? 'green' : 'muted'}>
                      {task.status}
                    </Pill>
                  </div>
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    {task.schedule_type} · {task.schedule_value}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <EmptyText>
          暂无直接关联任务或 Issue run；创建 Issue 并选择这个 Agent 运行后会显示在这里。
        </EmptyText>
      );
    case 'Args':
      return custom?.argvTemplate?.length ? (
        <div className="flex flex-wrap gap-2">
          {[custom.binary, ...custom.argvTemplate].map((arg, index) => (
            <code
              key={`${arg}-${index}`}
              className="rounded-lg border border-border bg-muted/40 px-2 py-1 text-xs"
            >
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
            <MetaRow
              label="Device"
              value={
                selectedDevice
                  ? `${selectedDevice.displayName} (${selectedDevice.id})`
                  : (custom?.deviceLinkId ?? '—')
              }
            />
            <MetaRow
              label="Client"
              value={
                selectedClient
                  ? `${selectedClient.displayName} (${selectedClient.id})`
                  : (custom?.agentClientId ?? '—')
              }
            />
            <MetaRow
              label="Timeout"
              value={formatDuration(custom?.timeoutMs)}
            />
            <MetaRow
              label="Max Output"
              value={formatBytes(custom?.maxOutputBytes)}
            />
          </div>
          <div className="space-y-3 rounded-2xl border border-border bg-muted/20 p-3">
            <div className="space-y-1.5">
              <Label className="text-xs">默认 Agent</Label>
              <Button
                variant={
                  agent.id === args.defaultBackend ? 'secondary' : 'outline'
                }
                size="sm"
                className="w-full justify-start"
                onClick={() => args.onSetDefault(agent.id)}
              >
                <CheckCircle2 className="size-4" />
                {agent.id === args.defaultBackend
                  ? '当前默认 Agent'
                  : '设为默认 Agent'}
              </Button>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={args.allowedBackends.includes(agent.id)}
                disabled={agent.id === args.defaultBackend}
                onChange={(event) =>
                  args.toggleAllowed(agent.id, event.target.checked)
                }
              />
              加入允许列表
            </label>
            <Button
              size="sm"
              onClick={args.onSave}
              disabled={args.saving}
              className="w-full"
            >
              {args.saving ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Save className="size-4" />
              )}
              保存全局 Agent 设置
            </Button>
          </div>
        </div>
      );
  }
}

function AgentManagementSection({ children }: { children: React.ReactNode }) {
  return <section id="agent">{children}</section>;
}

function SummaryCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 bg-background p-4">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 truncate text-sm font-medium text-foreground">
        {value}
      </div>
    </div>
  );
}

function MetaRow({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-border/60 pb-2 last:border-0 last:pb-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="max-w-[70%] break-words text-right text-xs font-medium text-foreground">
        {value || '—'}
      </span>
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
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${toneClass}`}
    >
      {children}
    </span>
  );
}

function EmptyText({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-border bg-muted/20 px-4 py-6 text-center text-xs text-muted-foreground">
      {children}
    </div>
  );
}

function AgentTeamWorkspace({
  agents,
  defaultGeneratorId,
  initialSelectedTeamId,
  initialSelectedRunId,
  onSelectedTeamIdChange,
}: {
  agents: AgentListItem[];
  defaultGeneratorId: string;
  initialSelectedTeamId?: string;
  initialSelectedRunId?: string;
  onSelectedTeamIdChange: (teamId?: string) => void;
}) {
  const {
    teams,
    loading,
    saving,
    error,
    load,
    loadAgentMdDefinitions,
    update,
    remove,
    createRun,
    listRuns,
    loadRun,
    loadRunEvents,
    loadRunApprovals,
    loadRunCheckpoints,
    decideRunApproval,
    cancelRun,
  } = useAgentTeamsStore();
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(
    initialSelectedTeamId ?? null,
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [editingJson, setEditingJson] = useState('');
  const [executionPrompt, setExecutionPrompt] = useState('');
  const [selectedExecutionAgentId, setSelectedExecutionAgentId] =
    useState(defaultGeneratorId);
  const [executionResult, setExecutionResult] =
    useState<AgentTeamExecutionResult | null>(null);
  const [activeRun, setActiveRun] = useState<AgentTeamRun | null>(null);
  const [approvalCard, setApprovalCard] = useState<AgentTeamApproval | null>(
    null,
  );
  const [runCheckpoints, setRunCheckpoints] = useState<AgentTeamCheckpoint[]>(
    [],
  );
  const [runHistory, setRunHistory] = useState<AgentTeamRun[]>([]);
  const [roleAssignments, setRoleAssignments] = useState<
    Record<string, AgentTeamRoleAssignment>
  >({});
  const selectedTeam =
    teams.find((team) => team.id === selectedTeamId) ?? teams[0] ?? null;
  const defaultGenerator =
    agents.find((agent) => agent.id === defaultGeneratorId) ??
    agents[0] ??
    null;
  const executionAgents = agents.filter((agent) => agent.status !== 'disabled');
  const openCreateDialog = () => setCreateOpen(true);
  const selectTeam = (teamId: string | null) => {
    setSelectedTeamId(teamId);
    onSelectedTeamIdChange(teamId ?? undefined);
  };

  useEffect(() => {
    void load().then(() => loadAgentMdDefinitions());
  }, [load, loadAgentMdDefinitions]);

  useEffect(() => {
    if (
      initialSelectedTeamId &&
      initialSelectedTeamId !== selectedTeamId &&
      teams.some((team) => team.id === initialSelectedTeamId)
    ) {
      setSelectedTeamId(initialSelectedTeamId);
    }
  }, [initialSelectedTeamId, selectedTeamId, teams]);

  useEffect(() => {
    if (!initialSelectedRunId || activeRun?.id === initialSelectedRunId) return;
    void loadRun(initialSelectedRunId)
      .then(async (run) => {
        if (run.teamId && run.teamId !== selectedTeamId) {
          setSelectedTeamId(run.teamId);
          onSelectedTeamIdChange(run.teamId);
        }
        await handleSelectRunHistory(run);
      })
      .catch(() => {
        toast.error('无法打开 Agent Team Run 来源');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSelectedRunId, activeRun?.id, loadRun]);

  useEffect(() => {
    if (selectedTeamId && teams.length === 0) return;
    if (!selectedTeam) {
      selectTeam(null);
      setEditingJson('');
      return;
    }
    if (!selectedTeamId || selectedTeam.id !== selectedTeamId) {
      selectTeam(selectedTeam.id);
    }
    setEditingJson(JSON.stringify(toEditableTeam(selectedTeam), null, 2));
  }, [selectedTeam?.id, selectedTeam?.updatedAt]);

  useEffect(() => {
    const preferred =
      selectedTeam?.createdByAgentId ||
      defaultGenerator?.id ||
      defaultGeneratorId;
    if (executionAgents.some((agent) => agent.id === selectedExecutionAgentId))
      return;
    setSelectedExecutionAgentId(
      executionAgents.some((agent) => agent.id === preferred)
        ? preferred
        : (executionAgents[0]?.id ?? preferred),
    );
  }, [
    defaultGenerator?.id,
    defaultGeneratorId,
    executionAgents,
    selectedExecutionAgentId,
    selectedTeam?.createdByAgentId,
  ]);

  useEffect(() => {
    if (!selectedTeam) {
      setRunHistory([]);
      setRoleAssignments({});
      return;
    }
    void listRuns({ teamId: selectedTeam.id })
      .then(setRunHistory)
      .catch(() => setRunHistory([]));
    setRoleAssignments((current) => {
      const roleIds = new Set(selectedTeam.roles.map((role) => role.id));
      const next = Object.fromEntries(
        Object.entries(current).filter(([roleId]) => roleIds.has(roleId)),
      );
      return Object.keys(next).length === Object.keys(current).length
        ? current
        : next;
    });
  }, [listRuns, selectedTeam?.id]);

  const refreshRunHistory = async () => {
    if (!selectedTeam) return;
    setRunHistory(await listRuns({ teamId: selectedTeam.id }));
  };

  const updateRoleAssignment = (roleId: string, runnerAgentId: string) => {
    setRoleAssignments((current) => {
      const next = { ...current };
      if (runnerAgentId) {
        next[roleId] = { runnerAgentId };
      } else {
        delete next[roleId];
      }
      return next;
    });
  };

  const clearRoleAssignments = () => setRoleAssignments({});

  const handleSave = async () => {
    if (!selectedTeam) return;
    try {
      const parsed = JSON.parse(editingJson) as Partial<AgentTeam>;
      const team = await update(selectedTeam.id, parsed);
      selectTeam(team.id);
      toast.success('Agent Team 已保存');
    } catch (err) {
      toast.error(
        err instanceof SyntaxError
          ? 'JSON 格式不正确'
          : getErrorMessage(err, '保存 Agent Team 失败'),
      );
    }
  };

  const handleDelete = async () => {
    if (!selectedTeam) return;
    if (!confirm(`确认删除 Agent Team「${selectedTeam.name}」？`)) return;
    try {
      await remove(selectedTeam.id);
      selectTeam(null);
      toast.success('Agent Team 已删除');
    } catch (err) {
      toast.error(getErrorMessage(err, '删除 Agent Team 失败'));
    }
  };

  const handleExecute = async () => {
    if (!selectedTeam) return;
    const prompt = executionPrompt.trim();
    if (!prompt) {
      toast.error('请输入 Team 执行目标');
      return;
    }
    if (!selectedExecutionAgentId) {
      toast.error('请选择后端 / Device');
      return;
    }
    try {
      const response = await createRun(
        selectedTeam.id,
        prompt,
        selectedExecutionAgentId,
        roleAssignments,
      );
      const run = response.run;
      setActiveRun(run);
      setApprovalCard(response.approval ?? null);
      setRunCheckpoints(
        response.checkpoint
          ? [response.checkpoint]
          : await loadRunCheckpoints(run.id),
      );
      if (response.execution) {
        setExecutionResult(response.execution);
        toast.success(
          response.execution.status === 'success'
            ? 'Agent Team 执行完成'
            : 'Agent Team 执行失败',
        );
      } else if (run.status === 'waiting_approval') {
        const approvals = response.approval
          ? [response.approval]
          : await loadRunApprovals(run.id);
        setApprovalCard(
          approvals.find((approval) => approval.status === 'pending') ??
            approvals[0] ??
            null,
        );
        setExecutionResult(null);
        toast.info('Agent Team 已暂停，等待审批');
      }
      await refreshRunHistory();
    } catch (err) {
      toast.error(getErrorMessage(err, '执行 Agent Team 失败'));
    }
  };

  const handleApprovalDecision = async (decision: 'approved' | 'rejected') => {
    if (!approvalCard) return;
    try {
      const response = await decideRunApproval(
        approvalCard.runId,
        approvalCard.id,
        decision,
      );
      setActiveRun(response.run);
      setRunCheckpoints(await loadRunCheckpoints(response.run.id));
      if (response.execution) setExecutionResult(response.execution);
      const approvals = await loadRunApprovals(response.run.id);
      setApprovalCard(
        approvals.find((approval) => approval.status === 'pending') ?? null,
      );
      await refreshRunHistory();
      toast.success(
        decision === 'approved'
          ? '审批已通过，Run 已继续执行'
          : '审批已拒绝，Run 已取消',
      );
    } catch (err) {
      toast.error(getErrorMessage(err, '处理审批失败'));
    }
  };

  const handleCancelRun = async () => {
    const runId = approvalCard?.runId ?? activeRun?.id;
    if (!runId) return;
    try {
      const response = await cancelRun(runId);
      setActiveRun(response.run);
      setApprovalCard(null);
      setRunCheckpoints(await loadRunCheckpoints(response.run.id));
      await refreshRunHistory();
      toast.success('Run 已取消');
    } catch (err) {
      toast.error(getErrorMessage(err, '取消 Run 失败'));
    }
  };

  const handleSelectRunHistory = async (run: AgentTeamRun) => {
    try {
      const [freshRun, approvals, checkpoints, traceEvents] = await Promise.all(
        [
          loadRun(run.id),
          loadRunApprovals(run.id),
          loadRunCheckpoints(run.id),
          loadRunEvents(run.id),
        ],
      );
      setActiveRun(freshRun);
      setApprovalCard(
        approvals.find((approval) => approval.status === 'pending') ?? null,
      );
      setRunCheckpoints(checkpoints);
      if (freshRun.finalResult || freshRun.error) {
        setExecutionResult({
          status: freshRun.status === 'success' ? 'success' : 'error',
          finalResult: freshRun.finalResult ?? freshRun.error ?? '',
          runId: freshRun.id,
          traceId: freshRun.traceId,
          roleResults: [],
          events: [],
          traceEvents,
          error: freshRun.error,
        });
      } else {
        setExecutionResult(null);
      }
    } catch (err) {
      toast.error(getErrorMessage(err, '加载 Run 历史失败'));
    }
  };

  return (
    <div id="agent-team" className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(260px,1fr)_minmax(0,2fr)]">
        <aside className="rounded-2xl border border-border bg-background/80 p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-foreground">
                Team 列表
              </h3>
              <p className="mt-1 text-xs text-muted-foreground">
                {teams.length} 个已保存 Team
              </p>
            </div>
            <Button
              size="sm"
              className={AGENT_ADD_BUTTON_CLASS}
              onClick={openCreateDialog}
              disabled={!defaultGenerator}
            >
              <Plus className="size-4" />
              创建 Team
            </Button>
          </div>
          {loading ? (
            <div className="mb-2 text-xs text-muted-foreground">
              正在加载 Team…
            </div>
          ) : null}
          {teams.length === 0 ? (
            <EmptyText>
              还没有 Agent Team。点击「创建 Team」开始生成。
            </EmptyText>
          ) : (
            <div className="space-y-2">
              {teams.map((team) => (
                <button
                  key={team.id}
                  type="button"
                  onClick={() => selectTeam(team.id)}
                  className={`w-full rounded-xl border p-3 text-left transition ${selectedTeam?.id === team.id ? 'border-primary bg-primary/5' : 'border-border bg-background/80 hover:bg-muted/40'}`}
                >
                  <div className="truncate text-sm font-medium text-foreground">
                    {team.name}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    <Pill tone="blue">{shapeLabel(team.shape)}</Pill>
                    <Pill>{team.roles.length} roles</Pill>
                  </div>
                  <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                    {team.goal}
                  </div>
                </button>
              ))}
            </div>
          )}
          {error ? (
            <div className="mt-3 text-xs text-red-600 dark:text-red-400">
              {error}
            </div>
          ) : null}
        </aside>

        <AgentTeamPanel
          selectedTeam={selectedTeam}
          editingJson={editingJson}
          executionPrompt={executionPrompt}
          selectedExecutionAgentId={selectedExecutionAgentId}
          executionAgents={executionAgents}
          executionResult={executionResult}
          activeRun={activeRun}
          approvalCard={approvalCard}
          runCheckpoints={runCheckpoints}
          runHistory={runHistory}
          roleAssignments={roleAssignments}
          saving={saving}
          onEditingJsonChange={setEditingJson}
          onExecutionPromptChange={setExecutionPrompt}
          onSelectedExecutionAgentIdChange={setSelectedExecutionAgentId}
          onRoleAssignmentChange={updateRoleAssignment}
          onClearRoleAssignments={clearRoleAssignments}
          onExecute={handleExecute}
          onApprovalDecision={handleApprovalDecision}
          onCancelRun={handleCancelRun}
          onSelectRunHistory={handleSelectRunHistory}
          onSave={handleSave}
          onDelete={handleDelete}
        />
      </div>

      <AgentTeamCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        agents={agents}
        defaultGeneratorId={defaultGenerator?.id ?? defaultGeneratorId}
        onCreated={(team) => selectTeam(team.id)}
      />
    </div>
  );
}

function AgentTeamPanel({
  selectedTeam,
  editingJson,
  executionPrompt,
  selectedExecutionAgentId,
  executionAgents,
  executionResult,
  activeRun,
  approvalCard,
  runCheckpoints,
  runHistory,
  roleAssignments,
  saving,
  onEditingJsonChange,
  onExecutionPromptChange,
  onSelectedExecutionAgentIdChange,
  onRoleAssignmentChange,
  onClearRoleAssignments,
  onExecute,
  onApprovalDecision,
  onCancelRun,
  onSelectRunHistory,
  onSave,
  onDelete,
}: {
  selectedTeam: AgentTeam | null;
  editingJson: string;
  executionPrompt: string;
  selectedExecutionAgentId: string;
  executionAgents: AgentListItem[];
  executionResult: AgentTeamExecutionResult | null;
  activeRun: AgentTeamRun | null;
  approvalCard: AgentTeamApproval | null;
  runCheckpoints: AgentTeamCheckpoint[];
  runHistory: AgentTeamRun[];
  roleAssignments: Record<string, AgentTeamRoleAssignment>;
  saving: boolean;
  onEditingJsonChange: (value: string) => void;
  onExecutionPromptChange: (value: string) => void;
  onSelectedExecutionAgentIdChange: (value: string) => void;
  onRoleAssignmentChange: (roleId: string, runnerAgentId: string) => void;
  onClearRoleAssignments: () => void;
  onExecute: () => void;
  onApprovalDecision: (decision: 'approved' | 'rejected') => void;
  onCancelRun: () => void;
  onSelectRunHistory: (run: AgentTeamRun) => void;
  onSave: () => void;
  onDelete: () => void;
}) {
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [teamEditOpen, setTeamEditOpen] = useState(false);
  const [teamEditMode, setTeamEditMode] = useState<'low-code' | 'json'>(
    'low-code',
  );
  const [dragRoleId, setDragRoleId] = useState<string | null>(null);
  const editableTeam = useMemo(
    () => parseEditableTeamJson(editingJson) ?? selectedTeam,
    [editingJson, selectedTeam],
  );
  const selectedRole =
    selectedTeam?.roles.find((role) => role.id === selectedRoleId) ??
    selectedTeam?.roles[0] ??
    null;

  useEffect(() => {
    if (!selectedTeam) {
      setSelectedRoleId(null);
      return;
    }
    if (
      !selectedRoleId ||
      !selectedTeam.roles.some((role) => role.id === selectedRoleId)
    ) {
      setSelectedRoleId(selectedTeam.roles[0]?.id ?? null);
    }
  }, [selectedTeam?.id, selectedTeam?.roles, selectedRoleId]);

  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-background/80 shadow-sm">
      <div className="flex items-center justify-between gap-3 border-b border-border/70 bg-[radial-gradient(circle_at_top_right,hsl(var(--primary)/0.10),transparent_32%)] p-4">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Team 详情</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            按 Team
            属性查看定义，并点击节点查看每个角色的输入、输出、技能和边界。
          </p>
        </div>
        {selectedTeam ? (
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={onSave}
              disabled={saving}
            >
              {saving ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Save className="size-4" />
              )}
              保存
            </Button>
            <Button size="sm" onClick={onExecute} disabled={saving}>
              {saving ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Sparkles className="size-4" />
              )}
              执行 Team
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={onDelete}
              disabled={saving}
            >
              <Trash2 className="size-4" />
              删除
            </Button>
          </div>
        ) : null}
      </div>
      {selectedTeam ? (
        <div className="space-y-4 p-4">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <AgentTeamPropertyCard
              label="Team"
              value={selectedTeam.name}
              hint={selectedTeam.id}
            />
            <AgentTeamPropertyCard
              label="Shape"
              value={shapeLabel(selectedTeam.shape)}
              hint={selectedTeam.shape}
            />
            <AgentTeamPropertyCard
              label="Generator"
              value={selectedTeam.createdByAgentId}
              hint="createdByAgentId"
            />
            <AgentTeamPropertyCard
              label="Updated"
              value={formatDateTime(selectedTeam.updatedAt)}
              hint={formatDateTime(selectedTeam.createdAt)}
            />
          </div>

          <div className="rounded-2xl border border-border bg-muted/20 p-4">
            <div className="text-xs font-medium text-muted-foreground">
              目标 / Goal
            </div>
            <p className="mt-2 text-sm leading-6 text-foreground">
              {selectedTeam.goal}
            </p>
            <div className="mt-4 text-xs font-medium text-muted-foreground">
              描述 / Description
            </div>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              {selectedTeam.description}
            </p>
          </div>

          <AgentTeamFlowGraph
            team={selectedTeam}
            selectedRoleId={selectedRole?.id ?? null}
            onSelectRole={setSelectedRoleId}
            onEdit={() => setTeamEditOpen(true)}
          />

          {teamEditOpen ? (
            <div className="rounded-2xl border border-primary/20 bg-primary/5 p-4">
              <div className="mb-3 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <h4 className="text-sm font-semibold text-foreground">
                    DAG 编辑模式
                  </h4>
                  <p className="mt-1 text-xs text-muted-foreground">
                    可在低代码拖拽配置与 JSON 编辑模式之间切换，保存后更新 Team
                    DAG。
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant={
                      teamEditMode === 'low-code' ? 'default' : 'outline'
                    }
                    size="sm"
                    onClick={() => setTeamEditMode('low-code')}
                  >
                    低代码拖拽配置
                  </Button>
                  <Button
                    variant={teamEditMode === 'json' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setTeamEditMode('json')}
                  >
                    JSON 编辑模式
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setTeamEditOpen(false)}
                  >
                    收起
                  </Button>
                </div>
              </div>
              {teamEditMode === 'low-code' ? (
                <div className="grid gap-3 lg:grid-cols-2">
                  {(editableTeam?.roles ?? selectedTeam.roles).map(
                    (role, index) => (
                      <div
                        key={role.id || `${role.name}-${index}`}
                        draggable
                        onDragStart={() => setDragRoleId(role.id)}
                        onDragOver={(event) => event.preventDefault()}
                        onDrop={() => {
                          if (!dragRoleId || dragRoleId === role.id) return;
                          onEditingJsonChange(
                            reorderTeamRoleInJson(
                              editingJson,
                              dragRoleId,
                              role.id,
                            ),
                          );
                          setDragRoleId(null);
                        }}
                        className="rounded-2xl border border-border bg-background/90 p-3 shadow-sm"
                      >
                        <div className="mb-3 flex items-center justify-between gap-2">
                          <div className="text-xs font-semibold text-muted-foreground">
                            拖拽排序 · Role {index + 1}
                          </div>
                          <Pill>{role.id}</Pill>
                        </div>
                        <div className="grid gap-2">
                          <label className="grid gap-1">
                            <span className="text-[11px] font-medium text-muted-foreground">
                              角色名称
                            </span>
                            <input
                              value={role.name}
                              onChange={(event) =>
                                onEditingJsonChange(
                                  updateTeamRoleInJson(editingJson, role.id, {
                                    name: event.target.value,
                                  }),
                                )
                              }
                              className="rounded-lg border border-border bg-background px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-ring"
                            />
                          </label>
                          <label className="grid gap-1">
                            <span className="text-[11px] font-medium text-muted-foreground">
                              责任说明
                            </span>
                            <textarea
                              value={role.responsibility}
                              onChange={(event) =>
                                onEditingJsonChange(
                                  updateTeamRoleInJson(editingJson, role.id, {
                                    responsibility: event.target.value,
                                  }),
                                )
                              }
                              className="min-h-20 rounded-lg border border-border bg-background px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-ring"
                            />
                          </label>
                          <label className="grid gap-1">
                            <span className="text-[11px] font-medium text-muted-foreground">
                              parallelGroup（相同值会形成并行链路）
                            </span>
                            <input
                              value={role.parallelGroup ?? ''}
                              onChange={(event) =>
                                onEditingJsonChange(
                                  updateTeamRoleInJson(editingJson, role.id, {
                                    parallelGroup:
                                      event.target.value || undefined,
                                  }),
                                )
                              }
                              className="rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs outline-none focus:ring-2 focus:ring-ring"
                              placeholder="例如 frontend-chain / backend-chain"
                            />
                          </label>
                        </div>
                      </div>
                    ),
                  )}
                </div>
              ) : (
                <label className="grid gap-1.5">
                  <span className="text-xs font-medium text-muted-foreground">
                    编辑 Team JSON
                  </span>
                  <textarea
                    value={editingJson}
                    onChange={(event) =>
                      onEditingJsonChange(event.target.value)
                    }
                    className="min-h-96 rounded-xl border border-border bg-background px-3 py-2 font-mono text-xs outline-none focus:ring-2 focus:ring-ring"
                  />
                </label>
              )}
            </div>
          ) : null}

          <div className="rounded-2xl border border-border bg-background/70 p-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
              <label className="grid gap-1.5 lg:w-72">
                <span className="text-xs font-medium text-muted-foreground">
                  选择后端 / Device
                </span>
                <select
                  value={selectedExecutionAgentId}
                  onChange={(event) =>
                    onSelectedExecutionAgentIdChange(event.target.value)
                  }
                  className="rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                >
                  {executionAgents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agentExecutionLabel(agent)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid flex-1 gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">
                  Team 执行目标
                </span>
                <textarea
                  value={executionPrompt}
                  onChange={(event) =>
                    onExecutionPromptChange(event.target.value)
                  }
                  className="min-h-24 rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                  placeholder="描述希望这个 Agent Team 实际执行的任务，例如：根据需求实现登录页并完成测试 review。"
                />
              </label>
              <Button onClick={onExecute} disabled={saving} className="lg:mb-1">
                {saving ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Workflow className="size-4" />
                )}
                执行 Team
              </Button>
            </div>
            <div className="mt-4 rounded-2xl border border-border bg-muted/20 p-4">
              <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="text-xs font-semibold text-foreground">
                    Role Runner 分配
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    默认继承上方后端 / Device，可为高风险或专长角色指定不同
                    Runner。
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onClearRoleAssignments}
                  disabled={saving || Object.keys(roleAssignments).length === 0}
                >
                  清空分配
                </Button>
              </div>
              <div className="grid gap-3 lg:grid-cols-2">
                {selectedTeam.roles.map((role, index) => (
                  <div
                    key={role.id || `${role.name}-${index}`}
                    className="rounded-xl border border-border bg-background/80 p-3"
                  >
                    <div className="mb-3 flex items-start justify-between gap-2">
                      <div>
                        <div className="text-sm font-medium text-foreground">
                          {role.name}
                        </div>
                        <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                          {role.id}
                        </div>
                      </div>
                      <Pill>Role {index + 1}</Pill>
                    </div>
                    <label className="grid gap-1.5">
                      <span className="text-[11px] font-medium text-muted-foreground">
                        Runner / Device
                      </span>
                      <select
                        value={roleAssignments[role.id]?.runnerAgentId ?? ''}
                        onChange={(event) =>
                          onRoleAssignmentChange(role.id, event.target.value)
                        }
                        className="rounded-lg border border-border bg-background px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-ring"
                      >
                        <option value="">
                          继承默认：{selectedExecutionAgentId || '未选择'}
                        </option>
                        {executionAgents.map((agent) => (
                          <option key={agent.id} value={agent.id}>
                            {agentExecutionLabel(agent)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <RolePolicyBudgetBadges role={role} />
                  </div>
                ))}
              </div>
            </div>
            {executionResult ? (
              <div className="mt-4 rounded-2xl border border-border bg-muted/20 p-4">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      executionResult
                    </div>
                    {executionResult.runId || executionResult.traceId ? (
                      <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                        {executionResult.runId
                          ? `run: ${executionResult.runId}`
                          : ''}
                        {executionResult.runId && executionResult.traceId
                          ? ' · '
                          : ''}
                        {executionResult.traceId
                          ? `trace: ${executionResult.traceId}`
                          : ''}
                      </div>
                    ) : null}
                  </div>
                  <Pill
                    tone={
                      executionResult.status === 'success' ? 'green' : 'red'
                    }
                  >
                    {executionResult.status}
                  </Pill>
                </div>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs leading-5 text-foreground">
                  {executionResult.finalResult}
                </pre>
                {executionResult.traceEvents?.length ? (
                  <div className="mt-4 rounded-xl border border-border bg-background/70 p-3">
                    <div className="mb-2 text-xs font-semibold text-muted-foreground">
                      执行轨迹
                    </div>
                    <div className="max-h-52 space-y-2 overflow-auto">
                      {executionResult.traceEvents.map((event) => (
                        <div
                          key={event.spanId}
                          className="rounded-lg border border-border/70 bg-muted/20 px-3 py-2 text-xs"
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <Pill>{event.type}</Pill>
                            <span className="font-mono text-muted-foreground">
                              {event.actor}
                            </span>
                            {event.taskId ? (
                              <span className="font-mono text-muted-foreground">
                                {event.taskId}
                              </span>
                            ) : null}
                          </div>
                          <div className="mt-1 text-[11px] text-muted-foreground">
                            {new Date(event.timestamp).toLocaleString()}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
            {approvalCard ? (
              <div className="mt-4 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4">
                <div className="mb-3 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
                      等待审批
                    </div>
                    <div className="mt-1 text-sm font-semibold text-foreground">
                      {approvalCard.title}
                    </div>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      {approvalCard.description}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Pill tone="blue">risk: {approvalCard.riskLevel}</Pill>
                      <Pill>{approvalCard.status}</Pill>
                      <span className="font-mono text-[11px] text-muted-foreground">
                        run: {approvalCard.runId}
                      </span>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      onClick={() => onApprovalDecision('approved')}
                      disabled={saving}
                    >
                      {saving ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <CheckCircle2 className="size-4" />
                      )}
                      批准并继续
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onApprovalDecision('rejected')}
                      disabled={saving}
                    >
                      拒绝审批
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={onCancelRun}
                      disabled={saving}
                    >
                      取消 Run
                    </Button>
                  </div>
                </div>
              </div>
            ) : activeRun?.status === 'cancelled' ? (
              <div className="mt-4 rounded-2xl border border-border bg-muted/20 p-4 text-xs text-muted-foreground">
                Run 已取消：<span className="font-mono">{activeRun.id}</span>
              </div>
            ) : null}
            {runCheckpoints.length ? (
              <div className="mt-4 rounded-xl border border-border bg-background/70 p-3">
                <div className="mb-2 text-xs font-semibold text-muted-foreground">
                  检查点
                </div>
                <div className="space-y-2">
                  {runCheckpoints.map((checkpoint) => (
                    <div
                      key={checkpoint.id}
                      className="rounded-lg border border-border/70 bg-muted/20 px-3 py-2 text-xs"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <Pill>{checkpoint.nodeId}</Pill>
                        <span className="font-mono text-muted-foreground">
                          {checkpoint.id}
                        </span>
                      </div>
                      <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap text-[11px] text-muted-foreground">
                        {JSON.stringify(checkpoint.state, null, 2)}
                      </pre>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            <div className="mt-4 rounded-xl border border-border bg-background/70 p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="text-xs font-semibold text-muted-foreground">
                  Run 历史
                </div>
                <Pill>{runHistory.length}</Pill>
              </div>
              {runHistory.length ? (
                <div className="max-h-56 space-y-2 overflow-auto">
                  {runHistory.map((run) => (
                    <button
                      key={run.id}
                      type="button"
                      onClick={() => onSelectRunHistory(run)}
                      className={`w-full rounded-lg border px-3 py-2 text-left text-xs transition ${activeRun?.id === run.id ? 'border-primary bg-primary/5' : 'border-border/70 bg-muted/20 hover:bg-muted/40'}`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="truncate font-medium text-foreground">
                          {run.prompt}
                        </span>
                        <Pill
                          tone={
                            run.status === 'success'
                              ? 'green'
                              : run.status === 'error' ||
                                  run.status === 'cancelled'
                                ? 'red'
                                : 'blue'
                          }
                        >
                          {run.status}
                        </Pill>
                      </div>
                      <div className="mt-1 flex flex-wrap gap-2 font-mono text-[11px] text-muted-foreground">
                        <span>{run.id}</span>
                        <span>{formatDateTime(run.createdAt)}</span>
                      </div>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-border bg-muted/20 px-3 py-4 text-center text-xs text-muted-foreground">
                  暂无 Run 历史。
                </div>
              )}
            </div>
          </div>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)]">
            <AgentTeamWorkflowSummary team={selectedTeam} />
            <AgentTeamNodeDetail role={selectedRole} />
          </div>

          <AgentTeamSuccessCriteria criteria={selectedTeam.successCriteria} />
        </div>
      ) : (
        <div className="p-4">
          <EmptyText>
            选择左侧 Agent Team 查看详情，或点击「创建 Team」生成新的 Team。
          </EmptyText>
        </div>
      )}
    </section>
  );
}

function AgentTeamPropertyCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-2xl border border-border bg-background/70 p-4">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-2 truncate text-sm font-semibold text-foreground">
        {value}
      </div>
      {hint ? (
        <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
          {hint}
        </div>
      ) : null}
    </div>
  );
}

function AgentTeamWorkflowSummary({ team }: { team: AgentTeam }) {
  return (
    <div className="rounded-2xl border border-border bg-background/70 p-4">
      <div className="mb-3 flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Workflow className="size-4" />
        Workflow
      </div>
      <p className="whitespace-pre-wrap text-sm leading-6 text-foreground">
        {team.workflow}
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        {team.roles.map((role, index) => (
          <button
            key={role.id || `${role.name}-${index}`}
            type="button"
            className="rounded-full border border-border bg-muted/20 px-3 py-1 text-xs text-muted-foreground"
          >
            {index + 1}. {role.name}
          </button>
        ))}
      </div>
    </div>
  );
}

function AgentTeamSuccessCriteria({ criteria }: { criteria: string[] }) {
  return (
    <div className="rounded-2xl border border-border bg-muted/20 p-4">
      <div className="text-xs font-medium text-muted-foreground">验收标准</div>
      <ul className="mt-2 space-y-2 text-sm leading-6 text-foreground">
        {criteria.map((criterion, index) => (
          <li key={`${criterion}-${index}`} className="flex gap-2">
            <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-medium text-primary">
              {index + 1}
            </span>
            <span>{criterion}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AgentTeamFlowGraph({
  team,
  selectedRoleId,
  onSelectRole,
  onEdit,
}: {
  team: AgentTeam;
  selectedRoleId: string | null;
  onSelectRole: (roleId: string) => void;
  onEdit: () => void;
}) {
  const dag = buildTeamDag(team);
  const edgeLabelByTarget = new Map(
    dag.edges.map((edge) => [edge.to, edge.label]),
  );

  return (
    <section
      aria-label="Agent Team DAG 流程"
      className="overflow-hidden rounded-3xl border border-border bg-background/80 shadow-sm"
    >
      <div className="border-b border-border/70 bg-[linear-gradient(135deg,hsl(var(--primary)/0.10),transparent_36%),repeating-linear-gradient(90deg,transparent,transparent_18px,hsl(var(--border)/0.28)_19px)] p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.24em] text-primary">
              DAG 流程图
            </div>
            <h4 className="mt-2 text-base font-semibold text-foreground">
              Agent 角色与协作流程
            </h4>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              整体以 DAG 模式展示角色流转；典型流水线：需求分析师 → 架构设计 →
              开发 → 测试 → Review；测试不通过 → 返工。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Pill tone="blue">{shapeLabel(team.shape)}</Pill>
            <Pill>{dag.nodes.length} nodes</Pill>
            <Pill>{dag.edges.length + dag.feedbackEdges.length} edges</Pill>
            <Button variant="outline" size="sm" onClick={onEdit}>
              <Pencil className="size-4" />
              编辑 DAG
            </Button>
          </div>
        </div>
      </div>

      <div className="space-y-4 p-4">
        <div className="rounded-2xl border border-border bg-muted/20 p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Flow summary
          </div>
          <div className="mt-2 break-words text-sm font-medium text-foreground">
            {dag.summary}
          </div>
          <div className="mt-2 text-xs leading-5 text-muted-foreground">
            {dag.hint}
          </div>
        </div>

        {dag.parallelChains.length ? (
          <div className="rounded-2xl border border-primary/20 bg-primary/5 p-4">
            <div className="text-xs font-semibold text-primary">
              并行链路 / parallelGroup
            </div>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              {dag.parallelChains.map((chain) => (
                <div
                  key={chain.group}
                  className="rounded-xl border border-border bg-background/80 p-3"
                >
                  <div className="font-mono text-xs font-semibold text-foreground">
                    {chain.group}
                  </div>
                  <div className="mt-2 text-xs leading-5 text-muted-foreground">
                    {chain.nodes.map((node) => node.label).join(' → ')}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div className="overflow-x-auto pb-2">
          <div className="flex min-w-max items-stretch gap-3">
            {dag.nodes.map((node, index) => {
              const active = selectedRoleId === node.id;
              const inboundLabel =
                index > 0 ? edgeLabelByTarget.get(node.id) : null;
              return (
                <div key={node.id} className="flex items-center gap-3">
                  {index > 0 ? (
                    <div className="flex min-w-20 flex-col items-center gap-1 text-primary">
                      <div className="h-px w-full bg-primary/50" />
                      <div className="whitespace-nowrap text-[10px] font-medium text-muted-foreground">
                        {inboundLabel ?? '流转'}
                      </div>
                      <div className="text-lg leading-none">→</div>
                    </div>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => onSelectRole(node.id)}
                    className={`group flex w-56 flex-col rounded-2xl border p-4 text-left transition ${active ? 'border-primary bg-primary/10 shadow-sm ring-2 ring-primary/20' : 'border-border bg-background hover:border-primary/50 hover:bg-muted/20'}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span
                        className={`flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-bold ${active ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground group-hover:text-foreground'}`}
                      >
                        {index + 1}
                      </span>
                      <Pill>{node.id}</Pill>
                    </div>
                    <div className="mt-3 truncate text-sm font-semibold text-foreground">
                      {node.label}
                    </div>
                    <div className="mt-1 line-clamp-3 text-xs leading-5 text-muted-foreground">
                      {node.subtitle}
                    </div>
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {dag.feedbackEdges.length ? (
          <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4">
            <div className="text-xs font-semibold text-amber-700 dark:text-amber-300">
              返工 / feedback edges
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {dag.feedbackEdges.map((edge) => (
                <span
                  key={`${edge.from}-${edge.to}-${edge.label}`}
                  className="rounded-full border border-amber-500/30 bg-background/70 px-3 py-1 text-xs text-foreground"
                >
                  {labelForDagNode(dag, edge.from)} →{' '}
                  {labelForDagNode(dag, edge.to)} · {edge.label}
                </span>
              ))}
            </div>
          </div>
        ) : null}

        <div className="grid gap-2 md:grid-cols-2">
          {[...dag.edges, ...dag.feedbackEdges].map((edge) => (
            <div
              key={`${edge.from}-${edge.to}-${edge.label}`}
              className="rounded-xl border border-border bg-muted/10 p-3 text-xs"
            >
              <div className="font-medium text-foreground">
                {labelForDagNode(dag, edge.from)} →{' '}
                {labelForDagNode(dag, edge.to)}
              </div>
              <div className="mt-1 text-muted-foreground">{edge.label}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function labelForDagNode(dag: TeamDagModel, id: string): string {
  return dag.nodes.find((node) => node.id === id)?.label ?? id;
}

function AgentTeamNodeDetail({ role }: { role: AgentTeamRole | null }) {
  if (!role) {
    return <EmptyText>选择一个节点查看详情。</EmptyText>;
  }
  return (
    <aside className="rounded-2xl border border-border bg-background/70 p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-medium text-muted-foreground">
            节点详情
          </div>
          <h4 className="mt-1 truncate text-base font-semibold text-foreground">
            {role.name}
          </h4>
          <div className="mt-1 font-mono text-[11px] text-muted-foreground">
            {role.id}
          </div>
        </div>
        <Pill tone="blue">Role node</Pill>
      </div>
      <div className="rounded-xl border border-border bg-muted/20 p-3">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Responsibility
        </div>
        <p className="mt-2 text-sm leading-6 text-foreground">
          {role.responsibility}
        </p>
      </div>
      <RoleList title="Inputs" values={role.inputs} />
      <RoleList title="Outputs" values={role.outputs} />
      <RoleList title="Skills / agent.md 建议" values={role.skills} />
      <RoleList title="Guardrails" values={role.guardrails} />
    </aside>
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
  const [generatedPreviewTeam, setGeneratedPreviewTeam] =
    useState<AgentTeam | null>(null);
  const generatorAgent =
    agents.find((agent) => agent.id === generatorAgentId) ?? agents[0] ?? null;
  const shapeMeta =
    TEAM_SHAPES.find((item) => item.value === shape) ?? TEAM_SHAPES[0];

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
      const team = await generate({
        generatorAgentId: generatorAgent.id,
        goal: trimmedGoal,
        shape,
      });
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
            <h3 className="text-base font-semibold text-foreground">
              创建 Team
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              左侧填写生成参数，右侧展示 Agent 返回后的 Team 结果。现有 agent.md
              简介会提供给模型。
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
          >
            关闭
          </Button>
        </div>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,1fr)]">
          <section className="space-y-4 rounded-2xl border border-border bg-muted/10 p-4">
            <div>
              <h4 className="text-sm font-semibold text-foreground">
                生成参数
              </h4>
              <p className="mt-1 text-xs text-muted-foreground">
                选择生成器 Agent、描述目标，并指定协作形态。
              </p>
            </div>
            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                选择生成器 Agent
              </span>
              <select
                value={generatorAgent?.id ?? ''}
                onChange={(event) => {
                  setGeneratorAgentId(event.target.value);
                  setGeneratedPreviewTeam(null);
                }}
                className="rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              >
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                希望这个 team 能够完成的事情
              </span>
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
              <div className="mb-2 text-xs font-medium text-muted-foreground">
                Interaction shape (optional)
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {TEAM_SHAPES.map((item) => (
                  <label
                    key={item.value}
                    className={`rounded-xl border p-3 text-left transition ${shape === item.value ? 'border-primary bg-primary/5' : 'border-border bg-background/80 hover:bg-muted/40'}`}
                  >
                    <div className="flex items-center gap-2">
                      <input
                        type="radio"
                        checked={shape === item.value}
                        onChange={() => {
                          setShape(item.value);
                          setGeneratedPreviewTeam(null);
                        }}
                      />
                      <span className="text-sm font-medium text-foreground">
                        {item.label}
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {item.description}
                    </div>
                  </label>
                ))}
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-border pt-4">
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={saving}
              >
                取消
              </Button>
              <Button
                onClick={handleGenerate}
                disabled={saving || !generatorAgent}
              >
                {saving ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Sparkles className="size-4" />
                )}
                生成 Team
              </Button>
            </div>
          </section>

          <aside className="space-y-4 rounded-2xl border border-border bg-background/80 p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h4 className="text-sm font-semibold text-foreground">
                  Team 预览
                </h4>
                <p className="mt-1 text-xs text-muted-foreground">
                  生成完成后这里会展示真实的 Team
                  pipeline、角色、工作流和验收标准。
                </p>
              </div>
              <Pill tone="blue">
                {generatedPreviewTeam
                  ? shapeLabel(generatedPreviewTeam.shape)
                  : shapeMeta.label}
              </Pill>
            </div>
            {saving ? (
              <div className="rounded-2xl border border-primary/30 bg-primary/5 p-4 text-sm text-foreground">
                <div className="flex items-center gap-2 font-semibold">
                  <Loader2 className="size-4 animate-spin" />
                  正在等待 Agent 返回 Team 定义…
                </div>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                  不会使用本地草稿兜底；返回后会在这里展示真实生成结果。
                </p>
              </div>
            ) : generatedPreviewTeam ? (
              <GeneratedTeamPreview
                team={generatedPreviewTeam}
                requestedShape={shape}
              />
            ) : (
              <div className="space-y-3 rounded-2xl border border-dashed border-border bg-muted/10 p-4">
                <div className="text-sm font-semibold text-foreground">
                  等待 Agent 生成结果
                </div>
                <p className="text-xs leading-5 text-muted-foreground">
                  点击「生成 Team」后，系统会等待生成器 Agent 返回完整 Team
                  定义；这里不会显示内置角色或本地模拟流程。
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="rounded-xl border border-border bg-background/80 p-3">
                    <div className="text-xs font-medium text-muted-foreground">
                      生成器 Agent
                    </div>
                    <div className="mt-1 truncate text-sm font-semibold text-foreground">
                      {generatorAgent?.displayName ?? '未选择'}
                    </div>
                  </div>
                  <div className="rounded-xl border border-border bg-background/80 p-3">
                    <div className="text-xs font-medium text-muted-foreground">
                      请求的 Interaction shape
                    </div>
                    <div className="mt-1 text-sm font-semibold text-foreground">
                      {shapeMeta.label}
                    </div>
                  </div>
                </div>
              </div>
            )}
            <div className="rounded-xl border border-dashed border-border bg-muted/10 p-3 text-xs text-muted-foreground">
              生成时会把已保存的 agent.md
              简介提供给模型；如果现有定义不足，模型可以返回新的 agent.md
              并由系统自动保存。
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

function AgentMdPanel({
  generatorAgent,
  initialSelectedId,
  onSelectedAgentMdIdChange,
}: {
  generatorAgent: AgentListItem | null;
  initialSelectedId?: string;
  onSelectedAgentMdIdChange: (agentMdId?: string) => void;
}) {
  const {
    agentMdDefinitions,
    saving,
    loadAgentMdDefinitions,
    createAgentMdDefinition,
    updateAgentMdDefinition,
    removeAgentMdDefinition,
  } = useAgentTeamsStore();
  const [selectedId, setSelectedId] = useState<string | null>(
    initialSelectedId ?? null,
  );
  const selected = selectedId
    ? (agentMdDefinitions.find((definition) => definition.id === selectedId) ??
      null)
    : null;
  const [draft, setDraft] = useState({
    name: '',
    summary: '',
    content: '',
  });
  const [createOpen, setCreateOpen] = useState(false);
  const [createDraft, setCreateDraft] = useState({
    name: '',
    summary: '',
    content: '',
  });
  const generatorName = generatorAgent?.displayName ?? 'Agent';
  const generatorId = generatorAgent?.id ?? 'manual';
  const selectAgentMd = (agentMdId: string | null) => {
    setSelectedId(agentMdId);
    onSelectedAgentMdIdChange(agentMdId ?? undefined);
  };

  useEffect(() => {
    void loadAgentMdDefinitions();
  }, [loadAgentMdDefinitions]);

  useEffect(() => {
    if (
      initialSelectedId &&
      initialSelectedId !== selectedId &&
      agentMdDefinitions.some(
        (definition) => definition.id === initialSelectedId,
      )
    ) {
      setSelectedId(initialSelectedId);
    }
  }, [agentMdDefinitions, initialSelectedId, selectedId]);

  useEffect(() => {
    if (selectedId && agentMdDefinitions.length === 0) return;
    if (!selected) {
      const firstDefinition = agentMdDefinitions[0];
      if (firstDefinition) {
        selectAgentMd(firstDefinition.id);
        return;
      }
      if (selectedId) selectAgentMd(null);
      setDraft({
        name: '',
        summary: '',
        content: defaultAgentMdContent(generatorName),
      });
      return;
    }
    if (!selectedId || selected.id !== selectedId) {
      selectAgentMd(selected.id);
    }
    setDraft({
      name: selected.name,
      summary: selected.summary,
      content: selected.content,
    });
  }, [selected?.id, selected?.updatedAt, selectedId, generatorName]);

  const handleNew = () => {
    setCreateDraft({
      name: '',
      summary: '',
      content: defaultAgentMdContent(generatorName),
    });
    setCreateOpen(true);
  };

  const handleCreate = async () => {
    const name = createDraft.name.trim();
    const summary = createDraft.summary.trim();
    const content = createDraft.content.trim();
    if (!name || !summary || !content) {
      toast.error('请填写 agent.md 的名称、简介和内容');
      return;
    }
    try {
      const saved = await createAgentMdDefinition({
        name,
        summary,
        content,
        createdByAgentId: generatorId,
      });
      selectAgentMd(saved.id);
      setCreateOpen(false);
      toast.success('agent.md 已创建');
    } catch (err) {
      toast.error(getErrorMessage(err, '创建 agent.md 失败'));
    }
  };

  const handleSave = async () => {
    if (!selected) {
      toast.error('请先选择一个 agent.md 定义');
      return;
    }
    const name = draft.name.trim();
    const summary = draft.summary.trim();
    const content = draft.content.trim();
    if (!name || !summary || !content) {
      toast.error('请填写 agent.md 的名称、简介和内容');
      return;
    }
    try {
      const payload = { name, summary, content, createdByAgentId: generatorId };
      const saved = await updateAgentMdDefinition(selected.id, payload);
      selectAgentMd(saved.id);
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
      selectAgentMd(null);
      toast.success('agent.md 已删除');
    } catch (err) {
      toast.error(getErrorMessage(err, '删除 agent.md 失败'));
    }
  };

  return (
    <div
      id="agent-md"
      className="grid gap-5 lg:grid-cols-[minmax(280px,1fr)_minmax(0,2fr)]"
    >
      <aside className="rounded-2xl border border-border bg-background/80 p-4 shadow-sm">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h4 className="text-sm font-semibold text-foreground">
              agent.md 定义
            </h4>
            <p className="mt-1 text-xs text-muted-foreground">
              {agentMdDefinitions.length} 个已保存定义
            </p>
          </div>
          <Button
            size="sm"
            className={AGENT_ADD_BUTTON_CLASS}
            onClick={handleNew}
          >
            <Plus className="size-4" />
            新增定义
          </Button>
        </div>
        <p className="mb-3 rounded-xl border border-dashed border-border bg-muted/10 p-3 text-xs leading-5 text-muted-foreground">
          现有 agent.md 简介会在生成 Team 时提供给模型，用于辅助拆分角色。
        </p>
        {agentMdDefinitions.length === 0 ? (
          <EmptyText>
            还没有 agent.md。点击「新增定义」开始创建。
          </EmptyText>
        ) : (
          <div className="max-h-[calc(100vh-19rem)] space-y-2 overflow-y-auto pr-1">
            {agentMdDefinitions.map((definition) => (
              <button
                key={definition.id}
                type="button"
                onClick={() => selectAgentMd(definition.id)}
                className={`w-full rounded-xl border p-3 text-left transition ${selected?.id === definition.id ? 'border-primary bg-primary/5 shadow-sm' : 'border-border bg-background/80 hover:bg-muted/40'}`}
              >
                <div className="truncate text-sm font-medium text-foreground">
                  {definition.name}
                </div>
                <div className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
                  {definition.summary}
                </div>
              </button>
            ))}
          </div>
        )}
      </aside>

      <main className="min-w-0 rounded-2xl border border-border bg-background/80 p-4 shadow-sm">
        {selected ? (
          <div className="space-y-4">
            <div className="flex flex-col gap-3 border-b border-border/70 pb-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <h4 className="truncate text-sm font-semibold text-foreground">
                  {selected.name}
                </h4>
                <p className="mt-1 text-xs text-muted-foreground">
                  最近更新：{formatDateTime(selected.updatedAt)}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                <Button size="sm" onClick={handleSave} disabled={saving}>
                  {saving ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Save className="size-4" />
                  )}
                  保存修改
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleDelete}
                  disabled={saving}
                >
                  <Trash2 className="size-4" />
                  删除
                </Button>
              </div>
            </div>
            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                名称
              </span>
              <input
                value={draft.name}
                onChange={(event) =>
                  setDraft((prev) => ({ ...prev, name: event.target.value }))
                }
                className="rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                placeholder="例如：Frontend Implementer"
              />
            </label>
            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                简介（会提供给 Agent Team 生成模型）
              </span>
              <textarea
                value={draft.summary}
                onChange={(event) =>
                  setDraft((prev) => ({ ...prev, summary: event.target.value }))
                }
                className="min-h-20 rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                placeholder="简要说明这个 agent.md 擅长什么、适合什么角色。"
              />
            </label>
            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                agent.md 内容
              </span>
              <textarea
                value={draft.content}
                onChange={(event) =>
                  setDraft((prev) => ({ ...prev, content: event.target.value }))
                }
                className="min-h-[28rem] rounded-xl border border-border bg-background px-3 py-2 font-mono text-xs leading-5 outline-none focus:ring-2 focus:ring-ring"
              />
            </label>
          </div>
        ) : (
          <div className="flex min-h-80 items-center justify-center">
            <EmptyText>选择左侧 agent.md 查看详情，或点击「新增定义」创建。</EmptyText>
          </div>
        )}
      </main>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-2xl">
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void handleCreate();
            }}
          >
            <DialogHeader>
              <DialogTitle>新增 agent.md 定义</DialogTitle>
              <DialogDescription>
                填写名称、简介和 agent.md 内容。创建后会自动选中并在右侧继续编辑。
              </DialogDescription>
            </DialogHeader>
            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                名称
              </span>
              <input
                value={createDraft.name}
                onChange={(event) =>
                  setCreateDraft((prev) => ({ ...prev, name: event.target.value }))
                }
                className="rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                placeholder="例如：Frontend Implementer"
                autoFocus
              />
            </label>
            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                简介
              </span>
              <textarea
                value={createDraft.summary}
                onChange={(event) =>
                  setCreateDraft((prev) => ({
                    ...prev,
                    summary: event.target.value,
                  }))
                }
                className="min-h-20 rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                placeholder="简要说明这个 agent.md 擅长什么、适合什么角色。"
              />
            </label>
            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                agent.md 内容
              </span>
              <textarea
                value={createDraft.content}
                onChange={(event) =>
                  setCreateDraft((prev) => ({
                    ...prev,
                    content: event.target.value,
                  }))
                }
                className="min-h-64 rounded-xl border border-border bg-background px-3 py-2 font-mono text-xs leading-5 outline-none focus:ring-2 focus:ring-ring"
              />
            </label>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setCreateOpen(false)}
              >
                取消
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Plus className="size-4" />
                )}
                创建定义
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function defaultAgentMdContent(agentName: string): string {
  return `# ${agentName} Role\n\n## Responsibility\n\n描述这个 agent.md 对应角色应该负责的事情。\n\n## Working Style\n\n描述它如何分析问题、产出结果和与其他角色交接。\n\n## Guardrails\n\n- 保持角色边界清晰\n- 不绑定具体 Agent CLI / provider / device\n`;
}

function toEditableTeam(
  team: AgentTeam,
): Omit<AgentTeam, 'id' | 'createdAt' | 'updatedAt'> {
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

function parseEditableTeamJson(editingJson: string): Partial<AgentTeam> | null {
  try {
    const parsed = JSON.parse(editingJson) as Partial<AgentTeam>;
    return Array.isArray(parsed.roles) ? parsed : null;
  } catch {
    return null;
  }
}

function updateTeamRoleInJson(
  editingJson: string,
  roleId: string,
  patch: Partial<AgentTeamRole>,
): string {
  try {
    const draft = JSON.parse(editingJson) as Partial<AgentTeam>;
    const roles = Array.isArray(draft.roles) ? draft.roles : [];
    return JSON.stringify(
      {
        ...draft,
        roles: roles.map((role) =>
          role.id === roleId ? { ...role, ...patch } : role,
        ),
      },
      null,
      2,
    );
  } catch {
    return editingJson;
  }
}

function reorderTeamRoleInJson(
  editingJson: string,
  dragRoleId: string,
  dropRoleId: string,
): string {
  try {
    const draft = JSON.parse(editingJson) as Partial<AgentTeam>;
    const roles = Array.isArray(draft.roles) ? [...draft.roles] : [];
    const from = roles.findIndex((role) => role.id === dragRoleId);
    const to = roles.findIndex((role) => role.id === dropRoleId);
    if (from < 0 || to < 0) return editingJson;
    const [moved] = roles.splice(from, 1);
    if (!moved) return editingJson;
    roles.splice(to, 0, moved);
    return JSON.stringify({ ...draft, roles }, null, 2);
  } catch {
    return editingJson;
  }
}

function agentExecutionLabel(agent: AgentListItem): string {
  const runtime = runtimeLabel(agent.runtime);
  const device = agent.custom?.deviceLinkId
    ? ` · Device ${agent.custom.deviceLinkId}`
    : '';
  return `${agent.displayName} (${runtime})${device}`;
}

function shapeLabel(shape: AgentTeamShape): string {
  return TEAM_SHAPES.find((item) => item.value === shape)?.label ?? shape;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN');
}

function GeneratedTeamPreview({
  team,
  requestedShape,
}: {
  team: AgentTeam;
  requestedShape: AgentTeamShape;
}) {
  return (
    <div className="space-y-4">
      <ShapeDecisionNotice team={team} requestedShape={requestedShape} />
      <div className="rounded-2xl border border-green-500/30 bg-green-500/5 p-4">
        <div className="flex items-center gap-2 text-xs font-semibold text-green-700 dark:text-green-300">
          <CheckCircle2 className="size-4" />
          Agent 返回结果
        </div>
        <h5 className="mt-2 text-base font-semibold text-foreground">
          {team.name}
        </h5>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          {team.description}
        </p>
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
        <div className="mb-2 text-xs font-medium text-muted-foreground">
          角色定义
        </div>
        <div className="space-y-2">
          {team.roles.map((role, index) => (
            <div
              key={role.id || `${role.name}-${index}`}
              className="rounded-xl border border-border bg-muted/10 p-3"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-sm font-medium text-foreground">
                    {role.name}
                  </div>
                  <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                    {role.id}
                  </div>
                </div>
                <Pill>Role {index + 1}</Pill>
              </div>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">
                {role.responsibility}
              </p>
              <RoleList title="Inputs" values={role.inputs} />
              <RoleList title="Outputs" values={role.outputs} />
              <RoleList title="Skills / agent.md 建议" values={role.skills} />
              <RoleList title="Guardrails" values={role.guardrails} />
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-2xl border border-border bg-muted/20 p-4">
        <div className="text-xs font-medium text-muted-foreground">
          Workflow
        </div>
        <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-foreground">
          {team.workflow}
        </p>
      </div>

      <div className="rounded-2xl border border-border bg-muted/20 p-4">
        <div className="text-xs font-medium text-muted-foreground">
          验收标准
        </div>
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

function ShapeDecisionNotice({
  team,
  requestedShape,
}: {
  team: AgentTeam;
  requestedShape: AgentTeamShape;
}) {
  const actualShape = shapeLabel(team.shape);
  if (requestedShape === 'auto') {
    return (
      <div className="rounded-2xl border border-blue-500/30 bg-blue-500/5 p-4">
        <div className="text-xs font-medium text-muted-foreground">
          AI 选择的 Interaction shape
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Pill tone="blue">{actualShape}</Pill>
          <span className="text-sm text-foreground">
            这次 Let AI decide 生成的是 {actualShape} Team。
          </span>
        </div>
      </div>
    );
  }
  return (
    <div className="rounded-2xl border border-border bg-muted/20 p-4">
      <div className="text-xs font-medium text-muted-foreground">
        Interaction shape
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Pill tone="blue">{actualShape}</Pill>
        {team.shape !== requestedShape ? (
          <span className="text-sm text-foreground">
            Agent 返回的实际形态与请求不同：请求 {shapeLabel(requestedShape)}
            ，返回 {actualShape}。
          </span>
        ) : (
          <span className="text-sm text-foreground">
            Agent 按请求生成了 {actualShape} Team。
          </span>
        )}
      </div>
    </div>
  );
}

function RoleList({ title, values }: { title: string; values?: string[] }) {
  if (!values?.length) return null;
  return (
    <div className="mt-2">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {values.map((value, index) => (
          <span
            key={`${value}-${index}`}
            className="rounded-full border border-border bg-background/80 px-2 py-1 text-[11px] text-muted-foreground"
          >
            {value}
          </span>
        ))}
      </div>
    </div>
  );
}

function RolePolicyBudgetBadges({ role }: { role: AgentTeamRole }) {
  const policy = role.policy;
  const budget = role.budget ?? {};
  const workspacePolicy = policy?.workspacePolicy ?? '默认工作区策略';
  const requiresApproval = policy?.requiresApproval ?? false;

  return (
    <div className="mt-3 flex flex-wrap gap-1.5">
      <Pill
        tone={
          policy?.permissionLevel &&
          ['L4', 'L5'].includes(policy.permissionLevel)
            ? 'red'
            : 'blue'
        }
      >
        permission: {policy?.permissionLevel ?? '默认'}
      </Pill>
      <Pill>workspacePolicy: {workspacePolicy}</Pill>
      <Pill tone={requiresApproval ? 'red' : 'green'}>
        {requiresApproval ? 'requiresApproval' : '无需审批'}
      </Pill>
      <Pill>duration: {formatDuration(budget.maxDurationMs)}</Pill>
      <Pill>tokens: {budget.maxTokens ?? '系统默认'}</Pill>
      <Pill>output: {formatBytes(budget.maxOutputBytes)}</Pill>
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
        <Button
          variant="outline"
          size="sm"
          onClick={onRetry}
          disabled={loading}
        >
          {loading ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <RefreshCw className="size-4" />
          )}
          重试加载 Skills
        </Button>
      </div>
    );
  }

  const workspaceSkills = skills?.workspaceSkills ?? [];
  const cliSkills = skills?.cliSkills ?? [];
  if (!loading && workspaceSkills.length === 0 && cliSkills.length === 0) {
    return (
      <EmptyText>该后端 CLI 未发现 Workspace Skills 或 CLI Skills。</EmptyText>
    );
  }

  return (
    <div className="min-w-0 space-y-4 overflow-hidden">
      <SkillGroup
        title="Workspace Skills"
        skills={workspaceSkills}
        empty="当前工作区没有 .claude/skills 技能。"
      />
      <SkillGroup
        title="CLI Skills"
        skills={cliSkills}
        empty="当前 CLI Home 没有全局 skills。"
      />
      {loading ? (
        <div className="text-xs text-muted-foreground">正在刷新 Skills…</div>
      ) : null}
    </div>
  );
}

function SkillGroup({
  title,
  skills,
  empty,
}: {
  title: string;
  skills: AgentSkillInfo[];
  empty: string;
}) {
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const packageGroups = groupSkillsByPackage(skills);

  return (
    <section className="min-w-0 space-y-2 overflow-hidden">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <h4 className="min-w-0 truncate text-sm font-semibold text-foreground">
          {title}
        </h4>
        <span className="shrink-0">
          <Pill tone="blue">{skills.length}</Pill>
        </span>
      </div>
      {skills.length ? (
        <div className="min-w-0 space-y-3">
          {packageGroups.map((group) => (
            <div
              key={group.packageName}
              className="min-w-0 overflow-hidden rounded-2xl border border-border/80 bg-background/60 p-3"
            >
              <div className="mb-2 flex min-w-0 items-center justify-between gap-2">
                <div
                  className="min-w-0 truncate font-mono text-xs font-semibold text-foreground"
                  title={group.packageName}
                >
                  {group.packageName}
                </div>
                <span className="shrink-0">
                  <Pill>{group.skills.length}</Pill>
                </span>
              </div>
              <div className="grid min-w-0 gap-2">
                {group.skills.map((skill) => {
                  const key = `${skill.source}:${skill.id}:${group.packageName}`;
                  const expanded = expandedKey === key;
                  return (
                    <div
                      key={key}
                      className="min-w-0 overflow-hidden rounded-xl border border-border bg-background/80 p-3"
                    >
                      <button
                        type="button"
                        onClick={() => setExpandedKey(expanded ? null : key)}
                        className="block w-full min-w-0 text-left"
                      >
                        <div className="flex min-w-0 items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="break-words text-sm font-medium text-foreground">
                              {skill.name || skill.id}
                            </div>
                            <div className="break-all font-mono text-[11px] text-muted-foreground">
                              {skill.id}
                            </div>
                            <div className="mt-1 flex flex-wrap gap-1">
                              {skill.sourceProvider ? (
                                <Pill tone="blue">{skill.sourceProvider}</Pill>
                              ) : null}
                              <Pill>{skill.levelKey || skill.level || 'skill'}</Pill>
                            </div>
                          </div>
                          <span className="shrink-0">
                            {skill.enabled === false ? (
                              <Pill>disabled</Pill>
                            ) : (
                              <Pill tone="green">enabled</Pill>
                            )}
                          </span>
                        </div>
                        {skill.description ? (
                          <p className="mt-2 line-clamp-3 break-words text-xs leading-relaxed text-muted-foreground">
                            {skill.description}
                          </p>
                        ) : null}
                      </button>
                      {expanded ? (
                        <div className="mt-3 max-h-[32rem] min-w-0 overflow-auto rounded-lg border border-border/70 bg-muted/20 p-3 overscroll-contain">
                          {skill.content ? (
                            <div className="min-w-0 max-w-full text-sm leading-relaxed [overflow-wrap:anywhere] [&_*]:max-w-full [&_a]:break-all [&_code]:whitespace-pre-wrap [&_code]:break-words [&_li]:break-words [&_p]:break-words [&_pre]:overflow-x-auto [&_pre]:whitespace-pre-wrap [&_table]:block [&_table]:overflow-x-auto">
                              <MarkdownRenderer
                                content={skill.content}
                                variant="docs"
                              />
                            </div>
                          ) : (
                            <p className="text-xs text-muted-foreground">
                              该 skill 未上报 SKILL.md 详情内容。
                            </p>
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
    case 'Instructions':
      return <Sparkles className="size-4" />;
    case 'Skills':
      return <Layers3 className="size-4" />;
    case 'Tasks':
      return <CheckCircle2 className="size-4" />;
    case 'Args':
      return <TerminalSquare className="size-4" />;
    case 'ENV':
      return <KeyRound className="size-4" />;
    case 'Settings':
      return <Settings2 className="size-4" />;
  }
}

function moduleDescription(module: AgentModuleName) {
  switch (module) {
    case 'Instructions':
      return '查看 Agent 的运行说明和工作目录策略';
    case 'Skills':
      return '查看 Agent 或 Device client 上报的能力';
    case 'Tasks':
      return '查看当前 Agent 关联的调度任务';
    case 'Args':
      return '查看 CLI 二进制与启动参数模板';
    case 'ENV':
      return '查看额外注入的环境变量';
    case 'Settings':
      return '调整默认 Agent、允许列表与运行配置';
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
    return tasks.filter((task) =>
      matchesLocalAgentTarget(
        agent,
        task.execution_node,
        null,
        null,
      ),
    );
  }
  if (agent.runtime === 'builtin' || agent.runtime === 'server-side') {
    return tasks.filter(
      (task) => !task.execution_node && task.execution_type !== 'script',
    );
  }
  return [];
}

function getRelatedIssues(agent: AgentListItem, issues: WorkspaceIssue[]) {
  if (agent.runtime === 'local-device' && agent.custom?.deviceLinkId) {
    return issues.filter((issue) =>
      matchesLocalAgentTarget(
        agent,
        issue.execution_node,
        issue.agent_link_id,
        issue.agent_client_id,
      ),
    );
  }
  if (agent.runtime === 'builtin' || agent.runtime === 'server-side') {
    return issues.filter((issue) => !issue.agent_link_id && !issue.execution_node);
  }
  return [];
}

function matchesLocalAgentTarget(
  agent: AgentListItem,
  executionNode?: string | null,
  agentLinkId?: string | null,
  agentClientId?: string | null,
) {
  const deviceLinkId = agent.custom?.deviceLinkId;
  if (!deviceLinkId) return false;
  const clientId = agent.custom?.agentClientId ?? undefined;
  if (agentLinkId === deviceLinkId) {
    return !clientId || !agentClientId || agentClientId === clientId;
  }
  if (!executionNode) return false;
  if (executionNode === deviceLinkId) return true;
  if (executionNode === `${deviceLinkId}:${clientId}`) return true;
  if (clientId && executionNode === `provider:${clientId}`) return true;
  if (executionNode.startsWith(`runtime:${deviceLinkId}:`)) {
    return !clientId || executionNode === `runtime:${deviceLinkId}:${clientId}`;
  }
  if (executionNode.startsWith(`${deviceLinkId}:`)) {
    return !clientId || executionNode === `${deviceLinkId}:${clientId}`;
  }
  return false;
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
