import { describe, expect, test, vi } from 'vitest';

import {
  createIssueRunPullRequest,
  getIssueRunPullRequestStatus,
  resolveGitProvider,
  type CreatePullRequestInput,
} from '../src/git-provider.js';

describe('git provider pull request creation', () => {
  const input: CreatePullRequestInput = {
    repositoryUrl: 'https://github.com/acme/app',
    title: 'Fix login retry',
    body: 'Issue run delivery body',
    sourceBranch: 'octodeck/issue-run-123',
    targetBranch: 'main',
  };

  test('resolves GitHub repository URLs to the GitHub API provider', () => {
    expect(resolveGitProvider('https://github.com/acme/app.git')).toMatchObject({
      provider: 'github',
      owner: 'acme',
      repo: 'app',
      apiBaseUrl: 'https://api.github.com',
    });
  });

  test('creates a GitHub pull request through the provider API', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          number: 42,
          html_url: 'https://github.com/acme/app/pull/42',
          id: 1234,
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      ),
    );

    const result = await createIssueRunPullRequest(input, {
      githubToken: 'ghp_test',
      fetchImpl,
    });

    expect(result).toMatchObject({
      ok: true,
      provider: 'github',
      url: 'https://github.com/acme/app/pull/42',
      number: 42,
      id: '1234',
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.github.com/repos/acme/app/pulls',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer ghp_test',
          Accept: 'application/vnd.github+json',
        }),
        body: JSON.stringify({
          title: 'Fix login retry',
          body: 'Issue run delivery body',
          head: 'octodeck/issue-run-123',
          base: 'main',
        }),
      }),
    );
  });

  test('creates a self-hosted GitLab merge request through the provider API', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          iid: 7,
          web_url: 'https://git.example.com/platform/app/-/merge_requests/7',
          id: 9001,
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      ),
    );

    const result = await createIssueRunPullRequest(
      {
        ...input,
        repositoryUrl: 'https://git.example.com/platform/app.git',
        sourceBranch: 'octodeck/issue-run-456',
      },
      { gitlabToken: 'glpat_test', fetchImpl },
    );

    expect(result).toMatchObject({
      ok: true,
      provider: 'gitlab',
      url: 'https://git.example.com/platform/app/-/merge_requests/7',
      number: 7,
      id: '9001',
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://git.example.com/api/v4/projects/platform%2Fapp/merge_requests',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'PRIVATE-TOKEN': 'glpat_test',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({
          title: 'Fix login retry',
          description: 'Issue run delivery body',
          source_branch: 'octodeck/issue-run-456',
          target_branch: 'main',
          remove_source_branch: false,
        }),
      }),
    );
  });

  test('returns a clear configuration error when provider token is missing', async () => {
    await expect(createIssueRunPullRequest(input, { githubToken: '' })).resolves.toMatchObject({
      ok: false,
      provider: 'github',
      error: 'provider_not_configured',
    });
  });

  test('normalizes provider API errors into actionable messages', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ message: ['Source branch does not exist'] }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(
      createIssueRunPullRequest(
        { ...input, repositoryUrl: 'https://gitlab.com/acme/app.git' },
        { gitlabToken: 'glpat_test', fetchImpl },
      ),
    ).resolves.toMatchObject({
      ok: false,
      provider: 'gitlab',
      error: 'Source branch does not exist',
    });
  });

  test('loads and normalizes GitHub pull request status with checks and reviews', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/pulls/42')) {
        return new Response(JSON.stringify({
          number: 42,
          html_url: 'https://github.com/acme/app/pull/42',
          state: 'open',
          mergeable: true,
          merged_at: null,
          head: { sha: 'abc123' },
          base: { ref: 'main' },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.endsWith('/commits/abc123/check-runs')) {
        return new Response(JSON.stringify({ check_runs: [{ name: 'test', status: 'completed', conclusion: 'success', html_url: 'https://checks/test' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.endsWith('/pulls/42/reviews')) {
        return new Response(JSON.stringify([{ user: { login: 'maintainer' }, state: 'APPROVED', html_url: 'https://reviews/1' }]), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 404 });
    });

    const result = await getIssueRunPullRequestStatus({ repositoryUrl: 'https://github.com/acme/app.git', number: 42 }, { githubToken: 'ghp_test', fetchImpl: fetchImpl as any });

    expect(result).toMatchObject({
      ok: true,
      provider: 'github',
      state: 'open',
      mergeable: true,
      headSha: 'abc123',
      targetBranch: 'main',
      checks: [{ name: 'test', status: 'completed', conclusion: 'success' }],
      reviews: [{ reviewer: 'maintainer', state: 'approved' }],
    });
  });

  test('loads GitHub legacy commit statuses and uses effective latest review decisions', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/pulls/42')) {
        return new Response(JSON.stringify({
          number: 42,
          html_url: 'https://github.com/acme/app/pull/42',
          state: 'open',
          mergeable: true,
          merged_at: null,
          head: { sha: 'abc123' },
          base: { ref: 'main' },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.endsWith('/commits/abc123/check-runs')) {
        return new Response(JSON.stringify({ check_runs: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.endsWith('/commits/abc123/status')) {
        return new Response(JSON.stringify({
          statuses: [{ context: 'legacy-ci', state: 'success', target_url: 'https://status/legacy-ci' }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.endsWith('/pulls/42/reviews')) {
        return new Response(JSON.stringify([
          { id: 1, user: { login: 'maintainer' }, state: 'CHANGES_REQUESTED', submitted_at: '2026-06-15T00:00:00.000Z' },
          { id: 2, user: { login: 'maintainer' }, state: 'APPROVED', submitted_at: '2026-06-15T00:10:00.000Z', html_url: 'https://reviews/2' },
          { id: 3, user: { login: 'observer' }, state: 'COMMENTED', submitted_at: '2026-06-15T00:12:00.000Z' },
        ]), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 404 });
    });

    const result = await getIssueRunPullRequestStatus({ repositoryUrl: 'https://github.com/acme/app.git', number: 42 }, { githubToken: 'ghp_test', fetchImpl: fetchImpl as any });

    expect(result.checks).toMatchObject([
      { name: 'legacy-ci', status: 'completed', conclusion: 'success', url: 'https://status/legacy-ci' },
    ]);
    expect(result.reviews).toMatchObject([
      { reviewer: 'maintainer', state: 'approved', url: 'https://reviews/2' },
    ]);
  });

  test('does not treat dismissed GitHub approvals as effective reviews', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/pulls/42')) {
        return new Response(JSON.stringify({
          number: 42,
          html_url: 'https://github.com/acme/app/pull/42',
          state: 'open',
          mergeable: true,
          merged_at: null,
          head: { sha: 'abc123' },
          base: { ref: 'main' },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.endsWith('/commits/abc123/check-runs')) {
        return new Response(JSON.stringify({ check_runs: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.endsWith('/commits/abc123/status')) {
        return new Response(JSON.stringify({ statuses: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.endsWith('/pulls/42/reviews')) {
        return new Response(JSON.stringify([
          { id: 1, user: { login: 'maintainer' }, state: 'APPROVED', submitted_at: '2026-06-15T00:00:00.000Z' },
          { id: 2, user: { login: 'maintainer' }, state: 'DISMISSED', submitted_at: '2026-06-15T00:10:00.000Z' },
        ]), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 404 });
    });

    const result = await getIssueRunPullRequestStatus({ repositoryUrl: 'https://github.com/acme/app.git', number: 42 }, { githubToken: 'ghp_test', fetchImpl: fetchImpl as any });

    expect(result.reviews).toEqual([]);
  });

  test('loads and normalizes GitLab merge request status with pipeline and approvals', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/merge_requests/7')) {
        return new Response(JSON.stringify({
          iid: 7,
          web_url: 'https://git.example.com/platform/app/-/merge_requests/7',
          state: 'opened',
          merge_status: 'can_be_merged',
          sha: 'def456',
          target_branch: 'main',
          merged_at: null,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.endsWith('/pipelines')) {
        return new Response(JSON.stringify([{ id: 99, status: 'success', web_url: 'https://pipeline/99' }]), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.endsWith('/approvals')) {
        return new Response(JSON.stringify({ approved_by: [{ user: { username: 'maintainer' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 404 });
    });

    const result = await getIssueRunPullRequestStatus({ repositoryUrl: 'https://git.example.com/platform/app.git', number: 7 }, { gitlabToken: 'glpat_test', fetchImpl: fetchImpl as any });

    expect(result).toMatchObject({
      ok: true,
      provider: 'gitlab',
      state: 'open',
      mergeable: true,
      headSha: 'def456',
      targetBranch: 'main',
      checks: [{ name: 'pipeline #99', status: 'completed', conclusion: 'success' }],
      reviews: [{ reviewer: 'maintainer', state: 'approved' }],
    });
  });

  test('uses only the current GitLab head pipeline for release checks', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/merge_requests/7')) {
        return new Response(JSON.stringify({
          iid: 7,
          web_url: 'https://git.example.com/platform/app/-/merge_requests/7',
          state: 'opened',
          merge_status: 'can_be_merged',
          sha: 'def456',
          target_branch: 'main',
          merged_at: null,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.endsWith('/pipelines')) {
        return new Response(JSON.stringify([
          { id: 98, sha: 'old000', status: 'failed', web_url: 'https://pipeline/98' },
          { id: 99, sha: 'def456', status: 'success', web_url: 'https://pipeline/99' },
        ]), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.endsWith('/approvals')) {
        return new Response(JSON.stringify({ approved_by: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 404 });
    });

    const result = await getIssueRunPullRequestStatus({ repositoryUrl: 'https://git.example.com/platform/app.git', number: 7 }, { gitlabToken: 'glpat_test', fetchImpl: fetchImpl as any });

    expect(result.checks).toMatchObject([
      { name: 'pipeline #99', status: 'completed', conclusion: 'success', url: 'https://pipeline/99' },
    ]);
  });

  test('represents missing GitLab approvals as pending reviews', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/merge_requests/7')) {
        return new Response(JSON.stringify({
          iid: 7,
          web_url: 'https://git.example.com/platform/app/-/merge_requests/7',
          state: 'opened',
          merge_status: 'can_be_merged',
          sha: 'def456',
          target_branch: 'main',
          merged_at: null,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.endsWith('/pipelines')) {
        return new Response(JSON.stringify([{ id: 99, sha: 'def456', status: 'success', web_url: 'https://pipeline/99' }]), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.endsWith('/approvals')) {
        return new Response(JSON.stringify({
          approvals_required: 2,
          approvals_left: 1,
          approved_by: [{ user: { username: 'maintainer' } }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 404 });
    });

    const result = await getIssueRunPullRequestStatus({ repositoryUrl: 'https://git.example.com/platform/app.git', number: 7 }, { gitlabToken: 'glpat_test', fetchImpl: fetchImpl as any });

    expect(result.reviews).toMatchObject([
      { reviewer: 'maintainer', state: 'approved' },
      { reviewer: '1 approval(s) pending', state: 'pending' },
    ]);
  });

  test('returns provider_not_configured when status token is missing', async () => {
    await expect(getIssueRunPullRequestStatus({ repositoryUrl: 'https://github.com/acme/app.git', number: 42 }, { githubToken: '' })).resolves.toMatchObject({
      ok: false,
      provider: 'github',
      error: 'provider_not_configured',
    });
  });
});
