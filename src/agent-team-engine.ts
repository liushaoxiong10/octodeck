import type { ContainerOutput } from './container-runner.js';
import type { AgentTeam, AgentTeamRole, AgentTeamShape } from './agent-teams.js';

export type AgentTeamExecutionPhase = 'plan' | 'work' | 'test' | 'feedback' | 'finalize' | 'judge' | 'route';

export interface AgentTeamRoleRunContext {
  team: AgentTeam;
  role: AgentTeamRole;
  prompt: string;
  phase: AgentTeamExecutionPhase;
  previousResults: AgentTeamRoleResult[];
  feedback?: string;
}

export interface AgentTeamRoleResult {
  roleId: string;
  roleName: string;
  phase: AgentTeamExecutionPhase;
  status: 'success' | 'error';
  result: string;
  error?: string;
}

export interface AgentTeamExecutionEvent {
  kind: 'role' | 'edge' | 'feedback' | 'route';
  roleId?: string;
  fromRoleId?: string;
  toRoleId?: string;
  phase?: AgentTeamExecutionPhase;
  label?: string;
}

export interface AgentTeamExecutionInput {
  prompt: string;
  maxFeedbackIterations?: number;
}

export interface AgentTeamExecutionResult {
  status: 'success' | 'error';
  finalResult: string;
  roleResults: AgentTeamRoleResult[];
  events: AgentTeamExecutionEvent[];
  error?: string;
}

export type AgentTeamRoleRunner = (context: AgentTeamRoleRunContext) => Promise<Pick<ContainerOutput, 'status' | 'result' | 'error'>>;

export async function executeAgentTeam(
  team: AgentTeam,
  input: AgentTeamExecutionInput,
  runner: AgentTeamRoleRunner,
): Promise<AgentTeamExecutionResult> {
  const shape = team.shape === 'auto' ? inferConcreteShape(team) : team.shape;
  if (shape === 'parallel') return executeParallel(team, input, runner);
  if (shape === 'leader-worker') return executeLeaderWorker(team, input, runner);
  if (shape === 'judge-route') return executeJudgeRoute(team, input, runner);
  return executePipeline(team, input, runner);
}

async function executePipeline(
  team: AgentTeam,
  input: AgentTeamExecutionInput,
  runner: AgentTeamRoleRunner,
): Promise<AgentTeamExecutionResult> {
  const roleResults: AgentTeamRoleResult[] = [];
  const events: AgentTeamExecutionEvent[] = [];
  const maxFeedbackIterations = input.maxFeedbackIterations ?? 1;
  let feedbackUsed = 0;

  for (let index = 0; index < team.roles.length; index += 1) {
    const role = team.roles[index];
    if (role.parallelGroup) {
      const start = index;
      const groupedRoles = team.roles.slice(start).filter((candidate) => candidate.parallelGroup);
      const chains = groupParallelChains(groupedRoles);
      for (const chain of chains) {
        events.push({ kind: 'edge', fromRoleId: team.roles[start - 1]?.id, toRoleId: chain.roles[0]?.id, label: `parallel-chain:${chain.group}` });
      }
      const chainResults = await Promise.all(chains.map((chain) => executeRoleChain(team, chain.roles, input.prompt, roleResults, runner, events)));
      for (const results of chainResults) roleResults.push(...results);
      const failed = chainResults.flat().find((result) => result.status === 'error');
      if (failed) return summarize(team, 'error', roleResults, events, failed.error || failed.result);
      index += groupedRoles.length - 1;
      continue;
    }
    const phase = roleLooksLikeTest(role) ? 'test' : index === team.roles.length - 1 ? 'finalize' : 'work';
    const result = await runRole(team, role, input.prompt, phase, roleResults, runner);
    roleResults.push(result);
    events.push({ kind: 'role', roleId: role.id, phase });
    if (result.status === 'error') return summarize(team, 'error', roleResults, events, result.error || result.result);

    if (roleLooksLikeTest(role) && isFailedTestResult(result.result) && feedbackUsed < maxFeedbackIterations) {
      const targetIndex = findFeedbackTargetIndex(team.roles, index);
      const target = team.roles[targetIndex];
      feedbackUsed += 1;
      events.push({ kind: 'feedback', fromRoleId: role.id, toRoleId: target.id, label: '测试不通过 → 返工' });
      const feedbackResult = await runRole(team, target, input.prompt, 'feedback', roleResults, runner, result.result);
      roleResults.push(feedbackResult);
      events.push({ kind: 'role', roleId: target.id, phase: 'feedback' });
      if (feedbackResult.status === 'error') return summarize(team, 'error', roleResults, events, feedbackResult.error || feedbackResult.result);
      const retest = await runRole(team, role, input.prompt, 'feedback', roleResults, runner, feedbackResult.result);
      roleResults.push(retest);
      events.push({ kind: 'role', roleId: role.id, phase: 'feedback' });
      if (retest.status === 'error' || isFailedTestResult(retest.result)) {
        return summarize(team, retest.status === 'error' ? 'error' : 'success', roleResults, events, retest.error);
      }
    }
  }

  return summarize(team, 'success', roleResults, events);
}

async function executeParallel(
  team: AgentTeam,
  input: AgentTeamExecutionInput,
  runner: AgentTeamRoleRunner,
): Promise<AgentTeamExecutionResult> {
  if (!hasParallelChains(team.roles)) return executeFlatParallel(team, input, runner);
  const events: AgentTeamExecutionEvent[] = [];
  const chains = groupParallelChains(team.roles);
  const roleResultsByChain = await Promise.all(chains.map(async (chain) => {
    events.push({ kind: 'edge', toRoleId: chain.roles[0]?.id, label: chain.group === 'default' ? 'fan-out / fan-in' : `parallel-chain:${chain.group}` });
    return executeRoleChain(team, chain.roles, input.prompt, [], runner, events);
  }));
  const roleResults = roleResultsByChain.flat();
  const failed = roleResults.find((result) => result.status === 'error');
  return summarize(team, failed ? 'error' : 'success', roleResults, events, failed?.error);
}

async function executeFlatParallel(
  team: AgentTeam,
  input: AgentTeamExecutionInput,
  runner: AgentTeamRoleRunner,
): Promise<AgentTeamExecutionResult> {
  const events: AgentTeamExecutionEvent[] = [];
  const roleResults = await Promise.all(team.roles.map(async (role) => {
    events.push({ kind: 'edge', toRoleId: role.id, label: 'fan-out / fan-in' });
    const result = await runRole(team, role, input.prompt, 'work', [], runner);
    events.push({ kind: 'role', roleId: role.id, phase: 'work' });
    return result;
  }));
  const failed = roleResults.find((result) => result.status === 'error');
  return summarize(team, failed ? 'error' : 'success', roleResults, events, failed?.error);
}

async function executeRoleChain(
  team: AgentTeam,
  roles: AgentTeamRole[],
  prompt: string,
  baseResults: AgentTeamRoleResult[],
  runner: AgentTeamRoleRunner,
  events: AgentTeamExecutionEvent[],
): Promise<AgentTeamRoleResult[]> {
  const chainResults: AgentTeamRoleResult[] = [];
  for (const role of roles) {
    const previousResults = [...baseResults, ...chainResults];
    const result = await runRole(team, role, prompt, roleLooksLikeTest(role) ? 'test' : 'work', previousResults, runner);
    chainResults.push(result);
    events.push({ kind: 'role', roleId: role.id, phase: result.phase });
    if (result.status === 'error') break;
  }
  return chainResults;
}

function hasParallelChains(roles: AgentTeamRole[]): boolean {
  return roles.some((role) => Boolean(role.parallelGroup));
}

function groupParallelChains(roles: AgentTeamRole[]): Array<{ group: string; roles: AgentTeamRole[] }> {
  const groups = new Map<string, AgentTeamRole[]>();
  roles.forEach((role, index) => {
    const group = role.parallelGroup?.trim() || `role-${role.id || index}`;
    groups.set(group, [...(groups.get(group) ?? []), role]);
  });
  return Array.from(groups.entries()).map(([group, groupRoles]) => ({ group, roles: groupRoles }));
}

async function executeLeaderWorker(
  team: AgentTeam,
  input: AgentTeamExecutionInput,
  runner: AgentTeamRoleRunner,
): Promise<AgentTeamExecutionResult> {
  const [lead, ...workers] = team.roles;
  const roleResults: AgentTeamRoleResult[] = [];
  const events: AgentTeamExecutionEvent[] = [];
  if (!lead) return summarize(team, 'error', roleResults, events, 'team has no lead role');

  const plan = await runRole(team, lead, input.prompt, 'plan', roleResults, runner);
  roleResults.push(plan);
  events.push({ kind: 'role', roleId: lead.id, phase: 'plan' });
  if (plan.status === 'error') return summarize(team, 'error', roleResults, events, plan.error || plan.result);

  const workerResults = await Promise.all(workers.map(async (worker) => {
    events.push({ kind: 'edge', fromRoleId: lead.id, toRoleId: worker.id, label: 'Lead 分派' });
    const result = await runRole(team, worker, input.prompt, 'work', roleResults, runner, plan.result);
    events.push({ kind: 'edge', fromRoleId: worker.id, toRoleId: lead.id, label: '汇总给 Lead' });
    events.push({ kind: 'role', roleId: worker.id, phase: 'work' });
    return result;
  }));
  roleResults.push(...workerResults);
  const failed = workerResults.find((result) => result.status === 'error');
  if (failed) return summarize(team, 'error', roleResults, events, failed.error || failed.result);

  const final = await runRole(team, lead, input.prompt, 'finalize', roleResults, runner);
  roleResults.push(final);
  events.push({ kind: 'role', roleId: lead.id, phase: 'finalize' });
  return summarize(team, final.status, roleResults, events, final.error);
}

async function executeJudgeRoute(
  team: AgentTeam,
  input: AgentTeamExecutionInput,
  runner: AgentTeamRoleRunner,
): Promise<AgentTeamExecutionResult> {
  const [judge, ...candidates] = team.roles;
  const roleResults: AgentTeamRoleResult[] = [];
  const events: AgentTeamExecutionEvent[] = [];
  if (!judge) return summarize(team, 'error', roleResults, events, 'team has no judge role');

  const judgeResult = await runRole(team, judge, input.prompt, 'judge', roleResults, runner);
  roleResults.push(judgeResult);
  events.push({ kind: 'role', roleId: judge.id, phase: 'judge' });
  if (judgeResult.status === 'error') return summarize(team, 'error', roleResults, events, judgeResult.error || judgeResult.result);

  const selected = parseRouteTarget(judgeResult.result, candidates) ?? candidates[0];
  if (selected) {
    events.push({ kind: 'route', fromRoleId: judge.id, toRoleId: selected.id, label: 'Judge 选择路径' });
    const routed = await runRole(team, selected, input.prompt, 'route', roleResults, runner, judgeResult.result);
    roleResults.push(routed);
    events.push({ kind: 'role', roleId: selected.id, phase: 'route' });
    if (routed.status === 'error') return summarize(team, 'error', roleResults, events, routed.error || routed.result);
  }

  const finalRole = candidates[candidates.length - 1];
  if (finalRole && finalRole.id !== selected?.id) {
    events.push({ kind: 'edge', fromRoleId: selected?.id ?? judge.id, toRoleId: finalRole.id, label: '进入复核' });
    const final = await runRole(team, finalRole, input.prompt, 'finalize', roleResults, runner);
    roleResults.push(final);
    events.push({ kind: 'role', roleId: finalRole.id, phase: 'finalize' });
    return summarize(team, final.status, roleResults, events, final.error);
  }

  return summarize(team, 'success', roleResults, events);
}

async function runRole(
  team: AgentTeam,
  role: AgentTeamRole,
  prompt: string,
  phase: AgentTeamExecutionPhase,
  previousResults: AgentTeamRoleResult[],
  runner: AgentTeamRoleRunner,
  feedback?: string,
): Promise<AgentTeamRoleResult> {
  const output = await runner({ team, role, prompt, phase, previousResults, feedback });
  return {
    roleId: role.id,
    roleName: role.name,
    phase,
    status: output.status === 'success' ? 'success' : 'error',
    result: output.result ?? '',
    error: output.error,
  };
}

function summarize(
  team: AgentTeam,
  status: 'success' | 'error',
  roleResults: AgentTeamRoleResult[],
  events: AgentTeamExecutionEvent[],
  error?: string,
): AgentTeamExecutionResult {
  const title = `${team.shape} team execution summary`;
  const finalResult = [title, ...roleResults.map((result) => `- ${result.roleName}(${result.phase}): ${result.result}`)].join('\n');
  return { status, finalResult, roleResults, events, error };
}

function inferConcreteShape(team: AgentTeam): Exclude<AgentTeamShape, 'auto'> {
  if (team.roles.length <= 2) return 'leader-worker';
  return 'pipeline';
}

function roleLooksLikeTest(role: AgentTeamRole): boolean {
  return /测试|test|qa|quality/i.test(`${role.name} ${role.responsibility}`);
}

function roleLooksLikeDevelopment(role: AgentTeamRole): boolean {
  return /开发|implement|dev|engineer|编码/i.test(`${role.name} ${role.responsibility}`);
}

function isFailedTestResult(result: string): boolean {
  return /测试不通过|不通过|失败|fail|failed|返工/i.test(result);
}

function findFeedbackTargetIndex(roles: AgentTeamRole[], testIndex: number): number {
  for (let index = testIndex - 1; index >= 0; index -= 1) {
    if (roleLooksLikeDevelopment(roles[index])) return index;
  }
  return Math.max(0, testIndex - 1);
}

function parseRouteTarget(result: string, candidates: AgentTeamRole[]): AgentTeamRole | null {
  const normalized = result.toLowerCase();
  return candidates.find((role) => normalized.includes(role.id.toLowerCase()) || normalized.includes(role.name.toLowerCase())) ?? null;
}
