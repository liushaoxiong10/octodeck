import type { ContainerOutput } from './container-runner.js';
import type {
  AgentTeam,
  AgentTeamRole,
  AgentTeamShape,
  AgentTeamWorkflowAction,
  AgentTeamWorkflowFailurePolicy,
  AgentTeamWorkflowStep,
} from './agent-teams.js';

export type AgentTeamExecutionPhase = string;

export interface AgentTeamBusMessage {
  id: string;
  runId: string;
  stepId?: string;
  from: string;
  to?: string;
  kind: 'control' | 'artifact' | 'context' | 'status';
  type: string;
  payload: unknown;
  timestamp: string;
}

export interface AgentTeamRoleRunContext {
  team: AgentTeam;
  role: AgentTeamRole;
  prompt: string;
  phase: AgentTeamExecutionPhase;
  previousResults: AgentTeamRoleResult[];
  feedback?: string;
  instructions?: string;
  busMessages?: AgentTeamBusMessage[];
  artifacts?: Record<string, string>;
}

export interface AgentTeamRoleResult {
  roleId: string;
  roleName: string;
  phase: AgentTeamExecutionPhase;
  status: 'success' | 'error';
  result: string;
  outputKey?: string;
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
  resumeFromCheckpoint?: AgentTeamRuntimeCheckpoint;
  approvalDecision?: {
    approvalId: string;
    status: 'approved' | 'rejected' | 'granted';
    targetRoleId?: string;
    comment?: string;
  };
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

export type AgentTeamWorkflowRuntimeStatus =
  | 'running'
  | 'success'
  | 'error'
  | 'waiting_approval'
  | 'cancelled';

export type AgentTeamWorkflowStepStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'success'
  | 'failed'
  | 'skipped'
  | 'waiting_approval';

export interface AgentTeamRuntimeStepState {
  status: AgentTeamWorkflowStepStatus;
  attempt: number;
  startedAt?: string;
  completedAt?: string;
  outputKey?: string;
  error?: string | null;
}

export interface AgentTeamWaitingApproval {
  approvalId: string;
  runId: string;
  traceId: string;
  stepId: string;
  requestedBy: string;
  reason: string;
  confidence: number;
  targetRoleId?: string;
  candidateRoleIds: string[];
  riskLevel: 'medium' | 'high' | 'critical';
  payload: Record<string, unknown>;
}

export interface AgentTeamRuntimeCheckpoint {
  schemaVersion: 2;
  runId: string;
  traceId: string;
  workflowNode: string;
  status: AgentTeamWorkflowRuntimeStatus;
  stepStatuses: Record<string, AgentTeamRuntimeStepState>;
  artifacts: Record<string, string>;
  waitingApproval?: AgentTeamWaitingApproval;
  busMessageSeq: number;
  spanSeq: number;
  messageSeq: number;
  lastError?: string | null;
  updatedAt: string;
}

export interface AgentTeamExecutionResult {
  status: 'success' | 'error' | 'waiting_approval';
  finalResult: string;
  roleResults: AgentTeamRoleResult[];
  events: AgentTeamExecutionEvent[];
  runId?: string;
  traceId?: string;
  traceEvents?: AgentTeamTraceEvent[];
  busMessages?: AgentTeamBusMessage[];
  waitingApproval?: AgentTeamWaitingApproval;
  checkpoint?: AgentTeamRuntimeCheckpoint;
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
  busMessages: AgentTeamBusMessage[];
  artifacts: Record<string, string>;
  stepStatuses: Record<string, AgentTeamRuntimeStepState>;
  waitingApproval?: AgentTeamWaitingApproval;
  lastError?: string | null;
  workflowNode?: string;
  spanSeq: number;
  messageSeq: number;
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
  if (team.workflowSteps?.length) {
    return executeWorkflowSteps(team, input, runner);
  }
  const shape = team.shape === 'auto' ? inferConcreteShape(team) : team.shape;
  if (shape === 'parallel') return executeParallel(team, input, runner);
  if (shape === 'leader-worker')
    return executeLeaderWorker(team, input, runner);
  if (shape === 'judge-route') return executeJudgeRoute(team, input, runner);
  return executePipeline(team, input, runner);
}

async function executeWorkflowSteps(
  team: AgentTeam,
  input: AgentTeamExecutionInput,
  runner: AgentTeamRoleRunner,
): Promise<AgentTeamExecutionResult> {
  const state = createExecutionState(input);
  const roleResults: AgentTeamRoleResult[] = [];
  const events: AgentTeamExecutionEvent[] = [];
  const graph = validateWorkflowGraph(team.workflowSteps ?? []);
  if ('error' in graph) {
    state.lastError = graph.error;
    emitTrace(state, {
      actor: 'orchestrator',
      type: 'workflow.validation.failed',
      payload: { teamId: team.id, error: graph.error },
    });
    return summarize(team, 'error', roleResults, events, state, graph.error);
  }
  for (const step of graph.steps) {
    state.stepStatuses[step.id] = { status: 'pending', attempt: 0, outputKey: step.outputKey, error: null };
  }
  if (input.resumeFromCheckpoint) {
    state.artifacts = { ...input.resumeFromCheckpoint.artifacts };
    state.stepStatuses = cloneStepStatuses(input.resumeFromCheckpoint.stepStatuses);
    state.workflowNode = input.resumeFromCheckpoint.workflowNode;
    state.lastError = input.resumeFromCheckpoint.lastError;
    state.waitingApproval = input.resumeFromCheckpoint.waitingApproval;
    state.spanSeq = input.resumeFromCheckpoint.spanSeq;
    state.messageSeq = input.resumeFromCheckpoint.messageSeq;
    if (input.approvalDecision?.status === 'rejected') {
      const error = `approval ${input.approvalDecision.approvalId} rejected`;
      state.lastError = error;
      return summarize(team, 'error', roleResults, events, state, error);
    }
    if (input.approvalDecision && state.waitingApproval) {
      const waitingStep = state.waitingApproval.stepId;
      state.stepStatuses[waitingStep] = {
        ...(state.stepStatuses[waitingStep] ?? { attempt: 0 }),
        status: 'pending',
        error: null,
      };
      state.waitingApproval = undefined;
    }
  }
  emitBus(state, {
    from: 'orchestrator',
    kind: 'control',
    type: 'workflow.started',
    payload: {
      teamId: team.id,
      shape: team.shape,
      protocol: 'octodeck.agent-team.bus.v1',
    },
  });

  while (hasPendingSteps(state)) {
    const readySteps = getReadySteps(state, graph);
    if (!readySteps.length) {
      const error = 'workflow deadlock: no ready steps remain';
      state.lastError = error;
      emitTrace(state, { actor: 'orchestrator', type: 'workflow.deadlock', payload: { teamId: team.id, stepStatuses: state.stepStatuses } });
      return summarize(team, 'error', roleResults, events, state, error);
    }
    for (const step of readySteps) {
      updateStepStatus(state, step.id, 'ready', { outputKey: step.outputKey });
      emitTrace(state, { actor: 'orchestrator', type: 'workflow.step.ready', taskId: step.id, payload: { stepId: step.id, dependsOn: graph.dependencies.get(step.id) ?? [] } });
    }
    const outcomes = await Promise.all(
      readySteps.map(async (step) => {
        updateStepStatus(state, step.id, 'running', { outputKey: step.outputKey });
        return {
          step,
          outcome: await executeWorkflowStep(team, input, runner, step, roleResults, events, state),
        };
      }),
    );
    for (const { step, outcome } of outcomes) {
      if (outcome.status === 'waiting_approval') {
        updateStepStatus(state, step.id, 'waiting_approval', { outputKey: step.outputKey });
        return summarize(team, 'waiting_approval', roleResults, events, state);
      }
      if (outcome.status === 'error') {
        updateStepStatus(state, step.id, 'failed', { outputKey: step.outputKey, error: outcome.error });
        return summarize(team, 'error', roleResults, events, state, outcome.error);
      }
      updateStepStatus(state, step.id, 'success', { outputKey: step.outputKey });
    }
  }
  return summarize(team, 'success', roleResults, events, state);
}

function cloneStepStatuses(
  statuses: Record<string, AgentTeamRuntimeStepState>,
): Record<string, AgentTeamRuntimeStepState> {
  return Object.fromEntries(Object.entries(statuses).map(([key, value]) => [key, { ...value }]));
}

interface WorkflowGraph {
  steps: AgentTeamWorkflowStep[];
  byId: Map<string, AgentTeamWorkflowStep>;
  dependencies: Map<string, string[]>;
}

function validateWorkflowGraph(
  steps: AgentTeamWorkflowStep[],
): WorkflowGraph | { error: string } {
  const byId = new Map<string, AgentTeamWorkflowStep>();
  for (const step of steps) {
    if (byId.has(step.id)) return { error: `duplicate workflow step id ${step.id}` };
    byId.set(step.id, step);
  }
  const dependencies = new Map<string, string[]>();
  const hasExplicitDependencies = steps.some((step) => (step.dependsOn ?? []).length > 0);
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const deps = hasExplicitDependencies ? step.dependsOn ?? [] : index > 0 ? [steps[index - 1].id] : [];
    for (const dep of deps) {
      if (!byId.has(dep)) return { error: `step ${step.id} dependsOn missing unknown step ${dep}` };
    }
    dependencies.set(step.id, deps);
  }
  const cycle = findWorkflowCycle(steps, dependencies);
  if (cycle) return { error: `workflow dependency cycle detected: ${cycle.join(' -> ')}` };
  return { steps, byId, dependencies };
}

function findWorkflowCycle(
  steps: AgentTeamWorkflowStep[],
  dependencies: Map<string, string[]>,
): string[] | null {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    if (visiting.has(id)) return [...stack.slice(stack.indexOf(id)), id];
    if (visited.has(id)) return null;
    visiting.add(id);
    stack.push(id);
    for (const dep of dependencies.get(id) ?? []) {
      const cycle = visit(dep);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
    return null;
  };
  for (const step of steps) {
    const cycle = visit(step.id);
    if (cycle) return cycle;
  }
  return null;
}

function hasPendingSteps(state: ExecutionState): boolean {
  return Object.values(state.stepStatuses).some((step) => step.status === 'pending' || step.status === 'ready');
}

function getReadySteps(state: ExecutionState, graph: WorkflowGraph): AgentTeamWorkflowStep[] {
  return graph.steps.filter((step) => {
    const current = state.stepStatuses[step.id]?.status;
    if (current !== 'pending' && current !== 'ready') return false;
    return (graph.dependencies.get(step.id) ?? []).every((dep) => state.stepStatuses[dep]?.status === 'success');
  });
}

function updateStepStatus(
  state: ExecutionState,
  stepId: string,
  status: AgentTeamWorkflowStepStatus,
  updates: Partial<AgentTeamRuntimeStepState> = {},
): void {
  const previous = state.stepStatuses[stepId] ?? { status: 'pending', attempt: 0 };
  const now = new Date().toISOString();
  const next: AgentTeamRuntimeStepState = {
    ...previous,
    ...updates,
    status,
    attempt: status === 'running' ? previous.attempt + 1 : previous.attempt,
    startedAt: status === 'running' ? now : previous.startedAt,
    completedAt: ['success', 'failed', 'skipped', 'waiting_approval'].includes(status) ? now : previous.completedAt,
  };
  state.stepStatuses[stepId] = next;
  state.workflowNode = stepId;
  if (next.error) state.lastError = next.error;
  emitTrace(state, { actor: 'orchestrator', type: `workflow.step.${status}`, taskId: stepId, payload: { stepId, status, attempt: next.attempt, error: next.error } });
}

async function executeWorkflowStep(
  team: AgentTeam,
  input: AgentTeamExecutionInput,
  runner: AgentTeamRoleRunner,
  step: AgentTeamWorkflowStep,
  roleResults: AgentTeamRoleResult[],
  events: AgentTeamExecutionEvent[],
  state: ExecutionState,
): Promise<{ status: 'success' | 'error' | 'waiting_approval'; error?: string }> {
  emitBus(state, {
    stepId: step.id,
    from: 'orchestrator',
    kind: 'control',
    type: 'step.started',
    payload: step,
  });
  const artifacts = selectArtifactsForStep(step, state);
  if ('error' in artifacts) return { status: 'error', error: artifacts.error };
  if (step.type === 'role') {
    if (!step.roleId) return { status: 'error', error: `step ${step.id} missing roleId` };
    const role = team.roles.find((candidate) => candidate.id === step.roleId);
    if (!role) return { status: 'error', error: `role ${step.roleId} not found` };
    const result = await runWorkflowAction(
      team,
      input,
      runner,
      role,
      {
        roleId: role.id,
        phase: step.phase ?? 'work',
        instructions: step.instructions,
        outputKey: step.outputKey,
      },
      step,
      selectPreviousResultsForStep(step, roleResults),
      state,
      artifacts.artifacts,
    );
    roleResults.push(result);
    events.push({ kind: 'role', roleId: role.id, phase: result.phase });
    return handleWorkflowFailure(team, input, runner, step, result, roleResults, events, state);
  }
  if (step.type === 'parallel') {
    const chains = step.parallel ?? [];
    const chainResults = await Promise.all(
      chains.map((chain) => executeWorkflowActionChain(team, input, runner, step, chain, selectPreviousResultsForStep(step, roleResults), state, artifacts.artifacts)),
    );
    for (const results of chainResults) roleResults.push(...results);
    for (const chain of chains) {
      events.push({ kind: 'edge', toRoleId: chain[0]?.roleId, label: `workflow-step:${step.id}` });
    }
    const failed = chainResults.flat().find((result) => result.status === 'error');
    if (!failed) {
      if (step.outputKey) {
        state.artifacts[step.outputKey] = chainResults.flat().map((result) => result.result).join('\n');
      }
      return { status: 'success' };
    }
    return handleWorkflowFailure(team, input, runner, step, failed, roleResults, events, state);
  }
  const route = step.route;
  if (!route) return { status: 'error', error: `step ${step.id} missing route` };
  if (input.approvalDecision?.approvalId === `${state.runId}:approval:${step.id}`) {
    const candidates = team.roles.filter((role) => route.candidateRoleIds.includes(role.id));
    const approvedTargetRoleId = input.approvalDecision.targetRoleId ?? route.fallbackRoleId ?? candidates[0]?.id;
    const approved = candidates.find((role) => role.id === approvedTargetRoleId);
    if (!approved) return { status: 'error', error: `approved target role ${approvedTargetRoleId} not found` };
    emitBus(state, {
      stepId: step.id,
      from: 'orchestrator',
      to: approved.id,
      kind: 'control',
      type: 'approval.granted',
      payload: { approvalId: input.approvalDecision.approvalId, targetRoleId: approved.id },
    });
    const routed = await runWorkflowAction(
      team,
      input,
      runner,
      approved,
      { roleId: approved.id, phase: 'route', instructions: input.approvalDecision.comment ?? 'Approved route approval', outputKey: step.outputKey ?? `${step.id}.${approved.id}` },
      step,
      selectPreviousResultsForStep(step, roleResults),
      state,
      artifacts.artifacts,
    );
    roleResults.push(routed);
    events.push({ kind: 'role', roleId: approved.id, phase: routed.phase });
    return handleWorkflowFailure(team, input, runner, step, routed, roleResults, events, state);
  }
  const judge = team.roles.find((role) => role.id === route.judgeRoleId);
  if (!judge) return { status: 'error', error: `judge role ${route.judgeRoleId} not found` };
  const judgeResult = await runWorkflowAction(
    team,
    input,
    runner,
    judge,
    { roleId: judge.id, phase: 'judge', instructions: step.instructions, outputKey: `${step.id}.judge` },
    step,
    selectPreviousResultsForStep(step, roleResults),
    state,
    artifacts.artifacts,
  );
  roleResults.push(judgeResult);
  events.push({ kind: 'role', roleId: judge.id, phase: judgeResult.phase });
  if (judgeResult.status === 'error') {
    return handleWorkflowFailure(team, input, runner, step, judgeResult, roleResults, events, state);
  }
  const candidates = team.roles.filter((role) => route.candidateRoleIds.includes(role.id));
  const decision = parseRouteDecision(judgeResult.result, candidates);
  if (decision?.action === 'request_approval') {
    if (input.approvalDecision && input.approvalDecision.approvalId === `${state.runId}:approval:${step.id}`) {
      const approvedTargetRoleId = input.approvalDecision.targetRoleId ?? decision.target ?? route.fallbackRoleId ?? candidates[0]?.id;
      const approved = candidates.find((role) => role.id === approvedTargetRoleId);
      if (!approved) return { status: 'error', error: `approved target role ${approvedTargetRoleId} not found` };
      emitBus(state, {
        stepId: step.id,
        from: 'orchestrator',
        to: approved.id,
        kind: 'control',
        type: 'approval.granted',
        payload: { approvalId: input.approvalDecision.approvalId, targetRoleId: approved.id },
      });
      const routed = await runWorkflowAction(
        team,
        input,
        runner,
        approved,
        { roleId: approved.id, phase: 'route', instructions: judgeResult.result, outputKey: step.outputKey ?? `${step.id}.${approved.id}` },
        step,
        selectPreviousResultsForStep(step, roleResults),
        state,
        artifacts.artifacts,
      );
      roleResults.push(routed);
      events.push({ kind: 'role', roleId: approved.id, phase: routed.phase });
      return handleWorkflowFailure(team, input, runner, step, routed, roleResults, events, state);
    }
    const targetRoleId = decision.target ?? route.fallbackRoleId ?? candidates[0]?.id;
    const waitingApproval = createWaitingApproval({ team, state, step, route, judge, decision, targetRoleId });
    state.waitingApproval = waitingApproval;
    emitBus(state, {
      stepId: step.id,
      from: judge.id,
      kind: 'control',
      type: 'approval.requested',
      payload: waitingApproval,
    });
    emitTrace(state, {
      actor: judge.id,
      type: 'approval.requested',
      taskId: step.id,
      payload: waitingApproval,
    });
    return { status: 'waiting_approval' };
  }
  const selected =
    (decision?.action === 'run_role' ? candidates.find((role) => role.id === decision.target) : null) ??
    candidates.find((role) => role.id === route.fallbackRoleId) ??
    candidates[0];
  if (selected && decision?.action !== 'finish') {
    emitBus(state, {
      stepId: step.id,
      from: judge.id,
      to: selected.id,
      kind: 'control',
      type: 'route.decided',
      payload: decision ?? { action: 'run_role', target: selected.id, reason: 'fallback route', confidence: 0.5 },
    });
    events.push({ kind: 'route', fromRoleId: judge.id, toRoleId: selected.id, label: decision?.reason ?? 'workflow route' });
    const routed = await runWorkflowAction(
      team,
      input,
      runner,
      selected,
      { roleId: selected.id, phase: 'route', instructions: judgeResult.result, outputKey: step.outputKey ?? `${step.id}.${selected.id}` },
      step,
      selectPreviousResultsForStep(step, roleResults),
      state,
      artifacts.artifacts,
    );
    roleResults.push(routed);
    events.push({ kind: 'role', roleId: selected.id, phase: routed.phase });
    const failure = await handleWorkflowFailure(team, input, runner, step, routed, roleResults, events, state);
    if (failure.status === 'error') return failure;
  }
  const finalRole = route.finalRoleId ? team.roles.find((role) => role.id === route.finalRoleId) : undefined;
  if (finalRole && finalRole.id !== selected?.id) {
    const final = await runWorkflowAction(
      team,
      input,
      runner,
      finalRole,
      { roleId: finalRole.id, phase: 'finalize', outputKey: step.outputKey ?? `${step.id}.final` },
      step,
      selectPreviousResultsForStep(step, roleResults),
      state,
      artifacts.artifacts,
    );
    roleResults.push(final);
    events.push({ kind: 'role', roleId: finalRole.id, phase: final.phase });
    return handleWorkflowFailure(team, input, runner, step, final, roleResults, events, state);
  }
  return { status: 'success' };
}

async function executeWorkflowActionChain(
  team: AgentTeam,
  input: AgentTeamExecutionInput,
  runner: AgentTeamRoleRunner,
  step: AgentTeamWorkflowStep,
  chain: AgentTeamWorkflowAction[],
  baseResults: AgentTeamRoleResult[],
  state: ExecutionState,
  artifacts?: Record<string, string>,
): Promise<AgentTeamRoleResult[]> {
  const results: AgentTeamRoleResult[] = [];
  for (const action of chain) {
    const role = team.roles.find((candidate) => candidate.id === action.roleId);
    if (!role) {
      results.push({ roleId: action.roleId, roleName: action.roleId, phase: action.phase ?? 'work', status: 'error', result: '', error: `role ${action.roleId} not found` });
      break;
    }
    const result = await runWorkflowAction(team, input, runner, role, action, step, [...baseResults, ...results], state, artifacts);
    results.push(result);
    if (result.status === 'error') break;
  }
  return results;
}

function runWorkflowAction(
  team: AgentTeam,
  input: AgentTeamExecutionInput,
  runner: AgentTeamRoleRunner,
  role: AgentTeamRole,
  action: AgentTeamWorkflowAction,
  step: AgentTeamWorkflowStep,
  previousResults: AgentTeamRoleResult[],
  state: ExecutionState,
  artifacts?: Record<string, string>,
): Promise<AgentTeamRoleResult> {
  return runRole(
    team,
    role,
    input.prompt,
    action.phase ?? step.phase ?? 'work',
    previousResults,
    runner,
    undefined,
    state,
    { stepId: step.id, instructions: action.instructions ?? step.instructions, outputKey: action.outputKey ?? step.outputKey },
    artifacts,
  );
}

function selectArtifactsForStep(
  step: AgentTeamWorkflowStep,
  state: ExecutionState,
): { artifacts: Record<string, string> } | { error: string } {
  if (!step.inputKeys?.length) return { artifacts: state.artifacts };
  const selected: Record<string, string> = {};
  for (const key of step.inputKeys) {
    if (!(key in state.artifacts)) return { error: `step ${step.id} missing input artifact ${key}` };
    selected[key] = state.artifacts[key];
  }
  return { artifacts: selected };
}

function selectPreviousResultsForStep(
  step: AgentTeamWorkflowStep,
  previousResults: AgentTeamRoleResult[],
): AgentTeamRoleResult[] {
  if (!step.inputKeys?.length) return previousResults;
  const allowed = new Set(step.inputKeys);
  return previousResults.filter((result) => result.outputKey && allowed.has(result.outputKey));
}

function createWaitingApproval(input: {
  team: AgentTeam;
  state: ExecutionState;
  step: AgentTeamWorkflowStep;
  route: NonNullable<AgentTeamWorkflowStep['route']>;
  judge: AgentTeamRole;
  decision: RouteDecision;
  targetRoleId?: string;
}): AgentTeamWaitingApproval {
  const approvalId = `${input.state.runId}:approval:${input.step.id}`;
  const payload = {
    schemaVersion: 2,
    action: 'agent_team.route_approval',
    reason: input.decision.reason,
    scope: {
      teamId: input.team.id,
      runId: input.state.runId,
      stepId: input.step.id,
      judgeRoleId: input.judge.id,
      candidateRoleIds: input.route.candidateRoleIds,
      targetRoleId: input.targetRoleId,
    },
    risk: 'high',
    rollback: 'Reject approval to stop this run before executing the selected route role.',
    artifactsPreview: Object.fromEntries(Object.entries(input.state.artifacts).map(([key, value]) => [key, value.slice(0, 1000)])),
    traceId: input.state.traceId,
  };
  return {
    approvalId,
    runId: input.state.runId,
    traceId: input.state.traceId,
    stepId: input.step.id,
    requestedBy: input.judge.id,
    reason: input.decision.reason,
    confidence: input.decision.confidence,
    targetRoleId: input.targetRoleId,
    candidateRoleIds: input.route.candidateRoleIds,
    riskLevel: 'high',
    payload,
  };
}

async function handleWorkflowFailure(
  team: AgentTeam,
  input: AgentTeamExecutionInput,
  runner: AgentTeamRoleRunner,
  step: AgentTeamWorkflowStep,
  result: AgentTeamRoleResult,
  roleResults: AgentTeamRoleResult[],
  events: AgentTeamExecutionEvent[],
  state: ExecutionState,
): Promise<{ status: 'success' | 'error'; error?: string }> {
  const failed = result.status === 'error' || isStructuredFailure(result.result);
  if (!failed) return { status: 'success' };
  const policy = step.onFailure;
  if (!policy || policy.action === 'abort') return { status: 'error', error: result.error || result.result };
  if (policy.action === 'continue') return { status: 'success' };
  const iterations = Math.max(1, Math.min(policy.maxIterations ?? input.maxFeedbackIterations ?? 1, 5));
  for (let index = 0; index < iterations; index += 1) {
    const targetRoleId = policy.action === 'retry' ? result.roleId : policy.targetRoleId;
    if (!targetRoleId) return { status: 'error', error: `step ${step.id} failure policy missing targetRoleId` };
    const target = team.roles.find((role) => role.id === targetRoleId);
    if (!target) return { status: 'error', error: `failure target role ${targetRoleId} not found` };
    emitBus(state, {
      stepId: step.id,
      from: 'orchestrator',
      to: target.id,
      kind: 'control',
      type: 'failure.recover',
      payload: { sourceRoleId: result.roleId, policy, iteration: index + 1, failure: result.result },
    });
    events.push({ kind: 'feedback', fromRoleId: result.roleId, toRoleId: target.id, label: policy.instructions ?? 'workflow onFailure' });
    const recovery = await runRole(
      team,
      target,
      input.prompt,
      policy.phase ?? 'revise',
      roleResults,
      runner,
      result.result,
      state,
      { stepId: step.id, instructions: policy.instructions, outputKey: `${step.id}.${target.id}.recovery.${index + 1}` },
    );
    roleResults.push(recovery);
    events.push({ kind: 'role', roleId: target.id, phase: recovery.phase });
    if (recovery.status === 'success' && !isStructuredFailure(recovery.result)) return { status: 'success' };
  }
  return { status: 'error', error: result.error || result.result };
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
    const phase = index === team.roles.length - 1 ? 'finalize' : 'work';
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
    if (isStructuredFailure(result.result)) {
      if (feedbackUsed >= maxFeedbackIterations) {
        return summarize(team, 'error', roleResults, events, state, result.result);
      }
      const target = team.roles[index - 1];
      if (!target) {
        return summarize(team, 'error', roleResults, events, state, result.result);
      }
      feedbackUsed += 1;
      events.push({
        kind: 'feedback',
        fromRoleId: role.id,
        toRoleId: target.id,
        label: result.result,
      });
      const recovery = await runRole(
        team,
        target,
        input.prompt,
        'work',
        roleResults,
        runner,
        result.result,
        state,
      );
      roleResults.push(recovery);
      events.push({ kind: 'role', roleId: target.id, phase: recovery.phase });
      if (recovery.status === 'error') {
        return summarize(team, 'error', roleResults, events, state, recovery.error || recovery.result);
      }
      const retry = await runRole(
        team,
        role,
        input.prompt,
        phase,
        roleResults,
        runner,
        recovery.result,
        state,
      );
      roleResults.push(retry);
      events.push({ kind: 'role', roleId: role.id, phase: retry.phase });
      if (retry.status === 'error' || isStructuredFailure(retry.result)) {
        return summarize(team, 'error', roleResults, events, state, retry.error || retry.result);
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
      'work',
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
  options: { stepId?: string; instructions?: string; outputKey?: string } = {},
  artifacts?: Record<string, string>,
): Promise<AgentTeamRoleResult> {
  const taskId = state ? `${state.runId}:${role.id}:${phase}` : undefined;
  if (state) {
    emitBus(state, {
      stepId: options.stepId,
      from: 'orchestrator',
      to: role.id,
      kind: 'control',
      type: 'role.start',
      payload: { roleId: role.id, roleName: role.name, phase, instructions: options.instructions },
    });
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
    instructions: options.instructions,
    busMessages: state?.busMessages,
    artifacts: artifacts ?? state?.artifacts,
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
  if (state) {
    const outputKey = options.outputKey || `${role.id}.${phase}.output`;
    state.artifacts[outputKey] = output.result ?? '';
    emitBus(state, {
      stepId: options.stepId,
      from: role.id,
      kind: 'artifact',
      type: 'role.output',
      payload: { roleId: role.id, phase, outputKey, status: output.status, result: output.result ?? '', error: output.error },
    });
  }
  return {
    roleId: role.id,
    roleName: role.name,
    phase,
    status: output.status === 'success' ? 'success' : 'error',
    result: output.result ?? '',
    outputKey: options.outputKey || `${role.id}.${phase}.output`,
    error: output.error,
  };
}

function summarize(
  team: AgentTeam,
  status: 'success' | 'error' | 'waiting_approval',
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
    type: status === 'success' ? 'workflow.completed' : status === 'waiting_approval' ? 'workflow.waiting_approval' : 'workflow.failed',
    payload: { teamId: team.id, status, error },
  });
  state.lastError = error ?? state.lastError;
  return {
    status,
    finalResult,
    roleResults,
    events,
    runId: state.runId,
    traceId: state.traceId,
    traceEvents: state.traceEvents,
    busMessages: state.busMessages,
    waitingApproval: state.waitingApproval,
    checkpoint: createRuntimeCheckpoint(state, status),
    error,
  };
}

function createRuntimeCheckpoint(
  state: ExecutionState,
  status: AgentTeamWorkflowRuntimeStatus,
): AgentTeamRuntimeCheckpoint {
  return {
    schemaVersion: 2,
    runId: state.runId,
    traceId: state.traceId,
    workflowNode: state.workflowNode ?? 'workflow',
    status,
    stepStatuses: state.stepStatuses,
    artifacts: state.artifacts,
    waitingApproval: state.waitingApproval,
    busMessageSeq: state.busMessages.length,
    spanSeq: state.spanSeq,
    messageSeq: state.messageSeq,
    lastError: state.lastError ?? null,
    updatedAt: new Date().toISOString(),
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
    busMessages: [],
    artifacts: {},
    stepStatuses: {},
    lastError: null,
    spanSeq: 0,
    messageSeq: 0,
  };
}

function emitBus(
  state: ExecutionState,
  message: Omit<AgentTeamBusMessage, 'id' | 'runId' | 'timestamp'>,
): void {
  state.messageSeq += 1;
  const busMessage: AgentTeamBusMessage = {
    id: `${state.runId}:msg_${state.messageSeq}`,
    runId: state.runId,
    timestamp: new Date().toISOString(),
    ...message,
  };
  state.busMessages.push(busMessage);
  emitTrace(state, {
    actor: message.from,
    type: `bus.${message.type}`,
    taskId: message.stepId,
    payload: busMessage,
  });
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
  if (team.roles.some((role) => role.parallelGroup)) return 'parallel';
  return 'pipeline';
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

function isStructuredFailure(result: string): boolean {
  const jsonText = extractJsonObject(result);
  if (!jsonText) return isPlainTextFailure(result);
  try {
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    const status = String(parsed.status ?? parsed.resultStatus ?? '').toLowerCase();
    if (['failed', 'rejected', 'needs_revision', 'blocked'].includes(status)) return true;
    if (parsed.success === false || parsed.ok === false) return true;
    return false;
  } catch {
    return isPlainTextFailure(result);
  }
}

function isPlainTextFailure(result: string): boolean {
  const normalized = result.trim().toLowerCase();
  if (!normalized) return false;
  return (
    /^fail(?:ed|ure)?\b/.test(normalized) ||
    normalized.includes('needs revision') ||
    normalized.includes('need revision') ||
    normalized.includes('需要返工') ||
    normalized.includes('测试不通过') ||
    normalized.includes('不通过')
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
