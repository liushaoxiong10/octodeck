import type { QualityEvaluation, QualityOutcome } from './quality-evaluator.js';

type IssueDeliveryIssue = {
  id: string;
  title: string;
  description?: string | null;
  project_git_url?: string | null;
};

type IssueDeliveryRun = {
  id: string;
  status: string;
  result?: string | null;
};

type IssueDeliveryDiffFile = {
  path: string;
  status: string;
  additions?: number;
  deletions?: number;
  patch?: string;
};

type IssueDeliveryDiff = {
  branch?: string;
  head?: string;
  clean: boolean;
  files: IssueDeliveryDiffFile[];
  diffStat?: string;
};

type IssueDeliveryCommit = {
  branch?: string;
  commit?: string;
  filesCommitted?: number;
};

export type IssueRunPullRequestDraft = {
  title: string;
  body: string;
  sourceBranch: string;
  targetBranch: string;
  changedFiles: string[];
  provider?: 'github' | 'gitlab' | 'codebase' | 'unknown';
  repositoryUrl?: string;
  createUrl?: string;
};

export type IssueRunReviewDraft = {
  reviewPrompt: string;
  comments: Array<{
    filePath: string;
    line?: number;
    severity: 'low' | 'medium' | 'high' | 'critical';
    confidence: 'low' | 'medium' | 'high';
    category: 'correctness' | 'security' | 'performance' | 'maintainability' | 'review_required';
    body: string;
  }>;
};

export type IssueRunDeliveryState = {
  stage: 'no_changes' | 'blocked_by_quality' | 'review_required' | 'diff_ready' | 'commit_ready' | 'proposal_ready' | 'delivered';
  nextAction: 'inspect_diff' | 'commit_changes' | 'create_pr_or_mr' | 'none';
  clean: boolean;
  hasCommit: boolean;
  hasPullRequestEntrypoint: boolean;
  hasReviewComments: boolean;
  qualityGate: {
    outcome: QualityOutcome | 'not_evaluated';
    allowed: boolean;
    score?: number;
    failureCategory?: string | null;
    reason?: string;
  };
  checklist: Array<{
    id: 'quality' | 'diff' | 'commit' | 'pull_request' | 'review';
    label: string;
    status: 'pending' | 'ready' | 'blocked';
    detail?: string;
  }>;
};

function normalizeGitRepoUrl(gitUrl?: string | null): { provider: 'github' | 'gitlab' | 'unknown'; repositoryUrl?: string } {
  if (!gitUrl) return { provider: 'unknown' };
  const trimmed = gitUrl.trim();
  const https = /^(https?):\/\/([^/]+)\/(.+?)(?:\.git)?(?:[#?].*)?$/.exec(trimmed);
  if (https) {
    const host = https[2];
    const path = https[3].replace(/\/+$/, '');
    return {
      provider: host === 'github.com' ? 'github' : 'gitlab',
      repositoryUrl: `${https[1]}://${host}/${path}`,
    };
  }
  const ssh = /^git@([^:]+):(.+?)(?:\.git)?$/.exec(trimmed);
  if (ssh) {
    const host = ssh[1];
    const path = ssh[2].replace(/\/+$/, '');
    return {
      provider: host === 'github.com' ? 'github' : 'gitlab',
      repositoryUrl: `https://${host}/${path}`,
    };
  }
  return { provider: 'unknown' };
}

export function buildPullRequestCreateUrl(input: {
  repositoryUrl?: string | null;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  body: string;
}): { provider: 'github' | 'gitlab' | 'unknown'; repositoryUrl?: string; createUrl?: string } {
  const repo = normalizeGitRepoUrl(input.repositoryUrl);
  if (!repo.repositoryUrl || !input.sourceBranch) return repo;
  if (repo.provider === 'github') {
    const params = new URLSearchParams({
      quick_pull: '1',
      title: input.title,
      body: input.body,
    });
    return {
      ...repo,
      createUrl: `${repo.repositoryUrl}/compare/${encodeURIComponent(input.targetBranch)}...${encodeURIComponent(input.sourceBranch)}?${params.toString()}`,
    };
  }
  if (repo.provider === 'gitlab') {
    const mrParams = new URLSearchParams({
      'merge_request[source_branch]': input.sourceBranch,
      'merge_request[target_branch]': input.targetBranch,
      'merge_request[title]': input.title,
      'merge_request[description]': input.body,
    });
    return {
      ...repo,
      createUrl: `${repo.repositoryUrl}/-/merge_requests/new?${mrParams.toString()}`,
    };
  }
  return repo;
}

export function buildIssueRunPullRequestDraft(input: {
  issue: IssueDeliveryIssue;
  run: IssueDeliveryRun;
  diff: IssueDeliveryDiff;
  commit?: IssueDeliveryCommit | null;
  qualityEvaluation?: Pick<QualityEvaluation, 'outcome' | 'score' | 'failureCategory' | 'reasons'> | null;
  targetBranch?: string;
}): IssueRunPullRequestDraft {
  const changedFiles = input.diff.files.map((file) => file.path);
  const sourceBranch = input.commit?.branch ?? input.diff.branch ?? '';
  const commitHash = input.commit?.commit ?? '';
  const fileList = changedFiles.length
    ? changedFiles.map((path) => `- ${path}`).join('\n')
    : '- No changed files reported';
  const body = [
    `## Issue`,
    `- ID: ${input.issue.id}`,
    `- Title: ${input.issue.title}`,
    input.issue.description ? `- Description: ${input.issue.description}` : undefined,
    input.issue.project_git_url ? `- Repository: ${input.issue.project_git_url}` : undefined,
    '',
    `## Run`,
    `- Run ID: ${input.run.id}`,
    `- Status: ${input.run.status}`,
    input.run.result ? `- Result: ${input.run.result}` : undefined,
    '',
    `## Commit`,
    `- Branch: ${sourceBranch || 'unknown'}`,
    `- Commit: ${commitHash || 'unknown'}`,
    `- Files committed: ${input.commit?.filesCommitted ?? 0}`,
    input.qualityEvaluation
      ? [
          '',
          `## Quality Gate`,
          `- Outcome: ${input.qualityEvaluation.outcome}`,
          `- Score: ${input.qualityEvaluation.score}`,
          input.qualityEvaluation.failureCategory ? `- Failure category: ${input.qualityEvaluation.failureCategory}` : undefined,
          input.qualityEvaluation.reasons[0] ? `- Reason: ${input.qualityEvaluation.reasons[0]}` : undefined,
        ]
      : undefined,
    '',
    `## Changed files`,
    fileList,
    input.diff.diffStat ? ['', `## Diff stat`, '```', input.diff.diffStat, '```'] : undefined,
  ]
    .flat()
    .filter((line): line is string => line !== undefined)
    .join('\n');
  const providerLink = buildPullRequestCreateUrl({
    repositoryUrl: input.issue.project_git_url,
    sourceBranch,
    targetBranch: input.targetBranch ?? 'main',
    title: input.issue.title,
    body,
  });

  return {
    title: input.issue.title,
    sourceBranch,
    targetBranch: input.targetBranch ?? 'main',
    changedFiles,
    body,
    provider: providerLink.provider,
    repositoryUrl: providerLink.repositoryUrl,
    createUrl: providerLink.createUrl,
  };
}

function firstNewLineFromPatch(patch?: string): number | undefined {
  if (!patch) return undefined;
  const match = /@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(patch);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

export function buildIssueRunReviewDraft(input: {
  issue: IssueDeliveryIssue;
  run: IssueDeliveryRun;
  diff: IssueDeliveryDiff;
}): IssueRunReviewDraft {
  const fileSections = input.diff.files.map((file) => {
    const stats = [
      file.status,
      file.additions !== undefined ? `+${file.additions}` : undefined,
      file.deletions !== undefined ? `-${file.deletions}` : undefined,
    ]
      .filter(Boolean)
      .join(' ');
    return [
      `### ${file.path}`,
      stats ? `Status: ${stats}` : undefined,
      file.patch ? ['```diff', file.patch, '```'].join('\n') : '_No per-file patch available._',
    ]
      .filter((line): line is string => line !== undefined)
      .join('\n');
  });
  const comments = input.diff.files.map((file) => ({
    filePath: file.path,
    line: firstNewLineFromPatch(file.patch),
    severity: 'medium' as const,
    confidence: 'medium' as const,
    category: 'review_required' as const,
    body: [
      `Review Agent should inspect ${file.path} for correctness, regressions, safety, and maintainability.`,
      `Status: ${file.status}`,
      file.additions !== undefined || file.deletions !== undefined
        ? `Change size: +${file.additions ?? 0} / -${file.deletions ?? 0}`
        : undefined,
    ]
      .filter((line): line is string => line !== undefined)
      .join('\n'),
  }));

  return {
    reviewPrompt: [
      `Review the Issue Run changes for correctness, regressions, safety, and maintainability.`,
      '',
      `Issue: ${input.issue.title}`,
      `Issue ID: ${input.issue.id}`,
      input.issue.description ? `Description: ${input.issue.description}` : undefined,
      '',
      `Run ID: ${input.run.id}`,
      `Run status: ${input.run.status}`,
      input.run.result ? `Run result: ${input.run.result}` : undefined,
      '',
      input.diff.diffStat ? ['Diff stat:', '```', input.diff.diffStat, '```'].join('\n') : undefined,
      '',
      `Changed files and patches:`,
      fileSections.join('\n\n'),
    ]
      .filter((line): line is string => line !== undefined)
      .join('\n'),
    comments,
  };
}

export function buildIssueRunDeliveryState(input: {
  diff: IssueDeliveryDiff;
  commit?: IssueDeliveryCommit | null;
  pullRequestDraft: IssueRunPullRequestDraft;
  reviewDraft: IssueRunReviewDraft;
  qualityEvaluation?: Pick<QualityEvaluation, 'outcome' | 'score' | 'failureCategory' | 'reasons'> | null;
}): IssueRunDeliveryState {
  const hasDiff = input.diff.files.length > 0 && !input.diff.clean;
  const hasCommit = Boolean(input.commit?.commit);
  const hasPullRequestEntrypoint = Boolean(input.pullRequestDraft.createUrl || input.pullRequestDraft.repositoryUrl);
  const hasReviewComments = input.reviewDraft.comments.length > 0;
  const prReady = hasCommit && hasPullRequestEntrypoint;
  const quality = input.qualityEvaluation ?? null;
  const qualityReason = quality?.reasons[0];
  const qualityGate: IssueRunDeliveryState['qualityGate'] = quality
    ? {
        outcome: quality.outcome,
        allowed: quality.outcome === 'passed',
        score: quality.score,
        failureCategory: quality.failureCategory,
        reason: qualityReason,
      }
    : { outcome: 'not_evaluated', allowed: true, reason: 'Quality gate not evaluated' };
  const qualityBlocked = quality?.outcome === 'failed';
  const qualityReviewRequired = quality?.outcome === 'needs_review' || quality?.outcome === 'partial' || quality?.outcome === 'inconclusive';
  const stage: IssueRunDeliveryState['stage'] = qualityBlocked
    ? 'blocked_by_quality'
    : qualityReviewRequired
      ? 'review_required'
      : prReady && hasReviewComments
          ? 'proposal_ready'
          : hasCommit
            ? 'commit_ready'
            : !hasDiff
              ? 'no_changes'
              : 'diff_ready';
  const nextAction: IssueRunDeliveryState['nextAction'] = stage === 'blocked_by_quality' || stage === 'no_changes'
    ? 'none'
    : stage === 'review_required'
      ? 'inspect_diff'
      : !hasCommit
        ? 'commit_changes'
        : hasPullRequestEntrypoint
          ? 'create_pr_or_mr'
          : 'none';
  const deliveryBlocked = stage === 'blocked_by_quality' || stage === 'review_required';

  return {
    stage,
    nextAction,
    clean: input.diff.clean,
    hasCommit,
    hasPullRequestEntrypoint,
    hasReviewComments,
    qualityGate,
    checklist: [
      {
        id: 'quality',
        label: 'Quality gate',
        status: deliveryBlocked ? 'blocked' : 'ready',
        detail: quality
          ? `${quality.outcome} · score ${quality.score}${qualityReason ? ` · ${qualityReason}` : ''}`
          : 'No quality evaluation attached; delivery actions remain manual',
      },
      {
        id: 'diff',
        label: 'Diff snapshot',
        status: hasDiff ? 'ready' : 'pending',
        detail: hasDiff ? `${input.diff.files.length} changed file(s)` : 'No changed files reported',
      },
      {
        id: 'commit',
        label: 'Commit',
        status: deliveryBlocked ? 'blocked' : hasCommit ? 'ready' : hasDiff ? 'pending' : 'blocked',
        detail: hasCommit ? input.commit?.commit : 'Create a commit before opening a PR/MR',
      },
      {
        id: 'pull_request',
        label: 'PR / MR entrypoint',
        status: deliveryBlocked ? 'blocked' : prReady ? 'ready' : hasCommit ? 'pending' : 'blocked',
        detail: hasPullRequestEntrypoint
          ? input.pullRequestDraft.createUrl ?? input.pullRequestDraft.repositoryUrl
          : 'Repository URL is unavailable',
      },
      {
        id: 'review',
        label: 'Review draft',
        status: hasReviewComments ? 'ready' : hasDiff ? 'pending' : 'blocked',
        detail: hasReviewComments ? `${input.reviewDraft.comments.length} structured comment(s)` : 'No review comments generated',
      },
    ],
  };
}
