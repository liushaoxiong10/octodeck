import { beforeEach, describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
  issue: {
    id: 'iss_remediation',
    title: 'Remediation route',
    description: 'Remediation route test issue',
    workspace_jid: 'web:main',
    workspace_folder: '/workspace',
    status: 'review',
    priority: 'normal',
    project_git_url: 'https://github.com/acme/app.git',
    created_by: 'admin',
    created_at: '2026-06-16T00:00:00.000Z',
    updated_at: '2026-06-16T00:00:00.000Z',
  },
  run: {
    id: 'irun_remediation',
    issue_id: 'iss_remediation',
    workspace_jid: 'web:main',
    workspace_folder: '/workspace',
    status: 'success',
    result: 'Released change',
    created_by: 'admin',
    created_at: '2026-06-16T00:01:00.000Z',
    run_completed_at: '2026-06-16T00:05:00.000Z',
  },
  events: [] as any[],
  createIssueAgentRunEvent: vi.fn((event: any) => {
    const created = { id: `irev_${state.events.length + 1}`, created_at: '2026-06-16T00:20:00.000Z', ...event };
    state.events.push(created);
    return created;
  }),
  createIssueEvent: vi.fn((event: any) => ({ id: 'iev_remediation', ...event })),
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
  getRegisteredGroup: vi.fn(() => undefined),
  getUserHomeGroup: vi.fn(),
  listAgentLinksByUser: vi.fn(() => []),
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
vi.mock('../src/git-provider.js', () => ({ createIssueRunPullRequest: vi.fn(), getIssueRunPullRequestStatus: vi.fn() }));
vi.mock('../src/agent-link/registry.js', () => ({ getSession: vi.fn(() => null), getOnlineMeta: vi.fn(() => null), isOnline: vi.fn(() => false) }));
vi.mock('../src/agent-link/agent-runtime-rpc.js', () => ({ requestWorkspaceGitCommit: vi.fn(), requestWorkspaceGitStatus: vi.fn() }));

const issueRoutes = (await import('../src/routes/issues.js')).default;

describe('issue remediation routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.events = [
      {
        id: 'irev_prod_incident',
        issue_id: state.issue.id,
        run_id: state.run.id,
        event_type: 'production_incident_detected',
        title: 'Production incident detected',
        summary: 'checkout 500s',
        detail: 'smoke failed',
        created_at: '2026-06-16T00:10:00.000Z',
      },
    ];
  });

  test('GET remediation is read-only', async () => {
    const res = await issueRoutes.request(`/${state.issue.id}/runs/${state.run.id}/remediation`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.remediation).toMatchObject({ stage: 'waiting_approval', recommendedAction: 'spawn_fix_run' });
    expect(state.createIssueAgentRunEvent).not.toHaveBeenCalled();
  });

  test('POST refresh records derived remediation event once', async () => {
    const first = await issueRoutes.request(`/${state.issue.id}/runs/${state.run.id}/remediation/refresh`, { method: 'POST' });
    const second = await issueRoutes.request(`/${state.issue.id}/runs/${state.run.id}/remediation/refresh`, { method: 'POST' });
    const body = await first.json();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(body.remediation).toMatchObject({ stage: 'waiting_approval' });
    expect(state.events.filter((event) => event.event_type === 'remediation_waiting_approval')).toHaveLength(1);
  });

  test('POST action records remediation action event', async () => {
    state.events = [
      {
        id: 'irev_quality_failed',
        issue_id: state.issue.id,
        run_id: state.run.id,
        event_type: 'quality_failed',
        title: 'Quality failed',
        summary: 'tests failed',
        created_at: '2026-06-16T00:10:00.000Z',
      },
    ];
    const res = await issueRoutes.request(`/${state.issue.id}/runs/${state.run.id}/remediation/actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'mark_verifying', summary: 'verification started' }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.action).toMatchObject({ action: 'mark_verifying', approvalRequired: false });
    expect(state.createIssueAgentRunEvent).toHaveBeenCalledWith(expect.objectContaining({
      event_type: 'remediation_action_recorded',
      title: 'Remediation action recorded',
      summary: 'verification started',
    }));
  });

  test('POST rollback action requires approval and does not execute rollback', async () => {
    state.events = [
      {
        id: 'irev_prod_rollback',
        issue_id: state.issue.id,
        run_id: state.run.id,
        event_type: 'production_rollback_recommended',
        title: 'Production rollback recommended',
        summary: 'error budget exhausted',
        created_at: '2026-06-16T00:10:00.000Z',
      },
    ];
    const res = await issueRoutes.request(`/${state.issue.id}/runs/${state.run.id}/remediation/actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'request_rollback', summary: 'request rollback approval' }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.action).toMatchObject({ action: 'request_rollback', approvalRequired: true });
    expect(state.events.some((event) => event.event_type === 'release_rollback_executed')).toBe(false);
  });

  test('POST execution action is blocked while remediation approval is pending', async () => {
    const res = await issueRoutes.request(`/${state.issue.id}/runs/${state.run.id}/remediation/actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'spawn_fix_run', summary: 'start fix run without approval' }),
    });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toContain('Approval is required');
    expect(state.events.some((event) => event.event_type === 'remediation_action_recorded')).toBe(false);
  });

  test('refresh preserves production incident remediation action', async () => {
    const refresh = await issueRoutes.request(`/${state.issue.id}/runs/${state.run.id}/remediation/refresh`, { method: 'POST' });
    expect(refresh.status).toBe(200);

    const res = await issueRoutes.request(`/${state.issue.id}/runs/${state.run.id}/remediation`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.remediation).toMatchObject({ stage: 'waiting_approval', recommendedAction: 'spawn_fix_run' });
  });

  test('raw production health signal drives remediation before refresh', async () => {
    state.events = [
      {
        id: 'irev_raw_prod_signal',
        issue_id: state.issue.id,
        run_id: state.run.id,
        event_type: 'production_health_signal_received',
        title: 'Production health signal received',
        summary: 'checkout 500s',
        detail: 'smoke failed',
        payload: { type: 'incident_detected', severity: 'critical', summary: 'checkout 500s', detail: 'smoke failed' },
        created_at: '2026-06-16T00:10:00.000Z',
      },
    ];

    const res = await issueRoutes.request(`/${state.issue.id}/runs/${state.run.id}/remediation`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.remediation).toMatchObject({ stage: 'waiting_approval', recommendedAction: 'spawn_fix_run' });
  });
});
