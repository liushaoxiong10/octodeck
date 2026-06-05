import { useEffect, useState } from 'react';
import { Loader2, Sparkles, X, SlidersHorizontal } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { api } from '../../api/client';
import { showToast } from '../../utils/toast';
import { INTERVAL_UNITS, CHANNEL_OPTIONS, toggleNotifyChannel } from '../../utils/task-utils';
import { useConnectedChannels } from '../../hooks/useConnectedChannels';
import { useTasksStore } from '../../stores/tasks';
import { useGroupsStore } from '../../stores/groups';
import { useAgentLinksStore } from '../../stores/agentLinks';
import type { AgentLink } from '../../stores/agentLinks';
import { useCustomBackendsStore } from '../../stores/customBackends';
import { formatGroupLabel } from '../settings/channel-meta';

interface CreateTaskFormProps {
  onSubmit: (data: {
    prompt: string;
    scheduleType: 'cron' | 'interval' | 'once';
    scheduleValue: string;
    executionType: 'agent' | 'script';
    executionMode?: 'host' | 'container';
    executionNode?: string;
    scriptCommand: string;
    notifyChannels: string[] | null;
    chatJid?: string;
    contextMode?: 'group' | 'isolated';
    runtimeProfile?: 'server-agent' | 'server-agent-device-tools' | 'device-cli-agent';
    agentClientId?: string;
    backend?: string;
    agentModel?: string;
  }) => Promise<void>;
  onClose: () => void;
  isAdmin?: boolean;
}

type CreateMode = 'ai' | 'manual';

function isAgentLinkExecutionTarget(target: string | null | undefined): target is string {
  return !!target && (/^cl_[0-9a-f]{16}$/.test(target) || /^runtime:cl_[0-9a-f]{16}:[^:]+$/.test(target) || /^cl_[0-9a-f]{16}:[^:]+$/.test(target) || /^provider:[^:]+$/.test(target));
}

function uniqueProviderIds(devices: AgentLink[]): string[] {
  return [...new Set(devices.flatMap((device) => [
    ...(device.runtimes ?? []).map((runtime) => runtime.agentClientId),
    ...device.agentClients.map((client) => client.id),
  ]).filter(Boolean))].sort();
}

function targetSummary(target: string): string {
  if (target.startsWith('provider:')) return `Provider Pool ${target.slice('provider:'.length)}`;
  if (target.startsWith('runtime:')) return `Runtime ${target.slice('runtime:'.length)}`;
  if (target.includes(':')) return `Runtime ${target}`;
  return `Device ${target}`;
}

export function CreateTaskForm({ onSubmit, onClose, isAdmin }: CreateTaskFormProps) {
  const [mode, setMode] = useState<CreateMode>('ai');

  // --- AI mode state ---
  const [aiDescription, setAiDescription] = useState('');
  const [aiSubmitting, setAiSubmitting] = useState(false);

  // --- Manual mode state ---
  const [formData, setFormData] = useState({
    prompt: '',
    scheduleType: 'cron' as 'cron' | 'interval' | 'once',
    scheduleValue: '',
    executionType: 'agent' as 'agent' | 'script',
    executionMode: (isAdmin ? 'host' : 'container') as 'host' | 'container',
    scriptCommand: '',
  });
  const [intervalNumber, setIntervalNumber] = useState('');
  const [intervalUnit, setIntervalUnit] = useState('60000');
  const [onceDateTime, setOnceDateTime] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  // --- Shared state ---
  const [notifyChannels, setNotifyChannels] = useState<string[] | null>(null);
  const [chatJid, setChatJid] = useState<string>('');
  const [contextMode] = useState<'group' | 'isolated'>('isolated');
  const [executionModeExplicit, setExecutionModeExplicit] = useState<boolean>(false);
  const [executionNode, setExecutionNode] = useState('');
  const [executionNodeExplicit, setExecutionNodeExplicit] = useState(false);
  const [agentConfigExplicit, setAgentConfigExplicit] = useState(false);
  const [runtimeProfile, setRuntimeProfile] = useState<'server-agent' | 'server-agent-device-tools' | 'device-cli-agent' | ''>('');
  const [agentBackendId, setAgentBackendId] = useState('');
  const [agentClientId, setAgentClientId] = useState('');
  const [agentModel, setAgentModel] = useState('');
  const connectedChannels = useConnectedChannels();

  const groupNames = useTasksStore((s) => s.groupNames);
  const loadTasks = useTasksStore((s) => s.loadTasks);
  const groups = useGroupsStore((s) => s.groups);
  const loadGroups = useGroupsStore((s) => s.loadGroups);
  const { links: devices, load: loadDevices } = useAgentLinksStore();
  const { backends: customBackends, load: loadCustomBackends } = useCustomBackendsStore();

  useEffect(() => {
    if (Object.keys(groupNames).length === 0) {
      loadTasks();
    }
    if (Object.keys(groups).length === 0) {
      loadGroups();
    }
    if (isAdmin) {
      loadDevices();
      loadCustomBackends();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync executionMode from selected workspace when user hasn't manually overridden.
  // For the "default" option (empty chatJid), fall back to a role-based placeholder
  // that matches what the backend infers for the user's own home workspace.
  useEffect(() => {
    if (executionModeExplicit) return;
    const sourceMode = chatJid ? groups[chatJid]?.execution_mode : undefined;
    const next = sourceMode ?? (isAdmin ? 'host' : 'container');
    setFormData((prev) =>
      prev.executionMode === next ? prev : { ...prev, executionMode: next },
    );
  }, [chatJid, groups, executionModeExplicit, isAdmin]);

  useEffect(() => {
    if (executionNodeExplicit) return;
    const sourceNode = chatJid ? groups[chatJid]?.execution_node : undefined;
    setExecutionNode(isAgentLinkExecutionTarget(sourceNode) ? sourceNode : '');
  }, [chatJid, groups, executionNodeExplicit]);

  useEffect(() => {
    if (agentConfigExplicit) return;
    const sourceGroup = chatJid ? groups[chatJid] : undefined;
    setRuntimeProfile(sourceGroup?.runtime_profile ?? '');
    setAgentBackendId(sourceGroup?.backend ?? '');
    setAgentClientId(sourceGroup?.agent_client_id ?? '');
    setAgentModel(sourceGroup?.agent_model ?? '');
  }, [chatJid, groups, agentConfigExplicit]);

  const isScript = formData.executionType === 'script';

  const sortedGroupEntries = Object.entries(groupNames).sort(([a], [b]) => {
    const aWeb = a.startsWith('web:') ? 0 : 1;
    const bWeb = b.startsWith('web:') ? 0 : 1;
    if (aWeb !== bWeb) return aWeb - bWeb;
    return a.localeCompare(b);
  });

  const executionTargetOptions = [
    ...uniqueProviderIds(devices).map((providerId) => {
      const onlineRuntimes = devices.flatMap((device) => device.runtimes ?? [])
        .filter((runtime) => runtime.agentClientId === providerId && runtime.status !== 'offline');
      const runningCount = onlineRuntimes.reduce((sum, runtime) => sum + (runtime.runningRuns?.length ?? 0), 0);
      return {
        value: `provider:${providerId}`,
        label: `⚡ Provider Pool · ${providerId} · ${onlineRuntimes.length} online · running ${runningCount}`,
        disabled: onlineRuntimes.length === 0,
      };
    }),
    ...devices.flatMap((device) => {
      const runtimes = device.runtimes && device.runtimes.length > 0
        ? device.runtimes
        : device.agentClients.map((client) => ({
            runtimeId: `${device.id}:${client.id}`,
            deviceLinkId: device.id,
            agentClientId: client.id,
            displayName: client.displayName || client.id,
            status: device.online ? 'idle' : 'offline',
            runningRuns: device.runningRuns ?? [],
          }));
      return [
        {
          value: device.id,
          label: `${device.online ? '🟢' : '⚪️'} Device · ${device.displayName} (${device.id}) · running ${device.runningRuns?.length ?? 0}`,
          disabled: !device.online,
        },
        ...runtimes.map((runtime) => ({
          value: `runtime:${runtime.deviceLinkId}:${runtime.agentClientId}`,
          label: `${runtime.status !== 'offline' ? '🟢' : '⚪️'} Runtime · ${device.displayName} · ${runtime.displayName ?? runtime.agentClientId} · ${runtime.status} · running ${runtime.runningRuns?.length ?? 0}`,
          disabled: !device.online || runtime.status === 'offline' || runtime.status === 'draining',
        })),
      ];
    }),
  ];

  const selectableAgentBackends = customBackends
    .filter((backend) => (backend.runtime === 'local-device' || backend.deviceLinkId) && backend.deviceLinkId && backend.agentClientId)
    .filter((backend) => !executionNode || backend.deviceLinkId === executionNode || executionNode.startsWith('provider:'));

  const renderAgentConfig = () => {
    if (!isAdmin || isScript) return null;
    return (
      <div className="rounded-lg border border-border p-3 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <label className="block text-sm font-medium text-foreground">Agent 配置</label>
            <p className="mt-1 text-xs text-muted-foreground">
              默认继承源工作区的 Agent / 模型；手动选择后会固定到这个定时任务
            </p>
          </div>
          {agentConfigExplicit && (
            <Button type="button" variant="outline" size="sm" onClick={() => setAgentConfigExplicit(false)}>
              恢复继承
            </Button>
          )}
        </div>
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1">Device CLI Agent</label>
          <Select
            value={agentBackendId || '__inherit__'}
            onValueChange={(value) => {
              setAgentConfigExplicit(true);
              if (value === '__inherit__') {
                setAgentBackendId('');
                setAgentClientId('');
                setRuntimeProfile('');
                return;
              }
              const selected = customBackends.find((backend) => backend.id === value);
              setAgentBackendId(value);
              setAgentClientId(selected?.agentClientId ?? '');
              setRuntimeProfile('device-cli-agent');
              if (selected?.deviceLinkId && !executionNodeExplicit) {
                setExecutionNode(selected.deviceLinkId);
                setFormData((prev) => ({ ...prev, executionMode: 'host' }));
              }
              if (selected?.model && !agentModel) setAgentModel(selected.model);
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__inherit__">继承源工作区</SelectItem>
              {agentBackendId && !selectableAgentBackends.some((backend) => backend.id === agentBackendId) && (
                <SelectItem value={agentBackendId}>{agentBackendId} · 当前配置</SelectItem>
              )}
              {selectableAgentBackends.map((backend) => (
                <SelectItem key={backend.id} value={backend.id}>
                  {backend.displayName || backend.id} · {backend.agentClientId} · {backend.deviceLinkId}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1">模型覆盖</label>
          <Input
            value={agentModel}
            onChange={(e) => {
              setAgentConfigExplicit(true);
              setAgentModel(e.target.value);
            }}
            placeholder="留空则继承工作区/Agent 默认模型"
          />
        </div>
      </div>
    );
  };

  const renderTargetWorkspace = () => (
    <div>
      <label className="block text-sm font-medium text-foreground mb-2">消息目标</label>
      <Select
        value={chatJid || '__default__'}
        onValueChange={(value) => setChatJid(value === '__default__' ? '' : value)}
      >
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__default__">默认（我的主工作区）</SelectItem>
          {sortedGroupEntries.map(([jid, name]) => (
            <SelectItem key={jid} value={jid}>
              {formatGroupLabel(jid, name)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="mt-1 text-xs text-muted-foreground">
        选择任务结果投递的目标工作区；默认落到你的主工作区
      </p>
    </div>
  );

  const renderContextMode = () => (
    <div>
      <label className="block text-sm font-medium text-foreground mb-2">运行模式</label>
      <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm text-foreground">
        后台任务模式
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        定时任务不会创建新的可见工作区；会在后台独立执行，结果写回任务日志并通知目标工作区
      </p>
    </div>
  );

  const connectedKeys = CHANNEL_OPTIONS.filter((c) => connectedChannels[c.key]).map((c) => c.key);

  const isChannelSelected = (key: string) => {
    if (notifyChannels === null) return true;
    return notifyChannels.includes(key);
  };

  const toggleChannel = (key: string) => {
    setNotifyChannels((prev) => toggleNotifyChannel(prev, key, connectedKeys));
  };

  // --- AI mode handler ---
  const handleAiCreate = async () => {
    if (!aiDescription.trim()) return;
    setAiSubmitting(true);
    try {
      // AI mode always sends context_mode — the execution_type (agent/script)
      // is decided by the backend parser, not the client. If the parser
      // resolves to script, the backend ignores context_mode server-side.
      const body: Record<string, unknown> = {
        description: aiDescription.trim(),
        notify_channels: notifyChannels,
        context_mode: contextMode,
      };
      if (chatJid) {
        body.chat_jid = chatJid;
      }
      await api.post('/api/tasks/ai', body);
      showToast('任务已创建', 'AI 正在后台解析调度参数，稍后自动激活');
      onClose();
    } catch (error) {
      showToast('创建失败', error instanceof Error ? error.message : '请稍后重试');
    } finally {
      setAiSubmitting(false);
    }
  };

  // --- Manual mode handlers ---
  const validateForm = () => {
    const newErrors: Record<string, string> = {};
    if (isScript) {
      if (!formData.scriptCommand.trim()) newErrors.scriptCommand = '请输入脚本命令';
    } else {
      if (!formData.prompt.trim()) newErrors.prompt = '请输入 Prompt';
    }
    if (isAdmin && formData.executionMode === 'host' && !executionNode) {
      newErrors.executionNode = '请选择执行 Device';
    }
    if (formData.scheduleType === 'cron') {
      if (!formData.scheduleValue.trim()) {
        newErrors.scheduleValue = '请输入 Cron 表达式';
      } else if (formData.scheduleValue.trim().split(' ').length < 5) {
        newErrors.scheduleValue = 'Cron 表达式格式错误（至少需要 5 个字段）';
      }
    } else if (formData.scheduleType === 'interval') {
      if (!intervalNumber.trim()) {
        newErrors.scheduleValue = '请输入间隔数值';
      } else {
        const num = parseInt(intervalNumber);
        if (isNaN(num) || num <= 0) newErrors.scheduleValue = '间隔必须是正整数';
      }
    } else if (formData.scheduleType === 'once') {
      if (!onceDateTime) {
        newErrors.scheduleValue = '请选择执行时间';
      } else {
        const date = new Date(onceDateTime);
        if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) {
          newErrors.scheduleValue = '请选择未来时间';
        }
      }
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleManualSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validateForm()) return;
    let finalScheduleValue = formData.scheduleValue;
    if (formData.scheduleType === 'interval') {
      finalScheduleValue = String(parseInt(intervalNumber, 10) * parseInt(intervalUnit, 10));
    } else if (formData.scheduleType === 'once') {
      finalScheduleValue = new Date(onceDateTime).toISOString();
    }
    setSubmitting(true);
    // Clear any lingering store error so we can detect whether this submit failed.
    useTasksStore.setState({ error: null });
    try {
      await onSubmit({
        prompt: formData.prompt,
        scheduleType: formData.scheduleType,
        scheduleValue: finalScheduleValue,
        executionType: formData.executionType,
        executionMode: executionModeExplicit ? formData.executionMode : undefined,
        executionNode: formData.executionMode === 'host' && executionNode ? executionNode : undefined,
        scriptCommand: formData.scriptCommand,
        notifyChannels,
        chatJid: chatJid || undefined,
        contextMode: !isScript ? contextMode : undefined,
        runtimeProfile: agentConfigExplicit && runtimeProfile ? runtimeProfile : undefined,
        agentClientId: agentConfigExplicit && agentClientId ? agentClientId : undefined,
        backend: agentConfigExplicit && agentBackendId ? agentBackendId : undefined,
        agentModel: agentConfigExplicit && agentModel.trim() ? agentModel.trim() : undefined,
      });
      // The store swallows API errors into state.error; surface it as a toast
      // so the user sees why the submit failed. TasksPage keeps the form open
      // whenever state.error is set.
      const storeError = useTasksStore.getState().error;
      if (storeError) {
        showToast('创建失败', storeError);
      }
    } catch (error) {
      console.error('Failed to create task:', error);
    } finally {
      setSubmitting(false);
    }
  };

  // --- Notify channels UI (shared) ---
  const connectedOptions = CHANNEL_OPTIONS.filter((ch) => connectedChannels[ch.key]);

  const renderNotifyChannels = () => (
    <div>
      <label className="block text-sm font-medium text-foreground mb-2">通知渠道</label>
      <div className="flex flex-wrap gap-3">
        <label className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
          <input type="checkbox" checked disabled className="rounded" />
          Web（始终）
        </label>
        {connectedOptions.map((ch) => (
          <label
            key={ch.key}
            className="inline-flex items-center gap-1.5 text-sm cursor-pointer"
          >
            <input
              type="checkbox"
              checked={isChannelSelected(ch.key)}
              onChange={() => toggleChannel(ch.key)}
              className="rounded"
            />
            {ch.label}
          </label>
        ))}
      </div>
      {connectedOptions.length === 0 && (
        <p className="mt-1 text-xs text-muted-foreground">
          未绑定任何 IM 渠道，任务结果仅在 Web 工作区展示
        </p>
      )}
      {connectedOptions.length > 0 && (
        <p className="mt-1 text-xs text-muted-foreground">
          选择任务结果推送的 IM 渠道，默认推送到所有已连接渠道
        </p>
      )}
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-card rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-border">
          <h2 className="text-xl font-bold text-foreground">创建定时任务</h2>
          <button
            onClick={onClose}
            className="p-2 text-muted-foreground hover:text-foreground hover:bg-muted rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Mode Tabs */}
        <div className="flex border-b border-border">
          <button
            onClick={() => setMode('ai')}
            className={cn(
              'flex-1 flex items-center justify-center gap-2 px-4 py-3 text-sm font-medium transition-colors cursor-pointer',
              mode === 'ai'
                ? 'text-primary border-b-2 border-primary bg-brand-50/50'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/50',
            )}
          >
            <Sparkles className="w-4 h-4" />
            AI 智能创建
          </button>
          <button
            onClick={() => setMode('manual')}
            className={cn(
              'flex-1 flex items-center justify-center gap-2 px-4 py-3 text-sm font-medium transition-colors cursor-pointer',
              mode === 'manual'
                ? 'text-primary border-b-2 border-primary bg-brand-50/50'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/50',
            )}
          >
            <SlidersHorizontal className="w-4 h-4" />
            手动配置
          </button>
        </div>

        {/* AI Mode */}
        {mode === 'ai' && (
          <div className="p-6 space-y-4">
            {/* Description */}
            <div>
              <label className="block text-sm font-medium text-foreground mb-2">
                用自然语言描述你的任务
              </label>
              <Textarea
                value={aiDescription}
                onChange={(e) => setAiDescription(e.target.value)}
                rows={4}
                className="resize-none"
                placeholder="例如：每天早上 9 点帮我总结最新的科技新闻&#10;每周一下午 2 点检查项目依赖是否有安全更新&#10;每隔 2 小时检查一次服务器状态"
              />
              <p className="mt-1.5 text-xs text-muted-foreground">
                AI 会自动解析调度时间和任务内容，创建后在后台完成解析
              </p>
            </div>

            {renderTargetWorkspace()}
            {renderContextMode()}

            {renderNotifyChannels()}

            {/* Actions */}
            <div className="flex items-center justify-end gap-3 pt-4 border-t border-border">
              <Button type="button" variant="outline" onClick={onClose}>
                取消
              </Button>
              <Button
                onClick={handleAiCreate}
                disabled={aiSubmitting || !aiDescription.trim()}
              >
                {aiSubmitting ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    创建中...
                  </>
                ) : (
                  <>
                    <Sparkles className="size-4" />
                    创建任务
                  </>
                )}
              </Button>
            </div>
          </div>
        )}

        {/* Manual Mode */}
        {mode === 'manual' && (
          <form onSubmit={handleManualSubmit} className="p-6 space-y-4">
            {/* Execution Type */}
            {isAdmin && (
              <div>
                <label className="block text-sm font-medium text-foreground mb-2">
                  执行方式
                </label>
                <Select
                  value={formData.executionType}
                  onValueChange={(value) =>
                    setFormData({ ...formData, executionType: value as 'agent' | 'script' })
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="agent">Agent（AI 代理）</SelectItem>
                    <SelectItem value="script">脚本（Shell 命令）</SelectItem>
                  </SelectContent>
                </Select>
                <p className="mt-1 text-xs text-muted-foreground">
                  {isScript
                    ? '直接执行 Shell 命令，零 API 消耗，适合确定性任务'
                    : '启动完整 Claude Agent，消耗 API tokens'}
                </p>
              </div>
            )}

            {/* Execution Mode */}
            {isAdmin && (
              <div>
                <label className="block text-sm font-medium text-foreground mb-2">
                  执行模式
                </label>
                <Select
                  value={formData.executionMode}
                  onValueChange={(value) => {
                    setExecutionModeExplicit(true);
                    setFormData({ ...formData, executionMode: value as 'host' | 'container' });
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="host">Device 原生执行</SelectItem>
                    <SelectItem value="container">Docker 容器</SelectItem>
                  </SelectContent>
                </Select>
                <p className="mt-1 text-xs text-muted-foreground">
                  {executionModeExplicit
                    ? '已手动指定执行模式，不再跟随源工作区'
                    : '默认继承源工作区的执行模式，选择后将锁定不再自动同步'}
                </p>
              </div>
            )}

            {isAdmin && formData.executionMode === 'host' && (
              <div>
                <label className="block text-sm font-medium text-foreground mb-2">
                  执行 Runtime / Provider
                </label>
                <Select
                  value={executionNode}
                  onValueChange={(value) => {
                    setExecutionNodeExplicit(true);
                    setExecutionNode(value);
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {executionNode && !executionTargetOptions.some((target) => target.value === executionNode) && (
                      <SelectItem value={executionNode}>{targetSummary(executionNode)} · 当前配置</SelectItem>
                    )}
                    {executionTargetOptions.map((target) => (
                      <SelectItem key={target.value} value={target.value} disabled={target.disabled}>
                        {target.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {errors.executionNode && (
                  <p className="mt-1 text-sm text-red-600 dark:text-red-400">{errors.executionNode}</p>
                )}
                <p className="mt-1 text-xs text-muted-foreground">
                  {executionNodeExplicit
                    ? '已手动指定执行 Runtime / Provider，不再跟随源工作区'
                    : '默认继承源工作区的执行 Runtime / Provider。Provider Pool 会自动选择有空闲 slots 的在线 runtime'}
                </p>
              </div>
            )}

            {renderTargetWorkspace()}
            {!isScript && renderContextMode()}
            {renderAgentConfig()}

            {/* Script Command */}
            {isScript && (
              <div>
                <label className="block text-sm font-medium text-foreground mb-2">
                  脚本命令 <span className="text-red-500">*</span>
                </label>
                <Textarea
                  value={formData.scriptCommand}
                  onChange={(e) => setFormData({ ...formData, scriptCommand: e.target.value })}
                  rows={3}
                  maxLength={4096}
                  className={cn("resize-none font-mono text-sm", errors.scriptCommand && "border-red-500")}
                  placeholder="例如: curl -s https://api.example.com/health | jq .status"
                />
                {errors.scriptCommand && (
                  <p className="mt-1 text-sm text-red-600 dark:text-red-400">{errors.scriptCommand}</p>
                )}
                <p className="mt-1 text-xs text-muted-foreground">
                  命令在群组工作目录下执行，最大 4096 字符
                </p>
              </div>
            )}

            {/* Prompt */}
            <div>
              <label className="block text-sm font-medium text-foreground mb-2">
                {isScript ? '任务描述' : '任务 Prompt'}{' '}
                {!isScript && <span className="text-red-500">*</span>}
              </label>
              <Textarea
                value={formData.prompt}
                onChange={(e) => setFormData({ ...formData, prompt: e.target.value })}
                rows={isScript ? 2 : 4}
                className={cn("resize-none", errors.prompt && "border-red-500")}
                placeholder={isScript ? '可选的任务描述...' : '输入任务的提示词...'}
              />
              {errors.prompt && (
                <p className="mt-1 text-sm text-red-600 dark:text-red-400">{errors.prompt}</p>
              )}
            </div>

            {/* Schedule Type */}
            <div>
              <label className="block text-sm font-medium text-foreground mb-2">
                调度类型 <span className="text-red-500">*</span>
              </label>
              <Select
                value={formData.scheduleType}
                onValueChange={(value) => {
                  setIntervalNumber('');
                  setOnceDateTime('');
                  setFormData({ ...formData, scheduleType: value as 'cron' | 'interval' | 'once', scheduleValue: '' });
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="cron">Cron 表达式</SelectItem>
                  <SelectItem value="interval">间隔执行</SelectItem>
                  <SelectItem value="once">单次执行</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Schedule Value */}
            <div>
              <label className="block text-sm font-medium text-foreground mb-2">
                调度值 <span className="text-red-500">*</span>
              </label>
              {formData.scheduleType === 'cron' && (
                <>
                  <Input
                    type="text"
                    value={formData.scheduleValue}
                    onChange={(e) => setFormData({ ...formData, scheduleValue: e.target.value })}
                    className={cn(errors.scheduleValue && "border-red-500")}
                    placeholder="例如: 0 9 * * * (每天 9 点)"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    格式: 分 时 日 月 星期（北京时间 UTC+8）。常用: <code className="bg-muted px-1 rounded">*/5 * * * *</code> 每5分钟, <code className="bg-muted px-1 rounded">0 9 * * 1-5</code> 工作日9点, <code className="bg-muted px-1 rounded">@daily</code> 每天
                  </p>
                </>
              )}
              {formData.scheduleType === 'interval' && (
                <>
                  <div className="flex gap-2">
                    <Input
                      type="number"
                      min="1"
                      value={intervalNumber}
                      onChange={(e) => setIntervalNumber(e.target.value)}
                      className={cn("flex-1", errors.scheduleValue && "border-red-500")}
                      placeholder="数值"
                    />
                    <Select value={intervalUnit} onValueChange={setIntervalUnit}>
                      <SelectTrigger className="w-28">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {INTERVAL_UNITS.map((u) => (
                          <SelectItem key={u.ms} value={String(u.ms)}>
                            {u.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">设置任务执行间隔</p>
                </>
              )}
              {formData.scheduleType === 'once' && (
                <>
                  <Input
                    type="datetime-local"
                    value={onceDateTime}
                    onChange={(e) => setOnceDateTime(e.target.value)}
                    className={cn(errors.scheduleValue && "border-red-500")}
                  />
                  <p className="mt-1 text-xs text-muted-foreground">选择任务的执行时间</p>
                </>
              )}
              {errors.scheduleValue && (
                <p className="mt-1 text-sm text-red-600 dark:text-red-400">{errors.scheduleValue}</p>
              )}
            </div>

            {renderNotifyChannels()}

            {/* Actions */}
            <div className="flex items-center justify-end gap-3 pt-4 border-t border-border">
              <Button type="button" variant="outline" onClick={onClose}>
                取消
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting && <Loader2 className="size-4 animate-spin" />}
                {submitting ? '创建中...' : '创建任务'}
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
