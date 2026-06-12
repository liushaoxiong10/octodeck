import { useEffect, useState, useMemo } from 'react';
import { Plus, RefreshCw, Puzzle, Trash2 } from 'lucide-react';
import { SearchInput } from '@/components/common';
import { PageHeader } from '@/components/common/PageHeader';
import { SkeletonCardList } from '@/components/common/Skeletons';
import { EmptyState } from '@/components/common/EmptyState';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { toast } from 'sonner';
import { useSkillsStore, type Skill } from '../stores/skills';
import { useAgentLinksStore, type AgentLink } from '../stores/agentLinks';
import {
  useCustomBackendsStore,
  type CustomBackendDef,
} from '../stores/customBackends';
import { SkillCard } from '../components/skills/SkillCard';
import { SkillDetail } from '../components/skills/SkillDetail';
import { InstallSkillDialog } from '../components/skills/InstallSkillDialog';
import { api } from '../api/client';
import {
  dedupeSkillsByIdentity,
  getSkillIdentityKey,
  groupSkillsByPackage,
  getSkillPackageName,
  normalizeSkillDisplayText,
} from '../utils/skillsGrouping';
import { MarkdownRenderer } from '../components/chat/MarkdownRenderer';

type SkillSourceFilter = 'all' | 'cloud' | 'device' | 'workspace';

interface AgentSkillsResponse {
  workspaceSkills: Array<Partial<Skill> & { id: string; source: 'workspace' }>;
  cliSkills: Array<Partial<Skill> & { id: string; source: 'cli' }>;
}

function getDeviceSkillsBackends(
  backends: CustomBackendDef[],
  devices: AgentLink[],
): CustomBackendDef[] {
  const devicesById = new Map(devices.map((device) => [device.id, device]));
  return backends.filter((backend) => {
    if (!backend.deviceLinkId || !backend.agentClientId) return false;
    const device = devicesById.get(backend.deviceLinkId);
    return (device?.agentClients ?? []).some(
      (client) => client.id === backend.agentClientId,
    );
  });
}

export function SkillsPage() {
  const {
    skills,
    loading,
    error,
    installing,
    loadSkills,
    installSkill,
    deleteAllUserSkills,
  } = useSkillsStore();
  const { links: devices, load: loadDevices } = useAgentLinksStore();
  const { backends, load: loadBackends } = useCustomBackendsStore();

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState<SkillSourceFilter>('all');
  const [deviceFilter, setDeviceFilter] = useState('all');
  const [workspaceFilter, setWorkspaceFilter] = useState('all');
  const [deviceSkills, setDeviceSkills] = useState<Skill[]>([]);
  const [deviceSkillsLoading, setDeviceSkillsLoading] = useState(false);
  const [deviceSkillsError, setDeviceSkillsError] = useState<string | null>(null);
  const [deviceSkillsRefreshKey, setDeviceSkillsRefreshKey] = useState(0);
  const [showInstallDialog, setShowInstallDialog] = useState(false);
  const [deletingAll, setDeletingAll] = useState(false);

  useEffect(() => {
    loadSkills();
    loadDevices();
    loadBackends();
  }, [loadSkills, loadDevices, loadBackends]);

  useEffect(() => {
    const deviceBackends = getDeviceSkillsBackends(backends, devices);
    if (deviceBackends.length === 0) {
      setDeviceSkills([]);
      setDeviceSkillsError(null);
      return;
    }

    let cancelled = false;
    const loadDeviceSkills = async () => {
      setDeviceSkillsLoading(true);
      try {
        const results = await Promise.allSettled(
          deviceBackends.map(async (backend) => {
            const cwd = backend.workdirMode === 'custom'
              ? (backend.workdir ?? '')
              : `octodeck-workspace://${backend.id}`;
            const data = await api.get<AgentSkillsResponse>(
              `/api/agent-links/${encodeURIComponent(backend.deviceLinkId!)}/providers/${encodeURIComponent(backend.agentClientId!)}/skills?cwd=${encodeURIComponent(cwd)}`,
              30_000,
            );
            const workspacePath = backend.workdirMode === 'custom'
              ? (backend.workdir ?? '自定义 Workspace')
              : `${backend.displayName} Workspace`;
            const normalize = (skill: Partial<Skill> & { id: string; source: 'cli' | 'workspace' }): Skill => ({
              id: skill.id,
              name: skill.name || skill.id,
              description: skill.description || '',
              source: skill.source,
              enabled: skill.enabled ?? true,
              packageName: skill.packageName,
              packageSource: skill.packageSource,
              sourceProvider: skill.sourceProvider,
              level: skill.level,
              levelKey: skill.levelKey,
              installedAt: skill.installedAt,
              content: skill.content,
              deviceId: backend.deviceLinkId ?? undefined,
              workspacePath: skill.source === 'workspace' ? workspacePath : undefined,
              userInvocable: true,
              allowedTools: [],
              argumentHint: null,
              updatedAt: new Date().toISOString(),
              files: [],
            });
            return [...(data.workspaceSkills ?? []).map(normalize), ...(data.cliSkills ?? []).map(normalize)];
          }),
        );
        if (!cancelled) {
          setDeviceSkills(results.flatMap((result) => (result.status === 'fulfilled' ? result.value : [])));
          const failures = results.flatMap((result, index) => {
            if (result.status !== 'rejected') return [];
            const backend = deviceBackends[index];
            const reason = result.reason as { message?: string; body?: { error?: string } } | Error | undefined;
            const detail =
              (reason && typeof reason === 'object' && 'body' in reason && reason.body?.error) ||
              (reason instanceof Error ? reason.message : undefined) ||
              (reason && typeof reason === 'object' && 'message' in reason ? reason.message : undefined) ||
              '未知错误';
            return [`${backend?.displayName || backend?.id || 'Device'}: ${detail}`];
          });
          setDeviceSkillsError(
            failures.length > 0
              ? `${failures.length} 个 Device Skills 加载失败 (${failures.join('; ')})`
              : null,
          );
        }
      } finally {
        if (!cancelled) setDeviceSkillsLoading(false);
      }
    };

    void loadDeviceSkills();
    return () => {
      cancelled = true;
    };
  }, [backends, devices, deviceSkillsRefreshKey]);

  const allSkills = useMemo(
    () => dedupeSkillsByIdentity([...skills, ...deviceSkills]),
    [skills, deviceSkills],
  );
  const selectedSkill = useMemo(
    () => allSkills.find((skill) => getSkillKey(skill) === selectedKey) ?? null,
    [allSkills, selectedKey],
  );

  const deviceOptions = useMemo(
    () => [...new Set(deviceSkills.map((skill) => skill.deviceId).filter(Boolean) as string[])],
    [deviceSkills],
  );
  const workspaceOptions = useMemo(
    () => [...new Set(deviceSkills.map((skill) => skill.workspacePath).filter(Boolean) as string[])],
    [deviceSkills],
  );

  const filtered = useMemo(() => {
    const q = searchQuery.toLowerCase();
    return allSkills.filter((s) => {
      const matchesSearch =
        !q ||
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        normalizeSkillDisplayText(s.packageName).toLowerCase().includes(q);
      const matchesSource =
        sourceFilter === 'all' ||
        (sourceFilter === 'cloud' && ['cloud', 'user', 'external'].includes(s.source)) ||
        (sourceFilter === 'device' && s.source === 'cli') ||
        (sourceFilter === 'workspace' && ['workspace', 'project'].includes(s.source));
      const matchesDevice = deviceFilter === 'all' || s.deviceId === deviceFilter;
      const matchesWorkspace = workspaceFilter === 'all' || s.workspacePath === workspaceFilter;
      return matchesSearch && matchesSource && matchesDevice && matchesWorkspace;
    });
  }, [allSkills, searchQuery, sourceFilter, deviceFilter, workspaceFilter]);

  const packageGroups = useMemo(() => groupSkillsByPackage(filtered), [filtered]);
  const cloudSkills = allSkills.filter((s) => ['cloud', 'user', 'external'].includes(s.source));
  const deviceCliSkills = allSkills.filter((s) => s.source === 'cli');
  const workspaceSkills = allSkills.filter((s) => ['workspace', 'project'].includes(s.source));

  const enabledCount = skills.filter((s) => s.enabled).length;

  const handleInstall = async (pkg: string, options?: Parameters<typeof installSkill>[1]) => {
    await installSkill(pkg, options);
    if (options?.target === 'device' || options?.target === 'device-agent-workspace') {
      setDeviceSkillsRefreshKey((value) => value + 1);
    }
  };

  const handleRefresh = () => {
    void loadSkills();
    void loadDevices();
    void loadBackends();
    setDeviceSkillsRefreshKey((value) => value + 1);
  };

  useEffect(() => {
    if (selectedKey && !filtered.some((skill) => getSkillKey(skill) === selectedKey)) {
      setSelectedKey(null);
    }
  }, [filtered, selectedKey]);

  return (
    <div className="min-h-full bg-background">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="bg-background border-b border-border px-6 py-4">
          <PageHeader
            title="技能(Skill)管理"
            subtitle={`Cloud ${cloudSkills.length} · Device ${deviceCliSkills.length} · Workspace ${workspaceSkills.length} · 启用 ${enabledCount}`}
            actions={
              <div className="flex items-center gap-3">
                <Button variant="outline" onClick={handleRefresh} disabled={loading || deviceSkillsLoading}>
                  <RefreshCw size={18} className={loading || deviceSkillsLoading ? 'animate-spin' : ''} />
                  刷新
                </Button>
                <Button onClick={() => setShowInstallDialog(true)}>
                  <Plus size={18} />
                  安装技能
                </Button>
              </div>
            }
          />
        </div>

        {/* Content */}
        <div className="flex gap-6 p-4">
          {/* 左侧列表 */}
          <div className="w-full lg:w-1/2 xl:w-2/5">
            <div className="mb-4 space-y-3">
              <SearchInput
                value={searchQuery}
                onChange={setSearchQuery}
                placeholder="搜索技能名称或描述"
              />
              <div className="grid gap-2 sm:grid-cols-3">
                <select className="rounded-lg border border-border bg-background px-3 py-2 text-sm" value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value as SkillSourceFilter)}>
                  <option value="all">全部来源</option>
                  <option value="cloud">Cloud</option>
                  <option value="device">Device CLI</option>
                  <option value="workspace">Workspace</option>
                </select>
                <select className="rounded-lg border border-border bg-background px-3 py-2 text-sm" value={deviceFilter} onChange={(event) => setDeviceFilter(event.target.value)}>
                  <option value="all">全部 Device</option>
                  {deviceOptions.map((id) => {
                    const device = devices.find((item) => item.id === id);
                    return <option key={id} value={id}>{device?.displayName || id}</option>;
                  })}
                </select>
                <select className="rounded-lg border border-border bg-background px-3 py-2 text-sm" value={workspaceFilter} onChange={(event) => setWorkspaceFilter(event.target.value)}>
                  <option value="all">全部 Workspace</option>
                  {workspaceOptions.map((workspace) => <option key={workspace} value={workspace}>{workspace}</option>)}
                </select>
              </div>
              {deviceSkillsLoading ? <div className="text-xs text-muted-foreground">正在加载 Device / Workspace skills…</div> : null}
              {deviceSkillsError ? <div className="text-xs text-error">{deviceSkillsError}</div> : null}
            </div>

            <div className="space-y-6">
              {loading && skills.length === 0 ? (
                <SkeletonCardList count={3} />
              ) : error ? (
                <Card className="border-error/20">
                  <CardContent className="text-center">
                    <p className="text-error">{error}</p>
                  </CardContent>
                </Card>
              ) : filtered.length === 0 ? (
                <EmptyState
                  icon={Puzzle}
                  title={searchQuery ? '没有找到匹配的技能' : '暂无技能'}
                />
              ) : (
                <>
                  {cloudSkills.length > 0 && sourceFilter !== 'device' && sourceFilter !== 'workspace' && (
                    <div className="flex justify-end">
                      <button
                        className="text-xs text-muted-foreground hover:text-error flex items-center gap-1 cursor-pointer"
                        disabled={deletingAll}
                        onClick={async () => {
                          if (!confirm('确定删除所有 Cloud 技能？Device / Workspace 技能不受影响。')) return;
                          setDeletingAll(true);
                          try {
                            const n = await deleteAllUserSkills();
                            setSelectedKey(null);
                            toast.success(`已删除 ${n} 个 Cloud 技能`);
                          } catch { /* handled by store */ }
                          setDeletingAll(false);
                        }}
                      >
                        <Trash2 size={12} />
                        {deletingAll ? '删除中...' : '清空 Cloud 技能'}
                      </button>
                    </div>
                  )}

                  {packageGroups.map((group) => (
                    <div key={group.packageName}>
                      <div className="flex items-center justify-between mb-3">
                        <h2 className="text-sm font-semibold text-muted-foreground">
                          {group.packageName} ({group.skills.length})
                        </h2>
                      </div>
                      <div className="space-y-2">
                        {group.skills.map((skill) => (
                          <SkillCard
                            key={getSkillKey(skill)}
                            skill={skill}
                            selected={selectedKey === getSkillKey(skill)}
                            onSelect={() => setSelectedKey(getSkillKey(skill))}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>

          {/* 右侧详情（桌面端） */}
          <div className="hidden lg:block lg:w-1/2 xl:w-3/5">
            {selectedSkill && ['cli', 'workspace'].includes(selectedSkill.source) ? (
              <DeviceSkillDetail skill={selectedSkill} />
            ) : (
              <SkillDetail skillId={selectedSkill?.id ?? null} onDeleted={() => setSelectedKey(null)} />
            )}
          </div>
        </div>

        {/* 移动端详情 */}
        {selectedSkill && (
          <div className="lg:hidden p-4">
            {['cli', 'workspace'].includes(selectedSkill.source) ? (
              <DeviceSkillDetail skill={selectedSkill} />
            ) : (
              <SkillDetail skillId={selectedSkill.id} onDeleted={() => setSelectedKey(null)} />
            )}
          </div>
        )}
      </div>

      <InstallSkillDialog
        open={showInstallDialog}
        onClose={() => setShowInstallDialog(false)}
        onInstall={handleInstall}
        installing={installing}
        devices={devices}
        agents={backends}
      />
    </div>
  );
}

function getSkillKey(skill: Skill): string {
  return getSkillIdentityKey(skill);
}

function DeviceSkillDetail({ skill }: { skill: Skill }) {
  return (
    <Card className="overflow-hidden">
      <div className="p-6 border-b border-border">
        <div className="flex items-start justify-between gap-4 mb-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-2">
              <h2 className="text-xl font-bold text-foreground">{skill.name}</h2>
              <span className="px-2 py-0.5 rounded text-xs font-medium bg-muted text-muted-foreground">
                {skill.source === 'workspace' ? 'Workspace' : 'Device'}
              </span>
              {skill.sourceProvider ? (
                <span className="px-2 py-0.5 rounded text-xs font-medium bg-primary/10 text-primary">
                  {skill.sourceProvider}
                </span>
              ) : null}
              {skill.enabled === false ? (
                <span className="px-2 py-0.5 rounded text-xs font-medium bg-muted text-muted-foreground">disabled</span>
              ) : (
                <span className="px-2 py-0.5 rounded text-xs font-medium bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">enabled</span>
              )}
            </div>
            <p className="text-sm text-muted-foreground">{skill.description || '未提供描述'}</p>
          </div>
        </div>

        <div className="space-y-2 text-sm">
          <MetaLine label="Skill ID" value={skill.id} mono />
          <MetaLine label="Package" value={getSkillPackageName(skill)} mono />
          <MetaLine label="Level" value={skill.levelKey || skill.level || 'skill'} mono />
          <MetaLine label="Provider" value={skill.sourceProvider || '—'} mono />
          <MetaLine label="Device" value={skill.deviceId || '—'} mono />
          {skill.workspacePath ? <MetaLine label="Workspace" value={skill.workspacePath} mono /> : null}
        </div>
      </div>

      <div className="p-6 border-b border-border">
        <h3 className="text-sm font-semibold text-foreground mb-3">技能说明</h3>
        {skill.content ? (
          <MarkdownRenderer content={skill.content} variant="docs" />
        ) : (
          <p className="text-sm text-muted-foreground">该 Device skill 暂无详细说明；可查看上方描述、Package、Device / Workspace 信息。</p>
        )}
      </div>

      <div className="p-6 bg-muted">
        <p className="text-sm text-muted-foreground">
          Device / Workspace skills 来自已绑定 Agent 的设备上报，仅支持查看详情。
        </p>
      </div>
    </Card>
  );
}

function MetaLine({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start gap-2">
      <span className="w-24 shrink-0 text-muted-foreground">{label}：</span>
      <span className={`min-w-0 break-words text-foreground ${mono ? 'font-mono text-xs' : ''}`}>{value}</span>
    </div>
  );
}
