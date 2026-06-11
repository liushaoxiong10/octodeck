import { useState } from 'react';
import { Send, Eye, PencilLine, MessageCircleQuestion } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { IssueMarkdownViewer } from './IssueMarkdownViewer';

export interface IssueCommentComposerProps {
  onSubmit: (body: string) => Promise<void> | void;
  placeholder?: string;
  submitting?: boolean;
  initialValue?: string;
  onCancelEdit?: () => void;
  compact?: boolean;
  /** When set, the composer is rendered as the reply box for an agent question. */
  agentQuestion?: string | null;
}

export function IssueCommentComposer({
  onSubmit,
  placeholder = 'Write a comment... (Markdown supported)',
  submitting = false,
  initialValue = '',
  onCancelEdit,
  compact = false,
  agentQuestion = null,
}: IssueCommentComposerProps) {
  const [body, setBody] = useState(initialValue);
  const [tab, setTab] = useState<'write' | 'preview'>('write');
  const canSubmit = body.trim().length > 0 && !submitting;
  const isReply = !!agentQuestion;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    await onSubmit(body.trim());
    setBody('');
    setTab('write');
  };

  return (
    <div
      className={cn(
        'rounded-xl border shadow-sm',
        isReply
          ? 'border-amber-400 bg-amber-50/60 dark:bg-amber-950/30'
          : 'bg-card',
        compact ? 'p-2' : 'p-3',
      )}
    >
      {isReply && (
        <div className="mb-2 flex items-start gap-2 rounded-md bg-amber-100/70 dark:bg-amber-900/30 px-2 py-1.5 text-xs">
          <MessageCircleQuestion className="h-4 w-4 text-amber-700 dark:text-amber-200 shrink-0 mt-0.5" />
          <div className="space-y-0.5">
            <p className="font-medium text-amber-900 dark:text-amber-100">Agent is waiting for your reply</p>
            <p className="text-amber-800 dark:text-amber-200/80 whitespace-pre-wrap break-words">
              {agentQuestion}
            </p>
          </div>
        </div>
      )}
      <Tabs value={tab} onValueChange={(v) => setTab(v as 'write' | 'preview')}>
        <div className="flex items-center justify-between gap-2 mb-2">
          <TabsList className="h-7">
            <TabsTrigger value="write" className="h-6 px-3 text-xs">
              <PencilLine className="mr-1 h-3 w-3" />
              Write
            </TabsTrigger>
            <TabsTrigger value="preview" className="h-6 px-3 text-xs">
              <Eye className="mr-1 h-3 w-3" />
              Preview
            </TabsTrigger>
          </TabsList>
          <div className="flex items-center gap-2">
            {onCancelEdit && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={onCancelEdit}
              >
                Cancel
              </Button>
            )}
            <Button
              size="sm"
              className="h-7 px-3 text-xs"
              disabled={!canSubmit}
              onClick={handleSubmit}
            >
              <Send className="mr-1 h-3 w-3" />
              {submitting ? 'Sending...' : isReply ? 'Reply Agent' : 'Submit'}
            </Button>
          </div>
        </div>
        <TabsContent value="write" className="mt-0">
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={isReply ? 'Type your answer to the agent...' : placeholder}
            rows={compact ? 3 : 5}
            className="resize-y text-sm min-h-[80px]"
          />
        </TabsContent>
        <TabsContent value="preview" className="mt-0">
          <div className={cn(
            'rounded-md border bg-background',
            compact ? 'min-h-[80px] p-2' : 'min-h-[120px] p-3',
          )}>
            {body.trim() ? (
              <IssueMarkdownViewer>{body}</IssueMarkdownViewer>
            ) : (
              <p className="text-sm text-muted-foreground italic">Nothing to preview.</p>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
