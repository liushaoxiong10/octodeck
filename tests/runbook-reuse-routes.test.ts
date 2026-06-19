import { beforeEach, describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
  issue: {
    id: 'iss_runbook_reuse',
    title: 'Runbook reuse route',
    description: 'Runbook reuse route test issue',
    workspace_jid: 'web:main',
    workspace_folder: '/workspace',
    status: 'review',
    priority: 'normal',
    created_by: 'admin',
    created_at: '2026-06-16T00:00:00.000Z',
    updated_at: '2026-06-16T00:00:00.000Z',
  },
  currentRun: {
    id: 'irun_runbook_current',
    issue_id: 'iss_runbook_reuse',
    workspace_jid: 'web:main',
    workspace_folder: '/workspace',
    status: 'success',
    result: 'Observed current incident',
    created_by: 'admin',
    created_at: '2026-06-16T00:10:00.000Z',
  },
  archivedRun: {
    id: 'irun_runbook_archived',
    issue_id: 'iss_runbook_reuse',
    workspace_jid: 'web:main',
    workspace_folder: '/workspace',
    status: 'success',
    result: 'Resolved previous incident',
    created_by: 'admin',
    created_at: '2026-06-16T00:01:00.000Z',
  },
  events: [] as any[],
  createIssueAgentRunEvent: vi.fn((event: any) => {
    const created = { id: `irev_${state.events.length + 1}`, created_at: '2026-06-16T00:20:00.000Z', ...event };
    state.events.push(created);
    return created;
  }),
  createIssueEvent: vi.fn((event: any) => ({ id: 'iev_runbook_reuse', ...event })),
}));

function archivedIncident(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ik_archived_checkout',
    issueId: state.issue.id,
    runId: state.archivedRun.id,
    title: 'checkout 500s',
    fingerprint: 'ik_high_checkout-500s',
    severity: 'high',
    status: 'resolved',
    symptoms: ['checkout 500s'],
    suspectedRootCauses: ['Null checkout guard'],
    remediationActions: [
      {
        action: 'spawn_fix_run',
        summary: 'Patch checkout null guard',
        observedAt: '2026-06-16T00:03:00.000Z',
      },
    ],
    verificationSignals: [
      {
        eventType: 'production_recovered',
        summary: 'healthy again',
        observedAt: '2026-06-16T00:04:00.000Z',
      },
    ],
    preventionChecklist: ['Verify recovery'],
    relatedEvents: [],
    createdAt: '2026-06-16T00:02:00.000Z',
    updatedAt: '2026-06-16T00:04:00.000Z',
    ...overrides,
  };
}

function currentIncidentEvent() {
  return {
    id: 'irev_current_incident',
    issue_id: state.issue.id,
    run_id: state.currentRun.id,
    event_type: 'production_incident_detected',
    title: 'Production incident detected',
    summary: 'checkout 500s',
    detail: 'smoke failed',
    created_at: '2026-06-16T00:11:00.000Z',
  };
}

function archivedKnowledgeEvent(payload: Record<string, unknown>) {
  return {
    id: 'irev_archived_knowledge',
    issue_id: state.issue.id,
    run_id: state.archivedRun.id,
    event_type: 'incident_knowledge_archived',
    title: 'Incident knowledge archived',
    summary: 'checkout 500s',
    detail: 'ik_high_checkout-500s',
    payload,
    created_at: '2026-06-16T00:05:00.000Z',
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
  listIssueAgentRuns: vi.fn(() => [state.archivedRun, state.currentRun]),
  listIssueAgentRunEvents: vi.fn((runId: string) => state.events.filter((event) => event.run_id === runId)),
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

describe('issue runbook reuse routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.events = [
      archivedKnowledgeEvent({ incidentKnowledge: { incidentKnowledge: archivedIncident(), events: [] } }),
      currentIncidentEvent(),
    ];
  });

  test('GET returns recommendation using archived incident knowledge and is read-only', async () => {
    const res = await issueRoutes.request(`/${state.issue.id}/runs/${state.currentRun.id}/runbook-reuse`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runbookReuse.recommendation.status).toBe('reuse_recommended');
    expect(body.runbookReuse.matches[0].fingerprint).toBe('ik_high_checkout-500s');
    expect(body.runbookReuse.reusableActions).toEqual([expect.objectContaining({ action: 'spawn_fix_run' })]);
    expect(state.events.filter((event) => event.event_type === 'runbook_reuse_applied')).toHaveLength(0);
    expect(state.createIssueAgentRunEvent).not.toHaveBeenCalled();
  });

  test('POST apply records exactly one runbook reuse event and returns latest recommendation', async () => {
    state.events = [
      archivedKnowledgeEvent({ incidentKnowledge: archivedIncident() }),
      currentIncidentEvent(),
    ];

    const first = await issueRoutes.request(`/${state.issue.id}/runs/${state.currentRun.id}/runbook-reuse/apply`, { method: 'POST' });
    const second = await issueRoutes.request(`/${state.issue.id}/runs/${state.currentRun.id}/runbook-reuse/apply`, { method: 'POST' });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const body = await second.json();
    expect(body.runbookReuse.recommendation.status).toBe('reuse_recommended');
    expect(body.runbookReuse.matches[0].fingerprint).toBe('ik_high_checkout-500s');
    expect(state.events.filter((event) => event.event_type === 'runbook_reuse_applied')).toHaveLength(1);
  });

  test('POST apply rejects approval-required recommendations without recording applied event', async () => {
    state.events = [
      archivedKnowledgeEvent({
        incidentKnowledge: archivedIncident({
          fingerprint: 'ik_critical_checkout-500s',
          severity: 'critical',
          remediationActions: [{ action: 'request_rollback', summary: 'Rollback release', observedAt: '2026-06-16T00:03:00.000Z' }],
        }),
      }),
      { ...currentIncidentEvent(), summary: 'checkout 500s', event_type: 'production_rollback_recommended' },
    ];

    const res = await issueRoutes.request(`/${state.issue.id}/runs/${state.currentRun.id}/runbook-reuse/apply`, { method: 'POST' });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.runbookReuse.recommendation).toMatchObject({ status: 'approval_required', approvalRequired: true });
    expect(state.events.filter((event) => event.event_type === 'runbook_reuse_applied')).toHaveLength(0);
  });

  test('malformed archived incident payloads are ignored instead of crashing recommendation', async () => {
    state.events = [
      archivedKnowledgeEvent({ incidentKnowledge: { fingerprint: 'ik_high_checkout-500s' } }),
      currentIncidentEvent(),
    ];

    const res = await issueRoutes.request(`/${state.issue.id}/runs/${state.currentRun.id}/runbook-reuse`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runbookReuse.recommendation).toMatchObject({ status: 'none', action: 'none' });
    expect(body.runbookReuse.matches).toEqual([]);
  });

  test('no current incident returns none recommendation and empty matches', async () => {
    state.events = [
      archivedKnowledgeEvent({ incidentKnowledge: archivedIncident() }),
      {
        id: 'irev_quality_passed',
        issue_id: state.issue.id,
        run_id: state.currentRun.id,
        event_type: 'quality_passed',
        title: 'Quality passed',
        created_at: '2026-06-16T00:11:00.000Z',
      },
    ];

    const res = await issueRoutes.request(`/${state.issue.id}/runs/${state.currentRun.id}/runbook-reuse`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runbookReuse.recommendation).toMatchObject({ status: 'none', action: 'none' });
    expect(body.runbookReuse.matches).toEqual([]);
  });

  test('POST apply rejects missing recommendations without recording applied event', async () => {
    state.events = [
      archivedKnowledgeEvent({ incidentKnowledge: archivedIncident() }),
      {
        id: 'irev_quality_passed',
        issue_id: state.issue.id,
        run_id: state.currentRun.id,
        event_type: 'quality_passed',
        title: 'Quality passed',
        created_at: '2026-06-16T00:11:00.000Z',
      },
    ];

    const res = await issueRoutes.request(`/${state.issue.id}/runs/${state.currentRun.id}/runbook-reuse/apply`, { method: 'POST' });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.runbookReuse.recommendation).toMatchObject({ status: 'none' });
    expect(state.events.filter((event) => event.event_type === 'runbook_reuse_applied')).toHaveLength(0);
  });
});
