import { beforeEach, describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
  user: { id: 'u_viewer', username: 'viewer', role: 'user', permissions: [] as string[] },
  issue: {
    id: 'iss_private_preview',
    title: 'Private issue',
    description: 'private orchestration context',
    workspace_jid: 'web:private',
    workspace_folder: '/private',
    status: 'todo',
    priority: 'normal',
    created_by: 'admin',
    created_at: '2026-06-16T00:00:00.000Z',
    updated_at: '2026-06-16T00:00:00.000Z',
  },
}));

vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', state.user);
    return next();
  },
}));

vi.mock('../src/db.js', () => ({
  getAllTasks: vi.fn(() => []),
  getIssueById: vi.fn((id: string) => (id === state.issue.id ? state.issue : null)),
  getRegisteredGroup: vi.fn(() => undefined),
  getTaskById: vi.fn(() => null),
  getTaskRunLogs: vi.fn(() => []),
  listAgentTasks: vi.fn(() => []),
  listAgentTeamApprovals: vi.fn(() => []),
  listAgentTeamRuns: vi.fn(() => []),
  listIssueAgentRequests: vi.fn(() => []),
  listIssueAgentRunEvents: vi.fn(() => []),
  listIssueAgentRuns: vi.fn(() => []),
  listIssues: vi.fn(() => ({ issues: [], total: 0 })),
}));

vi.mock('../src/web-context.js', () => ({
  canAccessGroup: vi.fn(() => false),
  hasHostExecutionPermission: vi.fn(() => false),
  isHostExecutionGroup: vi.fn(() => false),
}));

vi.mock('../src/routes/registry.js', () => ({
  buildRegistryGovernanceSnapshot: vi.fn(() => ({ registry: { summary: {}, capabilityCatalog: [] } })),
}));

const orchestrationRoutes = (await import('../src/routes/orchestration.js')).default;

describe('orchestration routes', () => {
  beforeEach(() => {
    state.user = { id: 'u_viewer', username: 'viewer', role: 'user', permissions: [] };
  });

  test('preview hides issues the user cannot access', async () => {
    const res = await orchestrationRoutes.request(`/preview?source=issue&id=${state.issue.id}`);
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe('issue not found');
  });
});
