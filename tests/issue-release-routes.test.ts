import { beforeEach, describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
  issue: {
    id: 'iss_release_route',
    title: 'Release governance route',
    description: 'Release route test issue',
    workspace_jid: 'web:main',
    workspace_folder: '/workspace',
    status: 'review',
    priority: 'normal',
    project_git_url: 'https://github.com/acme/app.git',
    created_by: 'admin',
    created_at: '2026-06-15T00:00:00.000Z',
    updated_at: '2026-06-15T00:00:00.000Z',
  },
  run: {
    id: 'irun_release',
    issue_id: 'iss_release_route',
    workspace_jid: 'web:main',
    workspace_folder: '/workspace',
    status: 'success',
    result: 'Changed src/release.ts and ran npm test',
    created_by: 'admin',
    created_at: '2026-06-15T00:01:00.000Z',
    run_completed_at: '2026-06-15T00:05:00.000Z',
  },
  events: [] as any[],
  createIssueAgentRunEvent: vi.fn(),
  createIssueEvent: vi.fn((event: any) => ({ id: 'iev_release', ...event })),
  getIssueRunPullRequestStatus: vi.fn(),
}));

vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', { id: 'admin', username: 'admin', role: 'admin', permissions: ['manage_system_config'] });
    return next();
  },
}));

vi.mock('../src/web-context.js', () => ({
  MAX_GROUP_NAME_LEN: 40,
  canAccessGroup: () => true,
  canDeleteGroup: () => true,
  canManageGroupMembers: () => true,
  canModifyGroup: () => true,
  getWebDeps: () => ({ queue: { enqueueTask: vi.fn() } }),
  hasHostExecutionPermission: () => true,
  isHostExecutionGroup: () => false,
}));

vi.mock('../src/db.js', () => ({
  answerIssueAgentRequest: vi.fn(),
  clearIssueAgentRunAwaiting: vi.fn(),
  createIssue: vi.fn(),
  createIssueAttachment: vi.fn(),
  createIssueAgentRequest: vi.fn(),
  createIssueAgentRun: vi.fn(),
  createIssueAgentRunEvent: state.createIssueAgentRunEvent,
  createIssueComment: vi.fn(),
  createIssueEvent: state.createIssueEvent,
  deleteIssueAttachment: vi.fn(),
  deleteIssue: vi.fn(),
  getAgentLinkById: vi.fn(),
  getAgentTaskScopedTokenById: vi.fn(),
  getAgentTaskById: vi.fn(),
  getIssueAgentRequestById: vi.fn(),
  getIssueAttachmentById: vi.fn(),
  getIssueById: vi.fn((id: string) => (id === state.issue.id ? state.issue : null)),
  getIssueCommentById: vi.fn(),
  getAllRegisteredGroups: vi.fn(() => ({})),
  getManagedRepoById: vi.fn(),
  listAgentLinksByUser: vi.fn(() => []),
  getRegisteredGroup: vi.fn(() => undefined),
  getUserHomeGroup: vi.fn(),
  listIssueAgentRequests: vi.fn(() => []),
  listIssueAgentRuns: vi.fn(() => [state.run]),
  listIssueAgentRunEvents: vi.fn(() => state.events),
  listIssueAttachments: vi.fn(() => []),
  listIssueComments: vi.fn(() => []),
  listIssueEvents: vi.fn(() => []),
  listIssues: vi.fn(() => ({ issues: [state.issue], total: 1 })),
  logAuthEvent: vi.fn(),
  softDeleteIssueComment: vi.fn(),
  updateIssue: vi.fn(),
  updateIssueAgentRun: vi.fn(),
  updateIssueComment: vi.fn(),
  updateIssueLastRun: vi.fn(),
}));

vi.mock('../src/issue-runner.js', () => ({ runIssueAgent: vi.fn() }));
vi.mock('../src/issue-notifier.js', () => ({ afterIssueEventCreated: vi.fn() }));
vi.mock('../src/git-provider.js', () => ({
  createIssueRunPullRequest: vi.fn(),
  getIssueRunPullRequestStatus: state.getIssueRunPullRequestStatus,
}));
vi.mock('../src/agent-link/registry.js', () => ({
  getSession: vi.fn(() => null),
  getOnlineMeta: vi.fn(() => null),
  isOnline: vi.fn(() => false),
}));
vi.mock('../src/agent-link/agent-runtime-rpc.js', () => ({
  requestWorkspaceGitCommit: vi.fn(),
  requestWorkspaceGitStatus: vi.fn(),
}));

const issueRoutes = (await import('../src/routes/issues.js')).default;

describe('issue release governance routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.events = [
      {
        id: 'irev_pr',
        issue_id: state.issue.id,
        run_id: state.run.id,
        event_type: 'pull_request_created',
        title: 'Pull request created',
        summary: 'https://github.com/acme/app/pull/42',
        payload: { ok: true, provider: 'github', url: 'https://github.com/acme/app/pull/42', number: 42, id: '42' },
        created_at: '2026-06-15T00:06:00.000Z',
      },
    ];
    state.getIssueRunPullRequestStatus.mockResolvedValue({
      ok: true,
      provider: 'github',
      url: 'https://github.com/acme/app/pull/42',
      number: 42,
      state: 'open',
      mergeable: true,
      checks: [{ name: 'test', status: 'completed', conclusion: 'success' }],
      reviews: [{ reviewer: 'maintainer', state: 'approved' }],
    });
  });

  test('GET release returns merge-ready state without recording events', async () => {
    const res = await issueRoutes.request(`/${state.issue.id}/runs/${state.run.id}/release`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.release.releaseState).toMatchObject({ stage: 'merge_ready', nextAction: 'merge_pr_or_mr' });
    expect(state.getIssueRunPullRequestStatus).toHaveBeenCalledWith(
      { repositoryUrl: 'https://github.com/acme/app.git', url: 'https://github.com/acme/app/pull/42', number: 42, id: '42' },
      expect.any(Object),
    );
    expect(state.createIssueAgentRunEvent).not.toHaveBeenCalled();
  });

  test('POST release refresh records release events once', async () => {
    const res = await issueRoutes.request(`/${state.issue.id}/runs/${state.run.id}/release/refresh`, { method: 'POST' });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.release.releaseState.stage).toBe('merge_ready');
    expect(state.createIssueAgentRunEvent).toHaveBeenCalledWith(expect.objectContaining({
      event_type: 'release_merge_ready',
      issue_id: state.issue.id,
      run_id: state.run.id,
      title: 'Release merge ready',
    }));
  });

  test('provider_not_configured still returns a manual release state', async () => {
    state.getIssueRunPullRequestStatus.mockResolvedValue({ ok: false, provider: 'github', checks: [], reviews: [], error: 'provider_not_configured' });

    const res = await issueRoutes.request(`/${state.issue.id}/runs/${state.run.id}/release`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.release.providerStatus).toMatchObject({ ok: false, error: 'provider_not_configured' });
    expect(body.release.releaseState).toMatchObject({ stage: 'checks_pending', nextAction: 'wait_for_checks' });
    expect(body.release.releaseState.checklist[1]).toMatchObject({ id: 'checks', status: 'pending' });
  });

  test('post-merge verification events can require rollback', async () => {
    state.events.push({
      id: 'irev_post_merge_failed',
      issue_id: state.issue.id,
      run_id: state.run.id,
      event_type: 'release_post_merge_failed',
      title: 'Post-merge verification failed',
      summary: 'Smoke test failed after merge',
      payload: { ok: false, summary: 'Smoke test failed after merge' },
      created_at: '2026-06-15T00:20:00.000Z',
    });
    state.getIssueRunPullRequestStatus.mockResolvedValue({
      ok: true,
      provider: 'github',
      url: 'https://github.com/acme/app/pull/42',
      number: 42,
      state: 'merged',
      mergeable: true,
      mergedAt: '2026-06-15T00:15:00.000Z',
      checks: [{ name: 'test', status: 'completed', conclusion: 'success' }],
      reviews: [{ reviewer: 'maintainer', state: 'approved' }],
    });

    const res = await issueRoutes.request(`/${state.issue.id}/runs/${state.run.id}/release/refresh`, { method: 'POST' });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.release.releaseState).toMatchObject({ stage: 'rollback_required', nextAction: 'inspect_release' });
    expect(state.createIssueAgentRunEvent).toHaveBeenCalledWith(expect.objectContaining({
      event_type: 'release_rollback_required',
      title: 'Release rollback required',
      summary: 'Smoke test failed after merge',
    }));
  });
});
