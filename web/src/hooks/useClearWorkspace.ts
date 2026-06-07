import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useChatStore } from '../stores/chat';
import { useAgentLinksStore } from '../stores/agentLinks';
import { useCustomBackendsStore } from '../stores/customBackends';

type ResetRuntimeProfile = 'server-agent' | 'server-agent-device-tools' | 'device-cli-agent';

function deviceIdFromExecutionTarget(target?: string): string {
  if (!target) return '';
  if (/^cl_[0-9a-f]{16}$/.test(target)) return target;
  const runtimeMatch = target.match(/^runtime:(cl_[0-9a-f]{16}):[^:]+$/);
  if (runtimeMatch) return runtimeMatch[1];
  const legacyRuntimeMatch = target.match(/^(cl_[0-9a-f]{16}):[^:]+$/);
  if (legacyRuntimeMatch) return legacyRuntimeMatch[1];
  return '';
}

export function useClearWorkspace() {
  const clearHistory = useChatStore((s) => s.clearHistory);
  const updateGroupConfig = useChatStore((s) => s.updateGroupConfig);
  const { links: devices, load: loadAgentLinks } = useAgentLinksStore();
  const { backends, load: loadCustomBackends } = useCustomBackendsStore();
  const [clearState, setClearState] = useState({ open: false, jid: '', name: '' });
  const [clearLoading, setClearLoading] = useState(false);
  const [resetRuntimeProfile, setResetRuntimeProfile] = useState<ResetRuntimeProfile>('server-agent');
  const [resetExecutionNode, setResetExecutionNode] = useState('');
  const [resetAgentBackendId, setResetAgentBackendId] = useState('');

  const openClear = (jid: string, name: string) => {
    setClearState({ open: true, jid, name });
    setResetRuntimeProfile('server-agent');
    setResetExecutionNode('');
    setResetAgentBackendId('');
  };
  const closeClear = () => {
    setClearState({ open: false, jid: '', name: '' });
    setResetRuntimeProfile('server-agent');
    setResetExecutionNode('');
    setResetAgentBackendId('');
  };

  const currentGroup = useChatStore((s) => (clearState.jid ? s.groups[clearState.jid] : undefined));
  useEffect(() => {
    if (!clearState.open || currentGroup?.editable !== true) return;
    void loadAgentLinks();
    void loadCustomBackends();
  }, [clearState.open, currentGroup?.editable, loadAgentLinks, loadCustomBackends]);

  useEffect(() => {
    if (!clearState.open || !currentGroup) return;
    const profile = currentGroup.runtime_profile ?? 'server-agent';
    setResetRuntimeProfile(profile);
    const deviceId = deviceIdFromExecutionTarget(currentGroup.device_link_id ?? currentGroup.execution_node);
    setResetExecutionNode(profile === 'server-agent' ? '' : deviceId);
    setResetAgentBackendId(profile === 'device-cli-agent' ? currentGroup.backend ?? '' : '');
  }, [clearState.open, currentGroup?.folder]);

  const selectableAgentBackends = useMemo(() => {
    return backends
      .filter((backend) => backend.runtime === 'local-device' || backend.deviceLinkId)
      .filter((backend) => !resetExecutionNode || backend.deviceLinkId === resetExecutionNode)
      .filter((backend) => backend.deviceLinkId && backend.agentClientId)
      .sort((a, b) => (a.displayName || a.id).localeCompare(b.displayName || b.id));
  }, [backends, resetExecutionNode]);

  const selectedResetAgent = selectableAgentBackends.find((backend) => backend.id === resetAgentBackendId);
  const canSelectResetAgent = clearState.open && currentGroup?.editable === true;

  useEffect(() => {
    if (resetRuntimeProfile !== 'device-cli-agent') return;
    if (!resetExecutionNode || selectableAgentBackends.length === 0) {
      setResetAgentBackendId('');
      return;
    }
    if (!selectableAgentBackends.some((backend) => backend.id === resetAgentBackendId)) {
      setResetAgentBackendId(selectableAgentBackends[0].id);
    }
  }, [resetRuntimeProfile, resetExecutionNode, selectableAgentBackends, resetAgentBackendId]);

  const handleClearConfirm = async () => {
    setClearLoading(true);
    try {
      if (canSelectResetAgent) {
        if (resetRuntimeProfile !== 'server-agent' && !resetExecutionNode) {
          toast.error('请选择执行 Device');
          return;
        }
        if (resetRuntimeProfile === 'device-cli-agent' && !selectedResetAgent) {
          toast.error('请选择该 Device 上已定义的 Agent');
          return;
        }
        const patch: Parameters<typeof updateGroupConfig>[1] = {
          runtime_profile: resetRuntimeProfile,
          backend: resetRuntimeProfile === 'device-cli-agent' ? selectedResetAgent?.id : 'claude-sdk',
        };
        if (!currentGroup?.is_home) {
          patch.execution_mode = 'host';
        }
        if (resetRuntimeProfile !== 'server-agent') {
          patch.device_link_id = resetExecutionNode;
          patch.execution_node = resetExecutionNode;
        }
        if (resetRuntimeProfile === 'device-cli-agent') {
          patch.agent_client_id = selectedResetAgent?.agentClientId;
        } else {
          patch.agent_client_id = null;
        }
        if (resetRuntimeProfile === 'server-agent') {
          patch.device_link_id = null;
          patch.execution_node = null;
        }
        const ok = await updateGroupConfig(clearState.jid, patch);
        if (!ok) {
          toast.error('切换 Agent 失败，请稍后重试');
          return;
        }
      }
      const ok = await clearHistory(clearState.jid);
      if (!ok) toast.error('重建工作区失败，请稍后重试');
      closeClear();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '重建工作区失败，请稍后重试');
      closeClear();
    } finally {
      setClearLoading(false);
    }
  };

  return {
    clearState,
    clearLoading,
    openClear,
    closeClear,
    handleClearConfirm,
    canSelectResetAgent,
    devices,
    selectableAgentBackends,
    resetRuntimeProfile,
    setResetRuntimeProfile,
    resetExecutionNode,
    setResetExecutionNode,
    resetAgentBackendId,
    setResetAgentBackendId,
  };
}
