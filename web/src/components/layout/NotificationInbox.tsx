import { Bell, CheckCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useNotificationsStore } from '@/stores/notifications';

export function NotificationInbox() {
  const inbox = useNotificationsStore((s) => s.inbox);
  const unreadCount = useNotificationsStore((s) => s.unreadCount);
  const markRead = useNotificationsStore((s) => s.markRead);
  const markAllRead = useNotificationsStore((s) => s.markAllRead);
  const pending = inbox.filter((item) => item.status === 'pending' || item.status === 'unread');

  if (inbox.length === 0) return null;

  return (
    <div className="pointer-events-none fixed right-4 top-14 z-40 w-[min(360px,calc(100vw-2rem))]">
      <div className="pointer-events-auto rounded-xl border bg-card/95 p-3 shadow-lg backdrop-blur">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Bell className="h-4 w-4" />Notification Inbox · Approval Inbox
            {unreadCount > 0 && <Badge variant="destructive" className="h-5 px-1.5 text-[10px]">{unreadCount}</Badge>}
          </div>
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={markAllRead} disabled={unreadCount === 0}>
            <CheckCheck className="mr-1 h-3 w-3" />markAllRead
          </Button>
        </div>
        <div className="space-y-2">
          {(pending.length ? pending : inbox.slice(0, 3)).map((item) => (
            <a
              key={item.id}
              href={item.href ?? '#'}
              onClick={() => markRead(item.id)}
              className="w-full rounded-lg border bg-background/80 p-2 text-left text-xs hover:bg-muted/50"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{item.title}</span>
                <Badge variant="outline" className="text-[10px]">{item.status}</Badge>
              </div>
              <div className="mt-1 text-[11px] text-muted-foreground">
                {item.summary || item.issueId || item.runId || item.updatedAt}
              </div>
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}
