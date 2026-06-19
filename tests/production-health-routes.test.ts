import { beforeEach, describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
  issue: {
    id: 'iss_prod_health',
    title: 'Production health route',
    description: 'Production route test issue',
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
    id: 'irun_prod_health',
    issue_id: 'iss_prod_health',
    workspace_jid: 'web:main',
    workspace_folder: '/workspace',
    status: 'success',
    result: 'Released change',
    created_by: 'admin',
    created_at: '2026-06-15T00:01:00.000Z',
    run_completed_at: '2026-06-15T00:05:00.000Z',
  },
  events: [] as any[],
  createIssueAgentRunEvent: vi.fn((event: any) => {
    const created = { id: `irev_${state.events.length + 1}`, created_at: '2026-06-15T00:20:00.000Z', ...event };
    state.events.push(created);
    return created;
  }),
  createIssueEvent: vi.fn((event: any) => ({ id: 'iev_prod_health', ...event })),
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
vi.mock('../src/git-provider.js', () => ({ createIssueRunPullRequest: vi.fn(), getIssueRunPullRequestStatus: vi.fn() }));
vi.mock('../src/agent-link/registry.js', () => ({ getSession: vi.fn(() => null), getOnlineMeta: vi.fn(() => null), isOnline: vi.fn(() => false) }));
vi.mock('../src/agent-link/agent-runtime-rpc.js', () => ({ requestWorkspaceGitCommit: vi.fn(), requestWorkspaceGitStatus: vi.fn() }));

const issueRoutes = (await import('../src/routes/issues.js')).default;

describe('issue production health routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.events = [
      {
        id: 'irev_release_completed',
        issue_id: state.issue.id,
        run_id: state.run.id,
        event_type: 'release_completed',
        title: 'Release completed',
        summary: 'Released',
        payload: { releaseState: { stage: 'released', releaseGate: { allowed: true } } },
        created_at: '2026-06-15T00:10:00.000Z',
      },
    ];
  });

  test('GET production health is read-only', async () => {
    const res = await issueRoutes.request(`/${state.issue.id}/runs/${state.run.id}/production-health`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.productionHealth).toMatchObject({ stage: 'observing', nextAction: 'collect_health_signal' });
    expect(state.createIssueAgentRunEvent).not.toHaveBeenCalled();
  });

  test('POST signal records health signal and returns degraded state', async () => {
    const res = await issueRoutes.request(`/${state.issue.id}/runs/${state.run.id}/production-health/signals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'degraded', severity: 'warning', summary: 'latency elevated', source: 'smoke' }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(state.createIssueAgentRunEvent).toHaveBeenCalledWith(expect.objectContaining({
      event_type: 'production_health_signal_received',
      title: 'Production health signal received',
      summary: 'latency elevated',
    }));
    expect(body.productionHealth).toMatchObject({ stage: 'degraded', severity: 'warning' });
  });

  test('POST signal rejects invalid health signal type', async () => {
    const res = await issueRoutes.request(`/${state.issue.id}/runs/${state.run.id}/production-health/signals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'unknown_signal', severity: 'warning', summary: 'bad signal' }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe('Invalid production health signal type');
    expect(state.events.filter((event) => event.event_type === 'production_health_signal_received')).toHaveLength(0);
  });

  test('POST signal rejects invalid health signal severity', async () => {
    const res = await issueRoutes.request(`/${state.issue.id}/runs/${state.run.id}/production-health/signals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'healthy', severity: 'fatal', summary: 'bad severity' }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe('Invalid production health signal severity');
    expect(state.events.filter((event) => event.event_type === 'production_health_signal_received')).toHaveLength(0);
  });

  test('POST refresh records derived incident event once', async () => {
    state.events.push({
      id: 'irev_signal_incident',
      issue_id: state.issue.id,
      run_id: state.run.id,
      event_type: 'production_health_signal_received',
      title: 'Production health signal received',
      summary: 'checkout 500s',
      payload: { type: 'incident', severity: 'critical', summary: 'checkout 500s', observedAt: '2026-06-15T00:12:00.000Z' },
      created_at: '2026-06-15T00:12:00.000Z',
    });

    const first = await issueRoutes.request(`/${state.issue.id}/runs/${state.run.id}/production-health/refresh`, { method: 'POST' });
    const second = await issueRoutes.request(`/${state.issue.id}/runs/${state.run.id}/production-health/refresh`, { method: 'POST' });
    const body = await first.json();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(body.productionHealth).toMatchObject({ stage: 'incident_detected', nextAction: 'mitigate_incident' });
    expect(state.events.filter((event) => event.event_type === 'production_incident_detected')).toHaveLength(1);
  });
});
