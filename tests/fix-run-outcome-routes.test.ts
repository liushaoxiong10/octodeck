import { beforeEach, describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
  issue: {
    id: 'iss_fix_outcome',
    title: 'Checkout is failing',
    description: 'checkout smoke failed',
    workspace_jid: 'web:main',
    workspace_folder: '/workspace',
    status: 'review',
    priority: 'normal',
    created_by: 'admin',
    created_at: '2026-06-16T00:00:00.000Z',
    updated_at: '2026-06-16T00:00:00.000Z',
  },
  sourceRun: {
    id: 'irun_outcome_source',
    issue_id: 'iss_fix_outcome',
    workspace_jid: 'web:main',
    workspace_folder: '/workspace',
    status: 'success',
    result: 'Observed current incident',
    created_by: 'admin',
    created_at: '2026-06-16T00:10:00.000Z',
  } as any,
  fixRun: {
    id: 'irun_outcome_fix',
    issue_id: 'iss_fix_outcome',
    workspace_jid: 'web:main',
    workspace_folder: '/workspace',
    parent_run_id: 'irun_outcome_source',
    status: 'success',
    result: 'patched checkout guard; tests passed; production recovered',
    created_by: 'admin',
    created_at: '2026-06-16T00:20:00.000Z',
  } as any,
  reviewRun: {
    id: 'irun_outcome_review',
    issue_id: 'iss_fix_outcome',
    workspace_jid: 'web:main',
    workspace_folder: '/workspace',
    parent_run_id: 'irun_outcome_source',
    status: 'success',
    result: 'reviewed',
    created_by: 'admin',
    created_at: '2026-06-16T00:25:00.000Z',
  } as any,
  runs: [] as any[],
  events: [] as any[],
  createIssueAgentRunEvent: vi.fn((event: any) => {
    const created = { id: event.id ?? `irev_${state.events.length + 1}`, created_at: event.created_at ?? '2026-06-16T00:30:00.000Z', ...event };
    state.events.push(created);
    return created;
  }),
  createIssueEvent: vi.fn((event: any) => ({ id: `iev_${state.events.length + 1}`, ...event })),
}));

const draft = {
  status: 'draft_ready',
  title: 'Fix checkout using runbook',
  riskLevel: 'high',
  sourceRunId: state.sourceRun.id,
  verificationChecklist: ['Run checkout smoke', 'Verify production recovery'],
  remediationActions: [{ action: 'spawn_fix_run', summary: 'Patch checkout null guard' }],
};

function event(overrides: Record<string, unknown>) {
  return {
    id: `irev_seed_${state.events.length + 1}`,
    issue_id: state.issue.id,
    run_id: state.fixRun.id,
    event_type: 'run_queued',
    title: 'event',
    summary: null,
    detail: null,
    payload: null,
    created_at: '2026-06-16T00:20:00.000Z',
    ...overrides,
  };
}

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
  getRegisteredGroup: vi.fn(() => undefined),
  getUserHomeGroup: vi.fn(),
  listAgentLinksByUser: vi.fn(() => []),
  listIssueAgentRequests: vi.fn(() => []),
  listIssueAgentRuns: vi.fn(() => state.runs),
  listIssueAgentRunEvents: vi.fn((runId: string) => state.events.filter((item) => item.run_id === runId)),
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
vi.mock('../src/git-provider.js', () => ({ createIssueRunPullRequest: vi.fn(), getIssueRunPullRequestStatus: vi.fn() }));
vi.mock('../src/agent-link/registry.js', () => ({ getSession: vi.fn(() => null), getOnlineMeta: vi.fn(() => null), isOnline: vi.fn(() => false) }));
vi.mock('../src/agent-link/agent-runtime-rpc.js', () => ({ requestWorkspaceGitCommit: vi.fn(), requestWorkspaceGitStatus: vi.fn() }));

const issueRoutes = (await import('../src/routes/issues.js')).default;

describe('issue fix run outcome routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.runs = [state.sourceRun, state.fixRun, state.reviewRun];
    state.events = [
      event({ run_id: state.sourceRun.id, event_type: 'fix_run_spawned', title: 'Fix run spawned', summary: state.fixRun.id, payload: { fixRunId: state.fixRun.id, fixRunDraft: draft } }),
      event({ run_id: state.fixRun.id, event_type: 'run_queued', title: 'Fix run queued', detail: 'prompt', payload: { trigger: 'fix_run_spawner', parentRunId: state.sourceRun.id, fixRunDraft: draft } }),
      event({ run_id: state.reviewRun.id, event_type: 'run_queued', title: 'Review run queued', payload: { trigger: 'review_agent', parentRunId: state.sourceRun.id } }),
    ];
  });

  test('GET returns read-only resolved outcome for source run', async () => {
    const res = await issueRoutes.request(`/${state.issue.id}/runs/${state.sourceRun.id}/fix-run-outcome`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fixRunOutcome).toMatchObject({ status: 'resolved', sourceRunId: state.sourceRun.id, fixRunId: state.fixRun.id });
    expect(body.fixRunOutcome.verificationChecklist).toContain('Run checkout smoke');
    expect(state.events.filter((item) => item.event_type === 'fix_run_resolved')).toHaveLength(0);
  });

  test('POST records resolved outcome once idempotently', async () => {
    const first = await issueRoutes.request(`/${state.issue.id}/runs/${state.fixRun.id}/fix-run-outcome/verify`, { method: 'POST' });
    const second = await issueRoutes.request(`/${state.issue.id}/runs/${state.fixRun.id}/fix-run-outcome/verify`, { method: 'POST' });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const body = await second.json();
    expect(body.fixRunOutcome.status).toBe('resolved');
    expect(state.events.filter((item) => item.event_type === 'fix_run_resolved')).toHaveLength(1);
  });

  test('GET blocks review-agent child runs', async () => {
    const res = await issueRoutes.request(`/${state.issue.id}/runs/${state.reviewRun.id}/fix-run-outcome`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fixRunOutcome).toMatchObject({ status: 'blocked', blockedReason: 'not_fix_run_spawner_child' });
  });

  test('POST rejects missing spawned fix run without writing orphan event', async () => {
    state.runs = [state.sourceRun];
    state.events = [];

    const res = await issueRoutes.request(`/${state.issue.id}/runs/${state.sourceRun.id}/fix-run-outcome/verify`, { method: 'POST' });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.fixRunOutcome).toMatchObject({ status: 'blocked', blockedReason: 'missing_fix_run' });
    expect(state.events.filter((item) => item.event_type === 'fix_run_failed')).toHaveLength(0);
    expect(state.createIssueAgentRunEvent).not.toHaveBeenCalled();
  });

  test('POST returns 404 for stale spawned fix run reference without writing orphan event', async () => {
    state.runs = [state.sourceRun];
    state.events = [
      event({ run_id: state.sourceRun.id, event_type: 'fix_run_spawned', title: 'Fix run spawned', summary: 'irun_missing', payload: { fixRunId: 'irun_missing', fixRunDraft: draft } }),
    ];

    const res = await issueRoutes.request(`/${state.issue.id}/runs/${state.sourceRun.id}/fix-run-outcome/verify`, { method: 'POST' });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.fixRunId).toBe('irun_missing');
    expect(state.createIssueAgentRunEvent).not.toHaveBeenCalled();
  });
});
