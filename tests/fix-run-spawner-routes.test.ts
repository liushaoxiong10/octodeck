import { beforeEach, describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
  issue: {
    id: 'iss_fix_spawn',
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
  currentRun: {
    id: 'irun_fix_current',
    issue_id: 'iss_fix_spawn',
    workspace_jid: 'web:main',
    workspace_folder: '/workspace',
    status: 'success',
    result: 'Observed current incident',
    created_by: 'admin',
    created_at: '2026-06-16T00:10:00.000Z',
  } as any,
  archivedRun: {
    id: 'irun_fix_archived',
    issue_id: 'iss_fix_spawn',
    workspace_jid: 'web:main',
    workspace_folder: '/workspace',
    status: 'success',
    result: 'Resolved previous incident',
    created_by: 'admin',
    created_at: '2026-06-16T00:01:00.000Z',
  } as any,
  runs: [] as any[],
  events: [] as any[],
  enqueued: [] as string[],
  createIssueAgentRun: vi.fn((run: any) => {
    state.runs.push(run);
    return run;
  }),
  createIssueAgentRunEvent: vi.fn((event: any) => {
    const created = { id: event.id ?? `irev_${state.events.length + 1}`, created_at: event.created_at ?? '2026-06-16T00:20:00.000Z', ...event };
    state.events.push(created);
    return created;
  }),
  createIssueEvent: vi.fn((event: any) => ({ id: `iev_${state.events.length + 1}`, ...event })),
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
    remediationActions: [{ action: 'spawn_fix_run', summary: 'Patch checkout null guard', observedAt: '2026-06-16T00:03:00.000Z' }],
    verificationSignals: [{ eventType: 'production_recovered', summary: 'healthy again', observedAt: '2026-06-16T00:04:00.000Z' }],
    preventionChecklist: ['Verify checkout recovery'],
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
  getWebDeps: () => ({ queue: { enqueueTask: vi.fn((jid: string) => state.enqueued.push(jid)) } }),
  hasHostExecutionPermission: () => true,
  isHostExecutionGroup: () => false,
}));

vi.mock('../src/db.js', () => ({
  answerIssueAgentRequest: vi.fn(),
  clearIssueAgentRunAwaiting: vi.fn(),
  createIssue: vi.fn(),
  createIssueAttachment: vi.fn(),
  createIssueAgentRequest: vi.fn(),
  createIssueAgentRun: state.createIssueAgentRun,
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

describe('issue fix run spawner routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.runs = [state.archivedRun, state.currentRun];
    state.enqueued = [];
    state.events = [archivedKnowledgeEvent({ incidentKnowledge: archivedIncident() }), currentIncidentEvent()];
  });

  test('GET returns draft-ready fix run and is read-only', async () => {
    const res = await issueRoutes.request(`/${state.issue.id}/runs/${state.currentRun.id}/fix-run-draft`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fixRunDraft).toMatchObject({ status: 'draft_ready', sourceRunId: state.currentRun.id });
    expect(body.fixRunDraft.prompt).toContain('Patch checkout null guard');
    expect(state.createIssueAgentRun).not.toHaveBeenCalled();
    expect(state.events.filter((event) => event.event_type === 'fix_run_spawned')).toHaveLength(0);
  });

  test('POST spawns exactly one child fix run and records audit event idempotently', async () => {
    const first = await issueRoutes.request(`/${state.issue.id}/runs/${state.currentRun.id}/fix-run`, { method: 'POST' });
    const second = await issueRoutes.request(`/${state.issue.id}/runs/${state.currentRun.id}/fix-run`, { method: 'POST' });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const body = await second.json();
    expect(body.run).toMatchObject({ issue_id: state.issue.id, parent_run_id: state.currentRun.id, status: 'queued' });
    expect(state.runs.filter((run) => run.parent_run_id === state.currentRun.id)).toHaveLength(1);
    expect(state.events.filter((event) => event.event_type === 'fix_run_spawned')).toHaveLength(1);
    expect(state.enqueued).toHaveLength(1);
  });

  test('POST rejects unsafe draft without creating child run', async () => {
    state.events = [
      archivedKnowledgeEvent({ incidentKnowledge: archivedIncident({ severity: 'critical', remediationActions: [{ action: 'request_rollback', summary: 'Rollback release', observedAt: '2026-06-16T00:03:00.000Z' }] }) }),
      { ...currentIncidentEvent(), event_type: 'production_rollback_recommended' },
    ];

    const res = await issueRoutes.request(`/${state.issue.id}/runs/${state.currentRun.id}/fix-run`, { method: 'POST' });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.fixRunDraft.status).toBe('approval_required');
    expect(state.runs.filter((run) => run.parent_run_id === state.currentRun.id)).toHaveLength(0);
    expect(state.events.filter((event) => event.event_type === 'fix_run_spawned')).toHaveLength(0);
  });
});
