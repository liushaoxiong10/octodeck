import { beforeEach, describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
  issue: { id: 'iss_resolution', title: 'Checkout failed', description: 'smoke failed', workspace_jid: 'web:main', workspace_folder: '/workspace', status: 'review', priority: 'normal', created_by: 'admin', created_at: '2026-06-16T00:00:00.000Z', updated_at: '2026-06-16T00:00:00.000Z' } as any,
  sourceRun: { id: 'irun_resolution_source', issue_id: 'iss_resolution', workspace_jid: 'web:main', workspace_folder: '/workspace', status: 'success', result: 'incident observed', created_by: 'admin', created_at: '2026-06-16T00:10:00.000Z' } as any,
  fixRun: { id: 'irun_resolution_fix', issue_id: 'iss_resolution', workspace_jid: 'web:main', workspace_folder: '/workspace', parent_run_id: 'irun_resolution_source', status: 'success', result: 'tests passed; production healthy', created_by: 'admin', created_at: '2026-06-16T00:20:00.000Z' } as any,
  runs: [] as any[],
  events: [] as any[],
  issueEvents: [] as any[],
  requests: [] as any[],
  createIssueAgentRunEvent: vi.fn((event: any) => {
    const created = { id: event.id ?? `irev_${state.events.length + 1}`, created_at: event.created_at ?? '2026-06-16T00:30:00.000Z', ...event };
    state.events.push(created);
    return created;
  }),
  createIssueEvent: vi.fn((event: any) => {
    const created = { id: `iev_${state.issueEvents.length + 1}`, created_at: '2026-06-16T00:31:00.000Z', ...event };
    state.issueEvents.push(created);
    return created;
  }),
  updateIssue: vi.fn((id: string, patch: any) => {
    if (id === state.issue.id) state.issue = { ...state.issue, ...patch, updated_at: '2026-06-16T00:32:00.000Z' };
  }),
}));

const draft = { status: 'draft_ready', title: 'Fix checkout', riskLevel: 'high', sourceRunId: state.sourceRun.id, verificationChecklist: ['Run checkout smoke'], remediationActions: [] };

function event(overrides: Record<string, unknown>) {
  return { id: `irev_seed_${state.events.length + 1}`, issue_id: state.issue.id, run_id: state.fixRun.id, event_type: 'run_queued', title: 'event', summary: null, detail: null, payload: null, created_at: '2026-06-16T00:20:00.000Z', ...overrides };
}

vi.mock('../src/middleware/auth.ts', () => ({ authMiddleware: async (c: any, next: any) => { c.set('user', { id: 'admin', username: 'admin', role: 'admin', permissions: ['manage_system_config'] }); return next(); } }));
vi.mock('../src/web-context.js', () => ({ MAX_GROUP_NAME_LEN: 40, canAccessGroup: () => true, canDeleteGroup: () => true, canManageGroupMembers: () => true, canModifyGroup: () => true, getWebDeps: () => ({ queue: { enqueueTask: vi.fn() } }), hasHostExecutionPermission: () => true, isHostExecutionGroup: () => false }));
vi.mock('../src/db.js', () => ({
  answerIssueAgentRequest: vi.fn(), clearIssueAgentRunAwaiting: vi.fn(), createIssue: vi.fn(), createIssueAttachment: vi.fn(), createIssueAgentRequest: vi.fn(), createIssueAgentRun: vi.fn(), createIssueAgentRunEvent: state.createIssueAgentRunEvent, createIssueComment: vi.fn(), createIssueEvent: state.createIssueEvent, deleteIssueAttachment: vi.fn(), deleteIssue: vi.fn(), getAgentLinkById: vi.fn(), getAgentTaskScopedTokenById: vi.fn(), getAgentTaskById: vi.fn(), getIssueAgentRequestById: vi.fn(), getIssueAttachmentById: vi.fn(), getIssueById: vi.fn((id: string) => (id === state.issue.id ? state.issue : null)), getIssueCommentById: vi.fn(), getAllRegisteredGroups: vi.fn(() => ({})), getManagedRepoById: vi.fn(), getRegisteredGroup: vi.fn(() => undefined), getUserHomeGroup: vi.fn(), listAgentLinksByUser: vi.fn(() => []), listIssueAgentRequests: vi.fn((issueId: string, opts: any = {}) => state.requests.filter((item) => item.issue_id === issueId && (!opts.runId || item.run_id === opts.runId) && (!opts.status || item.status === opts.status))), listIssueAgentRuns: vi.fn(() => state.runs), listIssueAgentRunEvents: vi.fn((runId: string) => state.events.filter((item) => item.run_id === runId)), listIssueAttachments: vi.fn(() => []), listIssueComments: vi.fn(() => []), listIssueEvents: vi.fn(() => state.issueEvents), listIssues: vi.fn(() => ({ issues: [state.issue], total: 1 })), logAuthEvent: vi.fn(), softDeleteIssueComment: vi.fn(), updateIssue: state.updateIssue, updateIssueAgentRun: vi.fn(), updateIssueComment: vi.fn(), updateIssueLastRun: vi.fn(),
}));
vi.mock('../src/issue-runner.js', () => ({ runIssueAgent: vi.fn() }));
vi.mock('../src/issue-notifier.js', () => ({ afterIssueEventCreated: vi.fn() }));
vi.mock('../src/git-provider.js', () => ({ createIssueRunPullRequest: vi.fn(), getIssueRunPullRequestStatus: vi.fn() }));
vi.mock('../src/agent-link/registry.js', () => ({ getSession: vi.fn(() => null), getOnlineMeta: vi.fn(() => null), isOnline: vi.fn(() => false) }));
vi.mock('../src/agent-link/agent-runtime-rpc.js', () => ({ requestWorkspaceGitCommit: vi.fn(), requestWorkspaceGitStatus: vi.fn() }));

const issueRoutes = (await import('../src/routes/issues.js')).default;

describe('issue resolution gate routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.issue = { ...state.issue, status: 'review' };
    state.runs = [state.sourceRun, state.fixRun];
    state.requests = [];
    state.issueEvents = [];
    state.events = [
      event({ run_id: state.sourceRun.id, event_type: 'fix_run_spawned', title: 'Fix run spawned', payload: { fixRunId: state.fixRun.id, fixRunDraft: draft } }),
      event({ run_id: state.fixRun.id, event_type: 'run_queued', title: 'Fix run queued', payload: { trigger: 'fix_run_spawner', parentRunId: state.sourceRun.id, fixRunDraft: draft } }),
    ];
  });

  test('GET returns ready gate and is read-only', async () => {
    const res = await issueRoutes.request(`/${state.issue.id}/runs/${state.fixRun.id}/resolution-gate`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resolutionGate).toMatchObject({ status: 'ready', recommendedIssueStatus: 'done', fixRunId: state.fixRun.id });
    expect(state.updateIssue).not.toHaveBeenCalled();
    expect(state.events.filter((item) => item.event_type === 'resolution_gate_applied')).toHaveLength(0);
  });

  test('POST applies safe gate once and closes issue idempotently', async () => {
    const first = await issueRoutes.request(`/${state.issue.id}/runs/${state.fixRun.id}/resolution-gate/apply`, { method: 'POST' });
    const second = await issueRoutes.request(`/${state.issue.id}/runs/${state.fixRun.id}/resolution-gate/apply`, { method: 'POST' });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(state.issue.status).toBe('done');
    expect(state.events.filter((item) => item.event_type === 'resolution_gate_applied')).toHaveLength(1);
    expect(state.issueEvents.filter((item) => item.event_type === 'status_changed')).toHaveLength(1);
  });

  test('POST rejects critical approval-required gate without closing issue', async () => {
    state.fixRun = { ...state.fixRun, result: 'tests passed; production healthy' };
    state.events = [
      event({ run_id: state.sourceRun.id, event_type: 'fix_run_spawned', title: 'Fix run spawned', payload: { fixRunId: state.fixRun.id, fixRunDraft: { ...draft, riskLevel: 'critical' } } }),
      event({ run_id: state.fixRun.id, event_type: 'run_queued', title: 'Fix run queued', payload: { trigger: 'fix_run_spawner', parentRunId: state.sourceRun.id, fixRunDraft: { ...draft, riskLevel: 'critical' } } }),
    ];
    const res = await issueRoutes.request(`/${state.issue.id}/runs/${state.fixRun.id}/resolution-gate/apply`, { method: 'POST' });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.resolutionGate.status).toBe('approval_required');
    expect(state.issue.status).toBe('review');
    expect(state.events.filter((item) => item.event_type === 'resolution_gate_applied')).toHaveLength(0);
  });

  test('POST applies critical gate after matching approval request is approved', async () => {
    state.fixRun = { ...state.fixRun, result: 'tests passed; production healthy' };
    state.events = [
      event({ run_id: state.sourceRun.id, event_type: 'fix_run_spawned', title: 'Fix run spawned', payload: { fixRunId: state.fixRun.id, fixRunDraft: { ...draft, riskLevel: 'critical' } } }),
      event({ run_id: state.fixRun.id, event_type: 'run_queued', title: 'Fix run queued', payload: { trigger: 'fix_run_spawner', parentRunId: state.sourceRun.id, fixRunDraft: { ...draft, riskLevel: 'critical' } } }),
    ];
    state.requests = [{
      id: 'req_resolution_approval',
      issue_id: state.issue.id,
      run_id: state.fixRun.id,
      kind: 'permission',
      title: 'Resolution approval required',
      payload: { resolutionGate: true, fixRunId: state.fixRun.id },
      status: 'answered',
      decision: 'approve',
      answer: 'approved',
      answered_at: '2026-06-16T00:30:00.000Z',
      answered_by: 'admin',
      created_at: '2026-06-16T00:29:00.000Z',
    }];

    const res = await issueRoutes.request(`/${state.issue.id}/runs/${state.fixRun.id}/resolution-gate/apply`, { method: 'POST' });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resolutionGate).toMatchObject({ status: 'ready', approvalRequired: false, riskLevel: 'critical' });
    expect(state.issue.status).toBe('done');
    expect(state.events.filter((item) => item.event_type === 'resolution_gate_applied')).toHaveLength(1);
  });
});
