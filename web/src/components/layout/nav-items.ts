import { Bot, MessageCircle, Clock4, Puzzle, Wallet, User, MonitorSmartphone, Cable, FolderGit2, CircleDot } from 'lucide-react';

export const baseNavItems = [
  { path: '/chat', icon: MessageCircle, label: '工作台' },
  { path: '/skills', icon: Puzzle, label: 'Skill' },
  { path: '/tasks', icon: Clock4, label: '任务' },
  { path: '/issues', icon: CircleDot, label: 'Issues' },
  { path: '/repos', icon: FolderGit2, label: 'Repo' },
  { path: '/devices', icon: MonitorSmartphone, label: '设备' },
  { path: '/agents', icon: Bot, label: 'Agent' },
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
