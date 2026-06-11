import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { IssueStatus } from '@/stores/issues';
import { STATUSES } from './shared';

export interface IssueStatusBarProps {
  current: IssueStatus;
  onChange: (next: IssueStatus) => void;
  disabled?: boolean;
}

export function IssueStatusBar({ current, onChange, disabled }: IssueStatusBarProps) {
  const currentIndex = STATUSES.findIndex((s) => s.value === current);
  return (
    <div className="flex flex-wrap items-center gap-2">
      {STATUSES.map((status, idx) => {
        const isCurrent = status.value === current;
        const isWaiting = status.value === 'waiting_for_human';
        return (
          <button
            key={status.value}
            type="button"
            disabled={disabled}
            onClick={() => onChange(status.value)}
            className={cn(
              'group relative',
              disabled && 'cursor-not-allowed opacity-60',
            )}
          >
            <Badge
              variant="outline"
              className={cn(
                'transition-all',
                isCurrent && isWaiting
                  ? 'border-amber-500 bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200 font-medium animate-pulse'
                  : isCurrent
                    ? 'border-primary bg-primary/10 text-primary font-medium'
                    : isWaiting
                      ? 'border-amber-400/40 hover:border-amber-500 hover:bg-amber-100/40'
                      : 'hover:border-primary/40 hover:bg-primary/5',
                !isCurrent && !disabled && 'group-hover:underline decoration-dotted',
              )}
              style={{
                borderLeftWidth: isCurrent ? '3px' : undefined,
                borderLeftColor: isCurrent
                  ? isWaiting
                    ? 'rgb(245 158 11)'
                    : 'hsl(var(--primary))'
                  : idx <= currentIndex
                    ? 'hsl(var(--primary) / 0.3)'
                    : undefined,
              }}
            >
              {status.label}
            </Badge>
          </button>
        );
      })}
    </div>
  );
}
