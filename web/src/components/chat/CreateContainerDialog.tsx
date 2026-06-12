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
import { useChatStore } from '../../stores/chat';
import { useAuthStore } from '../../stores/auth';
import { useAgentLinksStore } from '../../stores/agentLinks';
import { useReposStore } from '../../stores/repos';
import { useCustomBackendsStore } from '../../stores/customBackends';

function deviceIdFromExecutionTarget(target: string): string | null {
  if (/^cl_[0-9a-f]{16}$/.test(target)) return target;
  const runtimeMatch = target.match(/^runtime:(cl_[0-9a-f]{16}):[^:]+$/);
  if (runtimeMatch) return runtimeMatch[1];
  const legacyRuntimeMatch = target.match(/^(cl_[0-9a-f]{16}):[^:]+$/);
  if (legacyRuntimeMatch) return legacyRuntimeMatch[1];
  return null;
}

interface CreateContainerDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (jid: string, folder: string) => void;
}

type RuntimeProfile = 'server-agent' | 'server-agent-device-tools' | 'device-cli-agent';
type AgentAccessScope = 'all' | 'workspace';
type AgentPermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';

export function CreateContainerDialog({
  open,
  onClose,
  onCreated,
}: CreateContainerDialogProps) {
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(true);
  const [runtimeProfile, setRuntimeProfile] = useState<RuntimeProfile | ''>('');
  const [executionNode, setExecutionNode] = useState('');
  const [agentBackendId, setAgentBackendId] = useState('');
  const [hostRepoMode, setHostRepoMode] = useState<'all' | 'repo'>('all');
  const [selectedRepoId, setSelectedRepoId] = useState('');
  const [agentAccessScope, setAgentAccessScope] = useState<AgentAccessScope>('all');
  const [permissionMode, setPermissionMode] = useState<AgentPermissionMode>('bypassPermissions');

  const createFlow = useChatStore((s) => s.createFlow);
  const canHostExec = useAuthStore((s) => s.user?.role === 'admin');
  const { links: devices, load: loadDevices } = useAgentLinksStore();
  const { backends, load: loadBackends } = useCustomBackendsStore();
  const { repos, load: loadRepos } = useReposStore();

  useEffect(() => {
    if (open && canHostExec) {
      void loadDevices();
      void loadBackends();
      void loadRepos();
    }
  }, [open, canHostExec, loadDevices, loadBackends, loadRepos]);

  const selectedRepo = useMemo(
    () => repos.find((repo) => repo.id === selectedRepoId),
    [repos, selectedRepoId],
  );

  const selectedDeviceId = deviceIdFromExecutionTarget(executionNode);
  const deviceTargetOptions = useMemo(
    () => devices,
    [devices],
  );

  const selectableAgentBackends = useMemo(
    () => backends
      .filter((backend) => backend.runtime === 'local-device' || backend.deviceLinkId)
      .filter((backend) => !selectedDeviceId || backend.deviceLinkId === selectedDeviceId)
      .filter((backend) => backend.deviceLinkId && backend.agentClientId)
      .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [backends, selectedDeviceId],
  );

  const selectedAgentBackend = useMemo(
    () => backends.find((backend) => backend.id === agentBackendId),
    [backends, agentBackendId],
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

  useEffect(() => {
    if (runtimeProfile !== 'device-cli-agent') return;
    if (selectableAgentBackends.length === 0) {
      setAgentBackendId('');
      return;
    }
    if (!selectableAgentBackends.some((backend) => backend.id === agentBackendId)) {
      setAgentBackendId(selectableAgentBackends[0].id);
    }
  }, [runtimeProfile, selectableAgentBackends, agentBackendId]);

  const reset = () => {
    setName('');
    setAdvancedOpen(true);
    setRuntimeProfile('');
    setExecutionNode('');
    setAgentBackendId('');
    setHostRepoMode('all');
    setSelectedRepoId('');
    setAgentAccessScope('all');
    setPermissionMode('bypassPermissions');
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
      if (!runtimeProfile) {
        toast.error('请选择执行形态');
        return;
      }
      const options: Parameters<typeof createFlow>[1] = {};
      options.runtime_profile = runtimeProfile;
      options.agent_access_scope = agentAccessScope;
      options.permission_mode = permissionMode;
      if (runtimeProfile !== 'server-agent') {
        if (!executionNode) {
          toast.error('请选择执行 Device');
          return;
        }
        options.device_link_id = executionNode;
        if (runtimeProfile === 'device-cli-agent') {
          if (!selectedAgentBackend || selectedAgentBackend.deviceLinkId !== executionNode) {
            toast.error('请选择该 Device 上已定义的 Agent');
            return;
          }
          if (!selectedAgentBackend.agentClientId) {
            toast.error('该 Agent 未绑定 Device CLI，请先在 Agents 页面重新配置');
            return;
          }
          options.backend = selectedAgentBackend.id;
          options.agent_client_id = selectedAgentBackend.agentClientId;
        }
        if (hostRepoMode === 'repo' && selectedRepoId) {
          options.repo_id = selectedRepoId;
          options.visible_repo_mode = 'selected';
          options.visible_repo_ids = [selectedRepoId];
        } else if (hostRepoMode === 'repo') {
          toast.error('请选择项目 Repo');
          return;
        } else {
          options.visible_repo_mode = 'all';
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
                          setHostRepoMode('all');
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

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-sm font-medium mb-2">审批模式</label>
                    <select
                      value={permissionMode}
                      onChange={(e) => setPermissionMode(e.target.value as AgentPermissionMode)}
                      className="h-9 w-full px-3 text-sm border border-border rounded-md bg-transparent"
                    >
                      <option value="bypassPermissions">免审批</option>
                      <option value="default">默认审批</option>
                      <option value="acceptEdits">自动接受编辑</option>
                      <option value="plan">Plan</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-2">访问范围</label>
                    <select
                      value={agentAccessScope}
                      onChange={(e) => setAgentAccessScope(e.target.value as AgentAccessScope)}
                      className="h-9 w-full px-3 text-sm border border-border rounded-md bg-transparent"
                    >
                      <option value="all">All</option>
                      <option value="workspace">Workspace</option>
                    </select>
                  </div>
                </div>

                {/* Device native execution: target and custom cwd */}
                {runtimeProfile && runtimeProfile !== 'server-agent' && (
                  <>
                    <div>
                      <label className="block text-sm font-medium mb-2">
                        执行 Device
                      </label>
                      <select
                        value={executionNode}
                        onChange={(e) => {
                          setExecutionNode(e.target.value);
                          if (selectedRepo?.kind === 'device_path' && selectedRepo.device_link_id !== e.target.value) {
                            setSelectedRepoId('');
                            setHostRepoMode('all');
                          }
                        }}
                        disabled={selectedRepo?.kind === 'device_path'}
                        className="h-9 w-full px-3 text-sm border border-border rounded-md bg-transparent"
                      >
                        <option value="" disabled>请选择 Device</option>
                        {deviceTargetOptions.map((device) => (
                          <option key={device.id} value={device.id} disabled={!device.online}>
                            {device.online ? '🟢' : '⚪️'} {device.displayName} ({device.id}) · running {device.runningRuns?.length ?? 0}{device.online ? '' : ' · 离线'}
                          </option>
                        ))}
                      </select>
                      {runtimeProfile === 'device-cli-agent' && (
                        <p className="text-xs text-muted-foreground mt-1">
                          先选择 Device，再选择该 Device 上已经在 Agents 页面定义好的 Agent；runtime 仅用于定义 Agent 时发现 CLI 能力。
                        </p>
                      )}
                    </div>
                    {runtimeProfile === 'device-cli-agent' && selectedDeviceId && (
                      <div>
                        <label className="block text-sm font-medium mb-2">Device Agent</label>
                        <select
                          value={agentBackendId}
                          onChange={(e) => setAgentBackendId(e.target.value)}
                          disabled={!executionNode || selectableAgentBackends.length === 0}
                          className="h-9 w-full px-3 text-sm border border-border rounded-md bg-transparent"
                        >
                          {selectableAgentBackends.length === 0 ? (
                            <option value="">该 Device 暂无已定义 Agent，请先在 Agents 页面创建</option>
                          ) : selectableAgentBackends.map((backend) => (
                            <option key={backend.id} value={backend.id}>
                              {backend.displayName} · {backend.agentClientId} · {backend.id}
                            </option>
                          ))}
                        </select>
                        <p className="text-xs text-muted-foreground mt-1">工作区会绑定到这个已定义 Agent，后续会使用它的模型、参数和会话能力。</p>
                      </div>
                    )}
                    <div>
                      <label className="block text-sm font-medium mb-2">可见项目 Repo</label>
                      <div className="space-y-2">
                        <label className="flex items-start gap-3 p-2 rounded-lg border cursor-pointer hover:bg-accent/50 transition-colors">
                          <input type="radio" name="host_repo_mode" value="all" checked={hostRepoMode === 'all'} onChange={() => { setHostRepoMode('all'); setSelectedRepoId(''); }} className="mt-0.5 accent-primary" />
                          <div>
                            <span className="text-sm font-medium">全部 Repo 可见</span>
                            <p className="text-xs text-muted-foreground mt-0.5">Agent 运行目录始终是 Device Workspace；不限制到单个 Repo</p>
                          </div>
                        </label>
                        <label className="flex items-start gap-3 p-2 rounded-lg border cursor-pointer hover:bg-accent/50 transition-colors">
                          <input type="radio" name="host_repo_mode" value="repo" checked={hostRepoMode === 'repo'} onChange={() => { setHostRepoMode('repo'); }} className="mt-0.5 accent-primary" />
                          <div className="flex-1">
                            <div className="flex items-center gap-1.5">
                              <GitBranch className="w-4 h-4 text-muted-foreground" />
                              <span className="text-sm font-medium">已管理 Repo</span>
                            </div>
                            <p className="text-xs text-muted-foreground mt-0.5">从 Repo Center 指定一个项目作为上下文；工作区仍是 Agent 运行目录</p>
                          </div>
                        </label>
                        {hostRepoMode === 'repo' && (
                          <div className="ml-6">
                            <select
                              value={selectedRepoId}
                              onChange={(e) => {
                                const repo = repos.find((item) => item.id === e.target.value);
                                setSelectedRepoId(e.target.value);
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
          <Button onClick={handleConfirm} disabled={loading || !name.trim() || !runtimeProfile}>
            {loading && <Loader2 className="w-4 h-4 animate-spin" />}
            {loading ? '正在创建...' : '创建'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
