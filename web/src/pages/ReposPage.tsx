import { useEffect, useMemo, useState } from 'react';
import { BrainCircuit, FolderGit2, GitBranch, HardDrive, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { DirectoryBrowser } from '@/components/shared/DirectoryBrowser';
import { useAgentLinksStore } from '../stores/agentLinks';
import { useReposStore, type ManagedRepoInfo, type RepoKnowledgeContextPackage, type RepoKnowledgeHit, type RepoKnowledgeRun } from '../stores/repos';

function statNumber(stats: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = stats?.[key];
  return typeof value === 'number' ? value : undefined;
}

function statText(stats: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = stats?.[key];
  return typeof value === 'string' ? value : undefined;
}

function repoKnowledgeErrorHint(error: string | undefined): string | undefined {
  if (!error) return undefined;
  if (/\blink_offline\b|Device is offline|device.*offline|session.*offline/i.test(error)) {
    return 'Device 连接刚刚中断过，请确认绑定/执行 Device 仍在线后重新生成。';
  }
  if (error.includes('git_host_unreachable')) {
    return 'The OctoDeck server/container cannot resolve the Git host. For internal repos, run OctoDeck inside the same DNS/VPN, configure container DNS/proxy, use a reachable mirror, or use Device Path indexing from a machine that can access the repo.';
  }
  if (error.includes('git_auth_failed')) {
    return 'The OctoDeck server cannot authenticate to this repo. Configure runtime Git credentials/SSH key, use a credentialed clone URL, or index from a Device Path repo.';
  }
  if (error.includes('git_network_unreachable')) {
    return 'The OctoDeck server cannot connect to the Git host. Check VPN/proxy/firewall from the runtime or index through a Device Path repo.';
  }
  return undefined;
}

function RepoCard({ repo, onDelete, onGenerate, onShowRuns, generating }: {
  repo: ManagedRepoInfo;
  onDelete: (id: string) => void;
  onGenerate: (id: string) => void;
  onShowRuns: (repo: ManagedRepoInfo) => void;
  generating: boolean;
}) {
  const isGit = repo.kind === 'git';
  const knowledge = repo.knowledge;
  const stats = knowledge?.stats;
  const generator = stats?.generator as { provider?: string; requestedProvider?: string; fallbackBuiltin?: boolean } | undefined;
  const security = stats?.security as { skippedSensitiveFiles?: number; skippedSecretFiles?: number } | undefined;
  const waitingForDevice = stats?.waitingForDevice === true;
  const errorHint = repoKnowledgeErrorHint(knowledge?.error);
  const knowledgeStatus = knowledge?.status ?? 'none';
  const isIndexing = knowledgeStatus === 'indexing';
  const statusLabel = knowledgeStatus === 'ready'
    ? '已生成'
    : knowledgeStatus === 'error'
      ? '生成失败'
      : knowledgeStatus === 'indexing'
        ? '生成中'
        : '未生成';
  return (
    <Card className="overflow-hidden border-border/70 bg-card/90">
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <div className={`rounded-2xl p-2.5 ${isGit ? 'bg-sky-500/10 text-sky-500' : 'bg-amber-500/10 text-amber-500'}`}>
            {isGit ? <GitBranch className="size-5" /> : <HardDrive className="size-5" />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="truncate font-semibold text-foreground">{repo.name}</h3>
              <span className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground">
                {isGit ? 'Git' : 'Device Path'}
              </span>
            </div>
            <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
              {isGit ? repo.git_url : repo.device_path}
            </p>
            {isGit && repo.main_branch && (
              <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                <GitBranch className="size-3" /> 主分支：{repo.main_branch}
              </p>
            )}
            {repo.device_link_id && (
              <p className="mt-1 text-xs text-muted-foreground">绑定 Device：{repo.device_link_id}</p>
            )}
            <div className="mt-3 rounded-xl border border-border/70 bg-muted/30 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <BrainCircuit className="size-3.5" /> 知识库：
                  <span className={knowledgeStatus === 'ready' ? 'text-emerald-600' : knowledgeStatus === 'error' ? 'text-destructive' : ''}>{statusLabel}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => onShowRuns(repo)}>
                    历史
                  </Button>
                  <Button variant="outline" size="sm" className="h-7 gap-1 text-xs" disabled={generating} onClick={() => onGenerate(repo.id)}>
                    <RefreshCw className={`size-3 ${generating || isIndexing ? 'animate-spin' : ''}`} /> {isIndexing ? '重新下发' : knowledgeStatus === 'ready' ? '重新生成' : '生成'}
                  </Button>
                </div>
              </div>
              {knowledge?.generatedAt && <p className="mt-2 text-[11px] text-muted-foreground">生成时间：{new Date(knowledge.generatedAt).toLocaleString()}</p>}
              {typeof stats?.fileCount === 'number' && (
                <div className="mt-2 grid grid-cols-2 gap-1 text-[11px] text-muted-foreground sm:grid-cols-4">
                  <span>文件：{String(stats.fileCount)}</span>
                  <span>符号：{statNumber(stats, 'symbolCount') ?? '-'}</span>
                  <span>依赖：{statNumber(stats, 'dependencyCount') ?? '-'}</span>
                  <span>图边：{statNumber(stats, 'graphEdgeCount') ?? '-'}</span>
                  <span>Docs：{statNumber(stats, 'docCount') ?? '-'}</span>
                  <span>搜索：{statText(stats, 'searchBackend') ?? '-'}</span>
                  <span>插件：{generator?.provider ?? '-'}</span>
                  <span>安全跳过：{(security?.skippedSensitiveFiles ?? 0) + (security?.skippedSecretFiles ?? 0)}</span>
                </div>
              )}
              {generator?.fallbackBuiltin && <p className="mt-1 text-[11px] text-amber-600">外部生成器 {generator.requestedProvider} 不可用，已 fallback builtin。</p>}
              {waitingForDevice && knowledgeStatus === 'indexing' && <p className="mt-2 rounded-lg border border-amber-500/20 bg-amber-500/10 p-2 text-[11px] text-amber-700 dark:text-amber-300">Device 连接刚刚中断过，后台正在自动重新下发生成任务；如果 Device 已在线，稍等片刻会继续生成。</p>}
              {knowledge?.error && knowledgeStatus !== 'indexing' && <p className="mt-2 line-clamp-3 text-[11px] text-destructive">{knowledge.error}</p>}
              {errorHint && !waitingForDevice && knowledgeStatus !== 'indexing' && <p className="mt-2 rounded-lg border border-amber-500/20 bg-amber-500/10 p-2 text-[11px] text-amber-700 dark:text-amber-300">{errorHint}</p>}
            </div>
          </div>
          <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" onClick={() => onDelete(repo.id)}>
            <Trash2 className="size-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function ReposPage() {
  const { repos, loading, load, createRepo, deleteRepo, generateKnowledge, loadKnowledgeRuns, searchKnowledge, loadKnowledgePlugins, loadSearchBackends, loadKnowledgeContext, knowledgePlugins, searchBackends } = useReposStore();
  const { links: devices, load: loadDevices } = useAgentLinksStore();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'git' | 'device_path'>('git');
  const [gitUrl, setGitUrl] = useState('');
  const [mainBranch, setMainBranch] = useState('');
  const [devicePath, setDevicePath] = useState('');
  const [deviceLinkId, setDeviceLinkId] = useState('');
  const [generatingId, setGeneratingId] = useState<string | null>(null);
  const [generateRepo, setGenerateRepo] = useState<ManagedRepoInfo | null>(null);
  const [generateExecutionDeviceLinkId, setGenerateExecutionDeviceLinkId] = useState('');
  const [knowledgeQuery, setKnowledgeQuery] = useState('');
  const [knowledgeHits, setKnowledgeHits] = useState<RepoKnowledgeHit[]>([]);
  const [knowledgeContext, setKnowledgeContext] = useState<RepoKnowledgeContextPackage | null>(null);
  const [searchingKnowledge, setSearchingKnowledge] = useState(false);
  const [generateProvider, setGenerateProvider] = useState<'builtin' | 'auto' | 'graphify' | 'codegraph'>('builtin');
  const [searchBackend, setSearchBackend] = useState<'auto' | 'sqlite' | 'postgres' | 'mongo'>('auto');
  const [includeDocs, setIncludeDocs] = useState(true);
  const [includeDependencies, setIncludeDependencies] = useState(true);
  const [includeImportGraph, setIncludeImportGraph] = useState(true);
  const [searchKind, setSearchKind] = useState('');
  const [searchLanguage, setSearchLanguage] = useState('');
  const [searchPathPrefix, setSearchPathPrefix] = useState('');
  const [knowledgeOptionsOpen, setKnowledgeOptionsOpen] = useState(false);
  const [knowledgeSearchOpen, setKnowledgeSearchOpen] = useState(false);
  const [knowledgeRunsRepo, setKnowledgeRunsRepo] = useState<ManagedRepoInfo | null>(null);
  const [knowledgeRuns, setKnowledgeRuns] = useState<RepoKnowledgeRun[]>([]);
  const [loadingKnowledgeRuns, setLoadingKnowledgeRuns] = useState(false);

  useEffect(() => {
    void load();
    void loadDevices();
    void loadKnowledgePlugins();
    void loadSearchBackends();
  }, [load, loadDevices, loadKnowledgePlugins, loadSearchBackends]);

  useEffect(() => {
    if (!repos.some((repo) => repo.knowledge?.status === 'indexing')) return;
    const timer = window.setInterval(() => {
      void load();
      void loadDevices();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [repos, load, loadDevices]);

  const onlineDevices = useMemo(() => devices.filter((device) => device.online), [devices]);

  async function handleCreate() {
    if (!name.trim()) return toast.error('请输入 Repo 名称');
    if (kind === 'git' && !gitUrl.trim()) return toast.error('请输入 Git 仓库地址');
    if (kind === 'device_path' && !devicePath.trim()) return toast.error('请输入 Device 目录');
    if (kind === 'device_path' && !deviceLinkId) return toast.error('请选择绑定 Device');
    const repo = await createRepo({
      name: name.trim(),
      kind,
      git_url: kind === 'git' ? gitUrl.trim() : undefined,
      main_branch: kind === 'git' ? mainBranch.trim() || undefined : undefined,
      device_path: kind === 'device_path' ? devicePath.trim() : undefined,
      device_link_id: kind === 'device_path' ? deviceLinkId : undefined,
    });
    if (!repo) return toast.error('创建 Repo 失败');
    toast.success('Repo 已创建');
    setOpen(false);
    setName('');
    setGitUrl('');
    setMainBranch('');
    setDevicePath('');
    setDeviceLinkId('');
  }

  async function handleDelete(id: string) {
    const ok = await deleteRepo(id);
    if (ok) toast.success('Repo 已删除');
    else toast.error('删除 Repo 失败');
  }

  function openGenerateDialog(repo: ManagedRepoInfo) {
    setGenerateRepo(repo);
    setGenerateExecutionDeviceLinkId(repo.kind === 'device_path' ? repo.device_link_id || '' : onlineDevices[0]?.id || '');
  }

  async function openKnowledgeRuns(repo: ManagedRepoInfo) {
    setKnowledgeRunsRepo(repo);
    setLoadingKnowledgeRuns(true);
    const runs = await loadKnowledgeRuns(repo.id, 30);
    setKnowledgeRuns(runs);
    setLoadingKnowledgeRuns(false);
  }

  async function handleGenerateKnowledge() {
    const repo = generateRepo;
    if (!repo) return;
    if (repo.kind === 'device_path' && !repo.device_link_id) return toast.error('Device 目录 Repo 缺少绑定 Device');
    if (repo.kind === 'device_path' && generateExecutionDeviceLinkId !== repo.device_link_id) return toast.error('Device 目录 Repo 只能使用绑定 Device 生成知识库');
    const id = repo.id;
    setGeneratingId(id);
    const index = await generateKnowledge(id, {
      provider: generateProvider,
      search_backend: searchBackend,
      include_docs: includeDocs,
      include_dependencies: includeDependencies,
      include_import_graph: includeImportGraph,
      fallback_builtin: true,
      source_kind: 'repo',
      execution_device_link_id: generateExecutionDeviceLinkId || undefined,
    });
    setGeneratingId(null);
    if (index?.status === 'indexing') {
      toast.success('知识库生成任务已下发，后台生成中');
      setGenerateRepo(null);
      return;
    }
    if (index?.status === 'ready') {
      toast.success('知识库已生成');
      setGenerateRepo(null);
    }
    else toast.error(repoKnowledgeErrorHint(index?.error) || index?.error?.split('\n')[0] || '知识库生成失败');
  }

  async function handleSearchKnowledge() {
    if (!knowledgeQuery.trim()) return toast.error('请输入搜索关键词');
    setSearchingKnowledge(true);
    const hits = await searchKnowledge({
      query: knowledgeQuery.trim(),
      limit: 20,
      kind: searchKind || undefined,
      language: searchLanguage.trim() || undefined,
      path_prefix: searchPathPrefix.trim() || undefined,
      include_related: true,
    });
    setKnowledgeHits(hits);
    setKnowledgeContext(null);
    setSearchingKnowledge(false);
  }

  async function handleLoadContext(hit: RepoKnowledgeHit) {
    const context = await loadKnowledgeContext(hit.repoId, { chunk_id: hit.id, limit: 20 });
    setKnowledgeContext(context);
  }

  return (
    <div className="min-h-full bg-background">
      <div className="mx-auto max-w-7xl px-4 py-6 lg:px-8 lg:py-8 space-y-6">
        <div className="relative overflow-hidden rounded-3xl border border-border bg-muted/20 p-6 lg:p-8">
          <div className="absolute inset-y-0 right-0 w-1/2 bg-gradient-to-l from-cyan-500/10 to-transparent" />
          <div className="relative flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-2xl space-y-3">
              <div className="inline-flex items-center gap-2 rounded-full border border-cyan-500/20 bg-cyan-500/10 px-3 py-1 text-xs font-medium text-cyan-600 dark:text-cyan-300">
                <FolderGit2 className="size-3.5" /> Repo Center
              </div>
              <div>
                <h1 className="text-2xl lg:text-3xl font-bold tracking-tight text-foreground">Repo 管理</h1>
                <p className="mt-2 text-sm text-muted-foreground leading-6">
                  统一维护 Git 仓库与 Device 本地目录。工作区选择 Repo 后，Device 会自动缓存仓库并基于 worktree 执行。
                </p>
              </div>
            </div>
            <Button onClick={() => setOpen(true)} className="gap-2">
              <Plus className="size-4" /> 新建 Repo
            </Button>
          </div>
        </div>

        {loading ? (
          <div className="text-sm text-muted-foreground">加载中...</div>
        ) : repos.length === 0 ? (
          <Card><CardContent className="p-10 text-center text-sm text-muted-foreground">暂无 Repo，点击右上角创建。</CardContent></Card>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {repos.map((repo) => <RepoCard key={repo.id} repo={repo} onDelete={handleDelete} onGenerate={() => openGenerateDialog(repo)} onShowRuns={openKnowledgeRuns} generating={generatingId === repo.id} />)}
          </div>
        )}

        <Card className="border-border/70 bg-card/90">
          <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between lg:p-5">
            <div>
              <h2 className="flex items-center gap-2 font-semibold"><BrainCircuit className="size-4" /> Repo 知识库</h2>
              <p className="mt-1 text-xs text-muted-foreground">高级生成选项与知识库搜索已收敛为按钮，避免页面展开过长。</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setKnowledgeOptionsOpen(true)} className="gap-2">
                <BrainCircuit className="size-4" /> 生成选项
              </Button>
              <Button variant="outline" onClick={() => setKnowledgeSearchOpen(true)} className="gap-2">
                <Search className="size-4" /> 知识库搜索
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <Dialog open={knowledgeOptionsOpen} onOpenChange={setKnowledgeOptionsOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader><DialogTitle>知识库生成选项</DialogTitle></DialogHeader>
          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <h2 className="text-sm font-semibold">生成参数</h2>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <label className="text-xs text-muted-foreground">生成器插件
                  <select value={generateProvider} onChange={(e) => setGenerateProvider(e.target.value as typeof generateProvider)} className="mt-1 h-9 w-full rounded-md border border-border bg-transparent px-3 text-sm text-foreground">
                    <option value="builtin">builtin</option>
                    <option value="auto">auto</option>
                    <option value="graphify">graphify</option>
                    <option value="codegraph">codegraph</option>
                  </select>
                </label>
                <label className="text-xs text-muted-foreground">搜索后端
                  <select value={searchBackend} onChange={(e) => setSearchBackend(e.target.value as typeof searchBackend)} className="mt-1 h-9 w-full rounded-md border border-border bg-transparent px-3 text-sm text-foreground">
                    <option value="auto">auto</option>
                    <option value="sqlite">SQLite</option>
                    <option value="postgres">PostgreSQL</option>
                    <option value="mongo">MongoDB</option>
                  </select>
                </label>
              </div>
              <div className="mt-3 flex flex-wrap gap-3 text-xs text-muted-foreground">
                <label className="inline-flex items-center gap-2"><input type="checkbox" checked={includeDocs} onChange={(e) => setIncludeDocs(e.target.checked)} /> Docs</label>
                <label className="inline-flex items-center gap-2"><input type="checkbox" checked={includeDependencies} onChange={(e) => setIncludeDependencies(e.target.checked)} /> Dependencies</label>
                <label className="inline-flex items-center gap-2"><input type="checkbox" checked={includeImportGraph} onChange={(e) => setIncludeImportGraph(e.target.checked)} /> Import Graph</label>
              </div>
              <p className="mt-3 text-xs text-muted-foreground">这些选项会应用到每个 Repo 卡片里的“生成 / 重新生成”。</p>
            </div>
            <div>
              <h2 className="text-sm font-semibold">插件与后端状态</h2>
              <div className="mt-3 max-h-80 space-y-2 overflow-auto text-xs text-muted-foreground">
                {knowledgePlugins.map((plugin) => (
                  <div key={plugin.id} className="rounded-lg border border-border/70 p-2">
                    <span className={plugin.available ? 'text-emerald-600' : 'text-amber-600'}>{plugin.available ? '可用' : '不可用'}</span> · {plugin.displayName} · {plugin.capabilities.join(', ')}
                  </div>
                ))}
                {searchBackends.map((backend) => (
                  <div key={backend.id} className="rounded-lg border border-border/70 p-2">
                    <span className={backend.selected ? 'text-primary' : backend.available ? 'text-emerald-600' : 'text-amber-600'}>{backend.selected ? '当前' : backend.available ? '可用' : 'fallback'}</span> · {backend.displayName}
                  </div>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => setKnowledgeOptionsOpen(false)}>完成</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={knowledgeSearchOpen} onOpenChange={setKnowledgeSearchOpen}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader><DialogTitle>知识库搜索</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground">生成后 Agent 可通过 repo_knowledge_* MCP 工具访问，这里也可以直接验证检索效果。</p>
            <div className="space-y-2">
              <div className="flex gap-2">
                <Input value={knowledgeQuery} onChange={(e) => setKnowledgeQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void handleSearchKnowledge(); }} placeholder="搜索架构、函数、文件、依赖..." />
                <Button onClick={handleSearchKnowledge} disabled={searchingKnowledge} className="gap-2">
                  <Search className="size-4" /> 搜索
                </Button>
              </div>
              <div className="grid gap-2 sm:grid-cols-3">
                <select value={searchKind} onChange={(e) => setSearchKind(e.target.value)} className="h-8 rounded-md border border-border bg-transparent px-2 text-xs text-foreground">
                  <option value="">全部类型</option>
                  <option value="symbol">symbol</option>
                  <option value="file">file</option>
                  <option value="dependency">dependency</option>
                  <option value="doc">doc</option>
                </select>
                <Input value={searchLanguage} onChange={(e) => setSearchLanguage(e.target.value)} className="h-8 text-xs" placeholder="language" />
                <Input value={searchPathPrefix} onChange={(e) => setSearchPathPrefix(e.target.value)} className="h-8 text-xs" placeholder="path prefix" />
              </div>
            </div>
            <div className="max-h-[55vh] space-y-3 overflow-auto pr-1">
              {knowledgeHits.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">输入关键词后开始搜索。</div>
              ) : knowledgeHits.map((hit) => (
                <div key={hit.id} className="rounded-xl border border-border/70 bg-muted/20 p-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="rounded-full bg-primary/10 px-2 py-0.5 text-primary">{hit.kind}</span>
                    <span className="font-mono text-muted-foreground">{hit.path}{hit.startLine ? `:${hit.startLine}` : ''}</span>
                    {hit.name && <span className="text-foreground">{hit.name}</span>}
                    <button type="button" onClick={() => void handleLoadContext(hit)} className="ml-auto rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-accent">
                      上下文包
                    </button>
                  </div>
                  <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-xs leading-5 text-muted-foreground">{hit.snippet}</pre>
                  {hit.related?.length ? <p className="mt-2 text-[11px] text-muted-foreground">相关图边：{hit.related.map((edge) => `${edge.edgeKind}:${edge.toPath || edge.packageName || edge.fromPath}`).join(' · ')}</p> : null}
                </div>
              ))}
            </div>
            {knowledgeContext && (
              <div className="rounded-xl border border-primary/20 bg-primary/5 p-3 text-xs">
                <div className="font-semibold text-foreground">上下文包</div>
                {knowledgeContext.anchor && <p className="mt-1 font-mono text-muted-foreground">Anchor: {knowledgeContext.anchor.path}{knowledgeContext.anchor.startLine ? `:${knowledgeContext.anchor.startLine}` : ''}</p>}
                <div className="mt-2 grid gap-2 md:grid-cols-3">
                  <div className="rounded-lg bg-background/70 p-2">同文件 chunks：{knowledgeContext.sameFileChunks.length}</div>
                  <div className="rounded-lg bg-background/70 p-2">相关 chunks：{knowledgeContext.relatedChunks.length}</div>
                  <div className="rounded-lg bg-background/70 p-2">图边：{knowledgeContext.edges.length}</div>
                </div>
                {knowledgeContext.edges.length > 0 && (
                  <p className="mt-2 text-muted-foreground">{knowledgeContext.edges.slice(0, 8).map((edge) => `${edge.edgeKind}:${edge.toPath || edge.packageName || edge.fromPath}`).join(' · ')}</p>
                )}
                {[...knowledgeContext.dependencies, ...knowledgeContext.docs].slice(0, 6).length > 0 && (
                  <p className="mt-2 text-muted-foreground">依赖/文档：{[...knowledgeContext.dependencies, ...knowledgeContext.docs].slice(0, 6).map((chunk) => chunk.name || chunk.path).join(' · ')}</p>
                )}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!knowledgeRunsRepo} onOpenChange={(next) => { if (!next) setKnowledgeRunsRepo(null); }}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader><DialogTitle>知识库生成历史</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="rounded-xl border border-border/70 bg-muted/30 p-3 text-xs text-muted-foreground">
              <div className="font-medium text-foreground">{knowledgeRunsRepo?.name}</div>
              <p className="mt-1">展示最近 30 次知识库生成任务，包括后台等待、执行设备、完成状态与错误摘要。</p>
            </div>
            <div className="max-h-[60vh] space-y-2 overflow-auto pr-1">
              {loadingKnowledgeRuns ? (
                <div className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">加载中...</div>
              ) : knowledgeRuns.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">暂无生成历史。</div>
              ) : knowledgeRuns.map((run) => {
                const durationMs = run.startedAt && run.completedAt ? new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime() : undefined;
                const truncated = run.stats?.truncatedByOutputBudget === true;
                return (
                  <div key={run.id} className="rounded-xl border border-border/70 bg-muted/20 p-3 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={run.status === 'ready' ? 'rounded-full bg-emerald-500/10 px-2 py-0.5 text-emerald-600' : run.status === 'error' ? 'rounded-full bg-destructive/10 px-2 py-0.5 text-destructive' : 'rounded-full bg-amber-500/10 px-2 py-0.5 text-amber-600'}>{run.status}</span>
                      <span className="font-mono text-muted-foreground">{run.id}</span>
                      {run.executionDeviceLinkId && <span className="rounded-full border border-border px-2 py-0.5 text-muted-foreground">Device {run.executionDeviceLinkId}</span>}
                      {run.sourceKind && <span className="rounded-full border border-border px-2 py-0.5 text-muted-foreground">{run.sourceKind}</span>}
                    </div>
                    <div className="mt-2 grid gap-1 text-muted-foreground sm:grid-cols-2">
                      <span>下发：{new Date(run.queuedAt).toLocaleString()}</span>
                      <span>开始：{run.startedAt ? new Date(run.startedAt).toLocaleString() : '-'}</span>
                      <span>完成：{run.completedAt ? new Date(run.completedAt).toLocaleString() : '-'}</span>
                      <span>耗时：{typeof durationMs === 'number' && durationMs >= 0 ? `${Math.round(durationMs / 1000)}s` : '-'}</span>
                    </div>
                    {typeof run.stats?.fileCount === 'number' && (
                      <p className="mt-2 text-muted-foreground">文件 {String(run.stats.fileCount)} · chunks {String(run.stats.chunkCount ?? '-')} · 图边 {String(run.stats.graphEdgeCount ?? '-')}</p>
                    )}
                    {truncated && <p className="mt-2 text-amber-600">结果较大，已按单帧预算截断采集，避免 Device 连接被大包断开。</p>}
                    {run.error && <pre className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap rounded-lg bg-destructive/5 p-2 text-[11px] text-destructive">{run.error}</pre>}
                  </div>
                );
              })}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!generateRepo} onOpenChange={(next) => { if (!next && !generatingId) setGenerateRepo(null); }}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader><DialogTitle>生成知识库</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="rounded-xl border border-border/70 bg-muted/30 p-3 text-xs text-muted-foreground">
              <div className="font-medium text-foreground">{generateRepo?.name}</div>
              <p className="mt-1">生成知识库会沿用 Repo 自身配置。Git Repo 可选择一个在线 Device 负责执行克隆/读取；Device 目录 Repo 固定使用其绑定 Device。</p>
            </div>
            <div className="rounded-xl border border-border/70 p-3 text-xs text-muted-foreground">
              当前 Repo 配置：{generateRepo?.kind === 'git'
                ? `${generateRepo.git_url || '-'}${generateRepo.main_branch ? ` (${generateRepo.main_branch})` : ''}`
                : `${generateRepo?.device_path || '-'} (${generateRepo?.device_link_id || '-'})`}
            </div>
            {generateRepo?.kind === 'git' ? (
              <div>
                <label className="mb-2 block text-sm font-medium">执行 Device</label>
                <select value={generateExecutionDeviceLinkId} onChange={(e) => setGenerateExecutionDeviceLinkId(e.target.value)} className="h-9 w-full rounded-md border border-border bg-transparent px-3 text-sm">
                  <option value="">不使用 Device（服务端执行）</option>
                  {onlineDevices.map((device) => <option key={device.id} value={device.id}>{device.displayName} ({device.id})</option>)}
                </select>
                {onlineDevices.length === 0 && <p className="mt-2 text-xs text-amber-600">当前没有在线 Device；将由服务端按 Repo 的 Git 配置生成。</p>}
              </div>
            ) : (
              <div className="space-y-3">
                <div>
                  <label className="mb-2 block text-sm font-medium">绑定 Device</label>
                  <select value={generateExecutionDeviceLinkId} disabled className="h-9 w-full rounded-md border border-border bg-transparent px-3 text-sm disabled:opacity-70">
                    <option value={generateRepo?.device_link_id || ''}>{generateRepo?.device_link_id || '未绑定 Device'}</option>
                  </select>
                  <p className="mt-2 text-xs text-muted-foreground">Device 目录 Repo 只能使用创建时绑定的 Device 执行知识库生成。</p>
                  {generateRepo?.device_link_id && !onlineDevices.some((device) => device.id === generateRepo.device_link_id) && (
                    <p className="mt-2 text-xs text-amber-600">绑定 Device 当前不在线，生成可能失败。</p>
                  )}
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setGenerateRepo(null)} disabled={!!generatingId}>取消</Button>
            <Button onClick={handleGenerateKnowledge} disabled={!!generatingId} className="gap-2">
              <RefreshCw className={`size-4 ${generatingId ? 'animate-spin' : ''}`} /> 开始生成
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>新建 Repo</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="mb-2 block text-sm font-medium">名称</label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如 HappyClaw" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={() => setKind('git')} className={`rounded-xl border p-3 text-left text-sm ${kind === 'git' ? 'border-primary bg-primary/10' : 'hover:bg-accent'}`}>Git 仓库</button>
              <button type="button" onClick={() => setKind('device_path')} className={`rounded-xl border p-3 text-left text-sm ${kind === 'device_path' ? 'border-primary bg-primary/10' : 'hover:bg-accent'}`}>Device 目录</button>
            </div>
            {kind === 'git' ? (
              <>
                <div>
                  <label className="mb-2 block text-sm font-medium">Git URL</label>
                  <Input value={gitUrl} onChange={(e) => setGitUrl(e.target.value)} placeholder="https://github.com/user/repo.git" />
                </div>
                <div>
                  <label className="mb-2 block text-sm font-medium">主分支（可选）</label>
                  <Input value={mainBranch} onChange={(e) => setMainBranch(e.target.value)} placeholder="main / master / develop" />
                  <p className="mt-1 text-xs text-muted-foreground">留空时使用远端默认分支。</p>
                </div>
              </>
            ) : (
              <>
                <div>
                  <label className="mb-2 block text-sm font-medium">绑定 Device</label>
                  <select value={deviceLinkId} onChange={(e) => { setDeviceLinkId(e.target.value); setDevicePath(''); }} className="h-9 w-full rounded-md border border-border bg-transparent px-3 text-sm">
                    <option value="">请选择 Device</option>
                    {onlineDevices.map((device) => <option key={device.id} value={device.id}>{device.displayName} ({device.id})</option>)}
                  </select>
                </div>
                <DirectoryBrowser
                  value={devicePath}
                  onChange={setDevicePath}
                  placeholder={deviceLinkId ? '选择 Device 上的项目目录' : '请先选择绑定 Device'}
                  label="Device 目录"
                  browseEndpoint="/api/repos/device-directories"
                  browseParams={{ link_id: deviceLinkId }}
                  allowCreate={false}
                />
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>取消</Button>
            <Button onClick={handleCreate}>创建</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default ReposPage;
