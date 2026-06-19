import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', { id: 'admin', username: 'admin', role: 'admin', permissions: ['manage_system_config'] });
    return next();
  },
}));

vi.mock('../src/db.js', () => ({
  getAllTasks: () => [],
  getRegisteredGroup: () => undefined,
  getTaskRunLogs: () => [],
  listAgentTasks: () => [],
  listAgentTeamApprovals: () => [],
  listAgentTeamRuns: () => [],
  listIssueAgentRequests: () => [],
  listIssueAgentRunEvents: () => [
    {
      id: 'ev_files',
      issue_id: 'iss_quality',
      run_id: 'run_quality',
      event_type: 'files_changed',
      summary: 'src/quality.ts',
      created_at: '2026-06-15T02:08:00.000Z',
    },
  ],
  listIssueAgentRuns: () => [
    {
      id: 'run_quality',
      issue_id: 'iss_quality',
      workspace_jid: 'web:main',
      workspace_folder: 'main',
      status: 'success',
      result: 'Modified src/quality.ts',
      created_by: 'admin',
      created_at: '2026-06-15T02:01:00.000Z',
      run_completed_at: '2026-06-15T02:09:00.000Z',
    },
  ],
  listIssues: () => ({
    issues: [
      {
        id: 'iss_quality',
        title: 'Change code without tests',
        workspace_jid: 'web:main',
        workspace_folder: 'main',
        status: 'review',
        priority: 'normal',
        description: '',
        created_by: 'admin',
        created_at: '2026-06-15T02:00:00.000Z',
        updated_at: '2026-06-15T02:10:00.000Z',
      },
    ],
  }),
}));

const qualityRoutes = (await import('../src/routes/quality.js')).default;

describe('quality routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('returns filtered quality evaluation details', async () => {
    const res = await qualityRoutes.request('/evaluations?outcome=needs_review');
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.evaluations).toHaveLength(1);
    expect(body.evaluations[0]).toMatchObject({
      source: 'issue',
      sourceId: 'iss_quality',
      runId: 'run_quality',
      outcome: 'needs_review',
      failureCategory: 'missing_verification',
    });
  });

  test('returns quality scorecards for accessible runs', async () => {
    const res = await qualityRoutes.request('/scorecards');
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.summary).toMatchObject({ total: 1, needsReview: 1, passed: 0 });
    expect(body.insights).toContain('1 run(s) need human quality review');
  });
});
