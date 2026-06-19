import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { UnifiedSidebar } from './UnifiedSidebar';
import { BottomTabBar } from './BottomTabBar';
import { ConnectionBanner } from '../common/ConnectionBanner';
import { wsManager } from '../../api/ws';
import { useTheme } from '../../hooks/useTheme';
import { useRouteRestore } from '../../hooks/useRouteRestore';
import { useBillingStore } from '../../stores/billing';
import { useGroupsStore } from '../../stores/groups';
import { useChatStore } from '../../stores/chat';
import { useAuthStore } from '../../stores/auth';
import { useAgentLinksStore } from '../../stores/agentLinks';
import { useIssuesStore } from '../../stores/issues';
import { useNotificationsStore } from '../../stores/notifications';
import { useReposStore } from '../../stores/repos';
import { useAutopilotsStore } from '../../stores/autopilots';
import { useCustomBackendsStore } from '../../stores/customBackends';
import { useAgentTeamsStore } from '../../stores/agentTeams';
import { NotificationInbox } from './NotificationInbox';

export function AppLayout() {
  const location = useLocation();
  const isChatRoute = location.pathname.startsWith('/chat');
  const hideMobileTabBar = /^\/chat\/.+/.test(location.pathname);
  useTheme(); // 应用并同步持久化的主题偏好
  useRouteRestore(); // PWA 重启时恢复上次访问的路由（默认关闭，设置中启用）

  // Sidebar: expanded only on chat route, collapsed on other routes
  const [userCollapsed, setUserCollapsed] = useState(false);
  const sidebarCollapsed = isChatRoute ? userCollapsed : true;

  // Keyboard shortcut: Cmd+B (Mac) / Ctrl+B (Windows) to toggle sidebar
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
        e.preventDefault();
        if (isChatRoute) setUserCollapsed((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isChatRoute]);

  // 应用级别建立 WebSocket 连接，确保所有页面（非仅 ChatView）都有连接
  useEffect(() => {
    wsManager.connect();
    useNotificationsStore.getState().loadApprovalRequests();
  }, []);

  // 加载计费状态（控制导航栏是否显示账单入口）
  const loadBillingStatus = useBillingStore((s) => s.loadBillingStatus);
  useEffect(() => {
    loadBillingStatus();
  }, [loadBillingStatus]);

  // 更新 document.title，显示未读回复数
  const totalUnread = useChatStore((s) => Object.values(s.unreadReplies).reduce((sum, n) => sum + n, 0));
  const appearance = useAuthStore((s) => s.appearance);
  useEffect(() => {
    const appName = appearance?.appName || 'OctoDeck';
    document.title = totalUnread > 0 ? `(${totalUnread}) ${appName}` : appName;
  }, [totalUnread, appearance?.appName]);

  // 统一 OctoDeckEvent 入口：approval 进通知中心，runtime/device/task/issue 按 domain 刷新对应 store。
  useEffect(() => {
    const unsubApproval = wsManager.on('octodeck_event:approval', (data: any) => {
      if (data.event) useNotificationsStore.getState().recordEvent(data.event);
      useNotificationsStore.getState().loadApprovalRequests();
    });
    const unsubRuntime = wsManager.on('octodeck_event:runtime', (data: any) => {
      const event = data.event;
      if (event?.type?.startsWith('runtime.runner.') && event.chatJid) {
        const state = event.action === 'running' ? 'running' : 'idle';
        useGroupsStore.getState().setRunnerState(event.chatJid, state);
        useChatStore.getState().handleRunnerState(event.chatJid, state);
      }
    });
    const unsubDevice = wsManager.on('octodeck_event:device', () => {
      useAgentLinksStore.getState().load();
      useAgentLinksStore.getState().loadRuntimePool();
      useCustomBackendsStore.getState().load();
    });
    const unsubTask = wsManager.on('octodeck_event:agent_task', (data: any) => {
      const event = data.event;
      if (event.type?.startsWith('agent_task.agent_team_generation.') && event.payload?.job) {
        useAgentTeamsStore.getState().upsertGenerationJob(event.payload.job);
        if (event.action === 'success') {
          useAgentTeamsStore.getState().load();
          useAgentTeamsStore.getState().loadAgentMdDefinitions();
        }
      }
      if (event?.type?.startsWith('agent_task.agent_status.') && event.chatJid && event.payload?.agentId) {
        useChatStore.getState().handleAgentStatus(
          event.chatJid,
          event.payload.agentId,
          event.payload.status,
          event.payload.name,
          event.payload.prompt,
          event.payload.resultSummary,
          event.payload.kind,
          event.payload.titleGenerating,
        );
      }
      import('../../stores/tasks').then((m) => m.useTasksStore.getState().loadTasks());
    });
    const unsubIssue = wsManager.on('octodeck_event:issue', (data: any) => {
      const event = data.event;
      if (!event?.issueId) return;
      useIssuesStore.getState().loadIssueById(event.issueId);
      useIssuesStore.getState().loadIssueEvents(event.issueId);
      if (event.runId) {
        useIssuesStore.getState().loadIssueRuns(event.issueId);
        useIssuesStore.getState().loadIssueRunEvents(event.issueId, event.runId);
      }
    });
    const unsubRepoKnowledge = wsManager.on('octodeck_event:repo_knowledge', (data: any) => {
      const event = data.event;
      useReposStore.getState().load();
      if (event?.runId) useReposStore.getState().loadKnowledgeRun(event.runId);
    });
    const unsubAutopilot = wsManager.on('octodeck_event:autopilot', (data: any) => {
      const event = data.event;
      const autopilotId = typeof event?.payload?.autopilotId === 'string'
        ? event.payload.autopilotId
        : event?.correlationId;
      useAutopilotsStore.getState().loadAutopilots();
      if (autopilotId) useAutopilotsStore.getState().loadRuns(autopilotId);
    });
    const unsubBilling = wsManager.on('octodeck_event:billing', (data: any) => {
      const event = data.event;
      if (event?.type === 'billing.usage.updated' && event.payload) {
        useBillingStore.getState().handleBillingUpdate(event.payload);
      }
    });
    const unsubChat = wsManager.on('octodeck_event:chat', (data: any) => {
      const event = data.event;
      if (event.type === 'chat.message.created' && event.chatJid && event.payload?.message) {
        useChatStore.getState().handleWsNewMessage(
          event.chatJid,
          event.payload.message,
          event.payload.agentId,
          event.payload.source,
        );
      }
      if (event.type === 'chat.group.created') {
        useGroupsStore.getState().loadGroups();
        import('../../stores/tasks').then((m) => m.useTasksStore.getState().loadTasks());
      }
    });
    const unsubMemory = wsManager.on('octodeck_event:memory', () => {
      // MemoryPage keeps local state; standard memory events still refresh workspace metadata
      // that labels memory sources by group/device ownership.
      useGroupsStore.getState().loadGroups();
      useAgentLinksStore.getState().load();
    });
    return () => {
      unsubApproval();
      unsubRuntime();
      unsubDevice();
      unsubTask();
      unsubIssue();
      unsubRepoKnowledge();
      unsubAutopilot();
      unsubBilling();
      unsubChat();
      unsubMemory();
    };
  }, []);

  return (
    <div className="h-screen supports-[height:100dvh]:h-dvh flex flex-col lg:flex-row overflow-hidden safe-area-top">
      <div className="hidden lg:block h-full flex-shrink-0">
        <UnifiedSidebar
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setUserCollapsed((prev) => !prev)}
        />
      </div>

      <div className="flex-1 min-h-0 flex flex-col overflow-hidden relative">
        <ConnectionBanner />
        <NotificationInbox />
        <main
          data-app-scroll-root="true"
          className={`flex-1 min-h-0 lg:overflow-auto lg:pb-0 ${
            isChatRoute
              ? 'overflow-hidden'
              : `overflow-y-auto overflow-x-hidden overscroll-y-none ${hideMobileTabBar ? 'pb-6' : 'pb-nav-safe'}`
          }`}
        >
          <Outlet />
        </main>
      </div>

      {!hideMobileTabBar && <BottomTabBar />}
    </div>
  );
}
