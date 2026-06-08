import { describe, expect, test, vi } from 'vitest';

import type { AgentTeam, AgentTeamRole } from '../src/agent-teams.js';
import { executeAgentTeam, type AgentTeamRoleRunner } from '../src/agent-team-engine.js';

function makeTeam(shape: AgentTeam['shape'], roles: AgentTeamRole[]): AgentTeam {
  return {
    id: `team_${shape}`,
    name: `${shape} team`,
    goal: '交付一个功能',
    shape,
    description: '测试团队',
    roles,
    workflow: `${shape} workflow`,
    successCriteria: ['交付完成'],
    createdByAgentId: 'claude-sdk',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

describe('agent team execution engine', () => {
  test('executes pipeline roles in order and reruns development when testing fails', async () => {
    const team = makeTeam('pipeline', [
      { id: 'requirements', name: '需求分析师', responsibility: '分析需求' },
      { id: 'architecture', name: '架构设计', responsibility: '设计架构' },
      { id: 'developer', name: '开发', responsibility: '实现代码' },
      { id: 'tester', name: '测试', responsibility: '验证质量' },
      { id: 'reviewer', name: 'Review', responsibility: '最终评审' },
    ]);
    const calls: string[] = [];
    const runner: AgentTeamRoleRunner = vi.fn(async ({ role, feedback }) => {
      calls.push(feedback ? `${role.id}:feedback` : role.id);
      if (role.id === 'tester' && !feedback) return { status: 'success', result: 'FAIL: 测试不通过，需要返工' };
      return { status: 'success', result: `${role.id} ok` };
    });

    const result = await executeAgentTeam(team, { prompt: '实现登录', maxFeedbackIterations: 1 }, runner);

    expect(result.status).toBe('success');
    expect(calls).toEqual(['requirements', 'architecture', 'developer', 'tester', 'developer:feedback', 'tester:feedback', 'reviewer']);
    expect(result.events.some((event) => event.kind === 'feedback' && event.fromRoleId === 'tester' && event.toRoleId === 'developer')).toBe(true);
  });

  test('executes parallel workers concurrently and reports a fan-out/fan-in shape', async () => {
    const team = makeTeam('parallel', [
      { id: 'research', name: '调研', responsibility: '调研方案' },
      { id: 'frontend', name: '前端', responsibility: '实现 UI' },
      { id: 'backend', name: '后端', responsibility: '实现 API' },
    ]);
    const runner: AgentTeamRoleRunner = vi.fn(async ({ role }) => ({ status: 'success', result: `${role.id} done` }));

    const result = await executeAgentTeam(team, { prompt: '并行开发' }, runner);

    expect(result.status).toBe('success');
    expect(result.events.filter((event) => event.kind === 'role').map((event) => event.roleId).sort()).toEqual(['backend', 'frontend', 'research']);
    expect(result.finalResult).toContain('parallel team execution summary');
  });

  test('executes parallel chains with ordered roles inside each lane and merges afterward', async () => {
    const team = makeTeam('pipeline', [
      { id: 'planner', name: '规划', responsibility: '拆解任务' },
      { id: 'frontend_design', name: '前端设计', responsibility: '设计 UI', parallelGroup: 'frontend' },
      { id: 'frontend_dev', name: '前端开发', responsibility: '实现 UI', parallelGroup: 'frontend' },
      { id: 'backend_design', name: '后端设计', responsibility: '设计 API', parallelGroup: 'backend' },
      { id: 'backend_dev', name: '后端开发', responsibility: '实现 API', parallelGroup: 'backend' },
      { id: 'review', name: 'Review', responsibility: '合并复核' },
    ]);
    const calls: string[] = [];
    const runner: AgentTeamRoleRunner = vi.fn(async ({ role }) => {
      calls.push(role.id);
      return { status: 'success', result: `${role.id} ok` };
    });

    const result = await executeAgentTeam(team, { prompt: '实现前后端功能' }, runner);

    expect(result.status).toBe('success');
    expect(calls[0]).toBe('planner');
    expect(calls.at(-1)).toBe('review');
    expect(calls.indexOf('frontend_design')).toBeLessThan(calls.indexOf('frontend_dev'));
    expect(calls.indexOf('backend_design')).toBeLessThan(calls.indexOf('backend_dev'));
    expect(result.events.some((event) => event.kind === 'edge' && event.label === 'parallel-chain:frontend')).toBe(true);
    expect(result.events.some((event) => event.kind === 'edge' && event.label === 'parallel-chain:backend')).toBe(true);
  });

  test('executes leader-worker with lead plan, parallel workers, then lead summary', async () => {
    const team = makeTeam('leader-worker', [
      { id: 'lead', name: 'Lead', responsibility: '拆解和汇总' },
      { id: 'worker_a', name: 'Worker A', responsibility: '执行 A' },
      { id: 'worker_b', name: 'Worker B', responsibility: '执行 B' },
    ]);
    const calls: string[] = [];
    const runner: AgentTeamRoleRunner = vi.fn(async ({ role, phase }) => {
      calls.push(`${phase}:${role.id}`);
      return { status: 'success', result: `${phase} ${role.id}` };
    });

    const result = await executeAgentTeam(team, { prompt: '带队交付' }, runner);

    expect(result.status).toBe('success');
    expect(calls[0]).toBe('plan:lead');
    expect(calls).toContain('work:worker_a');
    expect(calls).toContain('work:worker_b');
    expect(calls.at(-1)).toBe('finalize:lead');
  });

  test('executes judge-route by following the route selected by the judge', async () => {
    const team = makeTeam('judge-route', [
      { id: 'judge', name: 'Judge', responsibility: '判断路径' },
      { id: 'docs', name: 'Docs', responsibility: '文档路线' },
      { id: 'code', name: 'Code', responsibility: '代码路线' },
      { id: 'review', name: 'Review', responsibility: '复核' },
    ]);
    const calls: string[] = [];
    const runner: AgentTeamRoleRunner = vi.fn(async ({ role }) => {
      calls.push(role.id);
      if (role.id === 'judge') return { status: 'success', result: 'route: code\n理由：需要代码实现' };
      return { status: 'success', result: `${role.id} ok` };
    });

    const result = await executeAgentTeam(team, { prompt: '修复 bug' }, runner);

    expect(result.status).toBe('success');
    expect(calls).toEqual(['judge', 'code', 'review']);
    expect(result.events.some((event) => event.kind === 'route' && event.toRoleId === 'code')).toBe(true);
  });

  test('executes judge-route from a structured route decision and records trace metadata', async () => {
    const team = makeTeam('judge-route', [
      { id: 'judge', name: 'Judge', responsibility: '判断路径' },
      { id: 'docs', name: 'Docs', responsibility: '文档路线' },
      { id: 'code', name: 'Code', responsibility: '代码路线' },
      { id: 'review', name: 'Review', responsibility: '复核' },
    ]);
    const calls: string[] = [];
    const runner: AgentTeamRoleRunner = vi.fn(async ({ role }) => {
      calls.push(role.id);
      if (role.id === 'judge') {
        return {
          status: 'success',
          result: JSON.stringify({
            action: 'run_role',
            target: 'docs',
            reason: '用户只需要文档方案',
            confidence: 0.91,
          }),
        };
      }
      return { status: 'success', result: `${role.id} ok` };
    });

    const result = await executeAgentTeam(team, {
      prompt: '输出接入文档',
      runId: 'run_test',
      traceId: 'trace_test',
      sessionId: 'session_test',
    }, runner);

    expect(result.status).toBe('success');
    expect(result.runId).toBe('run_test');
    expect(result.traceId).toBe('trace_test');
    expect(calls).toEqual(['judge', 'docs', 'review']);
    expect(result.events.some((event) => event.kind === 'route' && event.toRoleId === 'docs' && event.label?.includes('0.91'))).toBe(true);
    expect(result.traceEvents?.some((event) => event.type === 'route.decided' && event.payload && (event.payload as { target?: string }).target === 'docs')).toBe(true);
    for (const event of result.traceEvents ?? []) {
      expect(event.traceId).toBe('trace_test');
      expect(event.runId).toBe('run_test');
      expect(event.schemaVersion).toBe(1);
      expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  test('executes workflowSteps as a DAG and only exposes declared input artifacts', async () => {
    const team = makeTeam('pipeline', [
      { id: 'planner', name: 'Planner', responsibility: '规划' },
      { id: 'researcher', name: 'Researcher', responsibility: '调研' },
      { id: 'builder', name: 'Builder', responsibility: '实现' },
    ]);
    team.workflowSteps = [
      { id: 'plan', type: 'role', roleId: 'planner', phase: 'plan', outputKey: 'plan' },
      { id: 'research', type: 'role', roleId: 'researcher', phase: 'research', outputKey: 'research' },
      {
        id: 'build',
        type: 'role',
        roleId: 'builder',
        phase: 'build',
        dependsOn: ['plan'],
        inputKeys: ['plan'],
        outputKey: 'build',
      },
    ];
    const seen: Array<{ roleId: string; artifactKeys: string[] }> = [];
    const runner: AgentTeamRoleRunner = vi.fn(async ({ role, artifacts, previousResults }) => {
      seen.push({ roleId: role.id, artifactKeys: Object.keys(artifacts ?? {}).sort() });
      if (role.id === 'builder') {
        expect(previousResults.map((result) => result.roleId)).toEqual(['planner']);
      }
      return { status: 'success', result: `${role.id} output` };
    });

    const result = await executeAgentTeam(team, { prompt: '按 DAG 执行' }, runner);

    expect(result.status).toBe('success');
    expect(seen.find((entry) => entry.roleId === 'builder')?.artifactKeys).toEqual(['plan']);
    expect(result.traceEvents?.some((event) => event.type === 'workflow.step.ready' && event.taskId === 'build')).toBe(true);
    expect(result.checkpoint?.stepStatuses.build.status).toBe('success');
    expect(result.checkpoint?.artifacts.build).toBe('builder output');
  });

  test('writes route step outputKey for downstream inputKeys after approval resumes', async () => {
    const team = makeTeam('judge-route', [
      { id: 'judge', name: 'Judge', responsibility: '判断' },
      { id: 'executor', name: 'Executor', responsibility: '执行' },
      { id: 'verifier', name: 'Verifier', responsibility: '验证' },
    ]);
    team.workflowSteps = [
      {
        id: 'route',
        type: 'route',
        route: { judgeRoleId: 'judge', candidateRoleIds: ['executor'], fallbackRoleId: 'executor' },
        outputKey: 'route_output',
      },
      {
        id: 'verify',
        type: 'role',
        roleId: 'verifier',
        dependsOn: ['route'],
        inputKeys: ['route_output'],
        outputKey: 'verification',
      },
    ];
    const runner: AgentTeamRoleRunner = vi.fn(async ({ role, artifacts }) => {
      if (role.id === 'executor') return { status: 'success', result: 'executor output' };
      if (role.id === 'verifier') {
        expect(artifacts).toEqual({ route_output: 'executor output' });
        return { status: 'success', result: 'verified' };
      }
      return { status: 'success', result: 'judge skipped by resume approval' };
    });

    const result = await executeAgentTeam(team, {
      prompt: '审批后继续',
      runId: 'run_route_output',
      traceId: 'trace_route_output',
      resumeFromCheckpoint: {
        schemaVersion: 2,
        runId: 'run_route_output',
        traceId: 'trace_route_output',
        workflowNode: 'route',
        status: 'waiting_approval',
        stepStatuses: {
          route: { status: 'waiting_approval', attempt: 1, outputKey: 'route_output' },
          verify: { status: 'pending', attempt: 0, outputKey: 'verification' },
        },
        artifacts: {},
        waitingApproval: {
          approvalId: 'run_route_output:approval:route',
          runId: 'run_route_output',
          traceId: 'trace_route_output',
          stepId: 'route',
          requestedBy: 'judge',
          reason: 'approve route',
          confidence: 0.9,
          targetRoleId: 'executor',
          candidateRoleIds: ['executor'],
          riskLevel: 'high',
          payload: {},
        },
        busMessageSeq: 0,
        spanSeq: 0,
        messageSeq: 0,
        lastError: null,
        updatedAt: new Date(0).toISOString(),
      },
      approvalDecision: { approvalId: 'run_route_output:approval:route', status: 'approved', targetRoleId: 'executor' },
    }, runner);

    expect(result.status).toBe('success');
    expect(result.checkpoint?.artifacts.route_output).toBe('executor output');
    expect(result.checkpoint?.artifacts.verification).toBe('verified');
  });

  test('fails workflowSteps when dependsOn references an unknown step', async () => {
    const team = makeTeam('pipeline', [
      { id: 'builder', name: 'Builder', responsibility: '实现' },
    ]);
    team.workflowSteps = [
      { id: 'build', type: 'role', roleId: 'builder', dependsOn: ['missing'], outputKey: 'build' },
    ];
    const runner: AgentTeamRoleRunner = vi.fn(async () => ({ status: 'success', result: 'should not run' }));

    const result = await executeAgentTeam(team, { prompt: '无效依赖' }, runner);

    expect(result.status).toBe('error');
    expect(result.error).toContain('dependsOn missing unknown step missing');
    expect(runner).not.toHaveBeenCalled();
    expect(result.traceEvents?.some((event) => event.type === 'workflow.validation.failed')).toBe(true);
  });

  test('fails workflowSteps when dependency graph has a cycle', async () => {
    const team = makeTeam('pipeline', [
      { id: 'a', name: 'A', responsibility: 'A' },
      { id: 'b', name: 'B', responsibility: 'B' },
    ]);
    team.workflowSteps = [
      { id: 'a_step', type: 'role', roleId: 'a', dependsOn: ['b_step'], outputKey: 'a' },
      { id: 'b_step', type: 'role', roleId: 'b', dependsOn: ['a_step'], outputKey: 'b' },
    ];
    const runner: AgentTeamRoleRunner = vi.fn(async () => ({ status: 'success', result: 'should not run' }));

    const result = await executeAgentTeam(team, { prompt: '循环依赖' }, runner);

    expect(result.status).toBe('error');
    expect(result.error).toContain('workflow dependency cycle detected');
    expect(runner).not.toHaveBeenCalled();
  });

  test('fails a step when declared inputKeys are missing', async () => {
    const team = makeTeam('pipeline', [
      { id: 'builder', name: 'Builder', responsibility: '实现' },
    ]);
    team.workflowSteps = [
      { id: 'build', type: 'role', roleId: 'builder', inputKeys: ['plan'], outputKey: 'build' },
    ];
    const runner: AgentTeamRoleRunner = vi.fn(async () => ({ status: 'success', result: 'should not run' }));

    const result = await executeAgentTeam(team, { prompt: '缺少输入' }, runner);

    expect(result.status).toBe('error');
    expect(result.error).toContain('step build missing input artifact plan');
    expect(runner).not.toHaveBeenCalled();
    expect(result.checkpoint?.stepStatuses.build.status).toBe('failed');
  });

  test('pauses a route step when judge requests approval', async () => {
    const team = makeTeam('judge-route', [
      { id: 'judge', name: 'Judge', responsibility: '判断' },
      { id: 'executor', name: 'Executor', responsibility: '执行' },
    ]);
    team.workflowSteps = [
      {
        id: 'route',
        type: 'route',
        route: { judgeRoleId: 'judge', candidateRoleIds: ['executor'], fallbackRoleId: 'executor' },
      },
    ];
    const runner: AgentTeamRoleRunner = vi.fn(async ({ role }) => {
      if (role.id === 'judge') {
        return {
          status: 'success',
          result: JSON.stringify({
            action: 'request_approval',
            target: 'executor',
            reason: '执行前需要人工确认',
            confidence: 0.88,
          }),
        };
      }
      return { status: 'success', result: 'executor should not run before approval' };
    });

    const result = await executeAgentTeam(team, { prompt: '高风险执行', runId: 'run_approval', traceId: 'trace_approval' }, runner);

    expect(result.status).toBe('waiting_approval');
    expect(runner).toHaveBeenCalledTimes(1);
    expect(result.waitingApproval).toMatchObject({
      runId: 'run_approval',
      stepId: 'route',
      requestedBy: 'judge',
      targetRoleId: 'executor',
      reason: '执行前需要人工确认',
    });
    expect(result.checkpoint?.status).toBe('waiting_approval');
    expect(result.checkpoint?.stepStatuses.route.status).toBe('waiting_approval');
    expect(result.traceEvents?.some((event) => event.type === 'approval.requested')).toBe(true);
  });

  test('verify step writes verifier_report artifact', async () => {
    const team = makeTeam('pipeline', [
      { id: 'verifier', name: 'Verifier', responsibility: '独立验证质量' },
    ]);
    team.workflowSteps = [
      {
        id: 'verify_quality',
        type: 'verify',
        verify: { verifierRoleId: 'verifier', subjectKeys: [], rubric: '质量评分' },
        outputKey: 'verifier_report',
      },
    ];

    const result = await executeAgentTeam(team, { prompt: '验证交付' }, async () => ({
      status: 'success',
      result: JSON.stringify({ passed: true, score: 0.92, findings: [] }),
    }));

    expect(result.status).toBe('success');
    expect(result.checkpoint?.artifacts.verifier_report).toContain('0.92');
  });

  test('vote step aggregates candidate role outputs deterministically', async () => {
    const team = makeTeam('parallel', [
      { id: 'critic_a', name: 'Critic A', responsibility: '投票 A' },
      { id: 'critic_b', name: 'Critic B', responsibility: '投票 B' },
    ]);
    team.workflowSteps = [
      {
        id: 'vote_quality',
        type: 'vote',
        vote: { voterRoleIds: ['critic_a', 'critic_b'], subjectKeys: [], threshold: 0.5 },
        outputKey: 'vote_result',
      },
    ];

    const result = await executeAgentTeam(team, { prompt: '投票决策' }, async (context) => ({
      status: 'success',
      result: context.role.id === 'critic_a' ? 'APPROVE score=0.8' : 'APPROVE score=0.7',
    }));

    expect(result.status).toBe('success');
    expect(result.checkpoint?.artifacts.vote_result).toContain('approved');
  });
});
