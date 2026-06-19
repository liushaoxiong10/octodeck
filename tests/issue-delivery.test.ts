import { describe, expect, test } from 'vitest';

import {
  buildIssueRunDeliveryState,
  buildIssueRunPullRequestDraft,
  buildIssueRunReviewDraft,
} from '../src/issue-delivery.js';

describe('issue delivery drafts', () => {
  const issue = {
    id: 'iss_1234567890ab',
    title: '修复登录重试',
    description: '登录失败后应提示重试',
    project_git_url: 'https://github.com/acme/app.git',
  };
  const run = {
    id: 'run_123',
    status: 'success',
    result: '已修复登录重试逻辑',
  };
  const diff = {
    ok: true,
    branch: 'octodeck/issue-run-123',
    head: 'abc1234',
    clean: false,
    files: [
      {
        path: 'src/login.ts',
        status: 'modified',
        additions: 8,
        deletions: 2,
        patch: '@@ -1 +1 @@\n-old retry\n+new retry',
      },
    ],
    diffStat: ' src/login.ts | 10 +++++++---',
    durationMs: 10,
    error: null,
  };

  test('builds a pull request draft from issue, run, commit, and diff', () => {
    const draft = buildIssueRunPullRequestDraft({
      issue,
      run,
      diff,
      commit: { commit: 'abc1234', branch: 'octodeck/issue-run-123', filesCommitted: 1 },
    });

    expect(draft.title).toBe('修复登录重试');
    expect(draft.sourceBranch).toBe('octodeck/issue-run-123');
    expect(draft.targetBranch).toBe('main');
    expect(draft.changedFiles).toEqual(['src/login.ts']);
    expect(draft.body).toContain('iss_1234567890ab');
    expect(draft.body).toContain('abc1234');
    expect(draft.body).toContain('src/login.ts');
  });

  test('includes quality gate result in pull request draft when available', () => {
    const draft = buildIssueRunPullRequestDraft({
      issue,
      run,
      diff,
      commit: { commit: 'abc1234', branch: 'octodeck/issue-run-123', filesCommitted: 1 },
      qualityEvaluation: {
        id: 'quality:issue:iss_1234567890ab:run_123',
        source: 'issue',
        sourceId: issue.id,
        runId: run.id,
        outcome: 'passed',
        confidence: 'high',
        score: 94,
        failureCategory: null,
        needsReview: false,
        evidence: [],
        reasons: ['Run completed with verification evidence'],
        createdAt: '2026-06-15T00:00:00.000Z',
      },
    });

    expect(draft.body).toContain('## Quality Gate');
    expect(draft.body).toContain('- Outcome: passed');
    expect(draft.body).toContain('- Score: 94');
    expect(draft.body).toContain('- Reason: Run completed with verification evidence');
  });

  test('builds a GitHub create pull request URL from repository and branch metadata', () => {
    const draft = buildIssueRunPullRequestDraft({
      issue,
      run,
      diff,
      commit: { commit: 'abc1234', branch: 'octodeck/issue-run-123', filesCommitted: 1 },
    });

    expect(draft.provider).toBe('github');
    expect(draft.createUrl).toContain('https://github.com/acme/app/compare/main...octodeck%2Fissue-run-123');
    expect(draft.createUrl).toContain('quick_pull=1');
    expect(draft.createUrl).toContain('title=');
    expect(draft.createUrl).toContain('body=');
  });

  test('builds a self-hosted GitLab merge request URL without assuming GitHub', () => {
    const draft = buildIssueRunPullRequestDraft({
      issue: {
        ...issue,
        project_git_url: 'https://git.example.com/platform/app.git',
      },
      run,
      diff,
      commit: { commit: 'abc1234', branch: 'octodeck/issue-run-123', filesCommitted: 1 },
    });

    expect(draft.provider).toBe('gitlab');
    expect(draft.repositoryUrl).toBe('https://git.example.com/platform/app');
    expect(draft.createUrl).toContain('https://git.example.com/platform/app/-/merge_requests/new');
    expect(draft.createUrl).toContain('merge_request%5Bsource_branch%5D=octodeck%2Fissue-run-123');
    expect(draft.createUrl).not.toContain('github.com');
  });

  test('builds a review draft prompt grounded in per-file patches', () => {
    const review = buildIssueRunReviewDraft({ issue, run, diff });

    expect(review.reviewPrompt).toContain('修复登录重试');
    expect(review.reviewPrompt).toContain('src/login.ts');
    expect(review.reviewPrompt).toContain('+new retry');
  });

  test('builds structured review comments for changed files', () => {
    const review = buildIssueRunReviewDraft({ issue, run, diff });

    expect(review.comments).toHaveLength(1);
    expect(review.comments[0]).toMatchObject({
      filePath: 'src/login.ts',
      line: 1,
      severity: 'medium',
      confidence: 'medium',
      category: 'review_required',
    });
    expect(review.comments[0].body).toContain('Review Agent');
    expect(review.comments[0].body).toContain('src/login.ts');
  });

  test('builds a delivery state for uncommitted diff that blocks PR creation until commit', () => {
    const pullRequestDraft = buildIssueRunPullRequestDraft({ issue, run, diff });
    const reviewDraft = buildIssueRunReviewDraft({ issue, run, diff });

    const state = buildIssueRunDeliveryState({ diff, pullRequestDraft, reviewDraft });

    expect(state.stage).toBe('diff_ready');
    expect(state.nextAction).toBe('commit_changes');
    expect(state.hasCommit).toBe(false);
    expect(state.hasPullRequestEntrypoint).toBe(true);
    expect(state.checklist.map((item) => [item.id, item.status])).toEqual([
      ['quality', 'ready'],
      ['diff', 'ready'],
      ['commit', 'pending'],
      ['pull_request', 'blocked'],
      ['review', 'ready'],
    ]);
  });

  test('builds a delivery state for committed changes ready for PR/MR handoff', () => {
    const commit = { commit: 'abc1234', branch: 'octodeck/issue-run-123', filesCommitted: 1 };
    const pullRequestDraft = buildIssueRunPullRequestDraft({ issue, run, diff, commit });
    const reviewDraft = buildIssueRunReviewDraft({ issue, run, diff });

    const state = buildIssueRunDeliveryState({ diff, commit, pullRequestDraft, reviewDraft });

    expect(state.stage).toBe('proposal_ready');
    expect(state.nextAction).toBe('create_pr_or_mr');
    expect(state.hasCommit).toBe(true);
    expect(state.checklist.map((item) => [item.id, item.status])).toEqual([
      ['quality', 'ready'],
      ['diff', 'ready'],
      ['commit', 'ready'],
      ['pull_request', 'ready'],
      ['review', 'ready'],
    ]);
  });

  test('blocks delivery when quality gate failed', () => {
    const pullRequestDraft = buildIssueRunPullRequestDraft({ issue, run, diff });
    const reviewDraft = buildIssueRunReviewDraft({ issue, run, diff });

    const state = buildIssueRunDeliveryState({
      diff,
      pullRequestDraft,
      reviewDraft,
      qualityEvaluation: {
        id: 'quality:issue:iss_1234567890ab:run_123',
        source: 'issue',
        sourceId: issue.id,
        runId: run.id,
        outcome: 'failed',
        confidence: 'high',
        score: 20,
        failureCategory: 'test_failure',
        needsReview: true,
        evidence: [],
        reasons: ['Terminal status indicates failure: error'],
        createdAt: '2026-06-15T00:00:00.000Z',
      },
    });

    expect(state).toMatchObject({
      stage: 'blocked_by_quality',
      nextAction: 'none',
      qualityGate: {
        outcome: 'failed',
        allowed: false,
        reason: 'Terminal status indicates failure: error',
      },
    });
    expect(state.checklist.map((item) => [item.id, item.status])).toEqual([
      ['quality', 'blocked'],
      ['diff', 'ready'],
      ['commit', 'blocked'],
      ['pull_request', 'blocked'],
      ['review', 'ready'],
    ]);
  });

  test('requires review before delivery when quality gate needs review', () => {
    const pullRequestDraft = buildIssueRunPullRequestDraft({ issue, run, diff });
    const reviewDraft = buildIssueRunReviewDraft({ issue, run, diff });

    const state = buildIssueRunDeliveryState({
      diff,
      pullRequestDraft,
      reviewDraft,
      qualityEvaluation: {
        id: 'quality:issue:iss_1234567890ab:run_123',
        source: 'issue',
        sourceId: issue.id,
        runId: run.id,
        outcome: 'needs_review',
        confidence: 'medium',
        score: 62,
        failureCategory: 'missing_verification',
        needsReview: true,
        evidence: [],
        reasons: ['Code changes were detected without verification evidence'],
        createdAt: '2026-06-15T00:00:00.000Z',
      },
    });

    expect(state).toMatchObject({
      stage: 'review_required',
      nextAction: 'inspect_diff',
      qualityGate: {
        outcome: 'needs_review',
        allowed: false,
        reason: 'Code changes were detected without verification evidence',
      },
    });
    expect(state.checklist[0]).toMatchObject({ id: 'quality', status: 'blocked' });
  });
});
