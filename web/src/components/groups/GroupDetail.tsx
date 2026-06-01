import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BookOpen } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { GroupInfo } from '../../stores/groups';
import { api } from '../../api/client';
import { useAgentLinksStore } from '../../stores/agentLinks';
import type {
  BackendInfo,
  SystemSettings,
} from '../settings/types';
import { getErrorMessage } from '../settings/types';

interface GroupDetailProps {
  group: GroupInfo & { jid: string };
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

  // Execution Device selection (<device_id>)
  const { links: agentLinks, load: loadAgentLinks } = useAgentLinksStore();
  const [currentExecNode, setCurrentExecNode] = useState<string>(
    group.execution_node && group.execution_node.startsWith('cl_') ? group.execution_node : '',
  );
  const [savingExecNode, setSavingExecNode] = useState(false);

  useEffect(() => {
    setCurrentExecNode(group.execution_node && group.execution_node.startsWith('cl_') ? group.execution_node : '');
  }, [group.execution_node, group.jid]);

  useEffect(() => {
    if (!canEditBackend) return;
    loadAgentLinks();
  }, [canEditBackend, loadAgentLinks]);

  const handleExecNodeChange = async (next: string) => {
    if (next === currentExecNode) return;
    setSavingExecNode(true);
    try {
      await api.patch(`/api/groups/${encodeURIComponent(group.jid)}`, {
        execution_node: next,
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

      {/* Execution Device */}
      {canEditBackend && (
        <div>
          <div className="text-xs text-muted-foreground mb-1">执行 Device</div>
          <select
            value={currentExecNode}
            disabled={savingExecNode}
            onChange={(e) => handleExecNodeChange(e.target.value)}
            className="h-9 px-3 text-sm border border-border rounded-md bg-transparent w-full max-w-xs"
          >
            <option value="" disabled>未选择 Device</option>
            {agentLinks.map((device) => (
              <option key={device.id} value={device.id} disabled={!device.online}>
                {device.online ? '🟢' : '⚪️'} {device.displayName} ({device.id})
                {device.online ? '' : ' · 离线'}
              </option>
            ))}
          </select>
          <div className="text-xs text-muted-foreground mt-1">
            {currentExecNode ? `转发到 Device ${currentExecNode}` : '尚未绑定执行 Device'}
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
