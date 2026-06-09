import type { IssueAttachment, IssueAgentRun, IssueComment, IssueEvent } from '@/stores/issues';
import { TimelineComment, TimelineEvent, sortTimeline } from './IssueTimelineEvent';

export interface IssueTimelineProps {
  events: IssueEvent[];
  comments: IssueComment[];
  runs: IssueAgentRun[];
  attachments: IssueAttachment[];
  usersMap?: Record<string, { username: string; avatar_color?: string; display_name?: string }>;
  onUpdateComment?: (commentId: string, body: string) => Promise<void>;
  onDeleteComment?: (commentId: string) => Promise<void>;
  currentUserId?: string;
  onOpenRun?: (runId: string) => void;
}

export function IssueTimeline({
  events,
  comments,
  runs,
  attachments,
  usersMap,
  onUpdateComment,
  onDeleteComment,
  currentUserId,
  onOpenRun,
}: IssueTimelineProps) {
  const items = sortTimeline(events, comments);

  if (items.length === 0) {
    return (
      <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
        No activity yet. Add a comment or run the agent to get started.
      </div>
    );
  }

  return (
    <div className="relative space-y-5 before:absolute before:left-[15px] before:top-1 before:bottom-1 before:w-px before:bg-border">
      {items.map((entry, idx) => (
        <div key={`${entry.kind}-${entry.item.id}-${idx}`} className="relative">
          {entry.kind === 'comment' ? (
            <TimelineComment
              comment={entry.item}
              usersMap={usersMap}
              onUpdateComment={onUpdateComment}
              onDeleteComment={onDeleteComment}
              currentUserId={currentUserId}
            />
          ) : (
            <TimelineEvent
              event={entry.item}
              runs={runs}
              attachments={attachments}
              usersMap={usersMap}
              onOpenRun={onOpenRun}
            />
          )}
        </div>
      ))}
    </div>
  );
}
