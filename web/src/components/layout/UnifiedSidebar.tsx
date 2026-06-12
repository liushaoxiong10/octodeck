import { useState, useMemo, useEffect } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { Plus, PanelLeftClose, Bug, LogOut, UserCog, Cloud, Monitor, Cpu, AlertTriangle } from 'lucide-react';
import { useChatStore } from '../../stores/chat';
import { useAuthStore } from '../../stores/auth';
import { useBillingStore } from '../../stores/billing';
import { useGroupsStore } from '../../stores/groups';
import { useReposStore } from '../../stores/repos';
import { useClearWorkspace } from '../../hooks/useClearWorkspace';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/common';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EmojiAvatar } from '../common/EmojiAvatar';
import { BugReportDialog } from '../common/BugReportDialog';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ChatGroupItem } from '../chat/ChatGroupItem';
import { CreateContainerDialog } from '../chat/CreateContainerDialog';
import { RenameDialog } from '../chat/RenameDialog';
import { SkeletonCardList } from '@/components/common/Skeletons';
import { cn } from '@/lib/utils';
import { filterNavItems } from './nav-items';
import { type GroupEntry, type DateSection, groupByDate, compareByLastActivity } from '../../utils/group-utils';

interface UnifiedSidebarProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
}

export function UnifiedSidebar({ collapsed, onToggleCollapse }: UnifiedSidebarProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const isChatRoute = location.pathname.startsWith('/chat');
  const showWorkspaceList = isChatRoute && !collapsed;

  const user = useAuthStore((s) => s.user);
  const appearance = useAuthStore((s) => s.appearance);
  const billingEnabled = useBillingStore((s) => s.billingEnabled);
  const [showBugReport, setShowBugReport] = useState(false);
  const userInitial = (user?.display_name || user?.username || '?')[0].toUpperCase();

  const navItems = useMemo(
    () => filterNavItems(billingEnabled),
    [billingEnabled],
  );

  const [createOpen, setCreateOpen] = useState(false);
  const [renameState, setRenameState] = useState({ open: false, jid: '', name: '' });
  const [deleteState, setDeleteState] = useState({ open: false, jid: '', name: '' });
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [repoVisibilityState, setRepoVisibilityState] = useState<{
    open: boolean;
    jid: string;
    name: string;
    mode: 'all' | 'selected';
    ids: string[];
  }>({ open: false, jid: '', name: '', mode: 'all', ids: [] });
  const [repoVisibilitySaving, setRepoVisibilitySaving] = useState(false);
  const {
    clearState,
    clearLoading,
    openClear,
    closeClear,
    handleClearConfirm,
    canSelectResetAgent,
    devices: resetDevices,
    selectableAgentBackends: resetAgentOptions,
    resetRuntimeProfile,
    setResetRuntimeProfile,
    resetExecutionNode,
    setResetExecutionNode,
    resetAgentBackendId,
    setResetAgentBackendId,
    resetAgentAccessScope,
    setResetAgentAccessScope,
    resetPermissionMode,
    setResetPermissionMode,
  } = useClearWorkspace();

  const {
    groups, currentGroup, selectGroup, loadGroups, loading,
    deleteFlow, togglePin, updateGroupConfig,
  } = useChatStore();
  const runnerStates = useGroupsStore((s) => s.runnerStates);
  const repos = useReposStore((s) => s.repos);
  const reposLoading = useReposStore((s) => s.loading);
  const loadRepos = useReposStore((s) => s.load);

  useEffect(() => {
    if (isChatRoute) loadGroups();
  }, [isChatRoute, loadGroups]);

  useEffect(() => {
    if (repoVisibilityState.open) void loadRepos();
  }, [repoVisibilityState.open, loadRepos]);

  const { mainGroup, otherGroups } = useMemo(() => {
    let main: GroupEntry | null = null;
    const others: GroupEntry[] = [];
    for (const [jid, info] of Object.entries(groups)) {
      const entry = { jid, ...info };
      if (info.is_my_home) main = entry;
      else others.push(entry);
    }
    others.sort(compareByLastActivity);
    return { mainGroup: main, otherGroups: others };
  }, [groups]);

  const { pinnedGroups, mySections, collabSections } = useMemo(() => {
    const pinned: GroupEntry[] = [];
    const my: GroupEntry[] = [];
    const collab: GroupEntry[] = [];
    otherGroups.forEach((g) => {
      if (g.pinned_at) pinned.push(g);
      else if (g.is_shared && (g.member_count ?? 0) >= 2) collab.push(g);
      else my.push(g);
    });
    pinned.sort((a, b) => (a.pinned_at || '').localeCompare(b.pinned_at || ''));
    return { pinnedGroups: pinned, mySections: groupByDate(my), collabSections: groupByDate(collab) };
  }, [otherGroups]);

  const handleGroupSelect = (jid: string, folder: string) => { selectGroup(jid); navigate(`/chat/${folder}`); };
  const handleCreated = (jid: string, folder: string) => { selectGroup(jid); navigate(`/chat/${folder}`); };

  const openRepoVisibility = (jid: string, name: string) => {
    const group = groups[jid];
    setRepoVisibilityState({
      open: true,
      jid,
      name,
      mode: group?.visible_repo_mode ?? 'all',
      ids: group?.visible_repo_ids ?? [],
    });
  };

  const closeRepoVisibility = () => {
    if (repoVisibilitySaving) return;
    setRepoVisibilityState({ open: false, jid: '', name: '', mode: 'all', ids: [] });
  };

  const toggleVisibleRepo = (repoId: string) => {
    setRepoVisibilityState((state) => ({
      ...state,
      ids: state.ids.includes(repoId)
        ? state.ids.filter((id) => id !== repoId)
        : [...state.ids, repoId],
    }));
  };

  const handleRepoVisibilitySave = async () => {
    const { jid, mode, ids } = repoVisibilityState;
    if (!jid) return;
    setRepoVisibilitySaving(true);
    try {
      const ok = await updateGroupConfig(jid, {
        visible_repo_mode: mode,
        visible_repo_ids: mode === 'selected' ? ids : [],
      });
      if (ok) {
        setRepoVisibilityState({ open: false, jid: '', name: '', mode: 'all', ids: [] });
      }
    } finally {
      setRepoVisibilitySaving(false);
    }
  };

  const handleDeleteConfirm = async () => {
    setDeleteLoading(true);
    try {
      await deleteFlow(deleteState.jid);
      setDeleteState({ open: false, jid: '', name: '' });
      const nextJid = useChatStore.getState().currentGroup;
      const nextFolder = nextJid ? useChatStore.getState().groups[nextJid]?.folder : null;
      navigate(nextFolder ? `/chat/${nextFolder}` : '/chat');
    } catch (err: unknown) {
      const typed = err as {
        boundAgents?: Array<{ agentName: string; imGroups: Array<{ name: string }> }>;
        boundMainImGroups?: Array<{ name: string }>;
      };
      if (typed.boundAgents?.length || typed.boundMainImGroups?.length) {
        const details = [
          ...(typed.boundAgents ?? []).map((a) => `「${a.agentName}」→ ${a.imGroups.map((g) => g.name).join('、')}`),
          ...(typed.boundMainImGroups?.length
            ? [`主对话 → ${typed.boundMainImGroups.map((g) => g.name).join('、')}`]
            : []),
        ].join('\n');
        alert(`该工作区绑定了 IM 渠道，请先解绑后再删除：\n${details}`);
      } else {
        alert(`删除工作区失败：${err instanceof Error ? err.message : '未知错误'}`);
      }
      setDeleteState({ open: false, jid: '', name: '' });
    } finally { setDeleteLoading(false); }
  };

  const renderSections = (sections: DateSection[], showCollabBadge: boolean) =>
    sections.map((section) => (
      <div key={section.label} className="mb-1">
        <div className="px-2 pt-2 pb-1">
          <span className="text-[10px] text-muted-foreground/70 tracking-wide">{section.label}</span>
        </div>
        {section.items.map((g) => (
          <ChatGroupItem
            key={g.jid} jid={g.jid} name={g.name} folder={g.folder}
            lastMessage={g.lastMessage}            isShared={showCollabBadge ? g.is_shared : undefined}
            memberRole={showCollabBadge ? g.member_role : undefined}
            memberCount={showCollabBadge ? g.member_count : undefined}
            isActive={currentGroup === g.jid} isHome={false}
            isRunning={runnerStates[g.jid] === 'running'}
            editable={g.editable} deletable={g.deletable}
            onSelect={handleGroupSelect}
            onRename={(jid, name) => setRenameState({ open: true, jid, name })}
            onClearHistory={openClear}
            onDelete={(jid, name) => setDeleteState({ open: true, jid, name })}
            onTogglePin={(jid) => togglePin(jid)}
            onConfigureRepoVisibility={openRepoVisibility}
          />
        ))}
      </div>
    ));

  const panelWidth = showWorkspaceList ? '16.5rem' : '0';

  return (
    <TooltipProvider delayDuration={200}>
    <div className="h-full flex flex-shrink-0">
      <nav className="w-[4.5rem] h-full bg-muted/30 flex flex-col items-center py-3 gap-1 flex-shrink-0">
        <div className="w-11 h-11 rounded-xl overflow-hidden mb-3 flex-shrink-0">
          <img src={`${import.meta.env.BASE_URL}icons/icon-192.png`} alt="OctoDeck" className="w-full h-full object-cover" />
        </div>

        {navItems.map(({ path, icon: Icon, label }) => {
          const isChatItem = path === '/chat';
          const isActive = location.pathname.startsWith(path);
          const baseClass = 'w-12 h-12 rounded-xl flex flex-col items-center justify-center gap-0.5 transition-colors';
          const activeClass = isActive ? 'bg-brand-50 text-primary' : 'text-muted-foreground hover:bg-accent';

          return (
            <Tooltip key={path}>
              <TooltipTrigger asChild>
                {isChatItem && isChatRoute ? (
                  <button onClick={onToggleCollapse} className={cn(baseClass, activeClass)}>
                    <Icon className="w-[20px] h-[20px]" strokeWidth={isActive ? 2 : 1.75} />
                    <span className="text-[10px] leading-tight">{label}</span>
                  </button>
                ) : (
                  <NavLink to={path} className={cn(baseClass, activeClass)}>
                    <Icon className="w-[20px] h-[20px]" strokeWidth={isActive ? 2 : 1.75} />
                    <span className="text-[10px] leading-tight">{label}</span>
                  </NavLink>
                )}
              </TooltipTrigger>
              <TooltipContent side="right">{isChatItem && isChatRoute ? (collapsed ? '展开工作区' : '收起工作区') : label}</TooltipContent>
            </Tooltip>
          );
        })}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Bug report */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button onClick={() => setShowBugReport(true)} className="w-10 h-10 rounded-lg flex items-center justify-center text-muted-foreground hover:text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-950/30 transition-colors">
              <Bug className="w-4 h-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">报告问题</TooltipContent>
        </Tooltip>

        {/* User avatar popover */}
        <Popover>
          <PopoverTrigger asChild>
            <button className="rounded-full hover:ring-2 hover:ring-brand-200 transition-all cursor-pointer mb-2">
              <EmojiAvatar emoji={user?.avatar_emoji} color={user?.avatar_color} fallbackChar={userInitial} size="md" className="w-8 h-8" />
            </button>
          </PopoverTrigger>
          <PopoverContent side="right" align="end" className="w-44 p-1">
            <div className="px-3 py-2 text-xs font-medium text-muted-foreground truncate border-b border-border mb-1">{user?.display_name || user?.username}</div>
            <button onClick={() => navigate('/settings?tab=profile')} className="w-full flex items-center gap-2 px-3 py-2 text-sm rounded-md hover:bg-accent text-foreground cursor-pointer">
              <UserCog className="w-4 h-4" /> 个人设置
            </button>
            <button onClick={async () => { await useAuthStore.getState().logout(); navigate('/login'); }} className="w-full flex items-center gap-2 px-3 py-2 text-sm rounded-md hover:bg-destructive/10 text-destructive cursor-pointer">
              <LogOut className="w-4 h-4" /> 退出登录
            </button>
          </PopoverContent>
        </Popover>
      </nav>

      <div
        className="h-full overflow-hidden transition-[width] duration-200 ease-linear"
        style={{ width: panelWidth }}
      >
        <div className="w-[16.5rem] h-full flex flex-col bg-muted/30">
          <div className="flex items-center gap-2 px-4 pt-6 pb-3 mb-3 flex-shrink-0">
            <img src={`${import.meta.env.BASE_URL}icons/logo-text.svg`} alt={appearance?.appName || 'OctoDeck'} className="h-10" />
            <div className="flex-1" />
            <button onClick={onToggleCollapse} className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-accent text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
              <PanelLeftClose className="w-4 h-4" />
            </button>
          </div>
          {/* New workspace button */}
          <div className="px-3 pb-2 flex-shrink-0">
            <Button
              variant="outline"
              size="sm"
              className="w-full justify-start gap-2 text-xs"
              onClick={() => setCreateOpen(true)}
            >
              <Plus className="w-3.5 h-3.5" />
              新工作区
            </Button>
          </div>

              {/* Workspace list */}
              <div className="flex-1 overflow-y-auto px-1.5">
                {loading && !mainGroup && otherGroups.length === 0 ? (
                  <SkeletonCardList count={6} compact />
                ) : (
                  <>
                    {mainGroup && (
                      <div className="mb-1">
                        <div className="px-2 pt-1 pb-1">
                          <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">主工作区</span>
                        </div>
                        <ChatGroupItem
                          jid={mainGroup.jid} name={mainGroup.name} folder={mainGroup.folder}
                          lastMessage={mainGroup.lastMessage}                          isActive={currentGroup === mainGroup.jid} isHome
                          isRunning={runnerStates[mainGroup.jid] === 'running'} editable
                          onSelect={handleGroupSelect}
                          onRename={(jid, name) => setRenameState({ open: true, jid, name })}
                          onClearHistory={openClear}
                          onConfigureRepoVisibility={openRepoVisibility}
                        />
                      </div>
                    )}

                    {pinnedGroups.length > 0 && (
                      <div className="mb-1">
                        <div className="mt-1" />
                        <div className="px-2 pt-2 pb-1">
                          <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">已固定</span>
                        </div>
                        {pinnedGroups.map((g) => (
                          <ChatGroupItem
                            key={g.jid} jid={g.jid} name={g.name} folder={g.folder}
                            lastMessage={g.lastMessage}                            isShared={g.is_shared} memberRole={g.member_role} memberCount={g.member_count}
                            isActive={currentGroup === g.jid} isHome={false} isPinned
                            isRunning={runnerStates[g.jid] === 'running'}
                            editable={g.editable} deletable={g.deletable}
                            onSelect={handleGroupSelect}
                            onRename={(jid, name) => setRenameState({ open: true, jid, name })}
                            onClearHistory={openClear}
                            onDelete={(jid, name) => setDeleteState({ open: true, jid, name })}
                            onTogglePin={(jid) => togglePin(jid)}
                            onConfigureRepoVisibility={openRepoVisibility}
                          />
                        ))}
                      </div>
                    )}

                    {mySections.length === 0 && collabSections.length === 0 && pinnedGroups.length === 0 && !mainGroup ? (
                      <div className="flex flex-col items-center justify-center h-32 px-4">
                        <p className="text-xs text-muted-foreground text-center">暂无工作区</p>
                      </div>
                    ) : (
                      <>
                        {mySections.length > 0 && (
                          <div>
                            <div className="mt-1" />
                            <div className="px-2 pt-2 pb-1">
                              <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">我的工作区</span>
                            </div>
                            {renderSections(mySections, false)}
                          </div>
                        )}
                        {collabSections.length > 0 && (
                          <div>
                            <div className="mt-1" />
                            <div className="px-2 pt-2 pb-1">
                              <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">协作工作区</span>
                            </div>
                            {renderSections(collabSections, true)}
                          </div>
                        )}
                      </>
                    )}
                  </>
                )}
          </div>
        </div>
      </div>
    </div>

        <BugReportDialog open={showBugReport} onClose={() => setShowBugReport(false)} />
        <CreateContainerDialog open={createOpen} onClose={() => setCreateOpen(false)} onCreated={handleCreated} />
        <RenameDialog open={renameState.open} jid={renameState.jid} currentName={renameState.name} onClose={() => setRenameState({ open: false, jid: '', name: '' })} />
        <Dialog open={repoVisibilityState.open} onOpenChange={(open) => !open && closeRepoVisibility()}>
          <DialogContent className="sm:max-w-xl">
            <DialogHeader>
              <DialogTitle>可见 Repo 配置</DialogTitle>
              <DialogDescription>
                配置「{repoVisibilityState.name}」中新 Device 会话可见的 Repo。修改后对新增会话生效；全部可见会在会话有新消息时自动带上新增 Repo。
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="grid gap-2">
                <label className="flex items-start gap-3 rounded-lg border p-3 cursor-pointer hover:bg-accent/50 transition-colors">
                  <input
                    type="radio"
                    name="repo_visibility_mode"
                    checked={repoVisibilityState.mode === 'all'}
                    onChange={() => setRepoVisibilityState((s) => ({ ...s, mode: 'all' }))}
                    disabled={repoVisibilitySaving}
                    className="mt-1 accent-primary"
                  />
                  <div>
                    <div className="text-sm font-medium">全部可见</div>
                    <p className="text-xs text-muted-foreground mt-0.5">该账号下所有托管 Repo 都会挂载到新会话，新添加的 Repo 会在下一次新消息触发时生效。</p>
                  </div>
                </label>
                <label className="flex items-start gap-3 rounded-lg border p-3 cursor-pointer hover:bg-accent/50 transition-colors">
                  <input
                    type="radio"
                    name="repo_visibility_mode"
                    checked={repoVisibilityState.mode === 'selected'}
                    onChange={() => setRepoVisibilityState((s) => ({ ...s, mode: 'selected' }))}
                    disabled={repoVisibilitySaving}
                    className="mt-1 accent-primary"
                  />
                  <div>
                    <div className="text-sm font-medium">指定可见</div>
                    <p className="text-xs text-muted-foreground mt-0.5">仅挂载下方选中的 Repo。</p>
                  </div>
                </label>
              </div>
              {repoVisibilityState.mode === 'selected' ? (
                <div className="rounded-lg border">
                  <div className="flex items-center justify-between border-b px-3 py-2">
                    <span className="text-xs font-medium text-muted-foreground">Repo 列表</span>
                    <span className="text-xs text-muted-foreground">已选 {repoVisibilityState.ids.length}</span>
                  </div>
                  <div className="max-h-64 overflow-y-auto p-2 space-y-1">
                    {reposLoading ? (
                      <div className="px-2 py-6 text-center text-xs text-muted-foreground">加载中…</div>
                    ) : repos.length === 0 ? (
                      <div className="px-2 py-6 text-center text-xs text-muted-foreground">暂无 Repo，请先在 Repos 页面添加。</div>
                    ) : (
                      repos.map((repo) => (
                        <label key={repo.id} className="flex items-start gap-3 rounded-md px-2 py-2 hover:bg-accent/50 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={repoVisibilityState.ids.includes(repo.id)}
                            onChange={() => toggleVisibleRepo(repo.id)}
                            disabled={repoVisibilitySaving}
                            className="mt-1 accent-primary"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="text-sm font-medium truncate">{repo.name}</div>
                            <div className="text-xs text-muted-foreground truncate">
                              {repo.kind === 'git' ? repo.git_url : repo.device_path}
                            </div>
                          </div>
                          <span className="text-[10px] rounded bg-muted px-1.5 py-0.5 text-muted-foreground flex-shrink-0">
                            {repo.kind === 'git' ? 'Git' : 'Device'}
                          </span>
                        </label>
                      ))
                    )}
                  </div>
                </div>
              ) : null}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={closeRepoVisibility} disabled={repoVisibilitySaving}>取消</Button>
              <Button onClick={handleRepoVisibilitySave} disabled={repoVisibilitySaving}>保存</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <ConfirmDialog open={clearState.open} onClose={closeClear} onConfirm={handleClearConfirm} title="重建工作区" message={`确认重建「${clearState.name}」？会清除全部聊天记录、上下文、所有子对话及其消息，并删除工作目录文件。持久化目录 (data/extra/) 与定时任务本身保留。不可撤销。`} confirmText="确认重建" confirmVariant="danger" loading={clearLoading}>
          {canSelectResetAgent ? (
            <div className="space-y-3">
              <div>
                <div className="text-xs font-medium text-muted-foreground mb-2">重建后使用的 Agent 配置</div>
                <div className="space-y-2">
                  <label className="flex items-start gap-3 p-2 rounded-lg border cursor-pointer hover:bg-accent/50 transition-colors">
                    <input type="radio" name="reset_runtime_profile" checked={resetRuntimeProfile === 'server-agent'} onChange={() => { setResetRuntimeProfile('server-agent'); setResetExecutionNode(''); setResetAgentBackendId(''); }} disabled={clearLoading} className="mt-0.5 accent-primary" />
                    <div>
                      <div className="flex items-center gap-1.5"><Cloud className="w-4 h-4 text-muted-foreground" /><span className="text-sm font-medium">服务端 Agent</span><span className="text-xs text-primary font-medium">云端 SDK</span></div>
                      <p className="text-xs text-muted-foreground mt-0.5">仅使用云端 Claude SDK 推理和云端 MCP/Skill。</p>
                    </div>
                  </label>
                  <label className="flex items-start gap-3 p-2 rounded-lg border cursor-pointer hover:bg-accent/50 transition-colors">
                    <input type="radio" name="reset_runtime_profile" checked={resetRuntimeProfile === 'server-agent-device-tools'} onChange={() => { setResetRuntimeProfile('server-agent-device-tools'); setResetAgentBackendId(''); }} disabled={clearLoading} className="mt-0.5 accent-primary" />
                    <div>
                      <div className="flex items-center gap-1.5"><Monitor className="w-4 h-4 text-muted-foreground" /><span className="text-sm font-medium">服务端 Agent + Device 执行</span></div>
                      <p className="text-xs text-muted-foreground mt-0.5">Agent 在服务端运行，命令和文件工具转发到选中的 Device。</p>
                    </div>
                  </label>
                  <label className="flex items-start gap-3 p-2 rounded-lg border cursor-pointer hover:bg-accent/50 transition-colors">
                    <input type="radio" name="reset_runtime_profile" checked={resetRuntimeProfile === 'device-cli-agent'} onChange={() => setResetRuntimeProfile('device-cli-agent')} disabled={clearLoading} className="mt-0.5 accent-primary" />
                    <div>
                      <div className="flex items-center gap-1.5"><Cpu className="w-4 h-4 text-muted-foreground" /><span className="text-sm font-medium">Device CLI Agent</span></div>
                      <p className="text-xs text-muted-foreground mt-0.5">Agent CLI 直接在选中的 Device 上运行并使用本地工具链。</p>
                    </div>
                  </label>
                </div>
              </div>
              {resetRuntimeProfile !== 'server-agent' ? (
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">执行 Device</label>
                  <select value={resetExecutionNode} onChange={(e) => { setResetExecutionNode(e.target.value); setResetAgentBackendId(''); }} disabled={clearLoading} className="h-9 w-full px-3 text-sm border border-border rounded-md bg-background">
                    <option value="" disabled>请选择 Device</option>
                    {resetDevices.map((device) => (
                      <option key={device.id} value={device.id} disabled={!device.online}>{device.online ? '🟢' : '⚪️'} {device.displayName} ({device.id}) · running {device.runningRuns?.length ?? 0}{device.online ? '' : ' · 离线'}</option>
                    ))}
                  </select>
                </div>
              ) : null}
              {resetRuntimeProfile === 'device-cli-agent' && resetExecutionNode ? (
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">Device Agent</label>
                  <select value={resetAgentBackendId} onChange={(e) => setResetAgentBackendId(e.target.value)} disabled={clearLoading || resetAgentOptions.length === 0} className="h-9 w-full px-3 text-sm border border-border rounded-md bg-background">
                    {resetAgentOptions.length === 0 ? <option value="">该 Device 暂无已定义 Agent，请先在 Agents 页面创建</option> : resetAgentOptions.map((backend) => <option key={backend.id} value={backend.id}>{backend.displayName || backend.id} · {backend.agentClientId} · {backend.id}</option>)}
                  </select>
                  <p className="text-xs text-muted-foreground mt-1">工作区会绑定到这个已定义 Agent，后续会使用它的模型、参数和会话能力。</p>
                </div>
              ) : null}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">审批模式</label>
                  <select value={resetPermissionMode} onChange={(e) => setResetPermissionMode(e.target.value as typeof resetPermissionMode)} disabled={clearLoading} className="h-9 w-full px-3 text-sm border border-border rounded-md bg-background">
                    <option value="bypassPermissions">免审批</option>
                    <option value="default">默认审批</option>
                    <option value="acceptEdits">自动接受编辑</option>
                    <option value="plan">Plan</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">访问范围</label>
                  <select value={resetAgentAccessScope} onChange={(e) => setResetAgentAccessScope(e.target.value as typeof resetAgentAccessScope)} disabled={clearLoading} className="h-9 w-full px-3 text-sm border border-border rounded-md bg-background">
                    <option value="all">All</option>
                    <option value="workspace">Workspace</option>
                  </select>
                </div>
              </div>
              {resetRuntimeProfile !== 'server-agent' ? (
                <div className="flex items-start gap-2 p-2 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg">
                  <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
                  <p className="text-xs text-amber-700 dark:text-amber-300">Device 执行形态下 Agent 可访问所选 Device 的文件系统和工具链，请谨慎使用。</p>
                </div>
              ) : null}
            </div>
          ) : null}
        </ConfirmDialog>
        <ConfirmDialog open={deleteState.open} onClose={() => setDeleteState({ open: false, jid: '', name: '' })} onConfirm={handleDeleteConfirm} title="删除工作区" message={`确认删除「${deleteState.name}」？不可撤销。`} confirmText="删除" confirmVariant="danger" loading={deleteLoading} />
    </TooltipProvider>
  );
}
