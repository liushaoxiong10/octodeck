import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  useNavigate,
  useParams,
  useSearchParams,
  Link as RouterLink,
} from 'react-router-dom';
import {
  ChevronLeft,
  Edit2,
  Trash2,
  Save,
  PlayCircle,
  History,
  RefreshCw,
  FileText,
  GitBranch,
  ArrowLeft,
  Sparkles,
  AlertTriangle,
  Activity,
  BookOpen,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PageHeader } from '@/components/common/PageHeader';
import { showToast } from '@/utils/toast';
import { wsManager } from '@/api/ws';
import {
  useIssuesStore,
  type AgentTaskLedgerRow,
  type IssueAgentRequest,
  type IssueAgentRun,
  type IssueRunDeliveryDraft,
  type IssueRunDiff,
  type IssueRunPullRequestResult,
  type IssueRunReleaseDraft,
  type IssueRunProductionHealthDraft,
  type IssueRunProductionHealthSignal,
  type IssueRunRemediationAction,
  type IssueRunRemediationDraft,
  type IssueRunIncidentKnowledgeDraft,
  type IssueRunRunbookReuseDraft,
  type IssueRunFixRunDraft,
  type IssueRunFixRunOutcome,
  type IssueRunResolutionGate,
  type IssueRunRepoKnowledgeExplanation,
  type IssueEvent,
  type WorkspaceIssue,
} from '@/stores/issues';
import { useAuthStore } from '@/stores/auth';
import { useUsersStore } from '@/stores/users';
import { getOrchestrationPreviewKey, useOrchestrationStore } from '@/stores/orchestration';
import { IssueStatusBar } from '@/components/issues/IssueStatusBar';
import { IssueMarkdownViewer } from '@/components/issues/IssueMarkdownViewer';
import { IssueCommentComposer } from '@/components/issues/IssueCommentComposer';
import { IssueTimeline } from '@/components/issues/IssueTimeline';
import { IssueMetaPanel } from '@/components/issues/IssueMetaPanel';
import {
  IssueRunLivePanel,
  RunHistoryRow,
} from '@/components/issues/IssueRunLivePanel';
import { AgentRequestCard } from '@/components/issues/AgentRequestCard';
import { IssueAttachmentsGrid } from '@/components/issues/IssueAttachmentsGrid';
import {
  formatOptionalDate,
  formatRunDuration,
  priorityClass,
  priorityLabel,
  statusLabel,
} from '@/components/issues/shared';

type PendingAttachment = Omit<
  import('@/stores/issues').IssueAttachment,
  'id' | 'issue_id' | 'created_by' | 'created_at'
>;

function readImageFiles(files: FileList | null): Promise<PendingAttachment[]> {
  if (!files?.length) return Promise.resolve([]);
  return Promise.all(
    Array.from(files).map(
      (file) =>
        new Promise<PendingAttachment>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () =>
            resolve({
              filename: file.name,
              mime_type: file.type || 'application/octet-stream',
              size_bytes: file.size,
              data_url: String(reader.result || ''),
            });
          reader.onerror = () => reject(reader.error ?? new Error(`Failed to read ${file.name}`));
          reader.readAsDataURL(file);
        }),
    ),
  );
}

function shortId(id: string): string {
  return id.startsWith('iss_') ? id.slice(4, 12) : id.slice(0, 12);
}

function RunDiffViewer({
  diff,
  loading,
  committing,
  defaultMessage,
  onRefresh,
  onCommit,
}: {
  diff?: IssueRunDiff | null;
  loading: boolean;
  committing: boolean;
  defaultMessage: string;
  onRefresh: () => void;
  onCommit: (message: string) => Promise<void>;
}) {
  const [message, setMessage] = useState(defaultMessage);
  useEffect(() => {
    setMessage(defaultMessage);
  }, [defaultMessage]);
  return (
    <div className="rounded-xl border bg-card p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <GitBranch className="h-4 w-4" />Worktree diff
          {diff && (
            <Badge variant="outline" className="h-4 px-1.5 text-[10px] ml-1">
              {diff.clean ? 'clean' : `${diff.files.length} files`}
            </Badge>
          )}
        </h3>
        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={onRefresh} disabled={loading}>
          <RefreshCw className={`mr-1 h-3 w-3 ${loading ? 'animate-spin' : ''}`} />Refresh
        </Button>
      </div>
      {loading && !diff ? (
        <p className="rounded-lg border border-dashed p-3 text-center text-xs text-muted-foreground">Loading worktree diff…</p>
      ) : !diff ? (
        <p className="rounded-lg border border-dashed p-3 text-center text-xs text-muted-foreground">No diff loaded yet.</p>
      ) : diff.error ? (
        <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">{diff.error}</p>
      ) : diff.clean ? (
        <p className="rounded-lg border border-dashed p-3 text-center text-xs text-muted-foreground">Worktree is clean.</p>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            {diff.branch && <Badge variant="outline">{diff.branch}</Badge>}
            {diff.head && <span className="font-mono">{diff.head}</span>}
            {diff.workspacePath && <span className="truncate font-mono" title={diff.workspacePath}>{diff.workspacePath}</span>}
          </div>
          <div className="max-h-64 overflow-auto rounded-lg border">
            <table className="w-full text-xs">
              <tbody>
                {diff.files.map((file) => (
                  <tr key={`${file.status}:${file.path}`} className="border-b last:border-0 align-top">
                    <td className="w-24 px-2 py-1.5 text-muted-foreground">{file.status}</td>
                    <td className="px-2 py-1.5 font-mono">
                      <div>{file.path}</div>
                      {file.patch ? (
                        <details className="mt-2 rounded-md border bg-background/70 p-2 font-sans">
                          <summary className="cursor-pointer text-[11px] font-medium text-muted-foreground">
                            Per-file patch
                          </summary>
                          <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-muted-foreground">
                            {file.patch}
                          </pre>
                        </details>
                      ) : null}
                    </td>
                    <td className="w-20 px-2 py-1.5 text-right font-mono">
                      <span className="text-emerald-600">+{file.additions ?? 0}</span>{' '}
                      <span className="text-red-600">-{file.deletions ?? 0}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {diff.diffStat && (
            <pre className="max-h-48 overflow-auto rounded-lg bg-muted/40 p-3 text-[11px] leading-relaxed text-muted-foreground">
              {diff.diffStat}
            </pre>
          )}
          <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
            <label className="text-[11px] font-medium text-muted-foreground">Commit message</label>
            <Textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={3}
              className="min-h-[72px] resize-y bg-background text-xs"
              placeholder="Describe the agent changes…"
            />
            <div className="flex items-center justify-end gap-2">
              <Button
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={committing || !message.trim() || diff.clean}
                onClick={() => onCommit(message)}
              >
                {committing ? 'Committing…' : 'Commit changes'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function RunDeliveryDraftPanel({
  deliveryDraft,
  pullRequestResult,
  loading,
  creatingPullRequest,
  runningReview,
  onLoad,
  onCreatePullRequest,
  onRunReviewAgent,
}: {
  deliveryDraft?: IssueRunDeliveryDraft | null;
  pullRequestResult?: IssueRunPullRequestResult | null;
  loading: boolean;
  creatingPullRequest: boolean;
  runningReview: boolean;
  onLoad: () => void;
  onCreatePullRequest: () => void;
  onRunReviewAgent: () => void;
}) {
  const prActionUrl = deliveryDraft?.pullRequestDraft.createUrl ?? deliveryDraft?.pullRequestDraft.repositoryUrl;
  const qualityGate = deliveryDraft?.deliveryState.qualityGate;
  const qualityTone = qualityGate?.outcome === 'passed'
    ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
    : qualityGate?.outcome === 'failed'
      ? 'border-destructive/25 bg-destructive/10 text-destructive'
      : 'border-violet-500/20 bg-violet-500/10 text-violet-700 dark:text-violet-300';
  const prActionLabel = deliveryDraft?.pullRequestDraft.createUrl
    ? deliveryDraft.pullRequestDraft.provider === 'gitlab'
      ? 'Create MR'
      : 'Create PR'
    : 'Open repository';
  return (
    <div className="rounded-xl border bg-card p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <FileText className="h-4 w-4" />PR draft / Review prompt
        </h3>
        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={onLoad} disabled={loading}>
          <RefreshCw className={`mr-1 h-3 w-3 ${loading ? 'animate-spin' : ''}`} />Generate
        </Button>
      </div>
      {!deliveryDraft ? (
        <p className="rounded-lg border border-dashed p-3 text-center text-xs text-muted-foreground">
          Generate a PR draft and review prompt from the latest run diff.
        </p>
      ) : (
        <div className="space-y-3">
          <div className="rounded-lg border bg-muted/20 p-3 text-xs">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="font-semibold">Delivery state</span>
              <Badge variant="outline">{deliveryDraft.deliveryState.stage}</Badge>
              <Badge variant="secondary">next: {deliveryDraft.deliveryState.nextAction}</Badge>
            </div>
            {qualityGate ? (
              <div className={`mb-2 rounded-md border p-2 ${qualityTone}`}>
                <div className="flex flex-wrap items-center gap-2 font-medium">
                  <span>Quality gate: {qualityGate.outcome}</span>
                  {qualityGate.score !== undefined ? <Badge variant="outline">score {qualityGate.score}</Badge> : null}
                  {qualityGate.failureCategory ? <Badge variant="outline">{qualityGate.failureCategory}</Badge> : null}
                </div>
                {qualityGate.reason ? <div className="mt-1 text-[11px] opacity-90">{qualityGate.reason}</div> : null}
              </div>
            ) : null}
            <div className="grid gap-1.5 sm:grid-cols-2">
              {deliveryDraft.deliveryState.checklist.map((item) => (
                <div key={item.id} className="rounded-md border bg-background p-2">
                  <div className="mb-0.5 flex items-center justify-between gap-2">
                    <span className="font-medium">{item.label}</span>
                    <Badge variant={item.status === 'ready' ? 'default' : 'outline'}>{item.status}</Badge>
                  </div>
                  {item.detail && <div className="truncate text-[11px] text-muted-foreground">{item.detail}</div>}
                </div>
              ))}
            </div>
          </div>
          <details className="rounded-lg border bg-muted/20 p-3" open>
            <summary className="cursor-pointer text-xs font-semibold">PR draft</summary>
            <div className="mt-2 space-y-2 text-xs">
              <div className="font-medium">{deliveryDraft.pullRequestDraft.title}</div>
              <div className="flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
                <Badge variant="outline">{deliveryDraft.pullRequestDraft.sourceBranch || 'source unknown'}</Badge>
                <span>→</span>
                <Badge variant="outline">{deliveryDraft.pullRequestDraft.targetBranch}</Badge>
                {deliveryDraft.pullRequestDraft.provider && (
                  <Badge variant="outline">{deliveryDraft.pullRequestDraft.provider}</Badge>
                )}
              </div>
              <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-md bg-background p-2 text-[11px] leading-relaxed text-muted-foreground">
                {deliveryDraft.pullRequestDraft.body}
              </pre>
              {prActionUrl && (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    className="h-7 px-2 text-xs"
                    disabled={creatingPullRequest || deliveryDraft.deliveryState.nextAction !== 'create_pr_or_mr' || qualityGate?.allowed === false}
                    onClick={onCreatePullRequest}
                  >
                    {creatingPullRequest ? 'Creating PR…' : prActionLabel}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-xs"
                    onClick={() => window.open(prActionUrl, '_blank', 'noopener,noreferrer')}
                  >
                    Open draft link
                  </Button>
                </div>
              )}
              {pullRequestResult && (
                <div className={`rounded-md border p-2 text-[11px] ${pullRequestResult.ok ? 'bg-emerald-500/10 text-emerald-700' : 'bg-destructive/5 text-destructive'}`}>
                  <div className="font-semibold">{pullRequestResult.ok ? 'Created PR/MR' : 'PR/MR creation failed'}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <Badge variant="outline">{pullRequestResult.provider}</Badge>
                    {pullRequestResult.number ? <Badge variant="outline">#{pullRequestResult.number}</Badge> : null}
                    {pullRequestResult.error ? <span>{pullRequestResult.error}</span> : null}
                    {pullRequestResult.error === 'provider_not_configured' ? <span>Configure the provider token on the server and retry.</span> : null}
                    {pullRequestResult.url ? (
                      <button
                        type="button"
                        className="underline underline-offset-2"
                        onClick={() => window.open(pullRequestResult.url, '_blank', 'noopener,noreferrer')}
                      >
                        Open created PR/MR
                      </button>
                    ) : null}
                  </div>
                </div>
              )}
              {deliveryDraft.deliveryState.stage === 'review_required' ? (
                <div className="rounded-md border border-violet-500/20 bg-violet-500/10 p-2 text-[11px] text-violet-700 dark:text-violet-300">
                  Quality gate requires human review before PR/MR creation. Inspect the diff or run the Review Agent first.
                </div>
              ) : null}
              {deliveryDraft.deliveryState.stage === 'blocked_by_quality' ? (
                <div className="rounded-md border border-destructive/20 bg-destructive/10 p-2 text-[11px] text-destructive">
                  Delivery is blocked until the run passes quality gates.
                </div>
              ) : null}
            </div>
          </details>
          <details className="rounded-lg border bg-muted/20 p-3">
            <summary className="cursor-pointer text-xs font-semibold">Review prompt</summary>
            <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-background p-2 text-[11px] leading-relaxed text-muted-foreground">
              {deliveryDraft.reviewDraft.reviewPrompt}
            </pre>
          </details>
          {deliveryDraft.reviewDraft.comments.length > 0 && (
            <details className="rounded-lg border bg-muted/20 p-3" open>
              <summary className="cursor-pointer text-xs font-semibold">Structured review comments</summary>
              <div className="mt-2 space-y-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-xs"
                  disabled={runningReview}
                  onClick={onRunReviewAgent}
                >
                  {runningReview ? 'Starting Review Agent…' : 'Run Review Agent'}
                </Button>
                {deliveryDraft.reviewDraft.comments.map((comment) => (
                  <div key={`${comment.filePath}:${comment.line ?? 'file'}`} className="rounded-md border bg-background p-2 text-[11px]">
                    <div className="mb-1 flex flex-wrap items-center gap-1.5">
                      <span className="font-mono font-medium">{comment.filePath}{comment.line ? `:${comment.line}` : ''}</span>
                      <Badge variant="outline">{comment.severity}</Badge>
                      <Badge variant="outline">{comment.confidence}</Badge>
                      <Badge variant="outline">{comment.category}</Badge>
                    </div>
                    <pre className="whitespace-pre-wrap text-muted-foreground">{comment.body}</pre>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function RunReleaseGovernancePanel({
  releaseDraft,
  loading,
  onLoad,
  onRefreshRelease,
}: {
  releaseDraft?: IssueRunReleaseDraft | null;
  loading: boolean;
  onLoad: () => void;
  onRefreshRelease: () => void;
}) {
  const stage = releaseDraft?.releaseState.stage ?? 'not_started';
  const stageTone = stage === 'merge_ready' || stage === 'released'
    ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
    : stage === 'checks_failed' || stage === 'review_pending' || stage === 'rollback_required'
      ? 'border-destructive/25 bg-destructive/10 text-destructive'
      : 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300';
  const providerStatus = releaseDraft?.providerStatus;
  const pullRequestUrl = releaseDraft?.releaseState.pullRequest?.url ?? releaseDraft?.pullRequest?.url;

  return (
    <div className="rounded-xl border bg-card p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <GitBranch className="h-4 w-4" />Release Governance
        </h3>
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={onLoad} disabled={loading}>
            <RefreshCw className={`mr-1 h-3 w-3 ${loading ? 'animate-spin' : ''}`} />Load
          </Button>
          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={onRefreshRelease} disabled={loading}>
            <RefreshCw className={`mr-1 h-3 w-3 ${loading ? 'animate-spin' : ''}`} />Refresh gate
          </Button>
        </div>
      </div>
      {!releaseDraft ? (
        <p className="rounded-lg border border-dashed p-3 text-center text-xs text-muted-foreground">
          Load release governance after PR/MR creation to inspect checks, review approval, mergeability, and rollback gates.
        </p>
      ) : (
        <div className="space-y-3 text-xs">
          <div className={`rounded-lg border p-3 ${stageTone}`}>
            <div className="flex flex-wrap items-center gap-2 font-semibold">
              <span>Release stage</span>
              <Badge variant="outline">{stage}</Badge>
              <Badge variant="secondary">next: {releaseDraft.releaseState.nextAction}</Badge>
              {releaseDraft.releaseState.mergeable ? <Badge variant="outline">mergeable</Badge> : null}
            </div>
            <div className="mt-1 text-[11px] opacity-90">
              {releaseDraft.releaseState.releaseGate.reason ?? 'Release gate is waiting for provider status.'}
            </div>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {releaseDraft.releaseState.checklist.map((item) => (
              <div key={item.id} className="rounded-md border bg-background p-2">
                <div className="mb-0.5 flex items-center justify-between gap-2">
                  <span className="font-medium">{item.label}</span>
                  <Badge variant={item.status === 'ready' ? 'default' : item.status === 'blocked' ? 'destructive' : 'outline'}>{item.status}</Badge>
                </div>
                {item.detail ? <div className="truncate text-[11px] text-muted-foreground">{item.detail}</div> : null}
              </div>
            ))}
          </div>
          <div className="rounded-lg border bg-muted/20 p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2 font-semibold">
              <span>Provider status</span>
              {providerStatus ? <Badge variant="outline">{providerStatus.provider}</Badge> : <Badge variant="outline">manual</Badge>}
              {providerStatus?.state ? <Badge variant="outline">{providerStatus.state}</Badge> : null}
              {providerStatus?.error ? <Badge variant="destructive">{providerStatus.error}</Badge> : null}
            </div>
            <div className="grid gap-1 text-[11px] text-muted-foreground sm:grid-cols-3">
              <div>checks: {releaseDraft.releaseState.checks.passed}/{releaseDraft.releaseState.checks.total} passed</div>
              <div>pending: {releaseDraft.releaseState.checks.pending}</div>
              <div>reviews: {releaseDraft.releaseState.review.items.length}</div>
            </div>
            {pullRequestUrl ? (
              <button
                type="button"
                className="mt-2 text-[11px] font-medium underline underline-offset-2"
                onClick={() => window.open(pullRequestUrl, '_blank', 'noopener,noreferrer')}
              >
                Open PR/MR
              </button>
            ) : null}
          </div>
          {providerStatus?.error === 'provider_not_configured' ? (
            <div className="rounded-md border border-amber-500/20 bg-amber-500/10 p-2 text-[11px] text-amber-700 dark:text-amber-300">
              Provider token is not configured. Release governance can show the recorded PR/MR, but automated checks require server credentials.
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function RunProductionHealthPanel({
  productionHealth,
  loading,
  onLoad,
  onRefreshProductionHealth,
  onRecordProductionHealthSignal,
}: {
  productionHealth?: IssueRunProductionHealthDraft | null;
  loading: boolean;
  onLoad: () => void;
  onRefreshProductionHealth: () => void;
  onRecordProductionHealthSignal: (signal: IssueRunProductionHealthSignal) => void;
}) {
  const health = productionHealth?.productionHealth;
  const stage = health?.stage ?? 'not_observed';
  const tone = health?.severity === 'critical'
    ? 'border-destructive/25 bg-destructive/10 text-destructive'
    : health?.severity === 'warning'
      ? 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300'
      : 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
  const latestSignal = health?.signals?.[health.signals.length - 1];
  return (
    <div className="rounded-xl border bg-card p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <Activity className="h-4 w-4" />Production Health
        </h3>
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={onLoad} disabled={loading}>
            <RefreshCw className={`mr-1 h-3 w-3 ${loading ? 'animate-spin' : ''}`} />Load
          </Button>
          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={onRefreshProductionHealth} disabled={loading}>
            <RefreshCw className={`mr-1 h-3 w-3 ${loading ? 'animate-spin' : ''}`} />Refresh health
          </Button>
        </div>
      </div>
      {!health ? (
        <p className="rounded-lg border border-dashed p-3 text-center text-xs text-muted-foreground">
          Load production health after release to observe signals, incidents, recovery, and rollback recommendations.
        </p>
      ) : (
        <div className="space-y-3 text-xs">
          <div className={`rounded-lg border p-3 ${tone}`}>
            <div className="flex flex-wrap items-center gap-2 font-semibold">
              <span>Production stage</span>
              <Badge variant="outline">{stage}</Badge>
              <Badge variant="secondary">next: {health.nextAction}</Badge>
              <Badge variant="outline">{health.severity}</Badge>
            </div>
            <div className="mt-1 text-[11px] opacity-90">
              {health.incident?.summary ?? latestSignal?.summary ?? (health.healthy ? 'Production is healthy.' : 'Waiting for production signal.')}
            </div>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {health.checklist.map((item) => (
              <div key={item.id} className="rounded-md border bg-background p-2">
                <div className="mb-0.5 flex items-center justify-between gap-2">
                  <span className="font-medium">{item.label}</span>
                  <Badge variant={item.status === 'ready' ? 'default' : item.status === 'blocked' ? 'destructive' : 'outline'}>{item.status}</Badge>
                </div>
                {item.detail ? <div className="truncate text-[11px] text-muted-foreground">{item.detail}</div> : null}
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => onRecordProductionHealthSignal({ type: 'healthy', severity: 'info', summary: 'Manual healthy signal', source: 'manual' })}>Mark healthy</Button>
            <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => onRecordProductionHealthSignal({ type: 'degraded', severity: 'warning', summary: 'Manual degraded signal', source: 'manual' })}>Mark degraded</Button>
            <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => onRecordProductionHealthSignal({ type: 'incident', severity: 'critical', summary: 'Manual incident signal', source: 'manual' })}>Mark incident</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function RunRemediationPanel({
  remediation,
  loading,
  onLoad,
  onRefreshRemediation,
  onRecordRemediationAction,
}: {
  remediation?: IssueRunRemediationDraft | null;
  loading: boolean;
  onLoad: () => void;
  onRefreshRemediation: () => void;
  onRecordRemediationAction: (action: IssueRunRemediationAction) => void;
}) {
  const state = remediation?.remediation;
  const stage = state?.stage ?? 'not_needed';
  const tone = state?.riskLevel === 'critical' || state?.riskLevel === 'high'
    ? 'border-destructive/25 bg-destructive/10 text-destructive'
    : state?.riskLevel === 'medium'
      ? 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300'
      : 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
  return (
    <div className="rounded-xl border bg-card p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <AlertTriangle className="h-4 w-4" />Remediation Orchestrator
        </h3>
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={onLoad} disabled={loading}>
            <RefreshCw className={`mr-1 h-3 w-3 ${loading ? 'animate-spin' : ''}`} />Load
          </Button>
          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={onRefreshRemediation} disabled={loading}>
            <RefreshCw className={`mr-1 h-3 w-3 ${loading ? 'animate-spin' : ''}`} />Refresh remediation
          </Button>
        </div>
      </div>
      {!state ? (
        <p className="rounded-lg border border-dashed p-3 text-center text-xs text-muted-foreground">
          Load remediation orchestration to turn delivery, release, and production problems into auditable recovery actions.
        </p>
      ) : (
        <div className="space-y-3 text-xs">
          <div className={`rounded-lg border p-3 ${tone}`}>
            <div className="flex flex-wrap items-center gap-2 font-semibold">
              <span>Remediation stage</span>
              <Badge variant="outline">{stage}</Badge>
              <Badge variant="secondary">action: {state.recommendedAction}</Badge>
              <Badge variant="outline">risk: {state.riskLevel}</Badge>
              {state.approvalRequired ? <Badge variant="destructive">approval required</Badge> : null}
            </div>
            <div className="mt-1 text-[11px] opacity-90">
              {state.proposal?.reason ?? 'No remediation needed.'}
            </div>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {state.checklist.map((item) => (
              <div key={item.id} className="rounded-md border bg-background p-2">
                <div className="mb-0.5 flex items-center justify-between gap-2">
                  <span className="font-medium">{item.label}</span>
                  <Badge variant={item.status === 'ready' ? 'default' : item.status === 'blocked' ? 'destructive' : 'outline'}>{item.status}</Badge>
                </div>
                {item.detail ? <div className="truncate text-[11px] text-muted-foreground">{item.detail}</div> : null}
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => onRecordRemediationAction({ action: 'mark_verifying', summary: 'Manual verification started' })}>Mark verifying</Button>
            <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => onRecordRemediationAction({ action: 'mark_resolved', summary: 'Manual remediation resolved' })}>Mark resolved</Button>
            <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => onRecordRemediationAction({ action: 'spawn_fix_run', summary: 'Manual fix run proposal' })}>Spawn fix proposal</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function RunIncidentKnowledgePanel({
  incidentKnowledge,
  loading,
  onLoad,
  onArchive,
}: {
  incidentKnowledge?: IssueRunIncidentKnowledgeDraft | null;
  loading: boolean;
  onLoad: () => void;
  onArchive: () => void;
}) {
  const entry = incidentKnowledge?.incidentKnowledge ?? null;
  const events = incidentKnowledge?.events ?? [];
  const status = entry?.status ?? 'none';
  const severity = entry?.severity ?? 'low';
  const archived = Boolean(entry?.archived || entry?.archivedAt || events.some((event) => event.eventType === 'incident_knowledge_archived' || event.type === 'incident_archived'));
  const tone = archived
    ? 'border-slate-500/25 bg-slate-500/10 text-slate-600 dark:text-slate-300'
    : severity === 'critical' || severity === 'high'
      ? 'border-destructive/25 bg-destructive/10 text-destructive'
      : severity === 'medium'
        ? 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300'
        : 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
  const renderList = (label: string, items?: string[] | null) => (
    <div className="rounded-md border bg-background p-2">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      {items?.length ? (
        <ul className="space-y-1">
          {items.slice(0, 4).map((item, index) => (
            <li key={`${label}-${index}`} className="leading-relaxed">• {item}</li>
          ))}
        </ul>
      ) : (
        <div className="text-[11px] text-muted-foreground">No entries recorded.</div>
      )}
    </div>
  );
  return (
    <div className="rounded-xl border bg-card p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <BookOpen className="h-4 w-4" />Incident Knowledge Base
        </h3>
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={onLoad} disabled={loading}>
            <RefreshCw className={`mr-1 h-3 w-3 ${loading ? 'animate-spin' : ''}`} />Load
          </Button>
          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={onArchive} disabled={loading || !entry || archived}>
            Archive
          </Button>
        </div>
      </div>
      {!entry ? (
        <p className="rounded-lg border border-dashed p-3 text-center text-xs text-muted-foreground">
          Load incident knowledge to review reusable fingerprints, symptoms, remediation actions, verification signals, and prevention checks.
        </p>
      ) : (
        <div className="space-y-3 text-xs">
          <div className={`rounded-lg border p-3 ${tone}`}>
            <div className="flex flex-wrap items-center gap-2 font-semibold">
              <span>{entry.title || 'Incident fingerprint'}</span>
              <Badge variant="outline">status: {status}</Badge>
              <Badge variant="outline">severity: {severity}</Badge>
              {archived ? <Badge variant="secondary">archived</Badge> : null}
            </div>
            <div className="mt-1 font-mono text-[11px] opacity-90">{entry.fingerprint || 'no-fingerprint'}</div>
            {(entry.summary || entry.detail) ? (
              <div className="mt-2 text-[11px] opacity-90">{entry.summary || entry.detail}</div>
            ) : null}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {renderList('Symptoms', entry.symptoms)}
            {renderList('Remediation actions', entry.remediationActions?.map((action) => `${action.action}: ${action.summary}${action.detail ? ` — ${action.detail}` : ''}`))}
            {renderList('Verification signals', entry.verificationSignals?.map((signal) => `${signal.eventType}: ${signal.summary}`))}
            {renderList('Prevention checklist', entry.preventionChecklist)}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <span>updated: {formatOptionalDate(entry.updatedAt || entry.createdAt || null)}</span>
            {entry.archivedAt ? <span>archived: {formatOptionalDate(entry.archivedAt)}</span> : null}
            {events.length ? <span>{events.length} knowledge events</span> : null}
          </div>
        </div>
      )}
    </div>
  );
}

function RunbookReusePanel({
  runbookReuse,
  loading,
  applying,
  onLoad,
  onApply,
}: {
  runbookReuse?: IssueRunRunbookReuseDraft | null;
  loading: boolean;
  applying: boolean;
  onLoad: () => void;
  onApply: () => void;
}) {
  const reuse = runbookReuse?.runbookReuse;
  const recommendation = reuse?.recommendation ?? null;
  const canApply = Boolean(recommendation && recommendation.status === 'reuse_recommended' && !recommendation.approvalRequired);
  const tone = !recommendation
    ? 'border-slate-500/25 bg-slate-500/10 text-slate-600 dark:text-slate-300'
    : recommendation.riskLevel === 'critical' || recommendation.status === 'not_reusable'
      ? 'border-destructive/25 bg-destructive/10 text-destructive'
      : recommendation.approvalRequired || recommendation.riskLevel === 'high'
        ? 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300'
        : 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';

  return (
    <div className="rounded-xl border bg-card p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <BookOpen className="h-4 w-4" />Runbook Reuse Engine
        </h3>
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={onLoad} disabled={loading || applying}>
            <RefreshCw className={`mr-1 h-3 w-3 ${loading ? 'animate-spin' : ''}`} />Load
          </Button>
          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={onApply} disabled={loading || applying || !canApply}>
            {applying ? 'Applying…' : 'Apply'}
          </Button>
        </div>
      </div>
      {!reuse ? (
        <p className="rounded-lg border border-dashed p-3 text-center text-xs text-muted-foreground">
          Load archived incident knowledge matches to recommend safe runbook reuse for this completed run.
        </p>
      ) : (
        <div className="space-y-3 text-xs">
          <div className={`rounded-lg border p-3 ${tone}`}>
            {recommendation ? (
              <>
                <div className="flex flex-wrap items-center gap-2 font-semibold">
                  <span>Recommendation</span>
                  <Badge variant="outline">status: {recommendation.status}</Badge>
                  <Badge variant="secondary">action: {recommendation.action}</Badge>
                  <Badge variant="outline">risk: {recommendation.riskLevel}</Badge>
                  <Badge variant="outline">confidence: {recommendation.confidence}</Badge>
                  {recommendation.approvalRequired ? <Badge variant="destructive">approval required</Badge> : <Badge variant="outline">no approval required</Badge>}
                </div>
                <div className="mt-1 text-[11px] opacity-90">{recommendation.summary}</div>
                {recommendation.detail ? <div className="mt-1 text-[11px] opacity-80">{recommendation.detail}</div> : null}
              </>
            ) : (
              <div className="font-medium">No reusable runbook recommendation yet.</div>
            )}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-md border bg-background p-2">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Matches</div>
              {reuse.matches.length ? (
                <div className="space-y-1.5">
                  {reuse.matches.slice(0, 4).map((match) => (
                    <div key={match.id} className="rounded-md border bg-muted/20 p-2">
                      <div className="flex flex-wrap items-center gap-1.5 font-medium">
                        <span className="font-mono">{match.fingerprint}</span>
                        <Badge variant="outline">score {match.score}</Badge>
                        <Badge variant={match.reusable ? 'default' : 'outline'}>{match.reusable ? 'reusable' : 'blocked'}</Badge>
                      </div>
                      {match.rationale.length ? <div className="mt-1 text-[11px] text-muted-foreground">{match.rationale.join(' · ')}</div> : null}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-[11px] text-muted-foreground">No historical matches.</div>
              )}
            </div>
            <div className="rounded-md border bg-background p-2">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Reusable actions</div>
              {reuse.reusableActions.length ? (
                <ul className="space-y-1">
                  {reuse.reusableActions.slice(0, 5).map((action, index) => (
                    <li key={`${action.action}:${index}`} className="leading-relaxed">• {action.action}: {action.summary}</li>
                  ))}
                </ul>
              ) : (
                <div className="text-[11px] text-muted-foreground">No reusable actions available.</div>
              )}
            </div>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {reuse.checklist.map((item) => (
              <div key={item.id} className="rounded-md border bg-background p-2">
                <div className="mb-0.5 flex items-center justify-between gap-2">
                  <span className="font-medium">{item.label}</span>
                  <Badge variant={item.status === 'ready' ? 'default' : item.status === 'blocked' ? 'destructive' : 'outline'}>{item.status}</Badge>
                </div>
                {item.detail ? <div className="truncate text-[11px] text-muted-foreground">{item.detail}</div> : null}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function FixRunSpawnerPanel({
  fixRunDraft,
  loading,
  spawning,
  onLoad,
  onSpawn,
}: {
  fixRunDraft?: IssueRunFixRunDraft | null;
  loading: boolean;
  spawning: boolean;
  onLoad: () => void;
  onSpawn: () => void;
}) {
  const draft = fixRunDraft?.fixRunDraft ?? null;
  const canSpawn = Boolean(draft && draft.status === 'draft_ready' && !draft.approvalRequired);
  const tone = !draft
    ? 'border-slate-500/25 bg-slate-500/10 text-slate-600 dark:text-slate-300'
    : draft.status === 'blocked' || draft.riskLevel === 'critical'
      ? 'border-destructive/25 bg-destructive/10 text-destructive'
      : draft.status === 'approval_required' || draft.approvalRequired || draft.riskLevel === 'high'
        ? 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300'
        : 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
  return (
    <div className="rounded-xl border bg-card p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <PlayCircle className="h-4 w-4" />Fix Run Spawner
        </h3>
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={onLoad} disabled={loading || spawning}>
            <RefreshCw className={`mr-1 h-3 w-3 ${loading ? 'animate-spin' : ''}`} />Load
          </Button>
          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={onSpawn} disabled={loading || spawning || !canSpawn}>
            {spawning ? 'Spawning…' : 'Spawn fix run'}
          </Button>
        </div>
      </div>
      {!draft ? (
        <p className="rounded-lg border border-dashed p-3 text-center text-xs text-muted-foreground">
          Build a controlled child fix run from a safe runbook reuse recommendation.
        </p>
      ) : (
        <div className="space-y-3 text-xs">
          <div className={`rounded-lg border p-3 ${tone}`}>
            <div className="flex flex-wrap items-center gap-2 font-semibold">
              <span>{draft.title}</span>
              <Badge variant="outline">status: {draft.status}</Badge>
              <Badge variant="outline">risk: {draft.riskLevel}</Badge>
              {draft.approvalRequired ? <Badge variant="destructive">approval required</Badge> : <Badge variant="outline">no approval required</Badge>}
            </div>
            {draft.sourceFingerprint ? <div className="mt-1 font-mono text-[11px] opacity-90">{draft.sourceFingerprint}</div> : null}
            {draft.blockedReason ? <div className="mt-1 text-[11px] opacity-90">blocked: {draft.blockedReason}</div> : null}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-md border bg-background p-2">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Remediation actions</div>
              {draft.remediationActions.length ? (
                <ul className="space-y-1">
                  {draft.remediationActions.slice(0, 5).map((action, index) => (
                    <li key={`${action.action}:${index}`} className="leading-relaxed">• {action.action}: {action.summary}</li>
                  ))}
                </ul>
              ) : <div className="text-[11px] text-muted-foreground">No actions available.</div>}
            </div>
            <div className="rounded-md border bg-background p-2">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Verification checklist</div>
              {draft.verificationChecklist.length ? (
                <ul className="space-y-1">
                  {draft.verificationChecklist.slice(0, 5).map((item, index) => <li key={`${index}:${item}`} className="leading-relaxed">• {item}</li>)}
                </ul>
              ) : <div className="text-[11px] text-muted-foreground">No checks available.</div>}
            </div>
          </div>
          <div className="rounded-md border bg-background p-2">
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Prompt preview</div>
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap text-[11px] text-muted-foreground">{draft.prompt}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

function FixRunOutcomePanel({
  outcome,
  loading,
  verifying,
  onLoad,
  onVerify,
}: {
  outcome?: IssueRunFixRunOutcome | null;
  loading: boolean;
  verifying: boolean;
  onLoad: () => void;
  onVerify: () => void;
}) {
  const data = outcome?.fixRunOutcome ?? null;
  const tone = !data
    ? 'border-slate-500/25 bg-slate-500/10 text-slate-600 dark:text-slate-300'
    : data.status === 'resolved'
      ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
      : data.status === 'failed' || data.status === 'blocked'
        ? 'border-destructive/25 bg-destructive/10 text-destructive'
        : 'border-violet-500/25 bg-violet-500/10 text-violet-700 dark:text-violet-300';
  return (
    <div className="rounded-xl border bg-card p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <Activity className="h-4 w-4" />Fix Run Outcome
        </h3>
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={onLoad} disabled={loading || verifying}>
            <RefreshCw className={`mr-1 h-3 w-3 ${loading ? 'animate-spin' : ''}`} />Load
          </Button>
          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={onVerify} disabled={loading || verifying}>
            {verifying ? 'Verifying…' : 'Verify Outcome'}
          </Button>
        </div>
      </div>
      {!data ? (
        <p className="rounded-lg border border-dashed p-3 text-center text-xs text-muted-foreground">
          Verify whether the spawned fix run resolved the incident or needs follow-up.
        </p>
      ) : (
        <div className="space-y-3 text-xs">
          <div className={`rounded-lg border p-3 ${tone}`}>
            <div className="flex flex-wrap items-center gap-2 font-semibold">
              <span>{data.title}</span>
              <Badge variant="outline">status: {data.status}</Badge>
              <Badge variant="outline">risk: {data.riskLevel}</Badge>
            </div>
            <div className="mt-1 font-mono text-[11px] opacity-90">source {data.sourceRunId} → fix {data.fixRunId}</div>
            <div className="mt-1 text-[11px] opacity-90">next: {data.nextAction}</div>
            {data.blockedReason ? <div className="mt-1 text-[11px] opacity-90">blocked: {data.blockedReason}</div> : null}
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            <div className="rounded-md border bg-background p-2">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Verification checklist</div>
              {data.verificationChecklist.length ? data.verificationChecklist.slice(0, 4).map((item, index) => <div key={`${index}:${item}`}>• {item}</div>) : <div className="text-[11px] text-muted-foreground">No checks.</div>}
            </div>
            <div className="rounded-md border bg-background p-2">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Resolved signals</div>
              {data.resolvedSignals.length ? data.resolvedSignals.slice(0, 3).map((item, index) => <div key={`${index}:${item}`} className="truncate">• {item}</div>) : <div className="text-[11px] text-muted-foreground">No resolved signals.</div>}
            </div>
            <div className="rounded-md border bg-background p-2">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Failed signals</div>
              {data.failedSignals.length ? data.failedSignals.slice(0, 3).map((item, index) => <div key={`${index}:${item}`} className="truncate">• {item}</div>) : <div className="text-[11px] text-muted-foreground">No failed signals.</div>}
            </div>
          </div>
          <div className="rounded-md border bg-background p-2 text-[11px] text-muted-foreground">{data.summary}</div>
        </div>
      )}
    </div>
  );
}

function ResolutionGatePanel({
  resolutionGate,
  loading,
  applying,
  onLoad,
  onApply,
}: {
  resolutionGate?: IssueRunResolutionGate | null;
  loading: boolean;
  applying: boolean;
  onLoad: () => void;
  onApply: () => void;
}) {
  const gate = resolutionGate?.resolutionGate ?? null;
  const canApply = Boolean(gate && gate.status === 'ready' && !gate.approvalRequired);
  const tone = !gate
    ? 'border-slate-500/25 bg-slate-500/10 text-slate-600 dark:text-slate-300'
    : gate.status === 'ready'
      ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
      : gate.status === 'blocked'
        ? 'border-destructive/25 bg-destructive/10 text-destructive'
        : 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300';
  return (
    <div className="rounded-xl border bg-card p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <Activity className="h-4 w-4" />Resolution Gate
        </h3>
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={onLoad} disabled={loading || applying}>
            <RefreshCw className={`mr-1 h-3 w-3 ${loading ? 'animate-spin' : ''}`} />Load
          </Button>
          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={onApply} disabled={loading || applying || !canApply}>
            {applying ? 'Applying…' : 'Apply Resolution'}
          </Button>
        </div>
      </div>
      {!gate ? (
        <p className="rounded-lg border border-dashed p-3 text-center text-xs text-muted-foreground">
          Evaluate whether this run can close the issue, archive incident knowledge, and promote reusable runbook evidence.
        </p>
      ) : (
        <div className="space-y-3 text-xs">
          <div className={`rounded-lg border p-3 ${tone}`}>
            <div className="flex flex-wrap items-center gap-2 font-semibold">
              <span>{gate.title}</span>
              <Badge variant="outline">status: {gate.status}</Badge>
              <Badge variant="outline">recommended: {gate.recommendedIssueStatus}</Badge>
              <Badge variant="outline">risk: {gate.riskLevel}</Badge>
              {gate.approvalRequired ? <Badge variant="destructive">approval required</Badge> : <Badge variant="outline">no approval required</Badge>}
            </div>
            <div className="mt-1 text-[11px] opacity-90">{gate.summary}</div>
            <div className="mt-1 flex flex-wrap gap-2 text-[11px] opacity-90">
              <span>archive incident: {gate.archiveIncident ? 'yes' : 'no'}</span>
              <span>promote runbook: {gate.promoteRunbook ? 'yes' : 'no'}</span>
              {gate.sourceRunId ? <span>source: <span className="font-mono">{gate.sourceRunId}</span></span> : null}
              {gate.fixRunId ? <span>fix: <span className="font-mono">{gate.fixRunId}</span></span> : null}
            </div>
            {gate.blockedReason ? <div className="mt-1 text-[11px] opacity-90">blocked: {gate.blockedReason}</div> : null}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-md border bg-background p-2">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Rationale</div>
              {gate.rationale.length ? gate.rationale.slice(0, 5).map((item, index) => <div key={`${index}:${item}`} className="leading-relaxed">• {item}</div>) : <div className="text-[11px] text-muted-foreground">No rationale available.</div>}
            </div>
            <div className="rounded-md border bg-background p-2">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Checklist</div>
              {gate.checklist.length ? gate.checklist.slice(0, 5).map((item, index) => <div key={`${index}:${item}`} className="leading-relaxed">• {item}</div>) : <div className="text-[11px] text-muted-foreground">No checklist available.</div>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function RepoKnowledgeContextPanel({
  repoKnowledge,
  loading,
  onLoad,
}: {
  repoKnowledge?: IssueRunRepoKnowledgeExplanation | null;
  loading: boolean;
  onLoad: () => void;
}) {
  const hits = repoKnowledge?.hits ?? [];
  return (
    <div className="rounded-xl border bg-card p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <Sparkles className="h-4 w-4" />Repo Knowledge context
          {hits.length > 0 && (
            <Badge variant="outline" className="h-4 px-1.5 text-[10px] ml-1">
              {hits.length} chunks
            </Badge>
          )}
        </h3>
        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={onLoad} disabled={loading}>
          <RefreshCw className={`mr-1 h-3 w-3 ${loading ? 'animate-spin' : ''}`} />Explain
        </Button>
      </div>
      {!repoKnowledge ? (
        <p className="rounded-lg border border-dashed p-3 text-center text-xs text-muted-foreground">
          Explain which Repo Knowledge chunks were injected into this run and why.
        </p>
      ) : hits.length === 0 ? (
        <p className="rounded-lg border border-dashed p-3 text-center text-xs text-muted-foreground">
          No Repo Knowledge context was injected for this run.
        </p>
      ) : (
        <div className="space-y-3">
          <div className="rounded-lg border bg-muted/20 p-3 text-xs text-muted-foreground">
            <div className="mb-1 font-medium text-foreground">Why injected</div>
            <p>{repoKnowledge.architectureSummary || `Matched query: ${repoKnowledge.query}`}</p>
            {repoKnowledge.riskPoints?.length ? (
              <ul className="mt-2 list-disc space-y-1 pl-4">
                {repoKnowledge.riskPoints.slice(0, 3).map((risk, idx) => (
                  <li key={`${idx}:${risk}`}>{risk}</li>
                ))}
              </ul>
            ) : null}
          </div>
          <div className="space-y-2">
            {hits.slice(0, 5).map((hit) => (
              <details key={hit.chunkId} className="rounded-lg border bg-background/70 p-3" open={hits.length === 1}>
                <summary className="cursor-pointer text-xs font-semibold">
                  <span className="font-mono">{hit.path}</span>
                  {hit.startLine ? <span className="ml-1 text-muted-foreground">:{hit.startLine}</span> : null}
                </summary>
                <div className="mt-2 space-y-2 text-[11px] text-muted-foreground">
                  <div className="flex flex-wrap gap-1.5">
                    <Badge variant="outline">{hit.kind}</Badge>
                    {typeof hit.score === 'number' && <Badge variant="outline">score {hit.score}</Badge>}
                    {(hit.matchedTerms ?? []).map((term) => (
                      <Badge key={term} variant="secondary" className="text-[10px]">{term}</Badge>
                    ))}
                  </div>
                  <div>
                    rationale: {(hit.rationale ?? []).join(', ') || 'search match'}
                  </div>
                  {hit.snippet && (
                    <pre className="max-h-36 overflow-auto whitespace-pre-wrap rounded-md bg-muted/30 p-2 font-mono leading-relaxed">
                      {hit.snippet}
                    </pre>
                  )}
                </div>
              </details>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function AgentTaskLedgerPanel({
  tasks,
  onRefresh,
}: {
  tasks: AgentTaskLedgerRow[];
  onRefresh: () => void;
}) {
  return (
    <div className="rounded-xl border bg-card p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <History className="h-4 w-4" />AgentTask Ledger
          <Badge variant="outline" className="h-4 px-1.5 text-[10px] ml-1">
            {tasks.length}
          </Badge>
        </h3>
        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={onRefresh}>
          <RefreshCw className="mr-1 h-3 w-3" />Refresh
        </Button>
      </div>
      {tasks.length === 0 ? (
        <p className="rounded-lg border border-dashed p-3 text-center text-xs text-muted-foreground">
          No unified AgentTask ledger rows for this issue yet.
        </p>
      ) : (
        <div className="space-y-2">
          {tasks.map((task) => (
            <div key={task.id} className="rounded-lg border bg-muted/20 p-3 text-xs">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0 font-mono text-[11px] truncate">{task.id}</div>
                <Badge variant="secondary" className="shrink-0 text-[10px]">{task.status}</Badge>
              </div>
              <div className="mt-2 grid gap-1 text-[11px] text-muted-foreground">
                <div>source_type: <span className="font-mono">{task.source_type}</span></div>
                <div>run_ref: <span className="font-mono">{task.run_ref || '—'}</span></div>
                <div>runtime: <span className="font-mono">{task.execution_node || task.agent_client_id || task.backend || '—'}</span></div>
                <div>updated: {formatOptionalDate(task.updated_at)}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function IssueDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const issueId = id ?? '';

  // --- Store selectors ---
  const currentUser = useAuthStore((s) => s.user);
  const issueById = useIssuesStore((s) => s.issueById);
  const runsByIssue = useIssuesStore((s) => s.runsByIssue);
  const runEventsByRun = useIssuesStore((s) => s.runEventsByRun);
  const runDiffsByRun = useIssuesStore((s) => s.runDiffsByRun);
  const runDeliveryDraftsByRun = useIssuesStore((s) => s.runDeliveryDraftsByRun);
  const runReleaseDraftsByRun = useIssuesStore((s) => s.runReleaseDraftsByRun);
  const runProductionHealthByRun = useIssuesStore((s) => s.runProductionHealthByRun);
  const runRemediationByRun = useIssuesStore((s) => s.runRemediationByRun);
  const runIncidentKnowledgeByRun = useIssuesStore((s) => s.runIncidentKnowledgeByRun);
  const runbookReuseByRun = useIssuesStore((s) => s.runbookReuseByRun);
  const fixRunDraftsByRun = useIssuesStore((s) => s.fixRunDraftsByRun);
  const fixRunOutcomesByRun = useIssuesStore((s) => s.fixRunOutcomesByRun);
  const resolutionGatesByRun = useIssuesStore((s) => s.resolutionGatesByRun);
  const pullRequestResultsByRun = useIssuesStore((s) => s.pullRequestResultsByRun);
  const runRepoKnowledgeByRun = useIssuesStore((s) => s.runRepoKnowledgeByRun);
  const agentTasksByIssue = useIssuesStore((s) => s.agentTasksByIssue);
  const attachmentsByIssue = useIssuesStore((s) => s.attachmentsByIssue);
  const eventsByIssue = useIssuesStore((s) => s.eventsByIssue);
  const commentsByIssue = useIssuesStore((s) => s.commentsByIssue);
  const requestsByIssue = useIssuesStore((s) => s.requestsByIssue);
  const loadIssueById = useIssuesStore((s) => s.loadIssueById);
  const loadIssueEvents = useIssuesStore((s) => s.loadIssueEvents);
  const loadIssueRuns = useIssuesStore((s) => s.loadIssueRuns);
  const loadIssueRunEvents = useIssuesStore((s) => s.loadIssueRunEvents);
  const loadIssueRunDiff = useIssuesStore((s) => s.loadIssueRunDiff);
  const commitIssueRun = useIssuesStore((s) => s.commitIssueRun);
  const loadIssueRunDelivery = useIssuesStore((s) => s.loadIssueRunDelivery);
  const loadIssueRunRelease = useIssuesStore((s) => s.loadIssueRunRelease);
  const refreshIssueRunRelease = useIssuesStore((s) => s.refreshIssueRunRelease);
  const loadIssueRunProductionHealth = useIssuesStore((s) => s.loadIssueRunProductionHealth);
  const refreshIssueRunProductionHealth = useIssuesStore((s) => s.refreshIssueRunProductionHealth);
  const recordIssueRunProductionHealthSignal = useIssuesStore((s) => s.recordIssueRunProductionHealthSignal);
  const loadIssueRunRemediation = useIssuesStore((s) => s.loadIssueRunRemediation);
  const refreshIssueRunRemediation = useIssuesStore((s) => s.refreshIssueRunRemediation);
  const recordIssueRunRemediationAction = useIssuesStore((s) => s.recordIssueRunRemediationAction);
  const loadIssueRunIncidentKnowledge = useIssuesStore((s) => s.loadIssueRunIncidentKnowledge);
  const archiveIssueRunIncidentKnowledge = useIssuesStore((s) => s.archiveIssueRunIncidentKnowledge);
  const loadIssueRunRunbookReuse = useIssuesStore((s) => s.loadIssueRunRunbookReuse);
  const applyIssueRunRunbookReuse = useIssuesStore((s) => s.applyIssueRunRunbookReuse);
  const loadIssueRunFixRunDraft = useIssuesStore((s) => s.loadIssueRunFixRunDraft);
  const spawnIssueRunFixRun = useIssuesStore((s) => s.spawnIssueRunFixRun);
  const loadIssueRunFixRunOutcome = useIssuesStore((s) => s.loadIssueRunFixRunOutcome);
  const verifyIssueRunFixRunOutcome = useIssuesStore((s) => s.verifyIssueRunFixRunOutcome);
  const loadIssueRunResolutionGate = useIssuesStore((s) => s.loadIssueRunResolutionGate);
  const applyIssueRunResolutionGate = useIssuesStore((s) => s.applyIssueRunResolutionGate);
  const createIssueRunPullRequest = useIssuesStore((s) => s.createIssueRunPullRequest);
  const runIssueReviewAgent = useIssuesStore((s) => s.runIssueReviewAgent);
  const loadIssueRunRepoKnowledge = useIssuesStore((s) => s.loadIssueRunRepoKnowledge);
  const loadAgentTasksForIssue = useIssuesStore((s) => s.loadAgentTasksForIssue);
  const loadIssueAttachments = useIssuesStore((s) => s.loadIssueAttachments);
  const loadIssueComments = useIssuesStore((s) => s.loadIssueComments);
  const loadIssueRequests = useIssuesStore((s) => s.loadIssueRequests);
  const upsertIssueRequest = useIssuesStore((s) => s.upsertIssueRequest);
  const updateIssue = useIssuesStore((s) => s.updateIssue);
  const deleteIssue = useIssuesStore((s) => s.deleteIssue);
  const runIssueAgent = useIssuesStore((s) => s.runIssueAgent);
  const cancelIssueRun = useIssuesStore((s) => s.cancelIssueRun);
  const uploadIssueAttachment = useIssuesStore((s) => s.uploadIssueAttachment);
  const deleteIssueAttachment = useIssuesStore((s) => s.deleteIssueAttachment);
  const createIssueComment = useIssuesStore((s) => s.createIssueComment);
  const updateIssueComment = useIssuesStore((s) => s.updateIssueComment);
  const deleteIssueComment = useIssuesStore((s) => s.deleteIssueComment);
  const prependIssueEvent = useIssuesStore((s) => s.prependIssueEvent);
  const loadOrchestrationPreview = useOrchestrationStore((s) => s.loadPreview);
  const orchestrationDecision = useOrchestrationStore(
    (s) => s.previews[getOrchestrationPreviewKey('issue', issueId)],
  );

  // --- Users ---
  const users = useUsersStore((s) => s.users);
  const fetchUsers = useUsersStore((s) => s.fetchUsers);
  const usersMap = useMemo(() => {
    const m: Record<string, { username: string; avatar_color?: string; display_name?: string }> = {};
    for (const u of users) {
      m[u.id] = { username: u.username, avatar_color: u.avatar_color || undefined, display_name: u.display_name || undefined };
    }
    return m;
  }, [users]);

  // --- Resolve data ---
  const issue: WorkspaceIssue | undefined = issueById[issueId];
  const runs: IssueAgentRun[] = runsByIssue[issueId] ?? [];
  const agentTasks = agentTasksByIssue[issueId] ?? [];
  const attachments = attachmentsByIssue[issueId] ?? [];
  const events: IssueEvent[] = eventsByIssue[issueId] ?? [];
  const comments = commentsByIssue[issueId] ?? [];
  const requests: IssueAgentRequest[] = requestsByIssue[issueId] ?? [];
  const pendingRequests = useMemo(
    () => requests.filter((r) => r.status === 'pending'),
    [requests],
  );

  useEffect(() => {
    if (!issueId) return;
    void loadOrchestrationPreview({ source: 'issue', id: issueId });
  }, [issueId, loadOrchestrationPreview]);
  const pendingClarification = useMemo(
    () => pendingRequests.find((r) => r.kind === 'clarification') ?? null,
    [pendingRequests],
  );

  // --- UI state ---
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [editingDescription, setEditingDescription] = useState(false);
  const [descriptionDraft, setDescriptionDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [mobileTab, setMobileTab] = useState<'meta' | 'runs' | 'attachments'>('meta');
  const [expandedRunId, setExpandedRunId] = useState<string | null>(() => searchParams.get('run'));
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const hasActiveRun = useMemo(
    () => runs.some((r) => r.status === 'queued' || r.status === 'running'),
    [runs],
  );
  const activeRun = useMemo(
    () => runs.find((r) => r.status === 'running' || r.status === 'queued') ?? null,
    [runs],
  );
  const selectedRun = useMemo(() => {
    if (expandedRunId) return runs.find((r) => r.id === expandedRunId) ?? null;
    return activeRun ?? runs[0] ?? null;
  }, [runs, expandedRunId, activeRun]);
  const selectedRunEvents = selectedRun ? runEventsByRun[selectedRun.id] ?? [] : [];
  const selectedRunDiff = selectedRun ? runDiffsByRun[selectedRun.id] ?? null : null;
  const deliveryDraft = selectedRun ? runDeliveryDraftsByRun[selectedRun.id] ?? null : null;
  const releaseDraft = selectedRun ? runReleaseDraftsByRun[selectedRun.id] ?? null : null;
  const productionHealth = selectedRun ? runProductionHealthByRun[selectedRun.id] ?? null : null;
  const remediation = selectedRun ? runRemediationByRun[selectedRun.id] ?? null : null;
  const incidentKnowledge = selectedRun ? runIncidentKnowledgeByRun[selectedRun.id] ?? null : null;
  const runbookReuse = selectedRun ? runbookReuseByRun[selectedRun.id] ?? null : null;
  const fixRunDraft = selectedRun ? fixRunDraftsByRun[selectedRun.id] ?? null : null;
  const fixRunOutcome = selectedRun ? fixRunOutcomesByRun[selectedRun.id] ?? null : null;
  const resolutionGate = selectedRun ? resolutionGatesByRun[selectedRun.id] ?? null : null;
  const pullRequestResult = selectedRun ? pullRequestResultsByRun[selectedRun.id] ?? null : null;
  const repoKnowledge = selectedRun ? runRepoKnowledgeByRun[selectedRun.id] ?? null : null;
  const [diffLoadingRunId, setDiffLoadingRunId] = useState<string | null>(null);
  const [commitLoadingRunId, setCommitLoadingRunId] = useState<string | null>(null);
  const [deliveryLoadingRunId, setDeliveryLoadingRunId] = useState<string | null>(null);
  const [releaseLoadingRunId, setReleaseLoadingRunId] = useState<string | null>(null);
  const [productionHealthLoadingRunId, setProductionHealthLoadingRunId] = useState<string | null>(null);
  const [remediationLoadingRunId, setRemediationLoadingRunId] = useState<string | null>(null);
  const [incidentKnowledgeLoadingRunId, setIncidentKnowledgeLoadingRunId] = useState<string | null>(null);
  const [runbookReuseLoadingRunId, setRunbookReuseLoadingRunId] = useState<string | null>(null);
  const [runbookReuseApplyingRunId, setRunbookReuseApplyingRunId] = useState<string | null>(null);
  const [fixRunDraftLoadingRunId, setFixRunDraftLoadingRunId] = useState<string | null>(null);
  const [fixRunSpawningRunId, setFixRunSpawningRunId] = useState<string | null>(null);
  const [fixRunOutcomeLoadingRunId, setFixRunOutcomeLoadingRunId] = useState<string | null>(null);
  const [fixRunOutcomeVerifyingRunId, setFixRunOutcomeVerifyingRunId] = useState<string | null>(null);
  const [resolutionGateLoadingRunId, setResolutionGateLoadingRunId] = useState<string | null>(null);
  const [resolutionGateApplyingRunId, setResolutionGateApplyingRunId] = useState<string | null>(null);
  const [pullRequestLoadingRunId, setPullRequestLoadingRunId] = useState<string | null>(null);
  const [reviewLoadingRunId, setReviewLoadingRunId] = useState<string | null>(null);
  const [repoKnowledgeLoadingRunId, setRepoKnowledgeLoadingRunId] = useState<string | null>(null);

  // --- Initial load ---
  useEffect(() => {
    if (!issueId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const [loadedIssue] = await Promise.all([
          loadIssueById(issueId),
          loadIssueEvents(issueId),
          loadIssueRuns(issueId),
          loadAgentTasksForIssue(issueId),
          loadIssueAttachments(issueId),
          loadIssueComments(issueId),
          loadIssueRequests(issueId),
          fetchUsers({ status: 'active' }).catch(() => {}),
        ] as const);
        if (cancelled) return;
        if (!loadedIssue) {
          setLoadError('Issue not found');
        }
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issueId]);

  // --- Load run events for the first run that has none ---
  useEffect(() => {
    if (!issue || runs.length === 0) return;
    // Auto-expand to active or first run if no explicit run param
    if (!expandedRunId) {
      const next = activeRun ?? runs[0];
      if (next) setExpandedRunId(next.id);
      return; // expandedRunId change will re-trigger this effect for loading
    }
    // Load events for the selected run
    if (selectedRun && runEventsByRun[selectedRun.id] === undefined) {
      loadIssueRunEvents(issue.id, selectedRun.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issue?.id, runs.length, expandedRunId, activeRun?.id]);

  useEffect(() => {
    if (!issue || !selectedRun) return;
    if (selectedRun.status === 'queued' || selectedRun.status === 'running') return;
    if (runDiffsByRun[selectedRun.id] !== undefined) return;
    setDiffLoadingRunId(selectedRun.id);
    loadIssueRunDiff(issue.id, selectedRun.id).finally(() => setDiffLoadingRunId(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issue?.id, selectedRun?.id, selectedRun?.status]);

  useEffect(() => {
    if (!issue || !selectedRun) return;
    if (runRepoKnowledgeByRun[selectedRun.id] !== undefined) return;
    setRepoKnowledgeLoadingRunId(selectedRun.id);
    loadIssueRunRepoKnowledge(issue.id, selectedRun.id).finally(() => setRepoKnowledgeLoadingRunId(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issue?.id, selectedRun?.id]);

  useEffect(() => {
    if (!issue || !selectedRun) return;
    if (selectedRun.status === 'queued' || selectedRun.status === 'running') return;
    if (runReleaseDraftsByRun[selectedRun.id] !== undefined) return;
    setReleaseLoadingRunId(selectedRun.id);
    loadIssueRunRelease(issue.id, selectedRun.id).finally(() => setReleaseLoadingRunId(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issue?.id, selectedRun?.id, selectedRun?.status]);

  useEffect(() => {
    if (!issue || !selectedRun) return;
    if (selectedRun.status === 'queued' || selectedRun.status === 'running') return;
    if (runProductionHealthByRun[selectedRun.id] !== undefined) return;
    setProductionHealthLoadingRunId(selectedRun.id);
    loadIssueRunProductionHealth(issue.id, selectedRun.id).finally(() => setProductionHealthLoadingRunId(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issue?.id, selectedRun?.id, selectedRun?.status]);

  useEffect(() => {
    if (!issue || !selectedRun) return;
    if (selectedRun.status === 'queued' || selectedRun.status === 'running') return;
    if (runRemediationByRun[selectedRun.id] !== undefined) return;
    setRemediationLoadingRunId(selectedRun.id);
    loadIssueRunRemediation(issue.id, selectedRun.id).finally(() => setRemediationLoadingRunId(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issue?.id, selectedRun?.id, selectedRun?.status]);

  useEffect(() => {
    if (!issue || !selectedRun) return;
    if (selectedRun.status === 'queued' || selectedRun.status === 'running') return;
    if (runIncidentKnowledgeByRun[selectedRun.id] !== undefined) return;
    setIncidentKnowledgeLoadingRunId(selectedRun.id);
    loadIssueRunIncidentKnowledge(issue.id, selectedRun.id).finally(() => setIncidentKnowledgeLoadingRunId(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issue?.id, selectedRun?.id, selectedRun?.status]);

  useEffect(() => {
    if (!issue || !selectedRun) return;
    if (selectedRun.status === 'queued' || selectedRun.status === 'running') return;
    if (runbookReuseByRun[selectedRun.id] !== undefined) return;
    setRunbookReuseLoadingRunId(selectedRun.id);
    loadIssueRunRunbookReuse(issue.id, selectedRun.id).finally(() => setRunbookReuseLoadingRunId(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issue?.id, selectedRun?.id, selectedRun?.status]);

  useEffect(() => {
    if (!issue || !selectedRun) return;
    if (selectedRun.status === 'queued' || selectedRun.status === 'running') return;
    if (fixRunDraftsByRun[selectedRun.id] !== undefined) return;
    setFixRunDraftLoadingRunId(selectedRun.id);
    loadIssueRunFixRunDraft(issue.id, selectedRun.id).finally(() => setFixRunDraftLoadingRunId(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issue?.id, selectedRun?.id, selectedRun?.status]);

  useEffect(() => {
    if (!issue || !selectedRun) return;
    if (fixRunOutcomesByRun[selectedRun.id] !== undefined) return;
    setFixRunOutcomeLoadingRunId(selectedRun.id);
    loadIssueRunFixRunOutcome(issue.id, selectedRun.id).finally(() => setFixRunOutcomeLoadingRunId(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issue?.id, selectedRun?.id, selectedRun?.status]);

  useEffect(() => {
    if (!issue || !selectedRun) return;
    if (selectedRun.status === 'queued' || selectedRun.status === 'running') return;
    const cachedGate = resolutionGatesByRun[selectedRun.id]?.resolutionGate;
    const staleBlockedReason = cachedGate?.blockedReason === 'missing_fix_run_outcome' || cachedGate?.blockedReason === 'fix_run_not_resolved';
    if (resolutionGatesByRun[selectedRun.id] !== undefined && !staleBlockedReason) return;
    setResolutionGateLoadingRunId(selectedRun.id);
    loadIssueRunResolutionGate(issue.id, selectedRun.id).finally(() => setResolutionGateLoadingRunId(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issue?.id, selectedRun?.id, selectedRun?.status]);

  // --- Real-time WebSocket push ---
  useEffect(() => {
    if (!issueId) return;
    const unsubIssue = wsManager.on('octodeck_event:issue', (data: any) => {
      const event = data.event;
      if (event?.issueId !== issueId || !event.type?.startsWith('issue.timeline.')) return;
      const evt = event.payload as IssueEvent;
      prependIssueEvent(issueId, evt);
      // If it's a run_* event, also refresh runs
      if (evt.event_type.startsWith('run_')) {
        loadIssueRuns(issueId);
        loadAgentTasksForIssue(issueId);
        if (evt.run_id && (evt.event_type === 'run_event' || evt.event_type === 'run_delta')) {
          loadIssueRunEvents(issueId, evt.run_id);
        }
      }
      // If comment event, refresh comments
      if (evt.event_type.startsWith('comment_')) {
        loadIssueComments(issueId);
      }
      // If agent_request_* event, refresh issue (status may have changed)
      if (evt.event_type.startsWith('agent_request_')) {
        loadIssueById(issueId);
      }
    });
    const unsubApproval = wsManager.on('octodeck_event:approval', (data: any) => {
      const event = data.event;
      if (event?.issueId !== issueId || !event.type?.startsWith('approval.request.')) return;
      const req = event.payload as IssueAgentRequest;
      upsertIssueRequest(issueId, req);
      loadIssueById(issueId);
      loadIssueRuns(issueId);
    });
    return () => {
      unsubIssue();
      unsubApproval();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issueId]);

  // --- Sync ?run= query param with expandedRunId ---
  useEffect(() => {
    const urlRun = searchParams.get('run');
    if (urlRun && urlRun !== expandedRunId) {
      setExpandedRunId(urlRun);
    }
  }, [searchParams]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleToggleRun = useCallback((runId: string) => {
    const next = expandedRunId === runId ? null : runId;
    setExpandedRunId(next);
    if (next) {
      setSearchParams((prev) => {
        prev.set('run', runId);
        return prev;
      }, { replace: true });
      if (issue && runEventsByRun[runId] === undefined) {
        loadIssueRunEvents(issue.id, runId);
      }
    } else {
      setSearchParams((prev) => {
        prev.delete('run');
        return prev;
      }, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedRunId, issue?.id, runEventsByRun, setSearchParams]);

  // --- Title edit ---
  const startEditTitle = () => {
    if (!issue) return;
    setTitleDraft(issue.title);
    setEditingTitle(true);
  };
  const saveTitle = async () => {
    if (!issue || !titleDraft.trim() || titleDraft.trim() === issue.title) {
      setEditingTitle(false);
      return;
    }
    setSaving(true);
    try {
      const r = await updateIssue(issue.id, { title: titleDraft.trim() });
      if (r) showToast('Title updated');
    } finally {
      setSaving(false);
      setEditingTitle(false);
    }
  };

  // --- Description edit ---
  const startEditDescription = () => {
    if (!issue) return;
    setDescriptionDraft(issue.description);
    setEditingDescription(true);
  };
  const saveDescription = async () => {
    if (!issue) {
      setEditingDescription(false);
      return;
    }
    setSaving(true);
    try {
      const r = await updateIssue(issue.id, { description: descriptionDraft });
      if (r) showToast('Description updated');
    } finally {
      setSaving(false);
      setEditingDescription(false);
    }
  };

  // --- Meta patch wrapper ---
  const handlePatch = async (patch: Partial<WorkspaceIssue>) => {
    if (!issue) return;
    setSaving(true);
    try {
      const r = await updateIssue(issue.id, patch);
      if (r) showToast('Updated');
    } finally {
      setSaving(false);
    }
  };

  // --- Run agent ---
  const handleRunAgent = async () => {
    if (!issue) return;
    const r = await runIssueAgent(issue.id);
    if (r) {
      showToast('Agent run started');
      setExpandedRunId(r.id);
      setSearchParams((prev) => {
        prev.set('run', r.id);
        return prev;
      }, { replace: true });
    }
  };

  // --- Delete issue ---
  const handleDelete = async () => {
    if (!issue) return;
    setDeleting(true);
    try {
      await deleteIssue(issue.id);
      showToast('Issue deleted');
      navigate('/issues', { replace: true });
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to delete issue');
    } finally {
      setDeleting(false);
    }
  };

  // --- Attachments ---
  const addAttachments = async (files: FileList | null) => {
    if (!issue || !files?.length) return;
    const pending = await readImageFiles(files);
    await Promise.all(pending.map((a) => uploadIssueAttachment(issue.id, a)));
    showToast('Attachment added');
  };

  // --- Comments ---
  const handleSubmitComment = async (body: string) => {
    if (!issue) return;
    const c = await createIssueComment(issue.id, body);
    if (!c) showToast('Failed to post comment', 'Please try again');
  };
  const handleUpdateComment = async (commentId: string, body: string) => {
    if (!issue) return;
    const c = await updateIssueComment(issue.id, commentId, body);
    if (c) showToast('Comment updated');
    else showToast('Failed to update comment', 'Please try again');
  };
  const handleDeleteComment = async (commentId: string) => {
    if (!issue) return;
    await deleteIssueComment(issue.id, commentId);
    showToast('Comment deleted');
  };

  // --- Render loading / not found ---
  if (loading && !issue) {
    return (
      <div className="h-full overflow-y-auto bg-background">
        <div className="mx-auto max-w-7xl p-6">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <RefreshCw className="h-4 w-4 animate-spin" />Loading issue…
          </div>
        </div>
      </div>
    );
  }

  if (!loading && !issue) {
    return (
      <div className="h-full overflow-y-auto bg-background">
        <div className="mx-auto max-w-3xl p-6">
          <Button variant="ghost" onClick={() => navigate(-1)} className="mb-4">
            <ArrowLeft className="mr-2 h-4 w-4" />Back
          </Button>
          <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-8 text-center">
            <AlertTriangle className="mx-auto mb-3 h-10 w-10 text-destructive" />
            <h1 className="text-lg font-semibold">Issue not found</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {loadError || 'This issue may have been deleted or the link is incorrect.'}
            </p>
            <Button className="mt-4" onClick={() => navigate('/issues')}>
              Back to issues
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (!issue) return null;

  // --- Assemble ---
  const assigneeName =
    issue.assignee_user_id && usersMap[issue.assignee_user_id]
      ? usersMap[issue.assignee_user_id].display_name || usersMap[issue.assignee_user_id].username
      : issue.assignee_user_id;

  const headerSubtitle = [
    assigneeName ? `Assignee: ${assigneeName}` : null,
    statusLabel(issue.status),
    priorityLabel(issue.priority),
    `Updated ${formatOptionalDate(issue.updated_at)}`,
  ].filter(Boolean).join(' · ');

  const selectedRunCommitMessage = selectedRun
    ? `chore: ${issue.title}\n\nIssue: ${issue.id}\nRun: ${selectedRun.id}`
    : `chore: ${issue.title}`;

  const handleCommitSelectedRun = async (message: string) => {
    if (!selectedRun) return;
    setCommitLoadingRunId(selectedRun.id);
    try {
      const result = await commitIssueRun(issue.id, selectedRun.id, message);
      if (result?.commit) showToast('Commit created', result.commit);
      else showToast('Failed to create commit');
    } finally {
      setCommitLoadingRunId(null);
    }
  };

  const handleLoadSelectedRunDelivery = async () => {
    if (!selectedRun) return;
    setDeliveryLoadingRunId(selectedRun.id);
    try {
      const result = await loadIssueRunDelivery(issue.id, selectedRun.id);
      if (result) showToast('Delivery draft generated');
      else showToast('Failed to generate delivery draft');
    } finally {
      setDeliveryLoadingRunId(null);
    }
  };

  const handleCreatePullRequest = async () => {
    if (!selectedRun || !deliveryDraft) return;
    setPullRequestLoadingRunId(selectedRun.id);
    try {
      const result = await createIssueRunPullRequest(issue.id, selectedRun.id, deliveryDraft.pullRequestDraft);
      if (result?.url) showToast('PR/MR created', result.url);
      else showToast('Failed to create PR/MR', result?.error ?? 'Please check provider configuration');
      if (result?.ok) await loadIssueRunRelease(issue.id, selectedRun.id);
    } finally {
      setPullRequestLoadingRunId(null);
    }
  };

  const handleLoadSelectedRunRelease = async () => {
    if (!selectedRun) return;
    setReleaseLoadingRunId(selectedRun.id);
    try {
      const result = await loadIssueRunRelease(issue.id, selectedRun.id);
      if (result) showToast('Release governance loaded');
      else showToast('Failed to load release governance');
    } finally {
      setReleaseLoadingRunId(null);
    }
  };

  const handleRefreshSelectedRunRelease = async () => {
    if (!selectedRun) return;
    setReleaseLoadingRunId(selectedRun.id);
    try {
      const result = await refreshIssueRunRelease(issue.id, selectedRun.id);
      if (result) showToast('Release governance refreshed', result.releaseState.stage);
      else showToast('Failed to refresh release governance');
    } finally {
      setReleaseLoadingRunId(null);
    }
  };

  const handleLoadSelectedRunProductionHealth = async () => {
    if (!selectedRun) return;
    setProductionHealthLoadingRunId(selectedRun.id);
    try {
      const result = await loadIssueRunProductionHealth(issue.id, selectedRun.id);
      if (result) showToast('Production health loaded');
      else showToast('Failed to load production health');
    } finally {
      setProductionHealthLoadingRunId(null);
    }
  };

  const handleRefreshSelectedRunProductionHealth = async () => {
    if (!selectedRun) return;
    setProductionHealthLoadingRunId(selectedRun.id);
    try {
      const result = await refreshIssueRunProductionHealth(issue.id, selectedRun.id);
      if (result) showToast('Production health refreshed', result.productionHealth.stage);
      else showToast('Failed to refresh production health');
    } finally {
      setProductionHealthLoadingRunId(null);
    }
  };

  const handleRecordProductionHealthSignal = async (signal: IssueRunProductionHealthSignal) => {
    if (!selectedRun) return;
    setProductionHealthLoadingRunId(selectedRun.id);
    try {
      const result = await recordIssueRunProductionHealthSignal(issue.id, selectedRun.id, signal);
      if (result) showToast('Production health signal recorded', result.productionHealth.stage);
      else showToast('Failed to record production health signal');
    } finally {
      setProductionHealthLoadingRunId(null);
    }
  };

  const handleLoadSelectedRunRemediation = async () => {
    if (!selectedRun) return;
    setRemediationLoadingRunId(selectedRun.id);
    try {
      const result = await loadIssueRunRemediation(issue.id, selectedRun.id);
      if (result) showToast('Remediation loaded');
      else showToast('Failed to load remediation');
    } finally {
      setRemediationLoadingRunId(null);
    }
  };

  const handleRefreshSelectedRunRemediation = async () => {
    if (!selectedRun) return;
    setRemediationLoadingRunId(selectedRun.id);
    try {
      const result = await refreshIssueRunRemediation(issue.id, selectedRun.id);
      if (result) showToast('Remediation refreshed', result.remediation.stage);
      else showToast('Failed to refresh remediation');
    } finally {
      setRemediationLoadingRunId(null);
    }
  };

  const handleRecordRemediationAction = async (action: IssueRunRemediationAction) => {
    if (!selectedRun) return;
    setRemediationLoadingRunId(selectedRun.id);
    try {
      const result = await recordIssueRunRemediationAction(issue.id, selectedRun.id, action);
      if (result) showToast('Remediation action recorded', result.remediation.stage);
      else showToast('Failed to record remediation action');
    } finally {
      setRemediationLoadingRunId(null);
    }
  };

  const handleLoadSelectedRunIncidentKnowledge = async () => {
    if (!selectedRun) return;
    setIncidentKnowledgeLoadingRunId(selectedRun.id);
    try {
      const result = await loadIssueRunIncidentKnowledge(issue.id, selectedRun.id);
      if (result) showToast('Incident knowledge loaded');
      else showToast('Failed to load incident knowledge');
    } finally {
      setIncidentKnowledgeLoadingRunId(null);
    }
  };

  const handleArchiveSelectedRunIncidentKnowledge = async () => {
    if (!selectedRun) return;
    setIncidentKnowledgeLoadingRunId(selectedRun.id);
    try {
      const result = await archiveIssueRunIncidentKnowledge(issue.id, selectedRun.id);
      if (result) showToast('Incident knowledge archived');
      else showToast('Failed to archive incident knowledge');
    } finally {
      setIncidentKnowledgeLoadingRunId(null);
    }
  };

  const handleLoadSelectedRunbookReuse = async () => {
    if (!selectedRun) return;
    setRunbookReuseLoadingRunId(selectedRun.id);
    try {
      const result = await loadIssueRunRunbookReuse(issue.id, selectedRun.id);
      if (result) showToast('Runbook reuse loaded');
      else showToast('Failed to load runbook reuse');
    } finally {
      setRunbookReuseLoadingRunId(null);
    }
  };

  const handleApplySelectedRunbookReuse = async () => {
    if (!selectedRun) return;
    setRunbookReuseApplyingRunId(selectedRun.id);
    try {
      const result = await applyIssueRunRunbookReuse(issue.id, selectedRun.id);
      if (result) showToast('Runbook reuse applied');
      else showToast('Failed to apply runbook reuse');
    } finally {
      setRunbookReuseApplyingRunId(null);
    }
  };

  const handleLoadSelectedFixRunDraft = async () => {
    if (!selectedRun) return;
    setFixRunDraftLoadingRunId(selectedRun.id);
    try {
      const result = await loadIssueRunFixRunDraft(issue.id, selectedRun.id);
      if (result) showToast('Fix run draft loaded');
      else showToast('Failed to load fix run draft');
    } finally {
      setFixRunDraftLoadingRunId(null);
    }
  };

  const handleSpawnSelectedFixRun = async () => {
    if (!selectedRun) return;
    setFixRunSpawningRunId(selectedRun.id);
    try {
      const result = await spawnIssueRunFixRun(issue.id, selectedRun.id);
      if (result?.run) showToast('Fix run spawned', result.run.id);
      else showToast('Failed to spawn fix run');
    } finally {
      setFixRunSpawningRunId(null);
    }
  };

  const handleLoadSelectedFixRunOutcome = async () => {
    if (!selectedRun) return;
    setFixRunOutcomeLoadingRunId(selectedRun.id);
    try {
      const result = await loadIssueRunFixRunOutcome(issue.id, selectedRun.id);
      if (result) showToast('Fix run outcome loaded');
      else showToast('Failed to load fix run outcome');
    } finally {
      setFixRunOutcomeLoadingRunId(null);
    }
  };

  const handleVerifySelectedFixRunOutcome = async () => {
    if (!selectedRun) return;
    setFixRunOutcomeVerifyingRunId(selectedRun.id);
    try {
      const result = await verifyIssueRunFixRunOutcome(issue.id, selectedRun.id);
      if (result) {
        await loadIssueRunResolutionGate(issue.id, selectedRun.id);
        showToast('Fix run outcome verified', result.fixRunOutcome.status);
      }
      else showToast('Failed to verify fix run outcome');
    } finally {
      setFixRunOutcomeVerifyingRunId(null);
    }
  };

  const handleLoadSelectedResolutionGate = async () => {
    if (!selectedRun) return;
    setResolutionGateLoadingRunId(selectedRun.id);
    try {
      const result = await loadIssueRunResolutionGate(issue.id, selectedRun.id);
      if (result) showToast('Resolution gate loaded');
      else showToast('Failed to load resolution gate');
    } finally {
      setResolutionGateLoadingRunId(null);
    }
  };

  const handleApplySelectedResolutionGate = async () => {
    if (!selectedRun) return;
    setResolutionGateApplyingRunId(selectedRun.id);
    try {
      const result = await applyIssueRunResolutionGate(issue.id, selectedRun.id);
      if (result) showToast('Resolution applied', result.resolutionGate.recommendedIssueStatus);
      else showToast('Failed to apply resolution');
    } finally {
      setResolutionGateApplyingRunId(null);
    }
  };

  const handleRunReviewAgent = async () => {
    if (!selectedRun || !deliveryDraft) return;
    setReviewLoadingRunId(selectedRun.id);
    try {
      const result = await runIssueReviewAgent(issue.id, selectedRun.id, deliveryDraft.reviewDraft);
      if (result) showToast('Review Agent started', result.id);
      else showToast('Failed to start Review Agent');
    } finally {
      setReviewLoadingRunId(null);
    }
  };

  const handleLoadSelectedRunRepoKnowledge = async () => {
    if (!selectedRun) return;
    setRepoKnowledgeLoadingRunId(selectedRun.id);
    try {
      await loadIssueRunRepoKnowledge(issue.id, selectedRun.id);
    } finally {
      setRepoKnowledgeLoadingRunId(null);
    }
  };

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="mx-auto max-w-7xl p-4 md:p-6 space-y-4">
        {/* Breadcrumb + title */}
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <RouterLink to="/issues" className="inline-flex items-center gap-1 hover:text-foreground hover:underline">
            <ChevronLeft className="h-3 w-3" />Issues
          </RouterLink>
          <span>/</span>
          <span className="font-mono text-foreground">#{shortId(issue.id)}</span>
        </div>

        <PageHeader
          title={
            editingTitle ? (
              <div className="flex items-center gap-2 min-w-0">
                <Input
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onBlur={saveTitle}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveTitle();
                    if (e.key === 'Escape') { setEditingTitle(false); }
                  }}
                  className="text-base md:text-lg font-semibold h-9"
                  autoFocus
                />
                <Button size="sm" variant="ghost" className="h-8 px-2 text-xs shrink-0" onClick={saveTitle} disabled={saving}>
                  <Save className="mr-1 h-3 w-3" />Save
                </Button>
              </div>
            ) : (
              <button
                type="button"
                className="text-left group min-w-0"
                onClick={startEditTitle}
                title="Click to edit"
              >
                <span className="truncate">{issue.title}</span>
                <Edit2 className="ml-2 inline h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity align-middle" />
              </button>
            )
          }
          subtitle={headerSubtitle}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => {
                loadIssueById(issue.id);
                loadIssueEvents(issue.id);
                loadIssueRuns(issue.id);
                loadIssueComments(issue.id);
              }}>
                <RefreshCw className="mr-1 h-3.5 w-3.5" />Refresh
              </Button>
              <Button
                size="sm"
                onClick={handleRunAgent}
                disabled={hasActiveRun}
                variant={hasActiveRun ? 'outline' : 'default'}
              >
                {hasActiveRun ? (
                  <><Sparkles className="mr-1 h-3.5 w-3.5" />Running…</>
                ) : (
                  <><PlayCircle className="mr-1 h-3.5 w-3.5" />Run agent</>
                )}
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="destructive" size="sm">
                    <Trash2 className="mr-1 h-3.5 w-3.5" />Delete
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete this issue?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will permanently remove the issue, its comments, attachments, and run history. This action cannot be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={handleDelete} disabled={deleting} className="bg-destructive hover:bg-destructive/90">
                      {deleting ? 'Deleting…' : 'Delete issue'}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          }
        />

        {/* Status bar */}
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-3 shadow-sm">
          <IssueStatusBar
            current={issue.status}
            onChange={(s) => updateIssue(issue.id, { status: s }).then((r) => r && showToast('Status updated'))}
            disabled={saving}
          />
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge variant="outline" className={priorityClass(issue.priority)}>
              {priorityLabel(issue.priority)}
            </Badge>
            {issue.last_run_status && (
              <Badge variant="outline">Agent {issue.last_run_status}</Badge>
            )}
            {hasActiveRun && activeRun && (
              <Badge variant="outline" className="border-primary/40 text-primary animate-pulse">
                Running · {formatRunDuration(activeRun)}
              </Badge>
            )}
          </div>
        </div>

        <section className="rounded-xl border bg-card p-4 shadow-sm">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">Orchestration Preview</h3>
              <p className="mt-1 text-xs text-muted-foreground">source: 'issue' · 基于 Registry、Runtime Pool 与策略风险预判自动编排。</p>
            </div>
            {orchestrationDecision && (
              <Badge variant={orchestrationDecision.mode === 'blocked' ? 'destructive' : 'outline'}>
                {orchestrationDecision.mode}
              </Badge>
            )}
          </div>
          {orchestrationDecision ? (
            <div className="grid gap-3 text-xs md:grid-cols-4">
              <div className="rounded-lg border bg-background p-3">
                <div className="text-muted-foreground">Agent</div>
                <div className="mt-1 font-mono text-foreground">{orchestrationDecision.targetAgentId ?? 'manual'}</div>
              </div>
              <div className="rounded-lg border bg-background p-3">
                <div className="text-muted-foreground">Runtime</div>
                <div className="mt-1 font-mono text-foreground">{orchestrationDecision.targetRuntimeId ?? 'blocked'}</div>
              </div>
              <div className="rounded-lg border bg-background p-3">
                <div className="text-muted-foreground">Risk / Approval</div>
                <div className="mt-1 text-foreground">{orchestrationDecision.riskLevel} · approvalRequired: {String(orchestrationDecision.approvalRequired)}</div>
                <div className="mt-1 font-mono text-[11px] text-muted-foreground">{orchestrationDecision.enforcementAction}</div>
              </div>
              <div className="rounded-lg border bg-background p-3">
                <div className="text-muted-foreground">permissionScopes</div>
                <div className="mt-1 text-foreground">{orchestrationDecision.permissionScopes.join(', ') || 'none'}</div>
                <RouterLink to={`/orchestration?source=issue&id=${encodeURIComponent(issue.id)}`} className="mt-2 inline-flex text-[11px] text-primary hover:underline">
                  Open Control Tower
                </RouterLink>
              </div>
              <div className="md:col-span-2 rounded-lg border bg-background p-3">
                <div className="text-muted-foreground">Reasons</div>
                <div className="mt-1 text-foreground">{orchestrationDecision.reasons.join(' · ') || '—'}</div>
              </div>
              <div className="md:col-span-2 rounded-lg border bg-background p-3">
                <div className="text-muted-foreground">Blockers</div>
                <div className="mt-1 text-foreground">{orchestrationDecision.blockers.join(' · ') || 'none'}</div>
              </div>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">正在生成 orchestration preview…</p>
          )}
        </section>

        {/* Main grid: desktop 2-col, mobile 1-col with tabbed sidebar */}
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_max-w-sm] xl:grid-cols-[minmax(0,2fr)_minmax(320px,380px)]">
          {/* LEFT / MAIN column */}
          <div className="space-y-4 min-w-0">
            {/* Pending agent requests (permission / clarification) */}
            {pendingRequests.length > 0 && (
              <section className="space-y-2">
                {pendingRequests.map((req) => (
                  <AgentRequestCard key={req.id} issueId={issue.id} request={req} />
                ))}
              </section>
            )}

            {/* Description section */}
            <section className="rounded-xl border bg-card p-4 shadow-sm">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="flex items-center gap-1.5 text-sm font-semibold">
                  <FileText className="h-4 w-4" />Description
                </h3>
                {!editingDescription && (
                  <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={startEditDescription}>
                    <Edit2 className="mr-1 h-3 w-3" />Edit
                  </Button>
                )}
              </div>
              {editingDescription ? (
                <div className="space-y-2">
                  <Textarea
                    value={descriptionDraft}
                    onChange={(e) => setDescriptionDraft(e.target.value)}
                    rows={10}
                    placeholder="Describe the issue, context, or acceptance criteria… (Markdown supported)"
                    className="resize-y min-h-[200px] text-sm"
                    autoFocus
                  />
                  <div className="flex items-center justify-end gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={() => setEditingDescription(false)}
                      disabled={saving}
                    >
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={saveDescription}
                      disabled={saving}
                    >
                      <Save className="mr-1 h-3 w-3" />{saving ? 'Saving…' : 'Save description'}
                    </Button>
                  </div>
                </div>
              ) : issue.description.trim() ? (
                <div onDoubleClick={startEditDescription} className="cursor-default select-text">
                  <IssueMarkdownViewer>{issue.description}</IssueMarkdownViewer>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={startEditDescription}
                  className="w-full rounded-lg border border-dashed p-4 text-left text-sm text-muted-foreground hover:bg-muted/30"
                >
                  No description yet. Click to add context, requirements, or notes.
                </button>
              )}
            </section>

            {/* Attachments */}
            <section className="rounded-xl border bg-card p-4 shadow-sm lg:hidden">
              <IssueAttachmentsGrid
                attachments={attachments}
                uploadRef={attachmentInputRef}
                addAttachments={addAttachments}
                onDelete={(id) => deleteIssueAttachment(issue.id, id)}
              />
            </section>
            <section className="rounded-xl border bg-card p-4 shadow-sm hidden lg:block">
              <IssueAttachmentsGrid
                attachments={attachments}
                uploadRef={attachmentInputRef}
                addAttachments={addAttachments}
                onDelete={(id) => deleteIssueAttachment(issue.id, id)}
              />
            </section>

            {/* Timeline */}
            <section className="rounded-xl border bg-card p-4 shadow-sm">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="flex items-center gap-1.5 text-sm font-semibold">
                  <History className="h-4 w-4" />
                  Activity
                  <Badge variant="outline" className="h-4 px-1.5 text-[10px] ml-1">
                    {events.length + comments.length}
                  </Badge>
                </h3>
              </div>
              <IssueTimeline
                events={events}
                comments={comments}
                runs={runs}
                attachments={attachments}
                usersMap={usersMap}
                onUpdateComment={handleUpdateComment}
                onDeleteComment={handleDeleteComment}
                currentUserId={currentUser?.id}
                onOpenRun={(runId) => handleToggleRun(runId)}
              />
            </section>

            {/* Comment composer */}
            <IssueCommentComposer
              onSubmit={handleSubmitComment}
              agentQuestion={
                pendingClarification
                  ? (((pendingClarification.payload as Record<string, unknown> | null)?.question as string | undefined) ??
                    pendingClarification.summary ??
                    null)
                  : null
              }
            />
          </div>

          {/* RIGHT column (desktop) or tab (mobile) */}
          <div className="space-y-4 hidden lg:block lg:sticky lg:top-4 lg:self-start">
            {selectedRun && (
              <IssueRunLivePanel
                run={selectedRun}
                events={selectedRunEvents}
                isActive={selectedRun.status === 'queued' || selectedRun.status === 'running'}
                onRefresh={() => {
                  loadIssueRuns(issue.id);
                  loadIssueRunEvents(issue.id, selectedRun.id);
                }}
                onCancel={() => cancelIssueRun(issue.id, selectedRun.id)}
              />
            )}
            {selectedRun && selectedRun.status !== 'queued' && selectedRun.status !== 'running' && (
              <>
                <RepoKnowledgeContextPanel
                  repoKnowledge={repoKnowledge}
                  loading={repoKnowledgeLoadingRunId === selectedRun.id}
                  onLoad={handleLoadSelectedRunRepoKnowledge}
                />
                <RunDiffViewer
                  diff={selectedRunDiff}
                  loading={diffLoadingRunId === selectedRun.id}
                  committing={commitLoadingRunId === selectedRun.id}
                  defaultMessage={selectedRunCommitMessage}
                  onRefresh={() => {
                    setDiffLoadingRunId(selectedRun.id);
                    loadIssueRunDiff(issue.id, selectedRun.id).finally(() => setDiffLoadingRunId(null));
                  }}
                  onCommit={handleCommitSelectedRun}
                />
                <RunDeliveryDraftPanel
                  deliveryDraft={deliveryDraft}
                  pullRequestResult={pullRequestResult}
                  loading={deliveryLoadingRunId === selectedRun.id}
                  creatingPullRequest={pullRequestLoadingRunId === selectedRun.id}
                  runningReview={reviewLoadingRunId === selectedRun.id}
                  onLoad={handleLoadSelectedRunDelivery}
                  onCreatePullRequest={handleCreatePullRequest}
                  onRunReviewAgent={handleRunReviewAgent}
                />
                <RunReleaseGovernancePanel
                  releaseDraft={releaseDraft}
                  loading={releaseLoadingRunId === selectedRun.id}
                  onLoad={handleLoadSelectedRunRelease}
                  onRefreshRelease={handleRefreshSelectedRunRelease}
                />
                <RunProductionHealthPanel
                  productionHealth={productionHealth}
                  loading={productionHealthLoadingRunId === selectedRun.id}
                  onLoad={handleLoadSelectedRunProductionHealth}
                  onRefreshProductionHealth={handleRefreshSelectedRunProductionHealth}
                  onRecordProductionHealthSignal={handleRecordProductionHealthSignal}
                />
                <RunRemediationPanel
                  remediation={remediation}
                  loading={remediationLoadingRunId === selectedRun.id}
                  onLoad={handleLoadSelectedRunRemediation}
                  onRefreshRemediation={handleRefreshSelectedRunRemediation}
                  onRecordRemediationAction={handleRecordRemediationAction}
                />
                <RunIncidentKnowledgePanel
                  incidentKnowledge={incidentKnowledge}
                  loading={incidentKnowledgeLoadingRunId === selectedRun.id}
                  onLoad={handleLoadSelectedRunIncidentKnowledge}
                  onArchive={handleArchiveSelectedRunIncidentKnowledge}
                />
                <RunbookReusePanel
                  runbookReuse={runbookReuse}
                  loading={runbookReuseLoadingRunId === selectedRun.id}
                  applying={runbookReuseApplyingRunId === selectedRun.id}
                  onLoad={handleLoadSelectedRunbookReuse}
                  onApply={handleApplySelectedRunbookReuse}
                />
                <FixRunSpawnerPanel
                  fixRunDraft={fixRunDraft}
                  loading={fixRunDraftLoadingRunId === selectedRun.id}
                  spawning={fixRunSpawningRunId === selectedRun.id}
                  onLoad={handleLoadSelectedFixRunDraft}
                  onSpawn={handleSpawnSelectedFixRun}
                />
                <FixRunOutcomePanel
                  outcome={fixRunOutcome}
                  loading={fixRunOutcomeLoadingRunId === selectedRun.id}
                  verifying={fixRunOutcomeVerifyingRunId === selectedRun.id}
                  onLoad={handleLoadSelectedFixRunOutcome}
                  onVerify={handleVerifySelectedFixRunOutcome}
                />
                <ResolutionGatePanel
                  resolutionGate={resolutionGate}
                  loading={resolutionGateLoadingRunId === selectedRun.id}
                  applying={resolutionGateApplyingRunId === selectedRun.id}
                  onLoad={handleLoadSelectedResolutionGate}
                  onApply={handleApplySelectedResolutionGate}
                />
              </>
            )}
            <IssueMetaPanel issue={issue} onPatch={handlePatch} usersMap={usersMap} loading={saving} />

            {/* Run history */}
            <div className="rounded-xl border bg-card p-4 shadow-sm">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="flex items-center gap-1.5 text-sm font-semibold">
                  <History className="h-4 w-4" />Run history
                </h3>
                <div className="flex items-center gap-1">
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => loadIssueRuns(issue.id)}>
                    <RefreshCw className="mr-1 h-3 w-3" />Refresh
                  </Button>
                  <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={handleRunAgent} disabled={hasActiveRun}>
                    <PlayCircle className="mr-1 h-3 w-3" />New run
                  </Button>
                </div>
              </div>
              {runs.length === 0 ? (
                <p className="rounded-lg border border-dashed p-3 text-center text-xs text-muted-foreground">
                  No agent runs yet. Click "Run agent" to start.
                </p>
              ) : (
                <div className="space-y-2 max-h-[55vh] overflow-auto pr-1">
                  {runs.map((run) => (
                    <RunHistoryRow
                      key={run.id}
                      run={run}
                      events={runEventsByRun[run.id] ?? []}
                      expanded={expandedRunId === run.id}
                      onToggle={() => handleToggleRun(run.id)}
                      onCancel={() => cancelIssueRun(issue.id, run.id)}
                      onRefreshEvents={() => loadIssueRunEvents(issue.id, run.id)}
                    />
                  ))}
                </div>
              )}
            </div>
            <AgentTaskLedgerPanel
              tasks={agentTasks}
              onRefresh={() => loadAgentTasksForIssue(issue.id)}
            />
          </div>

          {/* MOBILE tabs */}
          <div className="lg:hidden">
            <Tabs value={mobileTab} onValueChange={(v) => setMobileTab(v as any)}>
              <TabsList className="w-full">
                <TabsTrigger value="meta" className="flex-1">Meta</TabsTrigger>
                <TabsTrigger value="runs" className="flex-1">Runs</TabsTrigger>
                <TabsTrigger value="attachments" className="flex-1">Files</TabsTrigger>
              </TabsList>
              <TabsContent value="meta" className="mt-3">
                {selectedRun && (
                  <div className="mb-3">
                    <IssueRunLivePanel
                      compact
                      run={selectedRun}
                      events={selectedRunEvents}
                      isActive={selectedRun.status === 'queued' || selectedRun.status === 'running'}
                      onRefresh={() => {
                        loadIssueRuns(issue.id);
                        loadIssueRunEvents(issue.id, selectedRun.id);
                      }}
                      onCancel={() => cancelIssueRun(issue.id, selectedRun.id)}
                    />
                    {selectedRun.status !== 'queued' && selectedRun.status !== 'running' && (
                      <div className="mt-3 space-y-3">
                        <RepoKnowledgeContextPanel
                          repoKnowledge={repoKnowledge}
                          loading={repoKnowledgeLoadingRunId === selectedRun.id}
                          onLoad={handleLoadSelectedRunRepoKnowledge}
                        />
                        <RunDiffViewer
                          diff={selectedRunDiff}
                          loading={diffLoadingRunId === selectedRun.id}
                          committing={commitLoadingRunId === selectedRun.id}
                          defaultMessage={selectedRunCommitMessage}
                          onRefresh={() => {
                            setDiffLoadingRunId(selectedRun.id);
                            loadIssueRunDiff(issue.id, selectedRun.id).finally(() => setDiffLoadingRunId(null));
                          }}
                          onCommit={handleCommitSelectedRun}
                        />
                        <RunDeliveryDraftPanel
                          deliveryDraft={deliveryDraft}
                          pullRequestResult={pullRequestResult}
                          loading={deliveryLoadingRunId === selectedRun.id}
                          creatingPullRequest={pullRequestLoadingRunId === selectedRun.id}
                          runningReview={reviewLoadingRunId === selectedRun.id}
                          onLoad={handleLoadSelectedRunDelivery}
                          onCreatePullRequest={handleCreatePullRequest}
                          onRunReviewAgent={handleRunReviewAgent}
                        />
                        <RunReleaseGovernancePanel
                          releaseDraft={releaseDraft}
                          loading={releaseLoadingRunId === selectedRun.id}
                          onLoad={handleLoadSelectedRunRelease}
                          onRefreshRelease={handleRefreshSelectedRunRelease}
                        />
                        <RunProductionHealthPanel
                          productionHealth={productionHealth}
                          loading={productionHealthLoadingRunId === selectedRun.id}
                          onLoad={handleLoadSelectedRunProductionHealth}
                          onRefreshProductionHealth={handleRefreshSelectedRunProductionHealth}
                          onRecordProductionHealthSignal={handleRecordProductionHealthSignal}
                        />
                        <RunRemediationPanel
                          remediation={remediation}
                          loading={remediationLoadingRunId === selectedRun.id}
                          onLoad={handleLoadSelectedRunRemediation}
                          onRefreshRemediation={handleRefreshSelectedRunRemediation}
                          onRecordRemediationAction={handleRecordRemediationAction}
                        />
                        <RunIncidentKnowledgePanel
                          incidentKnowledge={incidentKnowledge}
                          loading={incidentKnowledgeLoadingRunId === selectedRun.id}
                          onLoad={handleLoadSelectedRunIncidentKnowledge}
                          onArchive={handleArchiveSelectedRunIncidentKnowledge}
                        />
                        <RunbookReusePanel
                          runbookReuse={runbookReuse}
                          loading={runbookReuseLoadingRunId === selectedRun.id}
                          applying={runbookReuseApplyingRunId === selectedRun.id}
                          onLoad={handleLoadSelectedRunbookReuse}
                          onApply={handleApplySelectedRunbookReuse}
                        />
                        <FixRunSpawnerPanel
                          fixRunDraft={fixRunDraft}
                          loading={fixRunDraftLoadingRunId === selectedRun.id}
                          spawning={fixRunSpawningRunId === selectedRun.id}
                          onLoad={handleLoadSelectedFixRunDraft}
                          onSpawn={handleSpawnSelectedFixRun}
                        />
                        <FixRunOutcomePanel
                          outcome={fixRunOutcome}
                          loading={fixRunOutcomeLoadingRunId === selectedRun.id}
                          verifying={fixRunOutcomeVerifyingRunId === selectedRun.id}
                          onLoad={handleLoadSelectedFixRunOutcome}
                          onVerify={handleVerifySelectedFixRunOutcome}
                        />
                        <ResolutionGatePanel
                          resolutionGate={resolutionGate}
                          loading={resolutionGateLoadingRunId === selectedRun.id}
                          applying={resolutionGateApplyingRunId === selectedRun.id}
                          onLoad={handleLoadSelectedResolutionGate}
                          onApply={handleApplySelectedResolutionGate}
                        />
                      </div>
                    )}
                  </div>
                )}
                <IssueMetaPanel issue={issue} onPatch={handlePatch} usersMap={usersMap} loading={saving} />
              </TabsContent>
              <TabsContent value="runs" className="mt-3">
                <div className="rounded-xl border bg-card p-3 shadow-sm">
                  <div className="mb-2 flex items-center justify-between">
                    <h3 className="text-sm font-semibold">Runs ({runs.length})</h3>
                    <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={handleRunAgent} disabled={hasActiveRun}>
                      <PlayCircle className="mr-1 h-3 w-3" />New
                    </Button>
                  </div>
                  {runs.length === 0 ? (
                    <p className="rounded-lg border border-dashed p-3 text-center text-xs text-muted-foreground">No runs yet.</p>
                  ) : (
                    <div className="space-y-2 max-h-[70vh] overflow-auto">
                      {runs.map((run) => (
                        <RunHistoryRow
                          key={run.id}
                          run={run}
                          events={runEventsByRun[run.id] ?? []}
                          expanded={expandedRunId === run.id}
                          onToggle={() => handleToggleRun(run.id)}
                          onCancel={() => cancelIssueRun(issue.id, run.id)}
                          onRefreshEvents={() => loadIssueRunEvents(issue.id, run.id)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              </TabsContent>
              <TabsContent value="attachments" className="mt-3">
                <div className="rounded-xl border bg-card p-3 shadow-sm">
                  <IssueAttachmentsGrid
                    attachments={attachments}
                    uploadRef={attachmentInputRef}
                    addAttachments={addAttachments}
                    onDelete={(id) => deleteIssueAttachment(issue.id, id)}
                  />
                </div>
              </TabsContent>
            </Tabs>
          </div>
        </div>
      </div>
    </div>
  );
}
