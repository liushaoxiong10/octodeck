import fs from 'fs';
import os from 'os';
import path from 'path';

import bcrypt from 'bcryptjs';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'octodeck-agent-team-runtime-'));
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
    c.set('user', { id: 'alice', username: 'alice', role: 'admin', permissions: ['manage_system_config'] });
    return next();
  },
  systemConfigMiddleware: async (_c: any, next: any) => next(),
}));

vi.mock('../src/runtime-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/runtime-config.js')>();
  return {
    ...actual,
    getSystemSettings: () => ({
      ...actual.DEFAULT_SYSTEM_SETTINGS,
      defaultBackend: 'runner_a',
      allowedBackends: ['runner_a', 'runner_b'],
    }),
  };
});

const db = await import('../src/db.js');
const { registerBackend, unregisterBackend } = await import('../src/backends/registry.js');
const agentTeams = await import('../src/agent-teams.js');
const agentTeamRoutes = (await import('../src/routes/agent-teams.js')).default;
const agentLinkRoutes = (await import('../src/routes/agent-link.js')).default;

const calls: Array<{ backendId: string; prompt: string; folder: string }> = [];

function registerTestBackend(id: string) {
  registerBackend({
    id,
    displayName: id,
    usesProviderPool: false,
    supportsExecutionMode: (mode) => mode === 'host',
    run: vi.fn(async ({ input, group }) => {
      calls.push({ backendId: id, prompt: input.prompt, folder: group.folder });
      const roleMatch = input.prompt.match(/Current role: .*\(([^)]+)\)/);
      return { status: 'success', result: `${id}:${roleMatch?.[1] ?? 'unknown'}` };
    }),
  });
}

describe('agent team runtime persistence and role assignments', () => {
  beforeEach(async () => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.mkdirSync(tmpRoot, { recursive: true });
    calls.length = 0;
    await db.initDatabase();
    unregisterBackend('runner_a');
    unregisterBackend('runner_b');
    registerTestBackend('runner_a');
    registerTestBackend('runner_b');
  });

  test('executes roles with per-role runners and stores run/task/trace events', async () => {
    const team = agentTeams.createAgentTeam({
      name: 'Runtime Team',
      goal: '验证运行时能力',
      shape: 'pipeline',
      description: '测试 roleAssignments 和 trace 持久化。',
      roles: [
        { id: 'planner', name: 'Planner', responsibility: '规划。' },
        { id: 'builder', name: 'Builder', responsibility: '实现。' },
      ],
      workflow: 'Planner 后 Builder。',
      successCriteria: ['持久化运行记录'],
      createdByAgentId: 'runner_a',
    }, 'alice');

    const res = await agentTeamRoutes.request(`/${team.id}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: '执行一次运行时测试',
        runnerAgentId: 'runner_a',
        roleAssignments: {
          builder: { runnerAgentId: 'runner_b' },
        },
      }),
    });
    const body = await res.json() as { execution: { runId: string; traceId: string; traceEvents: unknown[] } };

    expect(res.status).toBe(200);
    expect(calls.map((call) => `${call.backendId}:${call.folder}`)).toEqual([
      `runner_a:agent-team-${team.id}-planner`,
      `runner_b:agent-team-${team.id}-builder`,
    ]);
    expect(body.execution.runId).toMatch(/^team_run_/);
    expect(body.execution.traceId).toMatch(/^team_trace_/);
    expect(body.execution.traceEvents.length).toBeGreaterThanOrEqual(5);

    const sqlite = db.getDatabaseForInternalUse();
    const run = sqlite.prepare('SELECT * FROM agent_team_runs WHERE id = ?').get(body.execution.runId) as { status: string; role_assignments: string };
    const tasks = sqlite.prepare('SELECT role_id, actor_id, status FROM agent_team_tasks WHERE run_id = ?').all(body.execution.runId) as Array<{ role_id: string; actor_id: string; status: string }>;
    const eventCount = sqlite.prepare('SELECT COUNT(*) AS count FROM agent_team_events WHERE run_id = ?').get(body.execution.runId) as { count: number };

    expect(run.status).toBe('success');
    expect(JSON.parse(run.role_assignments)).toEqual({ builder: { runnerAgentId: 'runner_b' } });
    expect(tasks.sort((a, b) => a.role_id.localeCompare(b.role_id))).toEqual([
      { role_id: 'builder', actor_id: 'runner_b', status: 'success' },
      { role_id: 'planner', actor_id: 'runner_a', status: 'success' },
    ]);
    expect(eventCount.count).toBe(body.execution.traceEvents.length);
  });

  test('executes an agent team through the bearer-protected tool bridge', async () => {
    const team = agentTeams.createAgentTeam({
      name: 'MCP Tool Team',
      goal: '让会话 agent 通过 MCP 驱动团队',
      shape: 'pipeline',
      description: '测试 agent_team_run 工具桥接。',
      roles: [
        { id: 'planner', name: 'Planner', responsibility: '规划。' },
        { id: 'builder', name: 'Builder', responsibility: '实现。' },
      ],
      workflow: 'Planner 后 Builder。',
      successCriteria: ['MCP 工具可执行 Team'],
      createdByAgentId: 'runner_a',
    }, 'alice');

    const unauthorized = await agentTeamRoutes.request('/tool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'alice', operation: 'list_teams' }),
    });
    expect(unauthorized.status).toBe(401);

    const res = await agentTeamRoutes.request('/tool', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OCTODECK_AGENT_RUNNER_SECRET}`,
      },
      body: JSON.stringify({
        userId: 'alice',
        operation: 'run_team',
        teamId: team.id,
        prompt: '通过 MCP tool 运行团队',
        runnerAgentId: 'runner_a',
        roleAssignments: { builder: { runnerAgentId: 'runner_b' } },
      }),
    });
    const body = await res.json() as { run: { id: string; status: string }; execution: { status: string; finalResult: string } };

    expect(res.status).toBe(201);
    expect(body.run.status).toBe('success');
    expect(body.execution.status).toBe('success');
    expect(body.execution.finalResult).toContain('runner_b:builder');
    expect(calls.map((call) => call.backendId)).toEqual(['runner_a', 'runner_b']);
  });

  test('executes an agent team through a daemon link authenticated tool bridge', async () => {
    const token = 'daemon-link-token-for-agent-team-tool';
    const now = new Date().toISOString();
    db.createUser({
      id: 'alice',
      username: 'alice',
      password_hash: 'hash',
      display_name: 'Alice',
      role: 'admin',
      status: 'active',
      created_at: now,
      updated_at: now,
    });
    db.createAgentLink({
      id: 'cl_agent_team_daemon',
      userId: 'alice',
      displayName: 'Alice Mac',
      tokenHash: await bcrypt.hash(token, 4),
    });
    const team = agentTeams.createAgentTeam({
      name: 'Daemon MCP Team',
      goal: '让 daemon 上的会话 agent 通过本地 MCP 调团队',
      shape: 'pipeline',
      description: '测试 daemon link token 桥接 Agent Team。',
      roles: [
        { id: 'planner', name: 'Planner', responsibility: '规划。' },
        { id: 'builder', name: 'Builder', responsibility: '实现。' },
      ],
      workflow: 'Planner 后 Builder。',
      successCriteria: ['daemon 可调用 Team'],
      createdByAgentId: 'runner_a',
    }, 'alice');

    const res = await agentLinkRoutes.request('/agent-team-tool', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Link-Token': token,
      },
      body: JSON.stringify({
        operation: 'run_team',
        teamId: team.id,
        prompt: '通过 daemon MCP tool 运行团队',
        runnerAgentId: 'runner_a',
        roleAssignments: { builder: { runnerAgentId: 'runner_b' } },
      }),
    });
    const body = await res.json() as { run: { status: string }; execution: { status: string; finalResult: string } };

    expect(res.status).toBe(201);
    expect(body.run.status).toBe('success');
    expect(body.execution.status).toBe('success');
    expect(body.execution.finalResult).toContain('runner_b:builder');
  });

  test('creates queryable runs with events, tasks, and blackboard outputs', async () => {
    const team = agentTeams.createAgentTeam({
      name: 'Queryable Runtime Team',
      goal: '查询运行历史',
      shape: 'pipeline',
      description: '测试 run 查询 API。',
      roles: [
        { id: 'planner', name: 'Planner', responsibility: '规划。' },
        { id: 'builder', name: 'Builder', responsibility: '实现。' },
      ],
      workflow: 'Planner 后 Builder。',
      successCriteria: ['可查询运行历史'],
      createdByAgentId: 'runner_a',
    }, 'alice');

    const createRes = await agentTeamRoutes.request(`/${team.id}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: '创建可查询 run',
        runnerAgentId: 'runner_a',
        roleAssignments: { builder: { runnerAgentId: 'runner_b' } },
      }),
    });
    const created = await createRes.json() as { run: { id: string; status: string; teamId: string }; execution: { status: string } };

    expect(createRes.status).toBe(201);
    expect(created.run.status).toBe('success');
    expect(created.run.teamId).toBe(team.id);
    expect(created.execution.status).toBe('success');

    const [runRes, tasksRes, eventsRes, blackboardRes] = await Promise.all([
      agentTeamRoutes.request(`/runs/${created.run.id}`),
      agentTeamRoutes.request(`/runs/${created.run.id}/tasks`),
      agentTeamRoutes.request(`/runs/${created.run.id}/events`),
      agentTeamRoutes.request(`/runs/${created.run.id}/blackboard`),
    ]);
    const runBody = await runRes.json() as { run: { id: string; status: string; roleAssignments: unknown } };
    const tasksBody = await tasksRes.json() as { tasks: Array<{ roleId: string; actorId: string; status: string }> };
    const eventsBody = await eventsRes.json() as { events: Array<{ runId: string; type: string; payload: unknown }> };
    const blackboardBody = await blackboardRes.json() as { entries: Array<{ kind: string; roleId: string; key: string; value: string }> };

    expect(runRes.status).toBe(200);
    expect(runBody.run).toMatchObject({ id: created.run.id, status: 'success' });
    expect(runBody.run.roleAssignments).toEqual({ builder: { runnerAgentId: 'runner_b' } });
    expect(tasksBody.tasks.map((task) => `${task.roleId}:${task.actorId}:${task.status}`).sort()).toEqual([
      'builder:runner_b:success',
      'planner:runner_a:success',
    ]);
    expect(eventsBody.events.some((event) => event.runId === created.run.id && event.type === 'workflow.completed')).toBe(true);
    expect(blackboardBody.entries.map((entry) => `${entry.kind}:${entry.roleId}:${entry.key}`).sort()).toEqual([
      'role_output:builder:builder.finalize.output',
      'role_output:planner:planner.work.output',
    ]);
    expect(blackboardBody.entries.find((entry) => entry.roleId === 'builder')?.value).toBe('runner_b:builder');
  });

  test('lists run history by team and status for the current user', async () => {
    const team = agentTeams.createAgentTeam({
      name: 'Run History Team',
      goal: '查询 run 历史列表',
      shape: 'pipeline',
      description: '测试 run history API。',
      roles: [
        { id: 'worker', name: 'Worker', responsibility: '执行。' },
      ],
      workflow: 'Worker 单步执行。',
      successCriteria: ['可列出历史 run'],
      createdByAgentId: 'runner_a',
    }, 'alice');
    const otherTeam = agentTeams.createAgentTeam({
      name: 'Other Run History Team',
      goal: '其他团队',
      shape: 'pipeline',
      description: '用于验证 teamId 过滤。',
      roles: [{ id: 'worker', name: 'Worker', responsibility: '执行。' }],
      workflow: 'Worker 单步执行。',
      successCriteria: ['不应混入'],
      createdByAgentId: 'runner_a',
    }, 'alice');

    const firstRes = await agentTeamRoutes.request(`/${team.id}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: '第一次 run', runnerAgentId: 'runner_a' }),
    });
    const secondRes = await agentTeamRoutes.request(`/${team.id}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: '第二次 run', runnerAgentId: 'runner_a' }),
    });
    await agentTeamRoutes.request(`/${otherTeam.id}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: '其他团队 run', runnerAgentId: 'runner_a' }),
    });
    const first = await firstRes.json() as { run: { id: string } };
    const second = await secondRes.json() as { run: { id: string } };

    const [allRes, filteredRes] = await Promise.all([
      agentTeamRoutes.request(`/runs?teamId=${encodeURIComponent(team.id)}`),
      agentTeamRoutes.request(`/runs?teamId=${encodeURIComponent(team.id)}&status=success&limit=1`),
    ]);
    const allBody = await allRes.json() as { runs: Array<{ id: string; teamId: string; prompt: string; status: string }> };
    const filteredBody = await filteredRes.json() as { runs: Array<{ id: string; teamId: string; status: string }> };

    expect(allRes.status).toBe(200);
    expect(allBody.runs.map((run) => run.id)).toEqual([second.run.id, first.run.id]);
    expect(allBody.runs.every((run) => run.teamId === team.id)).toBe(true);
    expect(allBody.runs.map((run) => run.prompt)).toEqual(['第二次 run', '第一次 run']);
    expect(filteredBody.runs).toHaveLength(1);
    expect(filteredBody.runs[0]).toMatchObject({ id: second.run.id, teamId: team.id, status: 'success' });
  });

  test('blocks L4 runs for approval, resumes after approval, and supports cancellation', async () => {
    const team = agentTeams.createAgentTeam({
      name: 'Approval Runtime Team',
      goal: '验证审批流',
      shape: 'pipeline',
      description: '包含 L4 高风险角色。',
      roles: [
        {
          id: 'deploy',
          name: 'Deploy',
          responsibility: '执行高风险发布。',
          policy: { permissionLevel: 'L4', workspacePolicy: 'worktree', requiresApproval: true },
        },
      ],
      workflow: '审批后执行 Deploy。',
      successCriteria: ['审批可恢复执行'],
      createdByAgentId: 'runner_a',
    }, 'alice');

    const createRes = await agentTeamRoutes.request(`/${team.id}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: '发布到生产', runnerAgentId: 'runner_a' }),
    });
    const created = await createRes.json() as { run: { id: string; status: string }; approval: { id: string; status: string; riskLevel: string }; checkpoint: { nodeId: string } };

    expect(createRes.status).toBe(202);
    expect(created.run.status).toBe('waiting_approval');
    expect(created.approval).toMatchObject({ status: 'pending', riskLevel: 'L4' });
    expect(created.checkpoint.nodeId).toBe('approval:deploy');
    expect(calls).toEqual([]);

    const approveRes = await agentTeamRoutes.request(`/runs/${created.run.id}/approvals/${created.approval.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approved' }),
    });
    const approved = await approveRes.json() as { run: { status: string }; execution: { status: string } };

    expect(approveRes.status).toBe(200);
    expect(approved.run.status).toBe('success');
    expect(approved.execution.status).toBe('success');
    expect(calls.map((call) => call.backendId)).toEqual(['runner_a']);

    const cancelTeam = agentTeams.createAgentTeam({
      ...agentTeams.buildAgentTeamDraft({ generatorAgentId: 'runner_a', goal: '取消审批 run', shape: 'pipeline' }),
      roles: [{ id: 'danger', name: 'Danger', responsibility: '危险操作。', policy: { permissionLevel: 'L4', requiresApproval: true } }],
    }, 'alice');
    const pendingRes = await agentTeamRoutes.request(`/${cancelTeam.id}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: '等待后取消', runnerAgentId: 'runner_a' }),
    });
    const pending = await pendingRes.json() as { run: { id: string } };
    const cancelRes = await agentTeamRoutes.request(`/runs/${pending.run.id}/cancel`, { method: 'POST' });
    const cancelled = await cancelRes.json() as { run: { status: string } };

    expect(cancelRes.status).toBe(200);
    expect(cancelled.run.status).toBe('cancelled');
  });
});
