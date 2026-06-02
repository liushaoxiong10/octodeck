import { Hono } from 'hono';
import { z } from 'zod';
import type { ChildProcess } from 'child_process';
import crypto from 'crypto';

import type { Variables } from '../web-context.js';
import { authMiddleware, systemConfigMiddleware } from '../middleware/auth.js';
import { getBackend } from '../backends/registry.js';
import { getSystemSettings } from '../runtime-config.js';
import type { AuthUser } from '../types.js';
import {
  buildAgentTeamGenerationPrompt,
  buildAgentTeamDraft,
  createAgentMdDefinition,
  createAgentTeam,
  deleteAgentMdDefinition,
  deleteAgentTeam,
  getAgentMdDefinition,
  getAgentTeam,
  isAbstractAgentTeamDefinition,
  listAgentMdDefinitions,
  listAgentMdSummaries,
  listAgentTeams,
  updateAgentMdDefinition,
  updateAgentTeam,
  type AgentTeam,
  type AgentTeamGenerationResult,
  type AgentTeamShape,
} from '../agent-teams.js';
import type { AgentMdDefinitionInput, AgentTeamInput } from '../agent-teams.js';
import { executeAgentTeam } from '../agent-team-engine.js';
import type { AgentTeamRoleResult, AgentTeamExecutionPhase, AgentTeamTraceEvent } from '../agent-team-engine.js';
import type { RegisteredGroup } from '../types.js';
import {
  getAgentTeamApproval,
  getAgentTeamRun,
  listAgentTeamRuns,
  listAgentTeamApprovals,
  listAgentTeamBlackboard,
  listAgentTeamCheckpoints,
  listAgentTeamTasks,
  listAgentTeamTraceEvents,
  recordAgentTeamApproval,
  recordAgentTeamBlackboard,
  recordAgentTeamCheckpoint,
  recordAgentTeamRun,
  recordAgentTeamTask,
  recordAgentTeamTraceEvent,
} from '../db.js';

const router = new Hono<{ Variables: Variables }>();
const AGENT_TEAM_GENERATION_TIMEOUT_MS = 600_000;

const ShapeSchema = z.enum(['auto', 'pipeline', 'parallel', 'leader-worker', 'judge-route']);
const PermissionLevelSchema = z.enum(['L0', 'L1', 'L2', 'L3', 'L4', 'L5']);
const WorkspacePolicySchema = z.enum(['none', 'read-only', 'sandbox', 'worktree', 'device']);

const RoleSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  responsibility: z.string().min(1).max(2000),
  parallelGroup: z.string().min(1).max(64).optional(),
  inputs: z.array(z.string().max(500)).max(12).optional(),
  outputs: z.array(z.string().max(500)).max(12).optional(),
  skills: z.array(z.string().max(500)).max(12).optional(),
  guardrails: z.array(z.string().max(500)).max(12).optional(),
  policy: z.object({
    permissionLevel: PermissionLevelSchema.optional(),
    workspacePolicy: WorkspacePolicySchema.optional(),
    requiresApproval: z.boolean().optional(),
  }).optional(),
  budget: z.object({
    maxDurationMs: z.number().int().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
    maxOutputBytes: z.number().int().positive().optional(),
  }).optional(),
});

const TeamInputSchema = z.object({
  name: z.string().min(1).max(160),
  goal: z.string().min(1).max(6000),
  shape: ShapeSchema,
  description: z.string().min(1).max(4000),
  roles: z.array(RoleSchema).min(1).max(12),
  workflow: z.string().min(1).max(6000),
  successCriteria: z.array(z.string().min(1).max(1000)).min(1).max(12),
  createdByAgentId: z.string().min(1).max(128),
});

const TeamPatchSchema = TeamInputSchema.partial();

const AgentMdInputSchema = z.object({
  name: z.string().min(1).max(160),
  summary: z.string().min(1).max(1000),
  content: z.string().min(1).max(30000),
  createdByAgentId: z.string().min(1).max(128),
});

const AgentMdPatchSchema = AgentMdInputSchema.partial();
const GeneratedAgentMdInputSchema = AgentMdInputSchema.omit({ createdByAgentId: true });
const GeneratedTeamSchema = z.union([
  TeamInputSchema,
  z.object({
    team: TeamInputSchema,
    agentMdDefinitionsToCreate: z.array(GeneratedAgentMdInputSchema).max(12).optional(),
  }),
]);

const GenerateSchema = z.object({
  generatorAgentId: z.string().min(1).max(128),
  goal: z.string().min(1).max(6000),
  shape: ShapeSchema.default('auto'),
});

const ExecuteSchema = z.object({
  prompt: z.string().min(1).max(10000),
  runnerAgentId: z.string().min(1).max(128).optional(),
  roleAssignments: z.record(z.string().min(1).max(64), z.object({
    runnerAgentId: z.string().min(1).max(128),
    linkId: z.string().min(1).max(128).optional(),
    agentClientId: z.string().min(1).max(128).optional(),
  })).optional(),
  maxFeedbackIterations: z.number().int().min(0).max(5).optional(),
});
type ExecuteRequest = z.infer<typeof ExecuteSchema>;

const ApprovalDecisionSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
});

const AgentTeamToolSchema = z.object({
  userId: z.string().min(1),
  operation: z.enum(['list_teams', 'get_team', 'run_team', 'get_run', 'decide_approval', 'cancel_run']),
  teamId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  approvalId: z.string().min(1).optional(),
  prompt: z.string().min(1).max(10000).optional(),
  runnerAgentId: z.string().min(1).max(128).optional(),
  roleAssignments: ExecuteSchema.shape.roleAssignments,
  maxFeedbackIterations: z.number().int().min(0).max(5).optional(),
  decision: z.enum(['approved', 'rejected']).optional(),
});

router.get('/', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  return c.json({ teams: listAgentTeams(user.id) });
});

router.post('/tool', async (c) => handleAgentTeamToolRequest(c));

router.post('/', authMiddleware, systemConfigMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));
  const parsed = TeamInputSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message || 'invalid team' }, 400);
  }
  if (!isAbstractAgentTeamDefinition(parsed.data)) {
    return c.json({ error: 'team must not bind concrete agent cli, provider, device, model, command or path' }, 400);
  }
  return c.json(createAgentTeam(parsed.data, user.id), 201);
});

router.post('/generate', authMiddleware, systemConfigMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));
  const parsed = GenerateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message || 'invalid generation request' }, 400);
  }
  const settings = getSystemSettings();
  if (!settings.allowedBackends.includes(parsed.data.generatorAgentId)) {
    return c.json({ error: 'generator agent is not in allowedBackends' }, 403);
  }
  const requestedBackend = getBackend(parsed.data.generatorAgentId);
  if (requestedBackend && !requestedBackend.supportsExecutionMode('host')) {
    return c.json({ error: 'generator agent does not support host execution mode' }, 400);
  }
  const fallback = buildAgentTeamDraft({
    generatorAgentId: parsed.data.generatorAgentId,
    goal: parsed.data.goal,
    shape: parsed.data.shape as AgentTeamShape,
  });
  const generated = await generateDraftWithAgent(parsed.data.generatorAgentId, fallback, user.id).catch(() => null);
  if (!generated) {
    return c.json({ error: 'agent team generator did not return a valid team definition' }, 502);
  }
  const createdAgentMdDefinitions = generated.agentMdDefinitionsToCreate.map((definition) => createAgentMdDefinition({
    ...definition,
    createdByAgentId: parsed.data.generatorAgentId,
  }, user.id));
  const team = createAgentTeam(generated.draft, user.id);
  return c.json({ team, agentMdDefinitions: createdAgentMdDefinitions }, 201);
});

router.get('/agent-md', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  return c.json({ definitions: listAgentMdDefinitions(user.id) });
});

router.post('/agent-md', authMiddleware, systemConfigMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));
  const parsed = AgentMdInputSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message || 'invalid agent.md definition' }, 400);
  }
  return c.json({ definition: createAgentMdDefinition(parsed.data, user.id) }, 201);
});

router.get('/agent-md-summaries', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  return c.json({ summaries: listAgentMdSummaries(user.id) });
});

router.get('/agent-md/:id', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const definition = getAgentMdDefinition(c.req.param('id'), user.id);
  if (!definition) return c.json({ error: 'agent.md definition not found' }, 404);
  return c.json({ definition });
});

router.patch('/agent-md/:id', authMiddleware, systemConfigMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));
  const parsed = AgentMdPatchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message || 'invalid agent.md patch' }, 400);
  }
  const definition = updateAgentMdDefinition(c.req.param('id'), parsed.data, user.id);
  if (!definition) return c.json({ error: 'agent.md definition not found' }, 404);
  return c.json({ definition });
});

router.delete('/agent-md/:id', authMiddleware, systemConfigMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const deleted = deleteAgentMdDefinition(c.req.param('id'), user.id);
  if (!deleted) return c.json({ error: 'agent.md definition not found' }, 404);
  return c.json({ ok: true });
});

router.get('/runs', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const status = c.req.query('status')?.trim();
  const allowedStatuses = new Set(['running', 'waiting_approval', 'paused', 'success', 'error', 'cancelled']);
  if (status && !allowedStatuses.has(status)) return c.json({ error: 'invalid run status' }, 400);
  const limitValue = Number(c.req.query('limit') ?? 50);
  const limit = Number.isFinite(limitValue) ? limitValue : 50;
  return c.json({
    runs: listAgentTeamRuns({
      userId: user.id,
      teamId: c.req.query('teamId')?.trim() || undefined,
      status: status || undefined,
      limit,
    }),
  });
});

router.get('/:id', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const team = getAgentTeam(c.req.param('id'), user.id);
  if (!team) return c.json({ error: 'team not found' }, 404);
  return c.json({ team });
});

router.get('/runs/:runId', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const run = getAgentTeamRun(c.req.param('runId'), user.id);
  if (!run) return c.json({ error: 'agent team run not found' }, 404);
  return c.json({ run });
});

router.get('/runs/:runId/tasks', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const run = getAgentTeamRun(c.req.param('runId'), user.id);
  if (!run) return c.json({ error: 'agent team run not found' }, 404);
  return c.json({ tasks: listAgentTeamTasks(run.id) });
});

router.get('/runs/:runId/events', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const run = getAgentTeamRun(c.req.param('runId'), user.id);
  if (!run) return c.json({ error: 'agent team run not found' }, 404);
  return c.json({ events: listAgentTeamTraceEvents(run.id) });
});

router.get('/runs/:runId/blackboard', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const run = getAgentTeamRun(c.req.param('runId'), user.id);
  if (!run) return c.json({ error: 'agent team run not found' }, 404);
  return c.json({ entries: listAgentTeamBlackboard(run.id) });
});

router.get('/runs/:runId/approvals', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const run = getAgentTeamRun(c.req.param('runId'), user.id);
  if (!run) return c.json({ error: 'agent team run not found' }, 404);
  return c.json({ approvals: listAgentTeamApprovals(run.id) });
});

router.get('/runs/:runId/checkpoints', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const run = getAgentTeamRun(c.req.param('runId'), user.id);
  if (!run) return c.json({ error: 'agent team run not found' }, 404);
  return c.json({ checkpoints: listAgentTeamCheckpoints(run.id) });
});

router.post('/runs/:runId/cancel', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const run = getAgentTeamRun(c.req.param('runId'), user.id);
  if (!run) return c.json({ error: 'agent team run not found' }, 404);
  recordAgentTeamRun({
    id: run.id,
    teamId: run.teamId,
    userId: run.userId,
    prompt: run.prompt,
    status: 'cancelled',
    traceId: run.traceId,
    workflowShape: run.workflowShape,
    roleAssignments: run.roleAssignments,
    finalResult: run.finalResult,
    error: 'cancelled by user',
    completedAt: new Date().toISOString(),
  });
  return c.json({ run: getAgentTeamRun(run.id, user.id) });
});

router.post('/runs/:runId/approvals/:approvalId', authMiddleware, systemConfigMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const run = getAgentTeamRun(c.req.param('runId'), user.id);
  if (!run) return c.json({ error: 'agent team run not found' }, 404);
  const approval = getAgentTeamApproval(c.req.param('approvalId'), run.id);
  if (!approval) return c.json({ error: 'agent team approval not found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const parsed = ApprovalDecisionSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message || 'invalid approval decision' }, 400);
  recordAgentTeamApproval({
    id: String(approval.id),
    runId: run.id,
    taskId: typeof approval.taskId === 'string' ? approval.taskId : undefined,
    requestedBy: String(approval.requestedBy),
    status: parsed.data.decision,
    riskLevel: String(approval.riskLevel),
    title: String(approval.title),
    description: String(approval.description),
    payload: approval.payload,
    resolvedBy: user.id,
    resolvedAt: new Date().toISOString(),
    createdAt: String(approval.createdAt),
  });
  if (parsed.data.decision === 'rejected') {
    recordAgentTeamRun({
      id: run.id,
      teamId: run.teamId,
      userId: run.userId,
      prompt: run.prompt,
      status: 'cancelled',
      traceId: run.traceId,
      workflowShape: run.workflowShape,
      roleAssignments: run.roleAssignments,
      error: 'approval rejected',
      completedAt: new Date().toISOString(),
    });
    return c.json({ run: getAgentTeamRun(run.id, user.id), approval: getAgentTeamApproval(String(approval.id), run.id) });
  }
  const result = await executeExistingRun(c, run.id, { bypassApproval: true });
  if ('response' in result) return result.response;
  return c.json({ run: getAgentTeamRun(run.id, user.id), approval: getAgentTeamApproval(String(approval.id), run.id), execution: result.execution });
});

router.post('/:id/runs', authMiddleware, systemConfigMiddleware, async (c) => {
  const result = await executeTeamRequest(c, c.req.param('id'));
  if ('response' in result) return result.response;
  return c.json({ run: getAgentTeamRun(result.execution.runId || '', (c.get('user') as AuthUser).id), execution: result.execution }, result.execution.status === 'success' ? 201 : 502);
});

router.post('/:id/execute', authMiddleware, systemConfigMiddleware, async (c) => {
  const result = await executeTeamRequest(c, c.req.param('id'));
  if ('response' in result) return result.response;
  return c.json({ execution: result.execution }, result.execution.status === 'success' ? 200 : 502);
});

async function executeTeamRequest(c: any, teamId: string): Promise<{ execution: Awaited<ReturnType<typeof executeAgentTeam>> } | { response: Response }> {
  const user = c.get('user') as AuthUser;
  const team = getAgentTeam(teamId, user.id);
  if (!team) return { response: c.json({ error: 'team not found' }, 404) };
  const body = await c.req.json().catch(() => ({}));
  const parsed = ExecuteSchema.safeParse(body);
  if (!parsed.success) {
    return { response: c.json({ error: parsed.error.issues[0]?.message || 'invalid execution request' }, 400) };
  }
  const settings = getSystemSettings();
  const runnerAgentId = parsed.data.runnerAgentId ?? team.createdByAgentId;
  if (!settings.allowedBackends.includes(runnerAgentId)) {
    return { response: c.json({ error: 'team runner agent is not in allowedBackends' }, 403) };
  }
  const backend = getBackend(runnerAgentId);
  if (!backend) return { response: c.json({ error: 'team runner backend not found' }, 404) };
  if (!backend.supportsExecutionMode('host')) {
    return { response: c.json({ error: 'team runner agent does not support host execution mode' }, 400) };
  }
  const runId = `team_run_${crypto.randomBytes(8).toString('hex')}`;
  const traceId = `team_trace_${crypto.randomBytes(8).toString('hex')}`;
  const approvalRole = findApprovalRequiredRole(team);
  if (approvalRole) {
    recordAgentTeamRun({
      id: runId,
      teamId: team.id,
      userId: user.id,
      prompt: parsed.data.prompt,
      status: 'waiting_approval',
      traceId,
      workflowShape: team.shape,
      roleAssignments: parsed.data.roleAssignments ?? {},
    });
    const checkpoint = createApprovalCheckpoint({
      runId,
      team,
      role: approvalRole,
      prompt: parsed.data.prompt,
      runnerAgentId,
      roleAssignments: parsed.data.roleAssignments ?? {},
      maxFeedbackIterations: parsed.data.maxFeedbackIterations,
    });
    const approval = createApprovalRequest({
      runId,
      user,
      team,
      role: approvalRole,
      prompt: parsed.data.prompt,
      runnerAgentId,
      roleAssignments: parsed.data.roleAssignments ?? {},
    });
    return {
      response: c.json({
        run: getAgentTeamRun(runId, user.id),
        approval: getAgentTeamApproval(approval.id, runId),
        checkpoint,
      }, 202),
    };
  }
  return executePreparedRun(c, {
    team,
    user,
    runId,
    traceId,
    prompt: parsed.data.prompt,
    runnerAgentId,
    roleAssignments: parsed.data.roleAssignments ?? {},
    maxFeedbackIterations: parsed.data.maxFeedbackIterations,
    defaultBackend: backend,
  });
}

export async function handleAgentTeamToolRequest(c: any): Promise<Response> {
  const secret = process.env.OCTODECK_AGENT_RUNNER_SECRET;
  const auth = c.req.header('authorization') || '';
  if (!secret || auth !== `Bearer ${secret}`) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json().catch(() => ({}));
  return handleAgentTeamToolBody(c, body);
}

export async function handleAgentTeamLinkToolRequest(c: any, userId: string, body: unknown): Promise<Response> {
  return handleAgentTeamToolBody(c, { ...(isRecord(body) ? body : {}), userId });
}

async function handleAgentTeamToolBody(c: any, body: unknown): Promise<Response> {
  const parsed = AgentTeamToolSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message || 'invalid agent team tool request' }, 400);
  const user: AuthUser = {
    id: parsed.data.userId,
    username: parsed.data.userId,
    role: 'admin',
    status: 'active',
    display_name: parsed.data.userId,
    permissions: ['manage_system_config'],
    must_change_password: false,
  };
  const toolContext = createInternalToolContext(c, user, parsed.data);

  switch (parsed.data.operation) {
    case 'list_teams':
      return c.json({ teams: listAgentTeams(user.id) });
    case 'get_team': {
      if (!parsed.data.teamId) return c.json({ error: 'teamId is required' }, 400);
      const team = getAgentTeam(parsed.data.teamId, user.id);
      if (!team) return c.json({ error: 'team not found' }, 404);
      return c.json({ team });
    }
    case 'run_team': {
      if (!parsed.data.teamId || !parsed.data.prompt) return c.json({ error: 'teamId and prompt are required' }, 400);
      const result = await executeTeamRequest(toolContext, parsed.data.teamId);
      if ('response' in result) return result.response;
      return c.json({ run: getAgentTeamRun(result.execution.runId || '', user.id), execution: result.execution }, result.execution.status === 'success' ? 201 : 502);
    }
    case 'get_run': {
      if (!parsed.data.runId) return c.json({ error: 'runId is required' }, 400);
      const run = getAgentTeamRun(parsed.data.runId, user.id);
      if (!run) return c.json({ error: 'agent team run not found' }, 404);
      return c.json({
        run,
        tasks: listAgentTeamTasks(run.id),
        events: listAgentTeamTraceEvents(run.id),
        blackboard: listAgentTeamBlackboard(run.id),
        approvals: listAgentTeamApprovals(run.id),
        checkpoints: listAgentTeamCheckpoints(run.id),
      });
    }
    case 'decide_approval': {
      if (!parsed.data.runId || !parsed.data.approvalId || !parsed.data.decision) return c.json({ error: 'runId, approvalId and decision are required' }, 400);
      const run = getAgentTeamRun(parsed.data.runId, user.id);
      if (!run) return c.json({ error: 'agent team run not found' }, 404);
      const approval = getAgentTeamApproval(parsed.data.approvalId, run.id);
      if (!approval) return c.json({ error: 'agent team approval not found' }, 404);
      recordAgentTeamApproval({
        id: String(approval.id),
        runId: run.id,
        taskId: typeof approval.taskId === 'string' ? approval.taskId : undefined,
        requestedBy: String(approval.requestedBy),
        status: parsed.data.decision,
        riskLevel: String(approval.riskLevel),
        title: String(approval.title),
        description: String(approval.description),
        payload: approval.payload,
        resolvedBy: user.id,
        resolvedAt: new Date().toISOString(),
        createdAt: String(approval.createdAt),
      });
      if (parsed.data.decision === 'rejected') {
        recordAgentTeamRun({
          id: run.id,
          teamId: run.teamId,
          userId: run.userId,
          prompt: run.prompt,
          status: 'cancelled',
          traceId: run.traceId,
          workflowShape: run.workflowShape,
          roleAssignments: run.roleAssignments,
          error: 'approval rejected',
          completedAt: new Date().toISOString(),
        });
        return c.json({ run: getAgentTeamRun(run.id, user.id), approval: getAgentTeamApproval(String(approval.id), run.id) });
      }
      const result = await executeExistingRun(toolContext, run.id, { bypassApproval: true });
      if ('response' in result) return result.response;
      return c.json({ run: getAgentTeamRun(run.id, user.id), approval: getAgentTeamApproval(String(approval.id), run.id), execution: result.execution });
    }
    case 'cancel_run': {
      if (!parsed.data.runId) return c.json({ error: 'runId is required' }, 400);
      const run = getAgentTeamRun(parsed.data.runId, user.id);
      if (!run) return c.json({ error: 'agent team run not found' }, 404);
      recordAgentTeamRun({
        id: run.id,
        teamId: run.teamId,
        userId: run.userId,
        prompt: run.prompt,
        status: 'cancelled',
        traceId: run.traceId,
        workflowShape: run.workflowShape,
        roleAssignments: run.roleAssignments,
        finalResult: run.finalResult,
        error: 'cancelled by agent team MCP tool',
        completedAt: new Date().toISOString(),
      });
      return c.json({ run: getAgentTeamRun(run.id, user.id) });
    }
  }
}

function createInternalToolContext(parent: any, user: AuthUser, data: z.infer<typeof AgentTeamToolSchema>) {
  return {
    ...parent,
    get: (key: string) => key === 'user' ? user : parent.get?.(key),
    req: {
      ...parent.req,
      json: async () => ({
        prompt: data.prompt,
        runnerAgentId: data.runnerAgentId,
        roleAssignments: data.roleAssignments,
        maxFeedbackIterations: data.maxFeedbackIterations,
      }),
    },
  };
}

async function executeExistingRun(c: any, runId: string, options: { bypassApproval?: boolean } = {}): Promise<{ execution: Awaited<ReturnType<typeof executeAgentTeam>> } | { response: Response }> {
  const user = c.get('user') as AuthUser;
  const run = getAgentTeamRun(runId, user.id);
  if (!run) return { response: c.json({ error: 'agent team run not found' }, 404) };
  if (run.status === 'cancelled') return { response: c.json({ error: 'agent team run is cancelled' }, 409) };
  const team = getAgentTeam(run.teamId, user.id);
  if (!team) return { response: c.json({ error: 'team not found' }, 404) };
  const state = getLatestApprovalCheckpointState(run.id);
  if (!options.bypassApproval && findApprovalRequiredRole(team)) {
    return { response: c.json({ error: 'agent team run is waiting for approval' }, 409) };
  }
  const runnerAgentId = typeof state.runnerAgentId === 'string' ? state.runnerAgentId : team.createdByAgentId;
  const roleAssignments = isRecord(state.roleAssignments) ? state.roleAssignments as ExecuteRequest['roleAssignments'] : run.roleAssignments as ExecuteRequest['roleAssignments'];
  const maxFeedbackIterations = typeof state.maxFeedbackIterations === 'number' ? state.maxFeedbackIterations : undefined;
  const settings = getSystemSettings();
  if (!settings.allowedBackends.includes(runnerAgentId)) {
    return { response: c.json({ error: 'team runner agent is not in allowedBackends' }, 403) };
  }
  const backend = getBackend(runnerAgentId);
  if (!backend) return { response: c.json({ error: 'team runner backend not found' }, 404) };
  if (!backend.supportsExecutionMode('host')) {
    return { response: c.json({ error: 'team runner agent does not support host execution mode' }, 400) };
  }
  return executePreparedRun(c, {
    team,
    user,
    runId: run.id,
    traceId: run.traceId,
    prompt: run.prompt,
    runnerAgentId,
    roleAssignments: roleAssignments ?? {},
    maxFeedbackIterations,
    defaultBackend: backend,
  });
}

async function executePreparedRun(
  c: any,
  config: {
    team: AgentTeam;
    user: AuthUser;
    runId: string;
    traceId: string;
    prompt: string;
    runnerAgentId: string;
    roleAssignments: ExecuteRequest['roleAssignments'];
    maxFeedbackIterations?: number;
    defaultBackend: NonNullable<ReturnType<typeof getBackend>>;
  },
): Promise<{ execution: Awaited<ReturnType<typeof executeAgentTeam>> } | { response: Response }> {
  const { team, user, runId, traceId, prompt, runnerAgentId, roleAssignments, maxFeedbackIterations, defaultBackend } = config;
  const settings = getSystemSettings();
  recordAgentTeamRun({
    id: runId,
    teamId: team.id,
    userId: user.id,
    prompt,
    status: 'running',
    traceId,
    workflowShape: team.shape,
    roleAssignments: roleAssignments ?? {},
  });
  const execution = await executeAgentTeam(team, {
    prompt,
    maxFeedbackIterations,
    runId,
    traceId,
    sessionId: `system:agent-team:${team.id}`,
  }, async ({ role, prompt, phase, previousResults, feedback }) => {
    const assignment = roleAssignments?.[role.id];
    const roleRunnerAgentId = assignment?.runnerAgentId ?? runnerAgentId;
    if (!settings.allowedBackends.includes(roleRunnerAgentId)) {
      return { status: 'error', result: '', error: `role runner ${roleRunnerAgentId} is not in allowedBackends` };
    }
    const roleBackend = roleRunnerAgentId === runnerAgentId ? defaultBackend : getBackend(roleRunnerAgentId);
    if (!roleBackend) return { status: 'error', result: '', error: `role runner backend ${roleRunnerAgentId} not found` };
    if (!roleBackend.supportsExecutionMode('host')) return { status: 'error', result: '', error: `role runner ${roleRunnerAgentId} does not support host execution mode` };
    const rolePrompt = buildAgentTeamRolePrompt(team, role, prompt, phase, previousResults, feedback);
    const taskId = `${runId}:${role.id}:${phase}`;
    recordAgentTeamTask({
      id: taskId,
      runId,
      roleId: role.id,
      phase,
      actorId: roleRunnerAgentId,
      status: 'running',
      input: rolePrompt,
    });
    const output = await roleBackend.run({
      group: {
        name: `Agent Team ${team.name}`,
        folder: `agent-team-${team.id}-${role.id}`,
        added_at: new Date().toISOString(),
        containerConfig: { timeout: AGENT_TEAM_GENERATION_TIMEOUT_MS },
        executionMode: 'host',
        backend: roleRunnerAgentId,
        created_by: user.id,
      },
      executionMode: 'host',
      input: {
        prompt: rolePrompt,
        groupFolder: `agent-team-${team.id}-${role.id}`,
        chatJid: `system:agent-team:${team.id}`,
        isMain: false,
        isHome: false,
        isAdminHome: false,
        executionProfile: 'single-turn-json',
      },
      onProcess: () => undefined,
    });
    recordAgentTeamTask({
      id: taskId,
      runId,
      roleId: role.id,
      phase,
      actorId: roleRunnerAgentId,
      status: output.status === 'success' ? 'success' : 'error',
      output: output.result ?? undefined,
      error: output.error ?? undefined,
      completedAt: new Date().toISOString(),
    });
    if (output.status === 'success') {
      recordAgentTeamBlackboard({
        id: `${taskId}:output`,
        runId,
        taskId,
        roleId: role.id,
        kind: 'role_output',
        key: `${role.id}.${phase}.output`,
        contentType: 'text/markdown',
        value: output.result ?? '',
      });
    }
    return output;
  });
  for (const event of execution.traceEvents ?? []) {
    recordAgentTeamTraceEvent(toTraceEventRecord(event));
  }
  recordAgentTeamRun({
    id: runId,
    teamId: team.id,
    userId: user.id,
    prompt,
    status: execution.status,
    traceId,
    workflowShape: team.shape,
    roleAssignments: roleAssignments ?? {},
    finalResult: execution.finalResult,
    error: execution.error,
    completedAt: new Date().toISOString(),
  });
  return { execution };
}

const PERMISSION_LEVEL_RANK: Record<string, number> = { L0: 0, L1: 1, L2: 2, L3: 3, L4: 4, L5: 5 };

function findApprovalRequiredRole(team: AgentTeam): AgentTeam['roles'][number] | undefined {
  return team.roles.find((role) => {
    const policy = role.policy;
    if (!policy) return false;
    if (policy.requiresApproval) return true;
    return (PERMISSION_LEVEL_RANK[policy.permissionLevel ?? 'L0'] ?? 0) >= PERMISSION_LEVEL_RANK.L4;
  });
}

function createApprovalCheckpoint(input: {
  runId: string;
  team: AgentTeam;
  role: AgentTeam['roles'][number];
  prompt: string;
  runnerAgentId: string;
  roleAssignments: ExecuteRequest['roleAssignments'];
  maxFeedbackIterations?: number;
}) {
  const checkpoint = {
    id: `${input.runId}:approval:${input.role.id}`,
    runId: input.runId,
    nodeId: `approval:${input.role.id}`,
    state: {
      teamId: input.team.id,
      prompt: input.prompt,
      runnerAgentId: input.runnerAgentId,
      roleAssignments: input.roleAssignments ?? {},
      maxFeedbackIterations: input.maxFeedbackIterations,
      pendingRoleId: input.role.id,
    },
  };
  recordAgentTeamCheckpoint(checkpoint);
  return checkpoint;
}

function createApprovalRequest(input: {
  runId: string;
  user: AuthUser;
  team: AgentTeam;
  role: AgentTeam['roles'][number];
  prompt: string;
  runnerAgentId: string;
  roleAssignments: ExecuteRequest['roleAssignments'];
}) {
  const riskLevel = input.role.policy?.permissionLevel ?? (input.role.policy?.requiresApproval ? 'L4' : 'L0');
  const approval = {
    id: `${input.runId}:approval:${input.role.id}`,
    runId: input.runId,
    requestedBy: input.user.id,
    status: 'pending' as const,
    riskLevel,
    title: `Approve ${input.role.name}`,
    description: `Role ${input.role.name} (${input.role.id}) requires approval before running.`,
    payload: {
      teamId: input.team.id,
      teamName: input.team.name,
      roleId: input.role.id,
      roleName: input.role.name,
      prompt: input.prompt,
      runnerAgentId: input.runnerAgentId,
      roleAssignments: input.roleAssignments ?? {},
      policy: input.role.policy ?? {},
    },
  };
  recordAgentTeamApproval(approval);
  return approval;
}

function getLatestApprovalCheckpointState(runId: string): Record<string, unknown> {
  const checkpoints = listAgentTeamCheckpoints(runId);
  for (let index = checkpoints.length - 1; index >= 0; index -= 1) {
    const checkpoint = checkpoints[index];
    if (typeof checkpoint.nodeId === 'string' && checkpoint.nodeId.startsWith('approval:') && isRecord(checkpoint.state)) {
      return checkpoint.state;
    }
  }
  return {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

router.patch('/:id', authMiddleware, systemConfigMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));
  const parsed = TeamPatchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message || 'invalid patch' }, 400);
  }
  const existing = getAgentTeam(c.req.param('id'), user.id);
  if (!existing) return c.json({ error: 'team not found' }, 404);
  const merged = { ...existing, ...parsed.data };
  if (!isAbstractAgentTeamDefinition(merged)) {
    return c.json({ error: 'team must not bind concrete agent cli, provider, device, model, command or path' }, 400);
  }
  const team = updateAgentTeam(c.req.param('id'), parsed.data, user.id);
  if (!team) return c.json({ error: 'team not found' }, 404);
  return c.json({ team });
});

router.delete('/:id', authMiddleware, systemConfigMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const deleted = deleteAgentTeam(c.req.param('id'), user.id);
  if (!deleted) return c.json({ error: 'team not found' }, 404);
  return c.json({ ok: true });
});

export default router;

async function generateDraftWithAgent(
  generatorAgentId: string,
  fallback: AgentTeamInput,
  ownerUserId: string,
): Promise<AgentTeamGenerationResult> {
  const backend = getBackend(generatorAgentId);
  if (!backend) throw new Error('agent team generator backend not found');

  const prompt = buildAgentTeamGenerationPrompt(fallback, listAgentMdSummaries(ownerUserId));
  let agentTeamGeneratorProc: ChildProcess | null = null;
  let streamText = '';
  let earlyGenerated: AgentTeamGenerationResult | null = null;
  const group: RegisteredGroup = {
    name: 'Agent Team Generator',
    folder: 'agent-team-generator',
    added_at: new Date().toISOString(),
    containerConfig: { timeout: AGENT_TEAM_GENERATION_TIMEOUT_MS },
    executionMode: 'host',
    backend: generatorAgentId,
    created_by: ownerUserId,
  };
  const output = await backend.run({
    group,
    executionMode: 'host',
    input: {
      prompt,
      groupFolder: group.folder,
      chatJid: 'system:agent-team-generator',
      isMain: false,
      isHome: false,
      isAdminHome: false,
      executionProfile: 'single-turn-json',
    },
    onProcess: (proc) => {
      agentTeamGeneratorProc = proc;
    },
    onOutput: async (output) => {
      const text = output.streamEvent?.text;
      if (!text || earlyGenerated) return;
      streamText += text;
      earlyGenerated = parseGeneratedTeam(streamText, fallback);
      if (earlyGenerated && agentTeamGeneratorProc && !agentTeamGeneratorProc.killed) {
        agentTeamGeneratorProc.kill('SIGTERM');
      }
    },
  });

  if (earlyGenerated) return earlyGenerated;
  if (output.status !== 'success' || !output.result) throw new Error(output.error || 'agent team generator failed');
  const generated = parseGeneratedTeam(output.result, fallback);
  if (!generated) throw new Error('agent team generator returned invalid JSON');
  return generated;
}

function parseGeneratedTeam(
  text: string,
  fallback: AgentTeamInput,
): AgentTeamGenerationResult | null {
  const jsonText = extractJsonObject(text);
  if (!jsonText) return null;
  try {
    const parsed = GeneratedTeamSchema.safeParse(JSON.parse(jsonText));
    if (!parsed.success) return null;
    if ('team' in parsed.data) {
      if (!isAbstractAgentTeamDefinition(parsed.data.team)) {
        return null;
      }
      return {
        draft: {
          ...parsed.data.team,
          createdByAgentId: fallback.createdByAgentId,
        },
        agentMdDefinitionsToCreate: parsed.data.agentMdDefinitionsToCreate ?? [],
      };
    }
    if (!isAbstractAgentTeamDefinition(parsed.data)) {
      return null;
    }
    return {
      draft: {
        ...parsed.data,
        createdByAgentId: fallback.createdByAgentId,
      },
      agentMdDefinitionsToCreate: [],
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

function buildAgentTeamRolePrompt(
  team: AgentTeamInput,
  role: AgentTeamInput['roles'][number],
  userPrompt: string,
  phase: AgentTeamExecutionPhase,
  previousResults: AgentTeamRoleResult[],
  feedback?: string,
): string {
  return [
    '你正在作为 Agent Team 中的一个抽象角色执行任务。',
    '请只完成当前角色职责范围内的工作，并输出清晰、可交接的结果。',
    '',
    `Team: ${team.name}`,
    `Goal: ${team.goal}`,
    `Shape: ${team.shape}`,
    `Workflow: ${team.workflow}`,
    '',
    `Current role: ${role.name} (${role.id})`,
    `Responsibility: ${role.responsibility}`,
    role.inputs?.length ? `Inputs: ${role.inputs.join('; ')}` : '',
    role.outputs?.length ? `Expected outputs: ${role.outputs.join('; ')}` : '',
    role.skills?.length ? `Suggested skills/agent.md: ${role.skills.join('; ')}` : '',
    role.guardrails?.length ? `Guardrails: ${role.guardrails.join('; ')}` : '',
    '',
    `Execution phase: ${phase}`,
    feedback ? `Feedback or upstream signal: ${feedback}` : '',
    previousResults.length ? 'Previous role results:' : '',
    ...previousResults.map((result) => `- ${result.roleName} (${result.phase}, ${result.status}): ${result.result}`),
    '',
    `User request: ${userPrompt}`,
    '',
    '输出要求：',
    '- 用中文输出。',
    '- 如果当前角色是测试/QA，请明确写出“测试通过”或“测试不通过”，并说明原因。',
    '- 如果当前角色是 Judge，请用 “route: <role_id>” 指明下一步选择的角色。',
    '- 不要调用工具，不要声明自己无法执行；按角色给出可交付结果。',
  ].filter(Boolean).join('\n');
}

function toTraceEventRecord(event: AgentTeamTraceEvent) {
  return {
    traceId: event.traceId,
    spanId: event.spanId,
    parentSpanId: event.parentSpanId,
    sessionId: event.sessionId,
    runId: event.runId,
    taskId: event.taskId,
    actor: event.actor,
    type: event.type,
    payload: event.payload,
    timestamp: event.timestamp,
    schemaVersion: event.schemaVersion,
  };
}
