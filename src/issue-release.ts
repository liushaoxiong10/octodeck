import type { IssueRunDeliveryState } from './issue-delivery.js';
import type { CreatePullRequestResult, GitPullRequestProvider } from './git-provider.js';

export type IssueRunReleaseStage =
  | 'not_started'
  | 'pr_created'
  | 'checks_pending'
  | 'checks_failed'
  | 'review_pending'
  | 'merge_ready'
  | 'merged'
  | 'post_merge_verifying'
  | 'released'
  | 'rollback_required';

export type IssueRunReleaseNextAction =
  | 'create_pr_or_mr'
  | 'wait_for_checks'
  | 'fix_checks'
  | 'request_review'
  | 'merge_pr_or_mr'
  | 'verify_release'
  | 'inspect_release'
  | 'none';

export interface IssueRunReleaseCheck {
  name: string;
  status: 'queued' | 'in_progress' | 'completed' | 'unknown';
  conclusion?: 'success' | 'failure' | 'cancelled' | 'skipped' | 'neutral' | 'timed_out' | 'unknown' | null;
  url?: string;
}

export interface IssueRunReleaseReview {
  reviewer?: string;
  state: 'approved' | 'changes_requested' | 'commented' | 'pending' | 'unknown';
  url?: string;
}

export interface IssueRunPullRequestStatus {
  ok: boolean;
  provider: GitPullRequestProvider;
  url?: string;
  number?: number;
  id?: string;
  state?: 'open' | 'closed' | 'merged' | 'unknown';
  mergeable?: boolean | null;
  checks: IssueRunReleaseCheck[];
  reviews: IssueRunReleaseReview[];
  mergedAt?: string | null;
  headSha?: string | null;
  targetBranch?: string | null;
  error?: string;
}

export interface IssueRunReleaseState {
  stage: IssueRunReleaseStage;
  nextAction: IssueRunReleaseNextAction;
  mergeable: boolean;
  pullRequest: {
    provider: GitPullRequestProvider;
    url?: string;
    number?: number;
    state?: string;
  } | null;
  checks: {
    total: number;
    pending: number;
    failed: number;
    passed: number;
    items: IssueRunReleaseCheck[];
  };
  review: {
    required: boolean;
    approved: boolean;
    changesRequested: boolean;
    items: IssueRunReleaseReview[];
  };
  releaseGate: {
    allowed: boolean;
    reason?: string;
  };
  checklist: Array<{
    id: 'pull_request' | 'checks' | 'review' | 'mergeability' | 'post_merge';
    label: string;
    status: 'pending' | 'ready' | 'blocked';
    detail?: string;
  }>;
}

function checkFailed(check: IssueRunReleaseCheck): boolean {
  return check.status === 'completed' && !checkPassed(check);
}

function checkPassed(check: IssueRunReleaseCheck): boolean {
  return check.status === 'completed' && ['success', 'skipped', 'neutral'].includes(check.conclusion ?? 'unknown');
}

export function buildIssueRunReleaseState(input: {
  deliveryState: IssueRunDeliveryState;
  pullRequest?: CreatePullRequestResult | null;
  providerStatus?: IssueRunPullRequestStatus | null;
  postMergeVerification?: { ok: boolean; summary?: string | null } | null;
}): IssueRunReleaseState {
  const pullRequest = input.providerStatus ?? input.pullRequest ?? null;
  const hasPullRequest = Boolean(pullRequest?.url || pullRequest?.number || pullRequest?.id);
  const checks = input.providerStatus?.checks ?? [];
  const reviews = input.providerStatus?.reviews ?? [];
  const failedChecks = checks.filter(checkFailed).length;
  const pendingChecks = checks.filter((check) => check.status !== 'completed').length;
  const passedChecks = checks.filter(checkPassed).length;
  const changesRequested = reviews.some((review) => review.state === 'changes_requested');
  const pendingReview = reviews.some((review) => review.state === 'pending' || review.state === 'unknown');
  const approved = reviews.some((review) => review.state === 'approved') && !pendingReview && !changesRequested;
  const merged = input.providerStatus?.state === 'merged' || Boolean(input.providerStatus?.mergedAt);
  const mergeable = Boolean(input.providerStatus?.mergeable);

  let stage: IssueRunReleaseStage = 'not_started';
  let nextAction: IssueRunReleaseNextAction = 'create_pr_or_mr';
  let gateAllowed = false;
  let reason = hasPullRequest ? 'Pull request created' : 'Create a PR/MR before release governance';

  if (!hasPullRequest) {
    stage = 'not_started';
    nextAction = input.deliveryState.nextAction === 'create_pr_or_mr' ? 'create_pr_or_mr' : 'none';
  } else if (merged && input.postMergeVerification?.ok === false) {
    stage = 'rollback_required';
    nextAction = 'inspect_release';
    reason = input.postMergeVerification.summary ?? 'Post-merge verification failed';
  } else if (merged && input.postMergeVerification?.ok === true) {
    stage = 'released';
    nextAction = 'none';
    gateAllowed = true;
    reason = input.postMergeVerification.summary ?? 'Released';
  } else if (merged) {
    stage = 'merged';
    nextAction = 'verify_release';
    gateAllowed = true;
    reason = 'PR/MR merged; verify release';
  } else if (failedChecks > 0) {
    stage = 'checks_failed';
    nextAction = 'fix_checks';
    reason = `${failedChecks} check(s) failed`;
  } else if (pendingChecks > 0 || checks.length === 0) {
    stage = 'checks_pending';
    nextAction = 'wait_for_checks';
    reason = checks.length === 0 ? 'No provider checks reported yet' : `${pendingChecks} check(s) pending`;
  } else if (changesRequested || pendingReview || (reviews.length > 0 && !approved)) {
    stage = 'review_pending';
    nextAction = 'request_review';
    reason = changesRequested ? 'Changes requested by reviewer' : 'Review approval pending';
  } else if (mergeable) {
    stage = 'merge_ready';
    nextAction = 'merge_pr_or_mr';
    gateAllowed = true;
    reason = 'Checks passed and PR/MR is mergeable';
  } else {
    stage = 'pr_created';
    nextAction = 'wait_for_checks';
    reason = 'PR/MR created; waiting for mergeability';
  }

  const pullRequestStatus = hasPullRequest ? 'ready' : 'pending';
  const checksStatus = !hasPullRequest ? 'blocked' : failedChecks > 0 ? 'blocked' : pendingChecks > 0 || checks.length === 0 ? 'pending' : 'ready';
  const reviewStatus = !hasPullRequest ? 'blocked' : changesRequested ? 'blocked' : pendingReview ? 'pending' : reviews.length === 0 || approved ? 'ready' : 'pending';
  const mergeabilityStatus = !hasPullRequest ? 'blocked' : mergeable || merged ? 'ready' : failedChecks > 0 || changesRequested ? 'blocked' : 'pending';
  const postMergeStatus = stage === 'released' ? 'ready' : stage === 'rollback_required' ? 'blocked' : merged ? 'pending' : 'blocked';

  return {
    stage,
    nextAction,
    mergeable,
    pullRequest: hasPullRequest
      ? {
          provider: pullRequest!.provider,
          url: pullRequest!.url,
          number: pullRequest!.number,
          state: input.providerStatus?.state,
        }
      : null,
    checks: { total: checks.length, pending: pendingChecks, failed: failedChecks, passed: passedChecks, items: checks },
    review: { required: reviews.length > 0, approved, changesRequested, items: reviews },
    releaseGate: { allowed: gateAllowed, reason },
    checklist: [
      { id: 'pull_request', label: 'PR / MR', status: pullRequestStatus, detail: pullRequest?.url ?? pullRequest?.error ?? 'No PR/MR recorded' },
      { id: 'checks', label: 'Checks', status: checksStatus, detail: checks.length ? `${passedChecks}/${checks.length} passed` : 'No checks reported' },
      { id: 'review', label: 'Review', status: reviewStatus, detail: reviews.length ? `${reviews.length} review(s)` : 'No review requirements reported' },
      { id: 'mergeability', label: 'Mergeability', status: mergeabilityStatus, detail: mergeable ? 'Mergeable' : 'Not mergeable yet' },
      { id: 'post_merge', label: 'Post-merge verification', status: postMergeStatus, detail: input.postMergeVerification?.summary ?? 'Verify after merge' },
    ],
  };
}
