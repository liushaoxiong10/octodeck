import { beforeEach, describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
  issue: {
    id: 'iss_delivery_route',
    title: 'Wire delivery route',
    description: 'Delivery route test issue',
    workspace_jid: 'web:main',
    workspace_folder: '/workspace',
    status: 'review',
    priority: 'normal',
    project_git_url: 'https://github.com/acme/app.git',
    agent_link_id: 'cl_1234567890abcd',
    agent_client_id: 'claude-code',
    created_by: 'admin',
    created_at: '2026-06-15T00:00:00.000Z',
    updated_at: '2026-06-15T00:00:00.000Z',
  },
  runs: [] as any[],
  eventsByRun: new Map<string, any[]>(),
  requests: [] as any[],
  diff: {
    ok: true,
    branch: 'octodeck/issue-run-123',
    head: 'worktree-head-should-not-be-a-commit',
    clean: false,
    files: [
      {
        path: 'src/delivery.ts',
        status: 'modified',
        additions: 4,
        deletions: 1,
        patch: '@@ -1 +1 @@\n-old\n+new',
      },
    ],
    diffStat: ' src/delivery.ts | 5 ++++-',
    durationMs: 10,
    error: null,
  },
  createIssueAgentRunEvent: vi.fn(),
  createIssueEvent: vi.fn((event: any) => ({ id: 'iev_test', ...event })),
  afterIssueEventCreated: vi.fn(),
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
  createIssueAgentRun: vi.fn((run: any) => {
    state.runs.push(run);
    return run;
  }),
  createIssueAgentRunEvent: state.createIssueAgentRunEvent,
  createIssueComment: vi.fn(),
  createIssueEvent: state.createIssueEvent,
  deleteIssueAttachment: vi.fn(),
  deleteIssue: vi.fn(),
  getAgentLinkById: vi.fn(() => ({ id: 'cl_1234567890abcd', userId: 'admin', displayName: 'Device' })),
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
  listIssueAgentRequests: vi.fn(() => state.requests),
  listIssueAgentRuns: vi.fn(() => state.runs),
  listIssueAgentRunEvents: vi.fn((runId: string) => state.eventsByRun.get(runId) ?? []),
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
vi.mock('../src/issue-notifier.js', () => ({ afterIssueEventCreated: state.afterIssueEventCreated }));
vi.mock('../src/git-provider.js', () => ({ createIssueRunPullRequest: vi.fn() }));
vi.mock('../src/agent-link/registry.js', () => ({
  getSession: vi.fn(() => ({ state: 'open' })),
  getOnlineMeta: vi.fn(() => null),
  isOnline: vi.fn(() => true),
}));
vi.mock('../src/agent-link/agent-runtime-rpc.js', () => ({
  requestWorkspaceGitCommit: vi.fn(() => ({ ok: true, commit: 'real-commit', branch: 'octodeck/issue-run-123', filesCommitted: 1 })),
  requestWorkspaceGitStatus: vi.fn(() => state.diff),
}));

const issueRoutes = (await import('../src/routes/issues.js')).default;

describe('issue delivery routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.diff = {
      ok: true,
      branch: 'octodeck/issue-run-123',
      head: 'worktree-head-should-not-be-a-commit',
      clean: false,
      files: [
        {
          path: 'src/delivery.ts',
          status: 'modified',
          additions: 4,
          deletions: 1,
          patch: '@@ -1 +1 @@\n-old\n+new',
        },
      ],
      diffStat: ' src/delivery.ts | 5 ++++-',
      durationMs: 10,
      error: null,
    };
    state.runs = [
      {
        id: 'irun_parent',
        issue_id: state.issue.id,
        workspace_jid: state.issue.workspace_jid,
        workspace_folder: state.issue.workspace_folder,
        agent_link_id: 'cl_1234567890abcd',
        agent_client_id: 'claude-code',
        status: 'success',
        result: 'Modified src/delivery.ts and ran npm test',
        created_by: 'admin',
        created_at: '2026-06-15T00:00:00.000Z',
        run_completed_at: '2026-06-15T00:05:00.000Z',
      },
    ];
    state.eventsByRun = new Map([['irun_parent', []]]);
    state.requests = [];
  });

  test('GET delivery does not treat the current worktree head as a created commit or record events', async () => {
    const res = await issueRoutes.request(`/${state.issue.id}/runs/irun_parent/delivery`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.delivery.deliveryState).toMatchObject({
      stage: 'diff_ready',
      nextAction: 'commit_changes',
      hasCommit: false,
    });
    expect(body.delivery.pullRequestDraft.body).toContain('- Commit: unknown');
    expect(body.delivery.pullRequestDraft.body).not.toContain('worktree-head-should-not-be-a-commit');
    expect(state.createIssueAgentRunEvent).not.toHaveBeenCalled();
  });

  test('commit blocked by a failed quality gate returns the same delivery payload shape as GET delivery', async () => {
    state.runs[0] = {
      ...state.runs[0],
      status: 'error',
      error: 'vitest failed',
      result: 'Modified src/delivery.ts and vitest failed',
    };

    const res = await issueRoutes.request(`/${state.issue.id}/runs/irun_parent/commit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'fix: delivery route' }),
    });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toMatchObject({
      error: 'Delivery blocked by quality gate',
      qualityEvaluation: { outcome: 'failed' },
      delivery: {
        deliveryState: { stage: 'blocked_by_quality', qualityGate: { outcome: 'failed', allowed: false } },
        qualityEvaluation: { outcome: 'failed' },
      },
    });
  });

  test('a successful Review Agent child run resolves a parent quality review gate for delivery', async () => {
    state.runs = [
      {
        ...state.runs[0],
        result: 'Modified src/delivery.ts',
      },
      {
        id: 'irun_review_child',
        issue_id: state.issue.id,
        workspace_jid: state.issue.workspace_jid,
        workspace_folder: state.issue.workspace_folder,
        parent_run_id: 'irun_parent',
        status: 'success',
        result: 'Review Agent inspected the diff and found no blockers.',
        created_by: 'admin',
        created_at: '2026-06-15T00:06:00.000Z',
        run_completed_at: '2026-06-15T00:08:00.000Z',
      },
    ];
    state.eventsByRun = new Map([
      [
        'irun_parent',
        [
          {
            id: 'irev_commit',
            issue_id: state.issue.id,
            run_id: 'irun_parent',
            event_type: 'git_commit_created',
            payload: { commit: 'real-created-commit', branch: 'octodeck/issue-run-123', filesCommitted: 1 },
            created_at: '2026-06-15T00:05:30.000Z',
          },
          {
            id: 'irev_review',
            issue_id: state.issue.id,
            run_id: 'irun_parent',
            event_type: 'review_agent_run_created',
            payload: { reviewRunId: 'irun_review_child' },
            created_at: '2026-06-15T00:06:00.000Z',
          },
        ],
      ],
      ['irun_review_child', []],
    ]);

    const res = await issueRoutes.request(`/${state.issue.id}/runs/irun_parent/delivery`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.delivery.qualityEvaluation).toMatchObject({
      outcome: 'passed',
      failureCategory: null,
      needsReview: false,
    });
    expect(body.delivery.deliveryState).toMatchObject({
      stage: 'proposal_ready',
      nextAction: 'create_pr_or_mr',
    });
  });

  test('GET delivery keeps a recorded commit deliverable after the worktree becomes clean', async () => {
    state.diff = { ...state.diff, clean: true, files: [], diffStat: '', head: 'real-created-commit' };
    state.eventsByRun = new Map([
      [
        'irun_parent',
        [
          {
            id: 'irev_commit',
            issue_id: state.issue.id,
            run_id: 'irun_parent',
            event_type: 'git_commit_created',
            payload: {
              commit: 'real-created-commit',
              branch: 'octodeck/issue-run-123',
              filesCommitted: 1,
              diff: {
                ...state.diff,
                clean: false,
                files: [{ path: 'src/delivery.ts', status: 'modified', additions: 4, deletions: 1 }],
                diffStat: ' src/delivery.ts | 5 ++++-',
              },
            },
            created_at: '2026-06-15T00:05:30.000Z',
          },
        ],
      ],
    ]);

    const res = await issueRoutes.request(`/${state.issue.id}/runs/irun_parent/delivery`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.delivery.deliveryState).toMatchObject({
      stage: 'proposal_ready',
      nextAction: 'create_pr_or_mr',
      hasCommit: true,
    });
    expect(body.delivery.pullRequestDraft.changedFiles).toEqual(['src/delivery.ts']);
  });

  test('ordinary child runs do not resolve a parent quality review gate without a Review Agent link event', async () => {
    state.runs = [
      {
        ...state.runs[0],
        result: 'Modified src/delivery.ts',
      },
      {
        id: 'irun_ordinary_child',
        issue_id: state.issue.id,
        workspace_jid: state.issue.workspace_jid,
        workspace_folder: state.issue.workspace_folder,
        parent_run_id: 'irun_parent',
        status: 'success',
        result: 'Did a review of the output but was not launched by Review Agent.',
        created_by: 'admin',
        created_at: '2026-06-15T00:06:00.000Z',
        run_completed_at: '2026-06-15T00:08:00.000Z',
      },
    ];

    const res = await issueRoutes.request(`/${state.issue.id}/runs/irun_parent/delivery`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.delivery.qualityEvaluation).toMatchObject({
      outcome: 'needs_review',
      failureCategory: 'missing_verification',
      needsReview: true,
    });
    expect(body.delivery.deliveryState).toMatchObject({ stage: 'review_required' });
  });

  test('PR creation is rejected when no real git commit was recorded for the run', async () => {
    const res = await issueRoutes.request(`/${state.issue.id}/runs/irun_parent/pull-request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Wire delivery route',
        body: 'Delivery draft body',
        sourceBranch: 'octodeck/issue-run-123',
        targetBranch: 'main',
        repositoryUrl: 'https://github.com/acme/app.git',
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toMatchObject({
      error: 'A recorded git commit is required before creating a PR/MR',
      deliveryState: { stage: 'diff_ready', nextAction: 'commit_changes', hasCommit: false },
    });
  });
});
