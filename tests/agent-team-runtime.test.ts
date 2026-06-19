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
const runtimeControl = await import('../src/agent-team-runtime-control.js');
const { registerBackend, unregisterBackend } = await import('../src/backends/registry.js');
const agentTeams = await import('../src/agent-teams.js');
const agentTeamRoutes = (await import('../src/routes/agent-teams.js')).default;
const agentLinkRoutes = (await import('../src/routes/agent-link.js')).default;

const calls: Array<{
  backendId: string;
  prompt: string;
  folder: string;
  remoteToolCwd?: string;
}> = [];

function registerTestBackend(id: string) {
  registerBackend({
    id,
    displayName: id,
    usesProviderPool: false,
    supportsExecutionMode: (mode) => mode === 'host',
    run: vi.fn(async ({ input, group }) => {
      calls.push({
        backendId: id,
        prompt: input.prompt,
        folder: group.folder,
        remoteToolCwd: input.remoteToolCwd,
      });
      const roleMatch = input.prompt.match(/Current role: .*\(([^)]+)\)/);
      if (input.prompt.includes('REQUEST_RUNTIME_APPROVAL') && roleMatch?.[1] === 'judge') {
        return {
          status: 'success',
          result: JSON.stringify({
            action: 'request_approval',
            target: 'executor',
            reason: '运行时路由需要人工确认',
            confidence: 0.86,
          }),
        };
      }
      if (input.prompt.includes('RETURN_PLAN_BODY')) {
        return { status: 'success', result: 'plan body' };
      }
      if (input.prompt.includes('RETURN_VERSIONED_ARTIFACTS')) {
        return { status: 'success', result: `${roleMatch?.[1] ?? 'unknown'} body` };
      }
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
    unregisterBackend('runner_a');
    unregisterBackend('runner_b');
    runtimeControl.clearAgentTeamRuntimeControlsForTests();
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

  test('rejects invalid per-role runner before any role executes', async () => {
    const team = agentTeams.createAgentTeam({
      name: 'Invalid Runtime Target Team',
      goal: '提前拒绝错误路由',
      shape: 'pipeline',
      description: '测试 roleAssignments 预校验。',
      roles: [{ id: 'worker', name: 'Worker', responsibility: '执行。' }],
      workflow: 'Worker 单步执行。',
      successCriteria: ['错误路由不会启动 role'],
      createdByAgentId: 'runner_a',
    }, 'alice');

    const response = await agentTeamRoutes.request(`/${team.id}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: '不应执行',
        runnerAgentId: 'runner_a',
        roleAssignments: { worker: { runnerAgentId: 'blocked_runner' } },
      }),
    });
    const body = await response.json() as { error: string; details?: string[] };

    expect(response.status).toBe(403);
    expect(body.error).toBe('invalid role runtime target');
    expect(body.details).toEqual([
      'role worker runner blocked_runner is not in allowedBackends',
    ]);
    expect(calls).toEqual([]);
  });

  test('revalidates per-role runners before resuming an approved run', async () => {
    const team = agentTeams.createAgentTeam({
      name: 'Approval Runtime Target Team',
      goal: '审批恢复时校验 role runtime target',
      shape: 'pipeline',
      description: '测试审批 checkpoint 中的 roleAssignments 不会绕过校验。',
      roles: [
        {
          id: 'deploy',
          name: 'Deploy',
          responsibility: '执行高风险发布。',
          policy: { permissionLevel: 'L4', requiresApproval: true },
        },
      ],
      workflow: '审批后执行 Deploy。',
      successCriteria: ['恢复前拒绝失效 runner'],
      createdByAgentId: 'runner_a',
    }, 'alice');

    const createRes = await agentTeamRoutes.request(`/${team.id}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: '发布到生产',
        runnerAgentId: 'runner_a',
        roleAssignments: { deploy: { runnerAgentId: 'runner_b' } },
      }),
    });
    const created = await createRes.json() as {
      run: { id: string; status: string };
      approval: { id: string };
    };

    expect(createRes.status).toBe(202);
    expect(created.run.status).toBe('waiting_approval');
    unregisterBackend('runner_b');

    const approveRes = await agentTeamRoutes.request(`/runs/${created.run.id}/approvals/${created.approval.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approved' }),
    });
    const approved = await approveRes.json() as { error: string; details?: string[] };

    expect(approveRes.status).toBe(404);
    expect(approved.error).toBe('invalid role runtime target');
    expect(approved.details).toEqual([
      'role deploy runner backend runner_b not found',
    ]);
    expect(calls).toEqual([]);
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

  test('cancel endpoint invokes registered runtime cancellation handlers', async () => {
    const cancel = vi.fn();
    runtimeControl.registerAgentTeamTaskCancellation({
      runId: 'run_cancel_runtime',
      taskId: 'run_cancel_runtime:role:work',
      cancel,
    });

    db.recordAgentTeamRun({
      id: 'run_cancel_runtime',
      teamId: 'team_cancel_runtime',
      userId: 'alice',
      prompt: 'stop me',
      status: 'running',
      traceId: 'trace_cancel_runtime',
      workflowShape: 'pipeline',
      roleAssignments: {},
    });

    const response = await agentTeamRoutes.request('/runs/run_cancel_runtime/cancel', {
      method: 'POST',
    });
    const body = await response.json() as {
      run: { status: string };
      cancelledTaskIds?: string[];
      cancellationErrors?: unknown[];
    };

    expect(response.status).toBe(200);
    expect(cancel).toHaveBeenCalledWith('cancelled by user');
    expect(body.cancelledTaskIds).toEqual(['run_cancel_runtime:role:work']);
    expect(body.cancellationErrors).toEqual([]);
    expect(body.run.status).toBe('cancelled');
  });

  test('tool bridge cancel_run invokes registered runtime cancellation handlers', async () => {
    const cancel = vi.fn();
    runtimeControl.registerAgentTeamTaskCancellation({
      runId: 'run_tool_cancel_runtime',
      taskId: 'run_tool_cancel_runtime:role:work',
      cancel,
    });

    db.recordAgentTeamRun({
      id: 'run_tool_cancel_runtime',
      teamId: 'team_tool_cancel_runtime',
      userId: 'alice',
      prompt: 'stop me from tool',
      status: 'running',
      traceId: 'trace_tool_cancel_runtime',
      workflowShape: 'pipeline',
      roleAssignments: {},
    });

    const response = await agentTeamRoutes.request('/tool', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OCTODECK_AGENT_RUNNER_SECRET}`,
      },
      body: JSON.stringify({
        userId: 'alice',
        operation: 'cancel_run',
        runId: 'run_tool_cancel_runtime',
      }),
    });
    const body = await response.json() as {
      run: { status: string };
      cancelledTaskIds?: string[];
      cancellationErrors?: unknown[];
    };

    expect(response.status).toBe(200);
    expect(cancel).toHaveBeenCalledWith('cancelled by agent team MCP tool');
    expect(body.cancelledTaskIds).toEqual(['run_tool_cancel_runtime:role:work']);
    expect(body.cancellationErrors).toEqual([]);
    expect(body.run.status).toBe('cancelled');
  });

  test('executes sandbox role in run-scoped workspace', async () => {
    const team = agentTeams.createAgentTeam({
      name: 'Sandbox Runtime Team',
      goal: '验证 sandbox workspace',
      shape: 'pipeline',
      description: '测试 role workspacePolicy 对执行 workspace 的影响。',
      roles: [
        {
          id: 'role_sandbox',
          name: 'Sandbox Role',
          responsibility: '在隔离 workspace 中执行。',
          policy: { workspacePolicy: 'sandbox' },
        },
      ],
      workflow: 'Sandbox Role 单步执行。',
      successCriteria: ['workspace 已隔离'],
      createdByAgentId: 'runner_a',
    }, 'alice');

    const response = await agentTeamRoutes.request(`/${team.id}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: '运行 sandbox role',
        runnerAgentId: 'runner_a',
        runtimeContext: {
          groupFolder: 'custom-root',
          remoteToolCwd: '/repo',
        },
      }),
    });
    const body = await response.json() as { run: { id: string; status: string } };

    expect(response.status).toBe(201);
    expect(body.run.status).toBe('success');
    expect(calls).toHaveLength(1);
    expect(calls[0].folder).toBe(`custom-root/${body.run.id}/role_sandbox`);
    expect(calls[0].remoteToolCwd).toBe(
      `/repo/.octodeck/agent-team-runs/${body.run.id}/role_sandbox`,
    );
  });

  test('persists workflow outputKey artifacts as versioned artifact records', async () => {
    const team = agentTeams.createAgentTeam({
      name: 'Artifact Runtime Team',
      goal: '持久化 workflow outputKey',
      shape: 'pipeline',
      description: '测试 workflow 输出会写入 artifact 数据面。',
      roles: [{ id: 'planner', name: 'Planner', responsibility: '产出计划。' }],
      workflow: 'Planner 产出 plan。',
      workflowSteps: [
        {
          id: 'plan',
          type: 'role',
          roleId: 'planner',
          outputKey: 'plan',
        },
      ],
      successCriteria: ['plan artifact 可查询'],
      createdByAgentId: 'runner_a',
    }, 'alice');

    const response = await agentTeamRoutes.request(`/${team.id}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'RETURN_PLAN_BODY', runnerAgentId: 'runner_a' }),
    });
    const body = await response.json() as { run: { id: string; status: string } };

    expect(response.status).toBe(201);
    expect(body.run.status).toBe('success');

    const artifactsResponse = await agentTeamRoutes.request(`/runs/${body.run.id}/artifacts`);
    expect(artifactsResponse.status).toBe(200);
    const artifactsBody = await artifactsResponse.json() as {
      artifacts: Array<{ key: string; version: number; value: string; sourceStepId: string }>;
    };

    expect(artifactsBody.artifacts).toMatchObject([
      { key: 'plan', version: 1, value: 'plan body', sourceStepId: 'plan' },
    ]);
  });

  test('persists artifact version snapshots and parent lineage', async () => {
    const team = agentTeams.createAgentTeam({
      name: 'Artifact Lineage Team',
      goal: '持久化 artifact 版本与派生关系',
      shape: 'pipeline',
      description: '测试同 key 多版本和 inputKeys lineage。',
      roles: [
        { id: 'planner_v1', name: 'Planner V1', responsibility: '产出第一版计划。' },
        { id: 'planner_v2', name: 'Planner V2', responsibility: '产出第二版计划。' },
        { id: 'builder', name: 'Builder', responsibility: '基于计划产出构建结果。' },
      ],
      workflow: 'Planner V1 后 Planner V2，再 Builder。',
      workflowSteps: [
        { id: 'plan_v1', type: 'role', roleId: 'planner_v1', outputKey: 'plan' },
        { id: 'plan_v2', type: 'role', roleId: 'planner_v2', outputKey: 'plan', dependsOn: ['plan_v1'] },
        { id: 'build', type: 'role', roleId: 'builder', outputKey: 'build', inputKeys: ['plan'], dependsOn: ['plan_v2'] },
      ],
      successCriteria: ['版本和 lineage 可查询'],
      createdByAgentId: 'runner_a',
    }, 'alice');

    const response = await agentTeamRoutes.request(`/${team.id}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'RETURN_VERSIONED_ARTIFACTS', runnerAgentId: 'runner_a' }),
    });
    const body = await response.json() as { run: { id: string; status: string } };
    expect(response.status).toBe(201);

    const artifactsResponse = await agentTeamRoutes.request(`/runs/${body.run.id}/artifacts`);
    expect(artifactsResponse.status).toBe(200);
    const artifactsBody = await artifactsResponse.json() as {
      artifacts: Array<{ id: string; key: string; version: number; value: string; parentArtifactIds: string[] }>;
    };

    const artifactSummaries = artifactsBody.artifacts
      .map((artifact) => ({
        key: artifact.key,
        version: artifact.version,
        value: artifact.value,
      }))
      .sort((a, b) => `${a.key}:${a.version}`.localeCompare(`${b.key}:${b.version}`));
    expect(artifactSummaries).toEqual([
      { key: 'build', version: 1, value: 'builder body' },
      { key: 'plan', version: 1, value: 'planner_v1 body' },
      { key: 'plan', version: 2, value: 'planner_v2 body' },
    ]);
    const latestPlan = artifactsBody.artifacts.find(
      (artifact) => artifact.key === 'plan' && artifact.version === 2,
    );
    const build = artifactsBody.artifacts.find((artifact) => artifact.key === 'build');
    expect(build?.parentArtifactIds).toEqual([latestPlan?.id]);
  });

  test('propagates cancel requests to the active role AbortSignal', async () => {
    let capturedSignal: AbortSignal | undefined;
    let cancelBody: { run: { id: string; status: string }; cancelledTaskIds: string[] } | undefined;
    registerBackend({
      id: 'runner_a',
      displayName: 'runner_a',
      usesProviderPool: false,
      supportsExecutionMode: (mode) => mode === 'host',
      run: vi.fn(async (args) => {
        capturedSignal = args.signal;
        if (!capturedSignal) {
          return { status: 'success', result: 'missing signal' };
        }
        const row = db.getDatabaseForInternalUse()
          .prepare("SELECT id FROM agent_team_runs WHERE status = 'running' ORDER BY started_at DESC LIMIT 1")
          .get() as { id: string };
        const cancelResponse = await agentTeamRoutes.request(`/runs/${row.id}/cancel`, {
          method: 'POST',
        });
        cancelBody = await cancelResponse.json() as typeof cancelBody;
        if (!capturedSignal.aborted) {
          await new Promise<void>((resolve) => {
            capturedSignal?.addEventListener('abort', () => resolve(), { once: true });
          });
        }
        return { status: 'error', result: '', error: 'aborted by test' };
      }),
    });
    const team = agentTeams.createAgentTeam({
      name: 'Abort Runtime Team',
      goal: '验证运行中 cancel',
      shape: 'pipeline',
      description: '测试 cancel 贯穿正在运行的 role。',
      roles: [{ id: 'worker', name: 'Worker', responsibility: '长任务。' }],
      workflow: 'Worker 单步执行。',
      successCriteria: ['cancel 可中断 role'],
      createdByAgentId: 'runner_a',
    }, 'alice');

    await agentTeamRoutes.request(`/${team.id}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: '启动后取消', runnerAgentId: 'runner_a' }),
    });

    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal?.aborted).toBe(true);
    expect(cancelBody?.run.status).toBe('cancelled');
    expect(cancelBody?.cancelledTaskIds).toHaveLength(1);
    expect(db.getAgentTeamRun(cancelBody?.run.id ?? '', 'alice')?.status).toBe('cancelled');
  });

  test('persists route approval requests and resumes approved workflow from checkpoint', async () => {
    const team = agentTeams.createAgentTeam({
      name: 'Route Approval Team',
      goal: '运行中路由审批',
      shape: 'judge-route',
      description: 'route step 可在运行时请求人工审批。',
      roles: [
        { id: 'judge', name: 'Judge', responsibility: '判断是否审批。' },
        { id: 'executor', name: 'Executor', responsibility: '执行审批后的动作。' },
      ],
      workflow: 'Judge 请求审批，审批通过后 Executor 执行。',
      workflowSteps: [
        {
          id: 'route',
          type: 'route',
          route: { judgeRoleId: 'judge', candidateRoleIds: ['executor'], fallbackRoleId: 'executor' },
          outputKey: 'route_output',
        },
      ],
      successCriteria: ['审批通过后继续运行'],
      createdByAgentId: 'runner_a',
    }, 'alice');

    const createRes = await agentTeamRoutes.request(`/${team.id}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'REQUEST_RUNTIME_APPROVAL', runnerAgentId: 'runner_a' }),
    });
    const created = await createRes.json() as {
      run: { id: string; status: string };
      approval: { id: string; status: string; payload: { action: string; scope: { stepId: string; targetRoleId: string }; rollback: string } };
      execution: { status: string; waitingApproval: { stepId: string; targetRoleId: string } };
    };

    expect(createRes.status).toBe(202);
    expect(created.run.status).toBe('waiting_approval');
    expect(created.execution.status).toBe('waiting_approval');
    expect(created.approval).toMatchObject({
      status: 'pending',
      payload: {
        action: 'agent_team.route_approval',
        scope: { stepId: 'route', targetRoleId: 'executor' },
      },
    });
    expect(created.approval.payload.rollback).toContain('Reject approval');
    expect(calls.map((call) => call.prompt.includes('Current role: Judge (judge)'))).toEqual([true]);

    const approveRes = await agentTeamRoutes.request(`/runs/${created.run.id}/approvals/${created.approval.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approved' }),
    });
    const approved = await approveRes.json() as { run: { status: string }; execution: { status: string; finalResult: string } };

    expect(approveRes.status).toBe(200);
    expect(approved.run.status).toBe('success');
    expect(approved.execution.status).toBe('success');
    expect(approved.execution.finalResult).toContain('runner_a:executor');
    expect(calls.map((call) => call.prompt.includes('Current role:'))).toEqual([true, true]);
  });
});
