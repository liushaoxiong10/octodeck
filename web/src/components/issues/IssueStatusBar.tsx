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
                isCurrent
                  ? 'border-primary bg-primary/10 text-primary font-medium'
                  : 'hover:border-primary/40 hover:bg-primary/5',
                !isCurrent && !disabled && 'group-hover:underline decoration-dotted',
              )}
              style={{
                borderLeftWidth: isCurrent ? '3px' : undefined,
                borderLeftColor: isCurrent
                  ? 'hsl(var(--primary))'
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
