import { Bot, MessageCircle, Clock4, History, Puzzle, Wallet, User, MonitorSmartphone, Cable, FolderGit2, CircleDot, Zap, Server, Boxes, GitBranch } from 'lucide-react';

export const baseNavItems = [
  { path: '/chat', icon: MessageCircle, label: '工作台' },
  { path: '/repos', icon: FolderGit2, label: 'Repo' },
  { path: '/issues', icon: CircleDot, label: 'Issues' },
  { path: '/tasks', icon: Clock4, label: '任务' },
  { path: '/autopilots', icon: Zap, label: 'Autopilot' },
  { path: '/history', icon: History, label: '历史' },
  { path: '/devices', icon: MonitorSmartphone, label: '设备' },
  { path: '/runtimes', icon: Server, label: 'Runtime' },
  { path: '/orchestration', icon: GitBranch, label: '编排' },
  { path: '/agents', icon: Bot, label: 'Agent' },
  { path: '/registry', icon: Boxes, label: 'Registry' },
  { path: '/skills', icon: Puzzle, label: 'Skill' },
  { path: '/model-endpoints', icon: Cable, label: '模型端点' },
  { path: '/billing', icon: Wallet, label: '账单', requiresBilling: true },
  { path: '/settings', icon: User, label: '设置' },
];

export function filterNavItems(billingEnabled: boolean) {
  return baseNavItems.filter((item) => {
    if (item.requiresBilling && !billingEnabled) return false;
    return true;
  });
}
