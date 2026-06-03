import type { ContainerOutput } from './container-runner.js';
import type {
  AgentTeam,
  AgentTeamRole,
  AgentTeamShape,
} from './agent-teams.js';

export type AgentTeamExecutionPhase =
  | 'plan'
  | 'work'
  | 'test'
  | 'feedback'
  | 'finalize'
  | 'judge'
  | 'route';

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
  runId?: string;
  traceId?: string;
  sessionId?: string;
}

export interface AgentTeamTraceEvent {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  sessionId?: string;
  runId: string;
  taskId?: string;
  actor: string;
  type: string;
  payload: unknown;
  timestamp: string;
  schemaVersion: 1;
}

export interface AgentTeamExecutionResult {
  status: 'success' | 'error';
  finalResult: string;
  roleResults: AgentTeamRoleResult[];
  events: AgentTeamExecutionEvent[];
  runId?: string;
  traceId?: string;
  traceEvents?: AgentTeamTraceEvent[];
  error?: string;
}

export type AgentTeamRoleRunner = (
  context: AgentTeamRoleRunContext,
) => Promise<Pick<ContainerOutput, 'status' | 'result' | 'error'>>;

interface ExecutionState {
  runId: string;
  traceId: string;
  sessionId?: string;
  traceEvents: AgentTeamTraceEvent[];
  spanSeq: number;
}

interface RouteDecision {
  action: 'run_role' | 'finish' | 'request_approval' | 'abort';
  target?: string;
  reason: string;
  confidence: number;
}

export async function executeAgentTeam(
  team: AgentTeam,
  input: AgentTeamExecutionInput,
  runner: AgentTeamRoleRunner,
): Promise<AgentTeamExecutionResult> {
  const shape = team.shape === 'auto' ? inferConcreteShape(team) : team.shape;
  if (shape === 'parallel') return executeParallel(team, input, runner);
  if (shape === 'leader-worker')
    return executeLeaderWorker(team, input, runner);
  if (shape === 'judge-route') return executeJudgeRoute(team, input, runner);
  return executePipeline(team, input, runner);
}

async function executePipeline(
  team: AgentTeam,
  input: AgentTeamExecutionInput,
  runner: AgentTeamRoleRunner,
): Promise<AgentTeamExecutionResult> {
  const state = createExecutionState(input);
  const roleResults: AgentTeamRoleResult[] = [];
  const events: AgentTeamExecutionEvent[] = [];
  const maxFeedbackIterations = input.maxFeedbackIterations ?? 1;
  let feedbackUsed = 0;

  for (let index = 0; index < team.roles.length; index += 1) {
    const role = team.roles[index];
    if (role.parallelGroup) {
      const start = index;
      const groupedRoles = team.roles
        .slice(start)
        .filter((candidate) => candidate.parallelGroup);
      const chains = groupParallelChains(groupedRoles);
      for (const chain of chains) {
        events.push({
          kind: 'edge',
          fromRoleId: team.roles[start - 1]?.id,
          toRoleId: chain.roles[0]?.id,
          label: `parallel-chain:${chain.group}`,
        });
      }
      const chainResults = await Promise.all(
        chains.map((chain) =>
          executeRoleChain(
            team,
            chain.roles,
            input.prompt,
            roleResults,
            runner,
            events,
            state,
          ),
        ),
      );
      for (const results of chainResults) roleResults.push(...results);
      const failed = chainResults
        .flat()
        .find((result) => result.status === 'error');
      if (failed)
        return summarize(
          team,
          'error',
          roleResults,
          events,
          state,
          failed.error || failed.result,
        );
      index += groupedRoles.length - 1;
      continue;
    }
    const phase = roleLooksLikeTest(role)
      ? 'test'
      : index === team.roles.length - 1
        ? 'finalize'
        : 'work';
    const result = await runRole(
      team,
      role,
      input.prompt,
      phase,
      roleResults,
      runner,
      undefined,
      state,
    );
    roleResults.push(result);
    events.push({ kind: 'role', roleId: role.id, phase });
    if (result.status === 'error')
      return summarize(
        team,
        'error',
        roleResults,
        events,
        state,
        result.error || result.result,
      );

    if (
      roleLooksLikeTest(role) &&
      isFailedTestResult(result.result) &&
      feedbackUsed < maxFeedbackIterations
    ) {
      const targetIndex = findFeedbackTargetIndex(team.roles, index);
      const target = team.roles[targetIndex];
      feedbackUsed += 1;
      events.push({
        kind: 'feedback',
        fromRoleId: role.id,
        toRoleId: target.id,
        label: '测试不通过 → 返工',
      });
      const feedbackResult = await runRole(
        team,
        target,
        input.prompt,
        'feedback',
        roleResults,
        runner,
        result.result,
        state,
      );
      roleResults.push(feedbackResult);
      events.push({ kind: 'role', roleId: target.id, phase: 'feedback' });
      if (feedbackResult.status === 'error')
        return summarize(
          team,
          'error',
          roleResults,
          events,
          state,
          feedbackResult.error || feedbackResult.result,
        );
      const retest = await runRole(
        team,
        role,
        input.prompt,
        'feedback',
        roleResults,
        runner,
        feedbackResult.result,
        state,
      );
      roleResults.push(retest);
      events.push({ kind: 'role', roleId: role.id, phase: 'feedback' });
      if (retest.status === 'error' || isFailedTestResult(retest.result)) {
        return summarize(
          team,
          retest.status === 'error' ? 'error' : 'success',
          roleResults,
          events,
          state,
          retest.error,
        );
      }
    }
  }

  return summarize(team, 'success', roleResults, events, state);
}

async function executeParallel(
  team: AgentTeam,
  input: AgentTeamExecutionInput,
  runner: AgentTeamRoleRunner,
): Promise<AgentTeamExecutionResult> {
  if (!hasParallelChains(team.roles))
    return executeFlatParallel(team, input, runner);
  const state = createExecutionState(input);
  const events: AgentTeamExecutionEvent[] = [];
  const chains = groupParallelChains(team.roles);
  const roleResultsByChain = await Promise.all(
    chains.map(async (chain) => {
      events.push({
        kind: 'edge',
        toRoleId: chain.roles[0]?.id,
        label:
          chain.group === 'default'
            ? 'fan-out / fan-in'
            : `parallel-chain:${chain.group}`,
      });
      return executeRoleChain(
        team,
        chain.roles,
        input.prompt,
        [],
        runner,
        events,
        state,
      );
    }),
  );
  const roleResults = roleResultsByChain.flat();
  const failed = roleResults.find((result) => result.status === 'error');
  return summarize(
    team,
    failed ? 'error' : 'success',
    roleResults,
    events,
    state,
    failed?.error,
  );
}

async function executeFlatParallel(
  team: AgentTeam,
  input: AgentTeamExecutionInput,
  runner: AgentTeamRoleRunner,
): Promise<AgentTeamExecutionResult> {
  const state = createExecutionState(input);
  const events: AgentTeamExecutionEvent[] = [];
  const roleResults = await Promise.all(
    team.roles.map(async (role) => {
      events.push({
        kind: 'edge',
        toRoleId: role.id,
        label: 'fan-out / fan-in',
      });
      const result = await runRole(
        team,
        role,
        input.prompt,
        'work',
        [],
        runner,
        undefined,
        state,
      );
      events.push({ kind: 'role', roleId: role.id, phase: 'work' });
      return result;
    }),
  );
  const failed = roleResults.find((result) => result.status === 'error');
  return summarize(
    team,
    failed ? 'error' : 'success',
    roleResults,
    events,
    state,
    failed?.error,
  );
}

async function executeRoleChain(
  team: AgentTeam,
  roles: AgentTeamRole[],
  prompt: string,
  baseResults: AgentTeamRoleResult[],
  runner: AgentTeamRoleRunner,
  events: AgentTeamExecutionEvent[],
  state: ExecutionState,
): Promise<AgentTeamRoleResult[]> {
  const chainResults: AgentTeamRoleResult[] = [];
  for (const role of roles) {
    const previousResults = [...baseResults, ...chainResults];
    const result = await runRole(
      team,
      role,
      prompt,
      roleLooksLikeTest(role) ? 'test' : 'work',
      previousResults,
      runner,
      undefined,
      state,
    );
    chainResults.push(result);
    events.push({ kind: 'role', roleId: role.id, phase: result.phase });
    if (result.status === 'error') break;
  }
  return chainResults;
}

function hasParallelChains(roles: AgentTeamRole[]): boolean {
  return roles.some((role) => Boolean(role.parallelGroup));
}

function groupParallelChains(
  roles: AgentTeamRole[],
): Array<{ group: string; roles: AgentTeamRole[] }> {
  const groups = new Map<string, AgentTeamRole[]>();
  roles.forEach((role, index) => {
    const group = role.parallelGroup?.trim() || `role-${role.id || index}`;
    groups.set(group, [...(groups.get(group) ?? []), role]);
  });
  return Array.from(groups.entries()).map(([group, groupRoles]) => ({
    group,
    roles: groupRoles,
  }));
}

async function executeLeaderWorker(
  team: AgentTeam,
  input: AgentTeamExecutionInput,
  runner: AgentTeamRoleRunner,
): Promise<AgentTeamExecutionResult> {
  const state = createExecutionState(input);
  const [lead, ...workers] = team.roles;
  const roleResults: AgentTeamRoleResult[] = [];
  const events: AgentTeamExecutionEvent[] = [];
  if (!lead)
    return summarize(
      team,
      'error',
      roleResults,
      events,
      state,
      'team has no lead role',
    );

  const plan = await runRole(
    team,
    lead,
    input.prompt,
    'plan',
    roleResults,
    runner,
    undefined,
    state,
  );
  roleResults.push(plan);
  events.push({ kind: 'role', roleId: lead.id, phase: 'plan' });
  if (plan.status === 'error')
    return summarize(
      team,
      'error',
      roleResults,
      events,
      state,
      plan.error || plan.result,
    );

  const workerResults = await Promise.all(
    workers.map(async (worker) => {
      events.push({
        kind: 'edge',
        fromRoleId: lead.id,
        toRoleId: worker.id,
        label: 'Lead 分派',
      });
      const result = await runRole(
        team,
        worker,
        input.prompt,
        'work',
        roleResults,
        runner,
        plan.result,
        state,
      );
      events.push({
        kind: 'edge',
        fromRoleId: worker.id,
        toRoleId: lead.id,
        label: '汇总给 Lead',
      });
      events.push({ kind: 'role', roleId: worker.id, phase: 'work' });
      return result;
    }),
  );
  roleResults.push(...workerResults);
  const failed = workerResults.find((result) => result.status === 'error');
  if (failed)
    return summarize(
      team,
      'error',
      roleResults,
      events,
      state,
      failed.error || failed.result,
    );

  const final = await runRole(
    team,
    lead,
    input.prompt,
    'finalize',
    roleResults,
    runner,
    undefined,
    state,
  );
  roleResults.push(final);
  events.push({ kind: 'role', roleId: lead.id, phase: 'finalize' });
  return summarize(team, final.status, roleResults, events, state, final.error);
}

async function executeJudgeRoute(
  team: AgentTeam,
  input: AgentTeamExecutionInput,
  runner: AgentTeamRoleRunner,
): Promise<AgentTeamExecutionResult> {
  const state = createExecutionState(input);
  const [judge, ...candidates] = team.roles;
  const roleResults: AgentTeamRoleResult[] = [];
  const events: AgentTeamExecutionEvent[] = [];
  if (!judge)
    return summarize(
      team,
      'error',
      roleResults,
      events,
      state,
      'team has no judge role',
    );

  const judgeResult = await runRole(
    team,
    judge,
    input.prompt,
    'judge',
    roleResults,
    runner,
    undefined,
    state,
  );
  roleResults.push(judgeResult);
  events.push({ kind: 'role', roleId: judge.id, phase: 'judge' });
  if (judgeResult.status === 'error')
    return summarize(
      team,
      'error',
      roleResults,
      events,
      state,
      judgeResult.error || judgeResult.result,
    );

  const decision = parseRouteDecision(judgeResult.result, candidates);
  const selected =
    (decision?.action === 'run_role'
      ? candidates.find((role) => role.id === decision.target)
      : null) ??
    parseRouteTarget(judgeResult.result, candidates) ??
    candidates[0];
  if (selected) {
    const label = decision
      ? `Judge 选择路径：${decision.reason} (${decision.confidence.toFixed(2)})`
      : 'Judge 选择路径';
    events.push({
      kind: 'route',
      fromRoleId: judge.id,
      toRoleId: selected.id,
      label,
    });
    emitTrace(state, {
      actor: judge.id,
      type: 'route.decided',
      taskId: `${state.runId}:${judge.id}:judge`,
      payload: {
        action: decision?.action ?? 'run_role',
        target: selected.id,
        reason:
          decision?.reason ?? 'fallback route target parsed from judge output',
        confidence: decision?.confidence ?? 0.5,
      },
    });
    const routed = await runRole(
      team,
      selected,
      input.prompt,
      'route',
      roleResults,
      runner,
      judgeResult.result,
      state,
    );
    roleResults.push(routed);
    events.push({ kind: 'role', roleId: selected.id, phase: 'route' });
    if (routed.status === 'error')
      return summarize(
        team,
        'error',
        roleResults,
        events,
        state,
        routed.error || routed.result,
      );
  }

  const finalRole = candidates[candidates.length - 1];
  if (finalRole && finalRole.id !== selected?.id) {
    events.push({
      kind: 'edge',
      fromRoleId: selected?.id ?? judge.id,
      toRoleId: finalRole.id,
      label: '进入复核',
    });
    const final = await runRole(
      team,
      finalRole,
      input.prompt,
      'finalize',
      roleResults,
      runner,
      undefined,
      state,
    );
    roleResults.push(final);
    events.push({ kind: 'role', roleId: finalRole.id, phase: 'finalize' });
    return summarize(
      team,
      final.status,
      roleResults,
      events,
      state,
      final.error,
    );
  }

  return summarize(team, 'success', roleResults, events, state);
}

async function runRole(
  team: AgentTeam,
  role: AgentTeamRole,
  prompt: string,
  phase: AgentTeamExecutionPhase,
  previousResults: AgentTeamRoleResult[],
  runner: AgentTeamRoleRunner,
  feedback?: string,
  state?: ExecutionState,
): Promise<AgentTeamRoleResult> {
  const taskId = state ? `${state.runId}:${role.id}:${phase}` : undefined;
  if (state) {
    emitTrace(state, {
      actor: role.id,
      type: 'agent.started',
      taskId,
      payload: { roleId: role.id, roleName: role.name, phase },
    });
  }
  const output = await runner({
    team,
    role,
    prompt,
    phase,
    previousResults,
    feedback,
  });
  if (state) {
    emitTrace(state, {
      actor: role.id,
      type: 'agent.completed',
      taskId,
      payload: {
        roleId: role.id,
        roleName: role.name,
        phase,
        status: output.status,
        error: output.error,
      },
    });
  }
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
  state: ExecutionState,
  error?: string,
): AgentTeamExecutionResult {
  const title = `${team.shape} team execution summary`;
  const finalResult = [
    title,
    ...roleResults.map(
      (result) => `- ${result.roleName}(${result.phase}): ${result.result}`,
    ),
  ].join('\n');
  emitTrace(state, {
    actor: 'orchestrator',
    type: status === 'success' ? 'workflow.completed' : 'workflow.failed',
    payload: { teamId: team.id, status, error },
  });
  return {
    status,
    finalResult,
    roleResults,
    events,
    runId: state.runId,
    traceId: state.traceId,
    traceEvents: state.traceEvents,
    error,
  };
}

function createExecutionState(input: AgentTeamExecutionInput): ExecutionState {
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const runId = input.runId || `team_run_${suffix}`;
  const traceId = input.traceId || `team_trace_${suffix}`;
  return {
    runId,
    traceId,
    sessionId: input.sessionId,
    traceEvents: [],
    spanSeq: 0,
  };
}

function emitTrace(
  state: ExecutionState,
  event: Omit<
    AgentTeamTraceEvent,
    'traceId' | 'spanId' | 'runId' | 'sessionId' | 'timestamp' | 'schemaVersion'
  >,
): void {
  state.spanSeq += 1;
  state.traceEvents.push({
    traceId: state.traceId,
    spanId: `${state.runId}:span_${state.spanSeq}`,
    sessionId: state.sessionId,
    runId: state.runId,
    timestamp: new Date().toISOString(),
    schemaVersion: 1,
    ...event,
  });
}

function inferConcreteShape(team: AgentTeam): Exclude<AgentTeamShape, 'auto'> {
  if (team.roles.length <= 2) return 'leader-worker';
  return 'pipeline';
}

function roleLooksLikeTest(role: AgentTeamRole): boolean {
  return /测试|test|qa|quality/i.test(`${role.name} ${role.responsibility}`);
}

function roleLooksLikeDevelopment(role: AgentTeamRole): boolean {
  return /开发|implement|dev|engineer|编码/i.test(
    `${role.name} ${role.responsibility}`,
  );
}

function isFailedTestResult(result: string): boolean {
  return /测试不通过|不通过|失败|fail|failed|返工/i.test(result);
}

function findFeedbackTargetIndex(
  roles: AgentTeamRole[],
  testIndex: number,
): number {
  for (let index = testIndex - 1; index >= 0; index -= 1) {
    if (roleLooksLikeDevelopment(roles[index])) return index;
  }
  return Math.max(0, testIndex - 1);
}

function parseRouteTarget(
  result: string,
  candidates: AgentTeamRole[],
): AgentTeamRole | null {
  const normalized = result.toLowerCase();
  return (
    candidates.find(
      (role) =>
        normalized.includes(role.id.toLowerCase()) ||
        normalized.includes(role.name.toLowerCase()),
    ) ?? null
  );
}

function parseRouteDecision(
  result: string,
  candidates: AgentTeamRole[],
): RouteDecision | null {
  const jsonText = extractJsonObject(result);
  if (!jsonText) return null;
  try {
    const parsed = JSON.parse(jsonText) as Partial<RouteDecision>;
    const action = parsed.action;
    if (
      !action ||
      !['run_role', 'finish', 'request_approval', 'abort'].includes(action)
    )
      return null;
    const confidence = Number(parsed.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)
      return null;
    const target =
      typeof parsed.target === 'string' ? parsed.target.trim() : undefined;
    if (
      action === 'run_role' &&
      (!target || !candidates.some((role) => role.id === target))
    )
      return null;
    return {
      action,
      target,
      reason:
        typeof parsed.reason === 'string' && parsed.reason.trim()
          ? parsed.reason.trim()
          : 'Judge route decision',
      confidence,
    };
  } catch {
    return null;
  }
}

function extractJsonObject(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced?.[1] ?? text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return raw.slice(start, end + 1);
}
