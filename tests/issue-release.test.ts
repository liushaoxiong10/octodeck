import { describe, expect, test } from 'vitest';

import { buildIssueRunReleaseState } from '../src/issue-release.js';

describe('issue release governance state', () => {
  const deliveryState = {
    stage: 'proposal_ready' as const,
    nextAction: 'create_pr_or_mr' as const,
    clean: false,
    hasCommit: true,
    hasPullRequestEntrypoint: true,
    hasReviewComments: true,
    qualityGate: { outcome: 'passed' as const, allowed: true, score: 94 },
    checklist: [],
  };

  test('blocks release when provider checks failed', () => {
    const state = buildIssueRunReleaseState({
      deliveryState,
      pullRequest: { ok: true, provider: 'github', url: 'https://github.com/acme/app/pull/42', number: 42 },
      providerStatus: {
        ok: true,
        provider: 'github',
        url: 'https://github.com/acme/app/pull/42',
        number: 42,
        state: 'open',
        mergeable: true,
        checks: [{ name: 'test', status: 'completed', conclusion: 'failure' }],
        reviews: [{ reviewer: 'bot', state: 'approved' }],
      },
    });

    expect(state).toMatchObject({
      stage: 'checks_failed',
      nextAction: 'fix_checks',
      releaseGate: { allowed: false, reason: '1 check(s) failed' },
    });
    expect(state.checklist.map((item) => [item.id, item.status])).toEqual([
      ['pull_request', 'ready'],
      ['checks', 'blocked'],
      ['review', 'ready'],
      ['mergeability', 'ready'],
      ['post_merge', 'blocked'],
    ]);
  });

  test('blocks release on completed checks with unknown non-success conclusions', () => {
    const state = buildIssueRunReleaseState({
      deliveryState,
      pullRequest: { ok: true, provider: 'github', url: 'https://github.com/acme/app/pull/42', number: 42 },
      providerStatus: {
        ok: true,
        provider: 'github',
        url: 'https://github.com/acme/app/pull/42',
        number: 42,
        state: 'open',
        mergeable: true,
        checks: [{ name: 'required-workflow', status: 'completed', conclusion: 'unknown' }],
        reviews: [{ reviewer: 'maintainer', state: 'approved' }],
      },
    });

    expect(state).toMatchObject({
      stage: 'checks_failed',
      nextAction: 'fix_checks',
      releaseGate: { allowed: false, reason: '1 check(s) failed' },
    });
  });

  test('marks release as merge-ready when checks and reviews pass', () => {
    const state = buildIssueRunReleaseState({
      deliveryState,
      pullRequest: { ok: true, provider: 'gitlab', url: 'https://git.example.com/acme/app/-/merge_requests/7', number: 7 },
      providerStatus: {
        ok: true,
        provider: 'gitlab',
        url: 'https://git.example.com/acme/app/-/merge_requests/7',
        number: 7,
        state: 'open',
        mergeable: true,
        checks: [{ name: 'pipeline', status: 'completed', conclusion: 'success' }],
        reviews: [{ reviewer: 'maintainer', state: 'approved' }],
      },
    });

    expect(state).toMatchObject({
      stage: 'merge_ready',
      nextAction: 'merge_pr_or_mr',
      mergeable: true,
      releaseGate: { allowed: true },
    });
  });

  test('keeps release review pending while required approvals are missing', () => {
    const state = buildIssueRunReleaseState({
      deliveryState,
      pullRequest: { ok: true, provider: 'gitlab', url: 'https://git.example.com/acme/app/-/merge_requests/7', number: 7 },
      providerStatus: {
        ok: true,
        provider: 'gitlab',
        url: 'https://git.example.com/acme/app/-/merge_requests/7',
        number: 7,
        state: 'open',
        mergeable: true,
        checks: [{ name: 'pipeline', status: 'completed', conclusion: 'success' }],
        reviews: [
          { reviewer: 'maintainer', state: 'approved' },
          { reviewer: '1 approval(s) pending', state: 'pending' },
        ],
      },
    });

    expect(state).toMatchObject({
      stage: 'review_pending',
      nextAction: 'request_review',
      review: { approved: false },
      releaseGate: { allowed: false },
    });
  });

  test('marks merged pull requests as released after post-merge verification passes', () => {
    const state = buildIssueRunReleaseState({
      deliveryState,
      pullRequest: { ok: true, provider: 'github', url: 'https://github.com/acme/app/pull/42', number: 42 },
      providerStatus: {
        ok: true,
        provider: 'github',
        url: 'https://github.com/acme/app/pull/42',
        number: 42,
        state: 'merged',
        mergeable: false,
        mergedAt: '2026-06-15T10:00:00.000Z',
        checks: [{ name: 'post-merge', status: 'completed', conclusion: 'success' }],
        reviews: [{ reviewer: 'maintainer', state: 'approved' }],
      },
      postMergeVerification: { ok: true, summary: 'main branch build passed' },
    });

    expect(state).toMatchObject({
      stage: 'released',
      nextAction: 'none',
      releaseGate: { allowed: true, reason: 'main branch build passed' },
    });
  });

  test('requires rollback when post-merge verification fails', () => {
    const state = buildIssueRunReleaseState({
      deliveryState,
      pullRequest: { ok: true, provider: 'github', url: 'https://github.com/acme/app/pull/42', number: 42 },
      providerStatus: {
        ok: true,
        provider: 'github',
        url: 'https://github.com/acme/app/pull/42',
        number: 42,
        state: 'merged',
        mergeable: false,
        mergedAt: '2026-06-15T10:00:00.000Z',
        checks: [{ name: 'post-merge', status: 'completed', conclusion: 'success' }],
        reviews: [{ reviewer: 'maintainer', state: 'approved' }],
      },
      postMergeVerification: { ok: false, summary: 'smoke test failed' },
    });

    expect(state).toMatchObject({
      stage: 'rollback_required',
      nextAction: 'inspect_release',
      releaseGate: { allowed: false, reason: 'smoke test failed' },
    });
  });
});
