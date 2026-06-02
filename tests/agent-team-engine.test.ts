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
});
