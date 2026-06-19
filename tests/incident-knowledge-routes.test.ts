import { beforeEach, describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
  issue: {
    id: 'iss_incident_knowledge',
    title: 'Incident knowledge route',
    description: 'Incident knowledge route test issue',
    workspace_jid: 'web:main',
    workspace_folder: '/workspace',
    status: 'review',
    priority: 'normal',
    created_by: 'admin',
    created_at: '2026-06-16T00:00:00.000Z',
    updated_at: '2026-06-16T00:00:00.000Z',
  },
  run: {
    id: 'irun_incident_knowledge',
    issue_id: 'iss_incident_knowledge',
    workspace_jid: 'web:main',
    workspace_folder: '/workspace',
    status: 'success',
    result: 'Released change',
    created_by: 'admin',
    created_at: '2026-06-16T00:01:00.000Z',
  },
  events: [] as any[],
  createIssueAgentRunEvent: vi.fn((event: any) => {
    const created = { id: `irev_${state.events.length + 1}`, created_at: '2026-06-16T00:20:00.000Z', ...event };
    state.events.push(created);
    return created;
  }),
  createIssueEvent: vi.fn((event: any) => ({ id: 'iev_incident_knowledge', ...event })),
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

describe('issue incident knowledge routes', () => {
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

  test('GET incident knowledge is read-only', async () => {
    const res = await issueRoutes.request(`/${state.issue.id}/runs/${state.run.id}/incident-knowledge`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.incidentKnowledge).toMatchObject({ status: 'open', severity: 'high', title: 'checkout 500s' });
    expect(state.createIssueAgentRunEvent).not.toHaveBeenCalled();
  });

  test('POST archive records one incident knowledge event', async () => {
    const first = await issueRoutes.request(`/${state.issue.id}/runs/${state.run.id}/incident-knowledge/archive`, { method: 'POST' });
    const second = await issueRoutes.request(`/${state.issue.id}/runs/${state.run.id}/incident-knowledge/archive`, { method: 'POST' });
    const body = await first.json();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(body.incidentKnowledge).toMatchObject({ fingerprint: expect.stringMatching(/^ik_/) });
    expect(state.events.filter((event) => event.event_type === 'incident_knowledge_archived')).toHaveLength(1);
  });

  test('archived snapshot merges with current derived entry', async () => {
    await issueRoutes.request(`/${state.issue.id}/runs/${state.run.id}/incident-knowledge/archive`, { method: 'POST' });
    state.events.push({
      id: 'irev_recovered',
      issue_id: state.issue.id,
      run_id: state.run.id,
      event_type: 'production_recovered',
      title: 'Production recovered',
      summary: 'healthy again',
      created_at: '2026-06-16T00:30:00.000Z',
    });

    const res = await issueRoutes.request(`/${state.issue.id}/runs/${state.run.id}/incident-knowledge`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.incidentKnowledge).toMatchObject({ status: 'resolved' });
    expect(body.incidentKnowledge.verificationSignals).toEqual([
      expect.objectContaining({ eventType: 'production_recovered' }),
    ]);
  });

  test('no incident returns null incident knowledge', async () => {
    state.events = [
      { id: 'irev_quality_passed', issue_id: state.issue.id, run_id: state.run.id, event_type: 'quality_passed', title: 'Quality passed', created_at: '2026-06-16T00:10:00.000Z' },
    ];

    const res = await issueRoutes.request(`/${state.issue.id}/runs/${state.run.id}/incident-knowledge`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.incidentKnowledge).toBeNull();
  });
});
