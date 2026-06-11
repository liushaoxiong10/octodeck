import { useMemo, useState } from 'react';
import { CheckCircle2, XCircle, MessageSquare, Clock } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { IssueAgentRequest } from '@/stores/issues';
import { useIssuesStore } from '@/stores/issues';

export interface AgentRequestCardProps {
  issueId: string;
  request: IssueAgentRequest;
  className?: string;
}

function extractQuestion(req: IssueAgentRequest): string | null {
  const q = (req.payload as Record<string, unknown> | null)?.question;
  if (typeof q === 'string' && q.trim()) return q;
  return req.summary ?? null;
}

function extractToolName(req: IssueAgentRequest): string | null {
  const payload = req.payload as Record<string, unknown> | null;
  if (!payload) return null;
  const candidates = ['toolName', 'tool_name', 'tool'];
  for (const k of candidates) {
    const v = payload[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return null;
}

function extractChoices(req: IssueAgentRequest): string[] {
  const choices = (req.payload as Record<string, unknown> | null)?.choices;
  if (Array.isArray(choices)) return choices.filter((c): c is string => typeof c === 'string');
  return [];
}

export function AgentRequestCard({ issueId, request, className }: AgentRequestCardProps) {
  const answer = useIssuesStore((s) => s.answerIssueRequest);
  const [reason, setReason] = useState('');
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const question = useMemo(() => extractQuestion(request), [request]);
  const toolName = useMemo(() => extractToolName(request), [request]);
  const choices = useMemo(() => extractChoices(request), [request]);

  const isPending = request.status === 'pending';
  const isExpired = request.status === 'expired';
  const isAnswered = request.status === 'answered';

  const submit = async (decision: 'approve' | 'reject' | 'reply', payloadText?: string) => {
    setSubmitting(true);
    setError(null);
    try {
      const ok = await answer(issueId, request.run_id, request.id, {
        decision,
        message: decision === 'reject' || decision === 'approve' ? payloadText || reason : undefined,
        answer: decision === 'reply' ? payloadText ?? text : undefined,
      });
      if (!ok) setError('Failed to submit decision');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const headerLabel =
    request.kind === 'permission' ? 'Agent requests permission' : 'Agent asked a question';
  const headerColor =
    isPending && request.kind === 'permission'
      ? 'border-amber-500/60 bg-amber-50 dark:bg-amber-950/30'
      : isPending
        ? 'border-blue-500/60 bg-blue-50 dark:bg-blue-950/30'
        : isExpired
          ? 'border-zinc-300/60 bg-zinc-50 dark:bg-zinc-900/40'
          : 'border-emerald-500/40 bg-emerald-50/40 dark:bg-emerald-950/20';

  return (
    <div className={cn('rounded-lg border-2 p-4 space-y-3', headerColor, className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Badge variant={request.kind === 'permission' ? 'destructive' : 'secondary'}>
              {request.kind === 'permission' ? 'Permission' : 'Clarification'}
            </Badge>
            <span className="text-sm font-medium">{headerLabel}</span>
            {!isPending && (
              <Badge variant="outline" className="text-xs capitalize">
                {request.status}
              </Badge>
            )}
          </div>
          {toolName && (
            <p className="text-xs text-muted-foreground">
              Tool: <code className="bg-muted px-1 rounded">{toolName}</code>
            </p>
          )}
          {question && (
            <p className="text-sm whitespace-pre-wrap break-words">{question}</p>
          )}
        </div>
        <div className="text-xs text-muted-foreground flex items-center gap-1 shrink-0">
          <Clock className="h-3 w-3" />
          {new Date(request.created_at).toLocaleString()}
        </div>
      </div>

      {isPending && request.kind === 'permission' && (
        <div className="space-y-2">
          <input
            type="text"
            placeholder="Optional message to agent (visible in audit trail)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-full text-sm rounded border bg-background px-2 py-1.5"
            disabled={submitting}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="default"
              onClick={() => void submit('approve')}
              disabled={submitting}
            >
              <CheckCircle2 className="h-4 w-4 mr-1" /> Approve
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => void submit('reject')}
              disabled={submitting}
            >
              <XCircle className="h-4 w-4 mr-1" /> Reject
            </Button>
          </div>
        </div>
      )}

      {isPending && request.kind === 'clarification' && (
        <div className="space-y-2">
          {choices.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {choices.map((c, i) => (
                <Button
                  key={i}
                  size="sm"
                  variant="outline"
                  onClick={() => void submit('reply', c)}
                  disabled={submitting}
                >
                  {c}
                </Button>
              ))}
            </div>
          )}
          <textarea
            placeholder="Type your answer to the agent..."
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="w-full text-sm rounded border bg-background px-2 py-1.5 min-h-[60px]"
            disabled={submitting}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => void submit('reply')}
              disabled={submitting || !text.trim()}
            >
              <MessageSquare className="h-4 w-4 mr-1" /> Send answer
            </Button>
          </div>
        </div>
      )}

      {isAnswered && (
        <div className="text-sm space-y-1 border-t pt-2">
          <p>
            <span className="text-muted-foreground">Decision:</span>{' '}
            <code className="px-1 bg-muted rounded">{request.decision ?? '-'}</code>
          </p>
          {request.answer && (
            <p className="whitespace-pre-wrap break-words text-muted-foreground">
              {request.answer}
            </p>
          )}
          {request.answered_at && (
            <p className="text-xs text-muted-foreground">
              Answered at {new Date(request.answered_at).toLocaleString()}
            </p>
          )}
        </div>
      )}

      {isExpired && (
        <p className="text-sm text-muted-foreground border-t pt-2">
          Request expired without a response.
        </p>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
