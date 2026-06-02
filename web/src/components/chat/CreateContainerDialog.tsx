import { useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  Monitor,
  GitBranch,
  Loader2,
  Cloud,
  Cpu,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DirectoryBrowser } from '../shared/DirectoryBrowser';
import { useChatStore } from '../../stores/chat';
import { useAuthStore } from '../../stores/auth';
import { useAgentLinksStore } from '../../stores/agentLinks';
import { useReposStore } from '../../stores/repos';

interface CreateContainerDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (jid: string, folder: string) => void;
}

export function CreateContainerDialog({
  open,
  onClose,
  onCreated,
}: CreateContainerDialogProps) {
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [runtimeProfile, setRuntimeProfile] = useState<'server-agent' | 'server-agent-device-tools' | 'device-cli-agent'>('server-agent');
  const [executionNode, setExecutionNode] = useState('');
  const [agentClientId, setAgentClientId] = useState('claude-code');
  const [hostRepoMode, setHostRepoMode] = useState<'default' | 'repo'>('default');
  const [customCwd, setCustomCwd] = useState('');
  const [selectedRepoId, setSelectedRepoId] = useState('');

  const createFlow = useChatStore((s) => s.createFlow);
  const canHostExec = useAuthStore((s) => s.user?.role === 'admin');
  const { links: devices, load: loadDevices } = useAgentLinksStore();
  const { repos, load: loadRepos } = useReposStore();

  useEffect(() => {
    if (open && canHostExec) {
      void loadDevices();
      void loadRepos();
    }
  }, [open, canHostExec, loadDevices, loadRepos]);

  const selectedRepo = useMemo(
    () => repos.find((repo) => repo.id === selectedRepoId),
    [repos, selectedRepoId],
  );

  const selectableRepos = useMemo(
    () => repos,
    [repos],
  );

  useEffect(() => {
    if (selectedRepo?.kind === 'device_path' && selectedRepo.device_link_id) {
      setExecutionNode(selectedRepo.device_link_id);
    }
  }, [selectedRepo]);

  const reset = () => {
    setName('');
    setAdvancedOpen(false);
    setRuntimeProfile('server-agent');
    setExecutionNode('');
    setAgentClientId('claude-code');
    setHostRepoMode('default');
    setCustomCwd('');
    setSelectedRepoId('');
  };

  const handleClose = () => {
    onClose();
    reset();
  };

  const handleConfirm = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;

    setLoading(true);
    try {
      const options: Record<string, string> = {};
      options.runtime_profile = runtimeProfile;
      if (runtimeProfile !== 'server-agent') {
        if (!executionNode) {
          toast.error('请选择执行 Device');
          return;
        }
        options.device_link_id = executionNode;
        if (runtimeProfile === 'device-cli-agent') {
          options.agent_client_id = agentClientId;
        }
        if (hostRepoMode === 'repo' && selectedRepoId) {
          options.repo_id = selectedRepoId;
        } else if (hostRepoMode === 'repo') {
          toast.error('请选择项目 Repo');
          return;
        } else if (customCwd.trim()) {
          options.custom_cwd = customCwd.trim();
        }
      }
      const created = await createFlow(trimmed, Object.keys(options).length ? options : undefined);
      if (created) {
        onCreated(created.jid, created.folder);
        handleClose();
      } else {
        toast.error('创建失败，请重试');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '创建失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>新建工作区</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Name input */}
          <div>
            <label className="block text-sm font-medium mb-2">工作区名称</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleConfirm(); }}
              placeholder="输入工作区名称"
              autoFocus
            />
          </div>

          {/* Advanced options */}
          <div className="border rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => setAdvancedOpen(!advancedOpen)}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground hover:bg-accent transition-colors cursor-pointer"
            >
              {advancedOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
              高级选项
            </button>
            {advancedOpen && (
              <div className="px-3 pb-3 space-y-3 border-t">
                {/* Runtime profile */}
                <div className="pt-3">
                  <label className="block text-sm font-medium mb-2">执行形态</label>
                  <div className="space-y-2">
                    <label className="flex items-start gap-3 p-2 rounded-lg border cursor-pointer hover:bg-accent/50 transition-colors">
                      <input
                        type="radio"
                        name="runtime_profile"
                        value="server-agent"
                        checked={runtimeProfile === 'server-agent'}
                        onChange={() => {
                          setRuntimeProfile('server-agent');
                          setCustomCwd('');
                          setHostRepoMode('default');
                          setSelectedRepoId('');
                          setExecutionNode('');
                        }}
                        className="mt-0.5 accent-primary"
                      />
                      <div>
                        <div className="flex items-center gap-1.5">
                          <Cloud className="w-4 h-4 text-muted-foreground" />
                          <span className="text-sm font-medium">服务端 Agent</span>
                          <span className="text-xs text-primary font-medium">推荐</span>
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">仅支持云端推理、MCP 调用、无需本地执行的 Skill</p>
                      </div>
                    </label>
                    <label className={`flex items-start gap-3 p-2 rounded-lg border transition-colors ${canHostExec ? 'cursor-pointer hover:bg-accent/50' : 'opacity-50 cursor-not-allowed'}`}>
                      <input
                        type="radio"
                        name="runtime_profile"
                        value="server-agent-device-tools"
                        checked={runtimeProfile === 'server-agent-device-tools'}
                        onChange={() => { if (canHostExec) setRuntimeProfile('server-agent-device-tools'); }}
                        disabled={!canHostExec}
                        className="mt-0.5 accent-primary"
                      />
                      <div>
                        <div className="flex items-center gap-1.5">
                          <Monitor className="w-4 h-4 text-muted-foreground" />
                          <span className="text-sm font-medium">服务端 Agent + Device 执行</span>
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {canHostExec ? 'Agent 在服务端运行，命令和文件工具转发到选中的 Device' : '需要管理员权限'}
                        </p>
                      </div>
                    </label>
                    <label className={`flex items-start gap-3 p-2 rounded-lg border transition-colors ${canHostExec ? 'cursor-pointer hover:bg-accent/50' : 'opacity-50 cursor-not-allowed'}`}>
                      <input
                        type="radio"
                        name="runtime_profile"
                        value="device-cli-agent"
                        checked={runtimeProfile === 'device-cli-agent'}
                        onChange={() => { if (canHostExec) setRuntimeProfile('device-cli-agent'); }}
                        disabled={!canHostExec}
                        className="mt-0.5 accent-primary"
                      />
                      <div>
                        <div className="flex items-center gap-1.5">
                          <Cpu className="w-4 h-4 text-muted-foreground" />
                          <span className="text-sm font-medium">Device CLI Agent</span>
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {canHostExec ? 'Agent CLI 直接在选中的 Device 上运行并使用本地工具链' : '需要管理员权限'}
                        </p>
                      </div>
                    </label>
                  </div>
                </div>

                {/* Device native execution: target and custom cwd */}
                {runtimeProfile !== 'server-agent' && (
                  <>
                    <div>
                      <label className="block text-sm font-medium mb-2">执行 Device</label>
                      <select
                        value={executionNode}
                        onChange={(e) => {
                          setExecutionNode(e.target.value);
                          if (selectedRepo?.kind === 'device_path' && selectedRepo.device_link_id !== e.target.value) {
                            setSelectedRepoId('');
                            setHostRepoMode('default');
                          }
                        }}
                        disabled={selectedRepo?.kind === 'device_path'}
                        className="h-9 w-full px-3 text-sm border border-border rounded-md bg-transparent"
                      >
                        <option value="" disabled>请选择 Device</option>
                        {devices.map((device) => (
                          <option key={device.id} value={device.id} disabled={!device.online}>
                            {device.online ? '🟢' : '⚪️'} {device.displayName} ({device.id}){device.online ? '' : ' · 离线'}
                          </option>
                        ))}
                      </select>
                    </div>
                    {runtimeProfile === 'device-cli-agent' && (
                      <div>
                        <label className="block text-sm font-medium mb-2">Agent CLI</label>
                        <select
                          value={agentClientId}
                          onChange={(e) => setAgentClientId(e.target.value)}
                          className="h-9 w-full px-3 text-sm border border-border rounded-md bg-transparent"
                        >
                          <option value="claude-code">Claude Code</option>
                          <option value="codex">Codex</option>
                        </select>
                        <p className="text-xs text-muted-foreground mt-1">选择 Device 上用于执行 Agent 的 CLI backend。</p>
                      </div>
                    )}
                    <div>
                      <label className="block text-sm font-medium mb-2">项目 Repo</label>
                      <div className="space-y-2">
                        <label className="flex items-start gap-3 p-2 rounded-lg border cursor-pointer hover:bg-accent/50 transition-colors">
                          <input type="radio" name="host_repo_mode" value="default" checked={hostRepoMode === 'default'} onChange={() => { setHostRepoMode('default'); setSelectedRepoId(''); }} className="mt-0.5 accent-primary" />
                          <div>
                            <span className="text-sm font-medium">默认 Device 工作区</span>
                            <p className="text-xs text-muted-foreground mt-0.5">使用 Device 上 OctoDeck 默认工作目录</p>
                          </div>
                        </label>
                        <label className="flex items-start gap-3 p-2 rounded-lg border cursor-pointer hover:bg-accent/50 transition-colors">
                          <input type="radio" name="host_repo_mode" value="repo" checked={hostRepoMode === 'repo'} onChange={() => { setHostRepoMode('repo'); setCustomCwd(''); }} className="mt-0.5 accent-primary" />
                          <div className="flex-1">
                            <div className="flex items-center gap-1.5">
                              <GitBranch className="w-4 h-4 text-muted-foreground" />
                              <span className="text-sm font-medium">已管理 Repo</span>
                            </div>
                            <p className="text-xs text-muted-foreground mt-0.5">从侧边栏 Repo Center 中选择；Git 仓库可在任意 Device 执行，Device 目录固定到绑定设备</p>
                          </div>
                        </label>
                        {hostRepoMode === 'repo' && (
                          <div className="ml-6">
                            <select
                              value={selectedRepoId}
                              onChange={(e) => {
                                const repo = repos.find((item) => item.id === e.target.value);
                                setSelectedRepoId(e.target.value);
                                setCustomCwd('');
                                if (repo?.kind === 'device_path' && repo.device_link_id) {
                                  setExecutionNode(repo.device_link_id);
                                }
                              }}
                              className="h-9 w-full px-3 text-sm border border-border rounded-md bg-transparent"
                            >
                              <option value="" disabled>请选择 Repo</option>
                              {selectableRepos.map((repo) => (
                                <option key={repo.id} value={repo.id}>
                                  {repo.kind === 'git' ? 'Git' : 'Device'} · {repo.name}
                                  {repo.kind === 'device_path' && repo.device_link_id ? ` · ${repo.device_link_id}` : ''}
                                </option>
                              ))}
                            </select>
                            {selectableRepos.length === 0 && (
                              <p className="text-xs text-muted-foreground mt-1">暂无可用 Repo，请先在侧边栏 Repo Center 添加。</p>
                            )}
                            {selectedRepo && (
                              <p className="text-xs text-muted-foreground mt-1 break-all">
                                {selectedRepo.kind === 'git'
                                  ? selectedRepo.git_url
                                  : `${selectedRepo.device_path}${selectedRepo.device_link_id ? `（绑定 ${selectedRepo.device_link_id}）` : ''}`}
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                    {hostRepoMode === 'default' && (
                      <DirectoryBrowser value={customCwd} onChange={setCustomCwd} placeholder="兼容旧模式：直接指定 cwd（可选）" />
                    )}
                    <div className="flex items-start gap-2 p-2 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg">
                      <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
                      <p className="text-xs text-amber-700 dark:text-amber-300">
                        Device 执行形态下 Agent 可访问所选 Device 的文件系统和工具链，请谨慎使用。
                      </p>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={loading}>
            取消
          </Button>
          <Button onClick={handleConfirm} disabled={loading || !name.trim()}>
            {loading && <Loader2 className="w-4 h-4 animate-spin" />}
            {loading ? '正在创建...' : '创建'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
