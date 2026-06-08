import fs from 'fs';
import os from 'os';
import path from 'path';

import { beforeEach, describe, expect, test, vi } from 'vitest';

const tmpRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'octodeck-agent-team-metrics-'),
);
const tmpStoreDir = path.join(tmpRoot, 'store');

vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return {
    ...actual,
    DATA_DIR: tmpRoot,
    STORE_DIR: tmpStoreDir,
  };
});

vi.mock('../src/middleware/auth.js', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', {
      id: 'alice',
      username: 'alice',
      role: 'admin',
      permissions: ['manage_system_config'],
    });
    return next();
  },
  systemConfigMiddleware: async (_c: any, next: any) => next(),
}));

const { summarizeAgentTeamMetrics } = await import(
  '../src/agent-team-metrics.js'
);
const db = await import('../src/db.js');
const agentTeamRoutes = (await import('../src/routes/agent-teams.js')).default;

describe('agent team metrics', () => {
  beforeEach(async () => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.mkdirSync(tmpRoot, { recursive: true });
    await db.initDatabase();
  });

  test('summarizes run success rate, duration, failed tasks, and approval latency', () => {
    const summary = summarizeAgentTeamMetrics({
      runs: [
        {
          id: 'run_success_fast',
          teamId: 'team_a',
          userId: 'alice',
          prompt: 'ship fast',
          status: 'success',
          traceId: 'trace_1',
          workflowShape: 'pipeline',
          roleAssignments: {},
          createdAt: '2026-06-08T00:00:00.000Z',
          startedAt: '2026-06-08T00:00:01.000Z',
          completedAt: '2026-06-08T00:00:03.000Z',
          updatedAt: '2026-06-08T00:00:03.000Z',
        },
        {
          id: 'run_success_slow',
          teamId: 'team_a',
          userId: 'alice',
          prompt: 'ship slow',
          status: 'success',
          traceId: 'trace_2',
          workflowShape: 'pipeline',
          roleAssignments: {},
          createdAt: '2026-06-08T00:01:00.000Z',
          startedAt: '2026-06-08T00:01:02.000Z',
          completedAt: '2026-06-08T00:01:08.000Z',
          updatedAt: '2026-06-08T00:01:08.000Z',
        },
        {
          id: 'run_error',
          teamId: 'team_a',
          userId: 'alice',
          prompt: 'fail',
          status: 'error',
          traceId: 'trace_3',
          workflowShape: 'pipeline',
          roleAssignments: {},
          createdAt: '2026-06-08T00:02:00.000Z',
          startedAt: '2026-06-08T00:02:00.000Z',
          completedAt: '2026-06-08T00:02:01.000Z',
          updatedAt: '2026-06-08T00:02:01.000Z',
        },
        {
          id: 'run_active',
          teamId: 'team_a',
          userId: 'alice',
          prompt: 'still running',
          status: 'running',
          traceId: 'trace_4',
          workflowShape: 'pipeline',
          roleAssignments: {},
          createdAt: '2026-06-08T00:03:00.000Z',
          startedAt: '2026-06-08T00:03:00.000Z',
          updatedAt: '2026-06-08T00:03:00.000Z',
        },
      ],
      tasks: [
        { id: 'task_ok', runId: 'run_success_fast', status: 'success' },
        { id: 'task_error', runId: 'run_error', status: 'error' },
        { id: 'task_cancelled', runId: 'run_error', status: 'cancelled' },
      ],
      approvals: [
        {
          id: 'approval_fast',
          runId: 'run_success_fast',
          requestedBy: 'judge',
          status: 'approved',
          riskLevel: 'medium',
          title: 'Approve fast',
          description: 'Fast approval',
          payload: {},
          createdAt: '2026-06-08T00:00:10.000Z',
          resolvedAt: '2026-06-08T00:00:20.000Z',
        },
        {
          id: 'approval_slow',
          runId: 'run_success_slow',
          requestedBy: 'judge',
          status: 'rejected',
          riskLevel: 'high',
          title: 'Approve slow',
          description: 'Slow approval',
          payload: {},
          createdAt: '2026-06-08T00:01:00.000Z',
          resolvedAt: '2026-06-08T00:02:00.000Z',
        },
        {
          id: 'approval_pending',
          runId: 'run_active',
          requestedBy: 'judge',
          status: 'pending',
          riskLevel: 'low',
          title: 'Pending',
          description: 'Ignored until resolved',
          payload: {},
          createdAt: '2026-06-08T00:03:00.000Z',
        },
      ],
    });

    expect(summary).toMatchObject({
      totalRuns: 4,
      successfulRuns: 2,
      failedRuns: 1,
      successRate: 0.5,
      averageDurationMs: 3000,
      failedTaskCount: 2,
      approvalLatency: {
        resolvedCount: 2,
        averageMs: 35000,
      },
    });
  });

  test('returns zero counts and null averages for empty inputs', () => {
    expect(
      summarizeAgentTeamMetrics({ runs: [], tasks: [], approvals: [] }),
    ).toEqual({
      totalRuns: 0,
      successfulRuns: 0,
      failedRuns: 0,
      cancelledRuns: 0,
      activeRuns: 0,
      successRate: 0,
      averageDurationMs: null,
      failedTaskCount: 0,
      approvalLatency: {
        resolvedCount: 0,
        averageMs: null,
      },
    });
  });

  test('loads filtered DB records and serves summarized authenticated metrics', async () => {
    db.recordAgentTeamRun({
      id: 'run_included_success',
      teamId: 'team_a',
      userId: 'alice',
      prompt: 'included success',
      status: 'success',
      traceId: 'trace_included_success',
      workflowShape: 'pipeline',
      createdAt: '2026-06-08T10:00:00.000Z',
      startedAt: '2026-06-08T10:00:00.000Z',
      completedAt: '2026-06-08T10:00:04.000Z',
      updatedAt: '2026-06-08T10:00:04.000Z',
    });
    db.recordAgentTeamRun({
      id: 'run_included_error',
      teamId: 'team_a',
      userId: 'alice',
      prompt: 'included error',
      status: 'error',
      traceId: 'trace_included_error',
      workflowShape: 'pipeline',
      createdAt: '2026-06-08T11:00:00.000Z',
      startedAt: '2026-06-08T11:00:00.000Z',
      completedAt: '2026-06-08T11:00:02.000Z',
      updatedAt: '2026-06-08T11:00:02.000Z',
    });
    db.recordAgentTeamRun({
      id: 'run_other_team',
      teamId: 'team_b',
      userId: 'alice',
      prompt: 'other team',
      status: 'success',
      traceId: 'trace_other_team',
      workflowShape: 'pipeline',
      createdAt: '2026-06-08T12:00:00.000Z',
      startedAt: '2026-06-08T12:00:00.000Z',
      completedAt: '2026-06-08T12:00:01.000Z',
      updatedAt: '2026-06-08T12:00:01.000Z',
    });
    db.recordAgentTeamRun({
      id: 'run_other_user',
      teamId: 'team_a',
      userId: 'bob',
      prompt: 'other user',
      status: 'success',
      traceId: 'trace_other_user',
      workflowShape: 'pipeline',
      createdAt: '2026-06-08T13:00:00.000Z',
      startedAt: '2026-06-08T13:00:00.000Z',
      completedAt: '2026-06-08T13:00:01.000Z',
      updatedAt: '2026-06-08T13:00:01.000Z',
    });
    db.recordAgentTeamRun({
      id: 'run_after_millisecond_until',
      teamId: 'team_a',
      userId: 'alice',
      prompt: 'after millisecond until',
      status: 'success',
      traceId: 'trace_after_millisecond_until',
      workflowShape: 'pipeline',
      createdAt: '2026-06-08T11:30:00.900Z',
      startedAt: '2026-06-08T11:30:00.900Z',
      completedAt: '2026-06-08T11:30:01.000Z',
      updatedAt: '2026-06-08T11:30:01.000Z',
    });
    db.recordAgentTeamTask({
      id: 'task_included_error',
      runId: 'run_included_error',
      status: 'error',
    });
    db.recordAgentTeamApproval({
      id: 'approval_included',
      runId: 'run_included_success',
      requestedBy: 'judge',
      status: 'approved',
      riskLevel: 'medium',
      title: 'Approve included',
      description: 'Included approval',
      payload: {},
      createdAt: '2026-06-08T10:00:10.000Z',
      resolvedAt: '2026-06-08T10:00:40.000Z',
    });

    const records = db.listAgentTeamRunsForMetrics({
      userId: 'alice',
      teamId: 'team_a',
      since: '2026-06-08T09:30:00.000Z',
      until: '2026-06-08T11:29:59.999Z',
      limit: 10,
    });

    expect(records.runs.map((run) => run.id).sort()).toEqual([
      'run_included_error',
      'run_included_success',
    ]);
    expect(records.tasks).toHaveLength(1);
    expect(records.approvals).toHaveLength(1);

    const res = await agentTeamRoutes.request(
      '/metrics?teamId=team_a&since=2026-06-08T09%3A30%3A00.000Z&until=2026-06-08T11%3A29%3A59.999Z',
    );
    const body = (await res.json()) as {
      metrics: ReturnType<typeof summarizeAgentTeamMetrics>;
    };

    expect(res.status).toBe(200);
    expect(body.metrics).toMatchObject({
      totalRuns: 2,
      successfulRuns: 1,
      failedRuns: 1,
      successRate: 0.5,
      averageDurationMs: 3000,
      failedTaskCount: 1,
      approvalLatency: {
        resolvedCount: 1,
        averageMs: 30000,
      },
    });

    const dateOnlyRes = await agentTeamRoutes.request(
      '/metrics?teamId=team_a&since=2026-06-08&until=2026-06-08',
    );
    const dateOnlyBody = (await dateOnlyRes.json()) as {
      metrics: ReturnType<typeof summarizeAgentTeamMetrics>;
    };

    expect(dateOnlyRes.status).toBe(200);
    expect(dateOnlyBody.metrics.totalRuns).toBe(3);

    const invalidRangeRes = await agentTeamRoutes.request(
      '/metrics?since=2026-06-09&until=2026-06-08',
    );

    expect(invalidRangeRes.status).toBe(400);
    expect(await invalidRangeRes.json()).toEqual({
      error: 'since must be before until',
    });

    const millisecondRes = await agentTeamRoutes.request(
      '/metrics?teamId=team_a&since=2026-06-08T11%3A30%3A00.000Z&until=2026-06-08T11%3A30%3A00.123Z',
    );
    const millisecondBody = (await millisecondRes.json()) as {
      metrics: ReturnType<typeof summarizeAgentTeamMetrics>;
    };

    expect(millisecondRes.status).toBe(200);
    expect(millisecondBody.metrics.totalRuns).toBe(0);
  });
});
