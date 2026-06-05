import { useEffect, useMemo, useState } from 'react';
import { FolderGit2, GitBranch, HardDrive, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { DirectoryBrowser } from '@/components/shared/DirectoryBrowser';
import { useAgentLinksStore } from '../stores/agentLinks';
import { useReposStore, type ManagedRepoInfo } from '../stores/repos';

function RepoCard({ repo, onDelete }: { repo: ManagedRepoInfo; onDelete: (id: string) => void }) {
  const isGit = repo.kind === 'git';
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
  const { repos, loading, load, createRepo, deleteRepo } = useReposStore();
  const { links: devices, load: loadDevices } = useAgentLinksStore();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'git' | 'device_path'>('git');
  const [gitUrl, setGitUrl] = useState('');
  const [mainBranch, setMainBranch] = useState('');
  const [devicePath, setDevicePath] = useState('');
  const [deviceLinkId, setDeviceLinkId] = useState('');

  useEffect(() => {
    void load();
    void loadDevices();
  }, [load, loadDevices]);

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
            {repos.map((repo) => <RepoCard key={repo.id} repo={repo} onDelete={handleDelete} />)}
          </div>
        )}
      </div>

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
