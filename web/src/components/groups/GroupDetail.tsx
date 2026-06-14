import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BookOpen } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { GroupInfo } from '../../stores/groups';
import { api } from '../../api/client';
import { useAgentLinksStore } from '../../stores/agentLinks';
import type { AgentLink } from '../../stores/agentLinks';
import type {
  BackendInfo,
  SystemSettings,
} from '../settings/types';
import { getErrorMessage } from '../settings/types';

interface GroupDetailProps {
  group: GroupInfo & { jid: string };
}

function isAgentLinkExecutionTarget(target: string | null | undefined): target is string {
  return !!target && (/^cl_[0-9a-f]{16}$/.test(target) || /^runtime:cl_[0-9a-f]{16}:[^:]+$/.test(target) || /^cl_[0-9a-f]{16}:[^:]+$/.test(target) || /^provider:[^:]+$/.test(target));
}

function agentClientIdFromExecutionTarget(target: string): string | undefined {
  return target.match(/^provider:([^:]+)$/)?.[1]
    ?? target.match(/^runtime:cl_[0-9a-f]{16}:([^:]+)$/)?.[1]
    ?? target.match(/^cl_[0-9a-f]{16}:([^:]+)$/)?.[1];
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

export function GroupDetail({ group }: GroupDetailProps) {
  const navigate = useNavigate();
  const formatDate = (timestamp: string | number) => {
    return new Date(timestamp).toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  // Backend selection (admin/owner-only PATCH; falls back to system default if cleared)
  const [backends, setBackends] = useState<BackendInfo[]>([]);
  const [defaultBackend, setDefaultBackend] = useState<string>('claude-sdk');
  const [allowedBackends, setAllowedBackends] = useState<string[]>([
    'claude-sdk',
  ]);
  const [currentBackend, setCurrentBackend] = useState<string>(
    group.backend ?? '',
  );
  const [savingBackend, setSavingBackend] = useState(false);
  const canEditBackend = group.editable === true;

  const [currentAccessScope, setCurrentAccessScope] = useState<'all' | 'workspace'>(
    group.agent_access_scope ?? 'all',
  );
  const [currentPermissionMode, setCurrentPermissionMode] = useState<'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'>(
    group.permission_mode ?? 'bypassPermissions',
  );
  const [savingPermissions, setSavingPermissions] = useState(false);

  // Execution Device selection (<device_id>)
  const { links: agentLinks, load: loadAgentLinks } = useAgentLinksStore();
  const [currentExecNode, setCurrentExecNode] = useState<string>(
    isAgentLinkExecutionTarget(group.execution_node) ? group.execution_node : '',
  );
  const [savingExecNode, setSavingExecNode] = useState(false);

  useEffect(() => {
    setCurrentExecNode(isAgentLinkExecutionTarget(group.execution_node) ? group.execution_node : '');
  }, [group.execution_node, group.jid]);

  useEffect(() => {
    if (!canEditBackend) return;
    loadAgentLinks();
  }, [canEditBackend, loadAgentLinks]);

  const handleExecNodeChange = async (next: string) => {
    if (next === currentExecNode) return;
    setSavingExecNode(true);
    try {
      const agentClientId = agentClientIdFromExecutionTarget(next);
      await api.patch(`/api/groups/${encodeURIComponent(group.jid)}`, {
        execution_node: next,
        ...(agentClientId ? { agent_client_id: agentClientId } : {}),
      });
      setCurrentExecNode(next);
      toast.success('执行 Device 已更新，下一次执行生效');
    } catch (err) {
      toast.error(getErrorMessage(err, '更新执行 Device 失败'));
    } finally {
      setSavingExecNode(false);
    }
  };

  useEffect(() => {
    setCurrentBackend(group.backend ?? '');
  }, [group.backend, group.jid]);

  useEffect(() => {
    setCurrentAccessScope(group.agent_access_scope ?? 'all');
    setCurrentPermissionMode(group.permission_mode ?? 'bypassPermissions');
  }, [group.agent_access_scope, group.permission_mode, group.jid]);

  const handleAccessScopeChange = async (next: 'all' | 'workspace') => {
    if (next === currentAccessScope) return;
    setSavingPermissions(true);
    try {
      await api.patch(`/api/groups/${encodeURIComponent(group.jid)}`, {
        agent_access_scope: next,
      });
      setCurrentAccessScope(next);
      toast.success('Agent 访问范围已更新，下一次执行生效');
    } catch (err) {
      toast.error(getErrorMessage(err, '更新 Agent 访问范围失败'));
    } finally {
      setSavingPermissions(false);
    }
  };

  const handlePermissionModeChange = async (next: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan') => {
    if (next === currentPermissionMode) return;
    setSavingPermissions(true);
    try {
      await api.patch(`/api/groups/${encodeURIComponent(group.jid)}`, {
        permission_mode: next,
      });
      setCurrentPermissionMode(next);
      toast.success('Agent 审批模式已更新，下一次执行生效');
    } catch (err) {
      toast.error(getErrorMessage(err, '更新 Agent 审批模式失败'));
    } finally {
      setSavingPermissions(false);
    }
  };

  useEffect(() => {
    if (!canEditBackend) return;
    let cancelled = false;
    (async () => {
      try {
        const [list, sys] = await Promise.all([
          api.get<{ backends: BackendInfo[] }>('/api/config/backends'),
          api.get<SystemSettings>('/api/config/system').catch(() => null),
        ]);
        if (cancelled) return;
        setBackends(list.backends ?? []);
        if (sys) {
          setDefaultBackend(sys.defaultBackend ?? 'claude-sdk');
          setAllowedBackends(sys.allowedBackends ?? ['claude-sdk']);
        }
      } catch {
        // 列表加载失败不阻塞详情面板
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canEditBackend]);

  const handleBackendChange = async (next: string) => {
    if (next === currentBackend) return;
    if (!next) {
      toast.error('暂不支持清空后端，请改为选择默认后端');
      return;
    }
    setSavingBackend(true);
    try {
      await api.patch(`/api/groups/${encodeURIComponent(group.jid)}`, {
        backend: next,
      });
      setCurrentBackend(next);
      toast.success('后端已更新，下一次执行生效');
    } catch (err) {
      toast.error(getErrorMessage(err, '更新后端失败'));
    } finally {
      setSavingBackend(false);
    }
  };

  const backendOptions = (
    backends.length > 0
      ? backends.filter((b) => allowedBackends.includes(b.id))
      : allowedBackends.map(
          (id) =>
            ({
              id,
              displayName: id,
              usesProviderPool: false,
              supportsHost: true,
              supportsContainer: true,
            }) as BackendInfo,
        )
  );

  const executionTargetOptions = [
    ...uniqueProviderIds(agentLinks).map((providerId) => {
      const onlineRuntimes = agentLinks.flatMap((device) => device.runtimes ?? [])
        .filter((runtime) => runtime.agentClientId === providerId && runtime.status !== 'offline');
      const runningCount = onlineRuntimes.reduce((sum, runtime) => sum + (runtime.runningRuns?.length ?? 0), 0);
      return {
        value: `provider:${providerId}`,
        label: `⚡ Provider Pool · ${providerId} · ${onlineRuntimes.length} online · running ${runningCount}`,
        disabled: onlineRuntimes.length === 0,
      };
    }),
    ...agentLinks.flatMap((device) => {
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

  return (
    <div className="p-4 bg-background space-y-3">
      {/* JID */}
      <div>
        <div className="text-xs text-muted-foreground mb-1">完整 JID</div>
        <code className="block text-xs font-mono bg-card px-3 py-2 rounded border border-border break-all">
          {group.jid}
        </code>
      </div>

      {/* Folder */}
      <div>
        <div className="text-xs text-muted-foreground mb-1">文件夹</div>
        <div className="text-sm text-foreground font-medium">{group.folder}</div>
      </div>

      {/* Added At */}
      <div>
        <div className="text-xs text-muted-foreground mb-1">添加时间</div>
        <div className="text-sm text-foreground">
          {formatDate(group.added_at)}
        </div>
      </div>

      {/* Last Message */}
      {group.lastMessage && (
        <div>
          <div className="text-xs text-muted-foreground mb-1">最后消息</div>
          <div className="text-sm text-foreground bg-card px-3 py-2 rounded border border-border line-clamp-3 break-words">
            {group.lastMessage}
          </div>
          {group.lastMessageTime && (
            <div className="text-xs text-muted-foreground mt-1">
              {formatDate(group.lastMessageTime)}
            </div>
          )}
        </div>
      )}

      {/* Agent backend */}
      {canEditBackend && (
        <div>
          <div className="text-xs text-muted-foreground mb-1">Agent 后端</div>
          <select
            value={currentBackend || defaultBackend}
            disabled={savingBackend}
            onChange={(e) => handleBackendChange(e.target.value)}
            className="h-9 px-3 text-sm border border-border rounded-md bg-transparent w-full max-w-xs"
          >
            {backendOptions.map((b) => (
              <option key={b.id} value={b.id}>
                {b.displayName} ({b.id})
                {b.id === defaultBackend ? ' · 默认' : ''}
              </option>
            ))}
          </select>
          <div className="text-xs text-muted-foreground mt-1">
            {currentBackend
              ? `当前：${currentBackend}`
              : `跟随系统默认（${defaultBackend}）`}
          </div>
        </div>
      )}

      {/* Agent permissions */}
      {canEditBackend && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <div className="text-xs text-muted-foreground mb-1">Agent 访问范围</div>
            <select
              value={currentAccessScope}
              disabled={savingPermissions}
              onChange={(e) => handleAccessScopeChange(e.target.value as 'all' | 'workspace')}
              className="h-9 px-3 text-sm border border-border rounded-md bg-transparent w-full max-w-xs"
            >
              <option value="all">All · 可访问完整运行环境</option>
              <option value="workspace">Workspace · 限当前工作区</option>
            </select>
            <div className="text-xs text-muted-foreground mt-1">
              {currentAccessScope === 'workspace'
                ? '限制到当前 workspace 目录，忽略自定义 CWD/额外挂载。'
                : '保留现有全量运行环境访问能力。'}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground mb-1">Agent 审批模式</div>
            <select
              value={currentPermissionMode}
              disabled={savingPermissions}
              onChange={(e) => handlePermissionModeChange(e.target.value as 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan')}
              className="h-9 px-3 text-sm border border-border rounded-md bg-transparent w-full max-w-xs"
            >
              <option value="bypassPermissions">免审批（自动允许工具）</option>
              <option value="default">默认（按 Agent 默认审批）</option>
              <option value="acceptEdits">自动接受编辑</option>
              <option value="plan">Plan（计划/只读优先）</option>
            </select>
            <div className="text-xs text-muted-foreground mt-1">
              当前：{currentPermissionMode}
            </div>
          </div>
        </div>
      )}

      {/* Workspace system prompt 已迁移到聊天页面的 Agent 配置面板 */}

      {/* Execution Device */}
      {canEditBackend && (
        <div>
          <div className="text-xs text-muted-foreground mb-1">执行 Runtime / Provider</div>
          <select
            value={currentExecNode}
            disabled={savingExecNode}
            onChange={(e) => handleExecNodeChange(e.target.value)}
            className="h-9 px-3 text-sm border border-border rounded-md bg-transparent w-full max-w-xs"
          >
            <option value="" disabled>未选择 Device</option>
            {currentExecNode && !executionTargetOptions.some((target) => target.value === currentExecNode) && (
              <option value={currentExecNode}>{targetSummary(currentExecNode)} · 当前配置</option>
            )}
            {executionTargetOptions.map((target) => (
              <option key={target.value} value={target.value} disabled={target.disabled}>
                {target.label}
              </option>
            ))}
          </select>
          <div className="text-xs text-muted-foreground mt-1">
            {currentExecNode ? `当前：${targetSummary(currentExecNode)}` : '尚未绑定执行 Runtime / Provider'}
          </div>
        </div>
      )}

      {/* Quick Actions */}
      <div className="pt-2 border-t border-border">
        <Button
          variant="outline"
          size="sm"
          onClick={() => navigate(`/settings?tab=memory&folder=${encodeURIComponent(group.folder)}`)}
        >
          <BookOpen className="w-4 h-4" />
          记忆管理
        </Button>
      </div>
    </div>
  );
}
