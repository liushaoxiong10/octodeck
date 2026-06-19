import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Bot, Download, Loader2, Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import {
  useAgentDefinitionsStore,
  type AgentDefinitionDetail,
} from '../stores/agent-definitions';
import { InstallAgentMarketplaceDialog } from '@/components/agent-definitions/InstallAgentMarketplaceDialog';

function formatRegistryBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function AgentDefinitionsPage() {
  const { agents, loading, error: listError, loadAgents, createAgent } =
    useAgentDefinitionsStore();
  const { registry, registryLoading, loadRegistry } = useAgentDefinitionsStore();
  const { agentGovernance, governanceLoading, loadAgentGovernance, rollbackAgentDefinition } =
    useAgentDefinitionsStore();
  const getAgentDetail = useAgentDefinitionsStore((s) => s.getAgentDetail);
  const updateAgent = useAgentDefinitionsStore((s) => s.updateAgent);
  const deleteAgent = useAgentDefinitionsStore((s) => s.deleteAgent);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  // Detail state
  const [detail, setDetail] = useState<AgentDefinitionDetail | null>(null);
  const [content, setContent] = useState('');
  const [initialContent, setInitialContent] = useState('');
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [rollingBackVersionId, setRollingBackVersionId] = useState<string | null>(null);

  // Create dialog
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState('');
  const [creating, setCreating] = useState(false);

  // Marketplace dialog
  const [showMarketplace, setShowMarketplace] = useState(false);

  // Notice
  const [notice, setNotice] = useState<string | null>(null);

  const isMobile = useMediaQuery('(max-width: 1023px)');
  const [showContent, setShowContent] = useState(false);

  const dirty = useMemo(() => content !== initialContent, [content, initialContent]);
  const byteCount = useMemo(() => new TextEncoder().encode(content).length, [content]);
  const selectedGovernance = selectedId ? agentGovernance[selectedId] : null;

  const filtered = useMemo(() => {
    const q = searchQuery.toLowerCase();
    return agents.filter(
      (a) =>
        !q ||
        a.name.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q),
    );
  }, [agents, searchQuery]);

  useEffect(() => {
    loadAgents();
    loadRegistry();
  }, [loadAgents, loadRegistry]);

  const loadDetail = useCallback(async (id: string) => {
    setLoadingDetail(true);
    setDetailError(null);
    setNotice(null);
    try {
      const data = await getAgentDetail(id);
      setDetail(data);
      setContent(data.content);
      setInitialContent(data.content);
      setSelectedId(id);
      void loadAgentGovernance(id);
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : '加载失败');
      setDetail(null);
    } finally {
      setLoadingDetail(false);
    }
  }, [getAgentDetail, loadAgentGovernance]);

  const handleSelectAgent = async (id: string) => {
    if (id === selectedId && isMobile) {
      setShowContent(true);
      return;
    }
    if (id === selectedId) return;
    if (dirty && !confirm('当前有未保存修改，切换会丢失。是否继续？')) return;
    await loadDetail(id);
    if (isMobile) setShowContent(true);
  };

  const handleSave = async () => {
    if (!detail) return;
    setSaving(true);
    setNotice(null);
    setDetailError(null);
    try {
      await updateAgent(detail.id, content);
      // updateAgent already calls loadAgents() internally to sync the list.
      // Just update local state with the saved content — no extra fetch needed.
      setInitialContent(content);
      setNotice('已保存');
      await loadRegistry();
      await loadAgentGovernance(detail.id);
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const handleRollbackVersion = async (versionId: string) => {
    if (!detail) return;
    if (dirty && !confirm('当前有未保存修改，回滚会覆盖编辑器内容。是否继续？')) return;
    if (!confirm('确认回滚到此版本？当前版本会先写入版本快照。')) return;
    setRollingBackVersionId(versionId);
    setDetailError(null);
    setNotice(null);
    try {
      await rollbackAgentDefinition(detail.id, versionId);
      await loadDetail(detail.id);
      setNotice('已回滚');
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : '回滚失败');
    } finally {
      setRollingBackVersionId(null);
    }
  };

  const handleDelete = async () => {
    if (!detail) return;
    if (!confirm(`确认删除 Agent「${detail.name}」？`)) return;
    setDeleting(true);
    try {
      await deleteAgent(detail.id);
      setSelectedId(null);
      setDetail(null);
      setContent('');
      setInitialContent('');
      if (isMobile) setShowContent(false);
    } catch {
      // error handled by store
    } finally {
      setDeleting(false);
    }
  };

  const handleCreate = async () => {
    if (!createName.trim()) return;
    setCreating(true);
    try {
      const defaultContent = `---
name: ${createName.trim()}
description:
tools:
  - WebSearch
  - Read
  - Write
---

# ${createName.trim()}

（在此编写 Agent 指令）
`;
      const id = await createAgent(createName.trim(), defaultContent);
      setCreateName('');
      setShowCreate(false);
      await loadDetail(id);
      if (isMobile) setShowContent(true);
    } catch {
      // error handled by store
    } finally {
      setCreating(false);
    }
  };

  const updatedText = detail?.updatedAt
    ? new Date(detail.updatedAt).toLocaleString('zh-CN')
    : '未记录';

  return (
    <div className="min-h-full bg-background p-4 lg:p-8">
      <div className="max-w-7xl mx-auto space-y-4">
        {/* Header card */}
        <Card>
          <CardContent>
            <div className="flex items-center justify-between gap-3 mb-3">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-brand-100 rounded-lg">
                  <Bot className="w-5 h-5 text-primary" />
                </div>
              <div>
                <h1 className="text-2xl font-bold text-foreground">Agent 管理</h1>
                <p className="text-sm text-muted-foreground mt-0.5">
                  管理 Agent 定义文件，通过 Task 工具的 subagent_type 调用。
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <Button variant="outline" size="sm" onClick={loadAgents} disabled={loading}>
                <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
                刷新
              </Button>
              <Button size="sm" variant="outline" onClick={() => setShowMarketplace(true)}>
                <Download size={16} />
                从商店添加
              </Button>
              <Button size="sm" onClick={() => setShowCreate(true)}>
                <Plus size={16} />
                新建
              </Button>
            </div>
          </div>
            <div className="text-xs text-muted-foreground">
              已加载 Agent: {agents.length}
            </div>
            <div className="mt-3 rounded-xl border border-border bg-muted/30 p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold text-foreground">Agent Registry</div>
                  <div className="text-xs text-muted-foreground">
                    版本化 Agent、requiredSkills 与 Skill Packages 安装记录
                  </div>
                </div>
                <Button variant="outline" size="sm" onClick={loadRegistry} disabled={registryLoading}>
                  <RefreshCw size={14} className={registryLoading ? 'animate-spin' : ''} />
                  Registry
                </Button>
              </div>
              <div className="grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-lg bg-background px-3 py-2">
                  <div className="text-muted-foreground">Agents</div>
                  <div className="font-semibold text-foreground">{registry?.summary.totalAgents ?? 0}</div>
                </div>
                <div className="rounded-lg bg-background px-3 py-2">
                  <div className="text-muted-foreground">Skill Packages</div>
                  <div className="font-semibold text-foreground">{registry?.summary.totalSkillPackages ?? 0}</div>
                </div>
                <div className="rounded-lg bg-background px-3 py-2">
                  <div className="text-muted-foreground">unresolvedSkillDependencies</div>
                  <div className="font-semibold text-foreground">{registry?.summary.unresolvedSkillDependencies ?? 0}</div>
                </div>
                <div className="rounded-lg bg-background px-3 py-2">
                  <div className="text-muted-foreground">Skill 依赖冲突</div>
                  <div className="font-semibold text-foreground">{registry?.summary.dependencyConflicts ?? 0}</div>
                </div>
              </div>
              {registry?.dependencyConflicts?.length ? (
                <div className="mt-2 space-y-1 rounded-lg border border-warning/40 bg-warning/10 p-2 text-xs text-warning">
                  {registry.dependencyConflicts.slice(0, 3).map((conflict) => (
                    <div key={`${conflict.agentId}:${conflict.skillId}`} className="break-all">
                      版本不匹配：{conflict.agentId} 需要 {conflict.skillId}@{conflict.requestedVersion ?? 'any'}，当前 {conflict.installedVersion ?? 'unknown'}
                    </div>
                  ))}
                </div>
              ) : null}
              {registry?.skillPackages?.length ? (
                <div className="mt-2 flex flex-wrap gap-1">
                  {registry.skillPackages.slice(0, 6).map((pkg) => (
                    <span key={pkg.id} className="rounded-full bg-background px-2 py-1 text-[11px] text-muted-foreground">
                      {pkg.id} · {pkg.version ?? 'unversioned'} · {pkg.installRecords.length} installs · 文件集合 {pkg.fileCount} files / {formatRegistryBytes(pkg.totalBytes)}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          </CardContent>
        </Card>

        {/* Grid: left list + right detail */}
        <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4">
          {/* Left: agent list */}
          {(!isMobile || !showContent) && (
            <Card>
              <CardContent>
                <div className="mb-3">
                  <Input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="搜索 Agent 名称或描述"
                  />
                </div>

                <div className="space-y-2 max-h-[calc(100dvh-280px)] lg:max-h-[560px] overflow-auto pr-1">
                {loading && agents.length === 0 ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="animate-spin text-primary" size={24} />
                  </div>
                ) : listError ? (
                  <div className="text-sm text-error py-4 text-center">{listError}</div>
                ) : filtered.length === 0 ? (
                  <div className="text-sm text-muted-foreground py-4 text-center">
                    {searchQuery ? '没有匹配的 Agent' : '暂无 Agent 定义'}
                  </div>
                ) : (
                  filtered.map((agent) => {
                    const active = agent.id === selectedId;
                    return (
                      <button
                        key={agent.id}
                        onClick={() => handleSelectAgent(agent.id)}
                        className={`w-full text-left rounded-lg border px-3 py-2 transition-colors ${
                          active
                            ? 'border-primary bg-brand-50'
                            : 'border-border hover:bg-muted/50'
                        }`}
                      >
                        <div className="text-sm font-medium text-foreground truncate">
                          {agent.name}
                        </div>
                        <div className="text-[11px] text-muted-foreground line-clamp-2 mt-0.5">
                          {agent.description || '无描述'}
                        </div>
                        <div className="mt-1 flex flex-wrap gap-1 text-[10px] text-muted-foreground">
                          <span className="rounded bg-muted px-1.5 py-0.5">v{agent.version ?? '0.1.0'}</span>
                          <span className="rounded bg-muted px-1.5 py-0.5">{agent.visibility ?? 'private'}</span>
                          {(agent.requiredSkills?.length ?? 0) > 0 && (
                            <span className="rounded bg-muted px-1.5 py-0.5">requiredSkills {agent.requiredSkills?.length}</span>
                          )}
                        </div>
                        {agent.tools.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1.5">
                            {agent.tools.slice(0, 4).map((tool) => (
                              <span
                                key={tool}
                                className="px-1.5 py-0.5 bg-muted text-muted-foreground rounded text-[10px]"
                              >
                                {tool}
                              </span>
                            ))}
                            {agent.tools.length > 4 && (
                              <span className="px-1.5 py-0.5 text-muted-foreground text-[10px]">
                                +{agent.tools.length - 4}
                              </span>
                            )}
                          </div>
                        )}
                      </button>
                    );
                  })
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Right: detail / editor */}
          {(!isMobile || showContent) && (
            <Card className="min-h-[calc(100dvh-280px)] lg:min-h-[560px]">
              <CardContent>
                {selectedId && detail ? (
                <>
                  {isMobile && (
                    <button
                      onClick={() => setShowContent(false)}
                      className="flex items-center gap-1 text-sm text-primary mb-3 hover:underline"
                    >
                      <ArrowLeft className="w-4 h-4" />
                      返回列表
                    </button>
                  )}

                  {/* Meta info */}
                  <div className="mb-3">
                    <div className="text-sm font-semibold text-foreground break-all">{detail.name}</div>
                    <div className="text-xs text-muted-foreground mt-1">
                      Agent ID: <span className="font-mono">{detail.id}</span> · 最近更新时间: {updatedText} · 字节数: {byteCount}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">
                      版本: {detail.version ?? '0.1.0'} · 可见性: {detail.visibility ?? 'private'} · 默认模型: {detail.defaultModel ?? '未设置'}
                    </div>
                    {(detail.requiredSkills?.length ?? 0) > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {detail.requiredSkills?.map((skill) => {
                          const registrySkill = registry?.agents
                            .find((agent) => agent.id === detail.id)
                            ?.requiredSkills.find((item) => item.id === skill.id);
                          const conflict = registrySkill?.versionSatisfied === false;
                          return (
                          <span key={skill.id} className={`rounded-full px-2 py-1 text-[11px] ${conflict ? 'bg-warning/10 text-warning' : 'bg-muted text-muted-foreground'}`}>
                            {skill.raw ?? skill.id}{conflict ? ' · 版本不匹配' : ''}
                          </span>
                          );
                        })}
                      </div>
                    )}
                    <div className="text-xs text-muted-foreground mt-1">
                      系统自动生成，作为唯一标识，不可修改
                    </div>
                  </div>

                  <Textarea
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    className="min-h-[calc(100dvh-380px)] lg:min-h-[460px] resize-y p-4 font-mono text-sm leading-6"
                    placeholder={loadingDetail ? '正在加载...' : '此 Agent 暂无内容'}
                    disabled={loadingDetail || saving}
                    spellCheck={false}
                  />

                  <div className="mt-4 flex flex-wrap items-center gap-3">
                    <Button onClick={handleSave} disabled={loadingDetail || saving || !dirty}>
                      {saving && <Loader2 className="size-4 animate-spin" />}
                      <Save className="w-4 h-4" />
                      保存
                    </Button>

                    <Button
                      variant="outline"
                      onClick={() => loadDetail(selectedId)}
                      disabled={loadingDetail || saving}
                    >
                      <RefreshCw className="w-4 h-4" />
                      重新加载
                    </Button>

                    <Button
                      variant="outline"
                      onClick={handleDelete}
                      disabled={deleting || saving}
                      className="text-error hover:text-error hover:bg-error-bg"
                    >
                      <Trash2 className="w-4 h-4" />
                      {deleting ? '删除中...' : '删除'}
                    </Button>

                    {dirty && <span className="text-sm text-warning">有未保存修改</span>}
                    {notice && <span className="text-sm text-success">{notice}</span>}
                    {detailError && <span className="text-sm text-error">{detailError}</span>}
                  </div>

                  <div className="mt-4 grid gap-3 lg:grid-cols-2">
                    <div className="rounded-xl border border-border bg-muted/20 p-3">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <div>
                          <div className="text-sm font-semibold text-foreground">审批审计</div>
                          <div className="text-xs text-muted-foreground">Agent Definition 变更审批与审计轨迹</div>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => loadAgentGovernance(detail.id)}
                          disabled={!!governanceLoading[detail.id]}
                        >
                          <RefreshCw className={`w-3.5 h-3.5 ${governanceLoading[detail.id] ? 'animate-spin' : ''}`} />
                        </Button>
                      </div>
                      <div className="space-y-2 text-xs">
                        {(selectedGovernance?.auditEvents ?? []).slice(0, 4).map((event) => (
                          <div key={event.id} className="rounded-lg bg-background px-3 py-2">
                            <div className="font-medium text-foreground">
                              {event.action} · {event.fromVersion ?? '∅'} → {event.toVersion ?? '∅'}
                            </div>
                            <div className="text-muted-foreground">
                              {event.approval.status} by {event.approval.approvedBy} · {new Date(event.createdAt).toLocaleString()}
                            </div>
                          </div>
                        ))}
                        {!selectedGovernance?.auditEvents?.length && (
                          <div className="text-muted-foreground">暂无审计记录</div>
                        )}
                      </div>
                    </div>

                    <div className="rounded-xl border border-border bg-muted/20 p-3">
                      <div className="mb-2">
                        <div className="text-sm font-semibold text-foreground">版本回滚</div>
                        <div className="text-xs text-muted-foreground">回滚前会先保存当前内容作为新版本快照</div>
                      </div>
                      <div className="space-y-2 text-xs">
                        {(selectedGovernance?.versions ?? []).slice(0, 4).map((version) => (
                          <div key={version.id} className="flex items-center justify-between gap-2 rounded-lg bg-background px-3 py-2">
                            <div className="min-w-0">
                              <div className="font-medium text-foreground">v{version.version} · {version.sourceAction}</div>
                              <div className="truncate text-muted-foreground">{version.checksum}</div>
                            </div>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleRollbackVersion(version.id)}
                              disabled={rollingBackVersionId === version.id || saving || deleting}
                            >
                              {rollingBackVersionId === version.id ? '回滚中...' : '回滚到此版本'}
                            </Button>
                          </div>
                        ))}
                        {!selectedGovernance?.versions?.length && (
                          <div className="text-muted-foreground">暂无可回滚版本</div>
                        )}
                      </div>
                    </div>
                  </div>
                </>
              ) : loadingDetail ? (
                <div className="flex items-center justify-center h-full">
                  <Loader2 className="animate-spin text-primary" size={32} />
                </div>
              ) : (
                <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
                  {selectedId ? (detailError || '加载失败') : '选择一个 Agent 查看详情'}
                </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* Create dialog */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <Card className="w-full max-w-md mx-4">
            <CardContent>
              <h2 className="text-lg font-semibold text-foreground mb-4">新建 Agent</h2>
              <div className="space-y-4">
                <div>
                  <Label className="mb-1">
                    名称
                  </Label>
                <input
                  type="text"
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  placeholder="例如：code-reviewer"
                  className="w-full px-3 py-2 border border-border rounded-lg bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                  onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                  autoFocus
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Agent ID 由系统自动生成，作为唯一标识，不可修改
                </p>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => { setShowCreate(false); setCreateName(''); }}>
                  取消
                </Button>
                <Button onClick={handleCreate} disabled={!createName.trim() || creating}>
                  {creating ? '创建中...' : '创建'}
                </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      <InstallAgentMarketplaceDialog
        open={showMarketplace}
        onClose={() => setShowMarketplace(false)}
      />
    </div>
  );
}
