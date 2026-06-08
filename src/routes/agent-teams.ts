import { Hono } from 'hono';
import { z } from 'zod';
import type { ChildProcess } from 'child_process';
import crypto from 'crypto';

import type { Variables } from '../web-context.js';
import { authMiddleware, systemConfigMiddleware } from '../middleware/auth.js';
import { AGENT_RUNNER_SECRET, verifyAgentToolToken } from '../config.js';
import { getBackend } from '../backends/registry.js';
import { getSystemSettings } from '../runtime-config.js';
import { getUserById } from '../db.js';
import type { AuthUser } from '../types.js';
import {
  buildAgentTeamGenerationPrompt,
  buildAgentTeamDraft,
  createAgentMdDefinitionFromStore,
  createAgentMdDefinition,
  createAgentTeam,
  deleteAgentMdDefinition,
  deleteAgentTeamWithLinkedAgentMd,
  findAgentMdTeamReferences,
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
import {
  createAgentTeamInputFromTemplate,
  getAgentTeamTemplate,
  listAgentTeamTemplates,
} from '../agent-team-templates.js';
import { executeAgentTeam } from '../agent-team-engine.js';
import { summarizeAgentTeamMetrics } from '../agent-team-metrics.js';
import {
  cancelAgentTeamRun,
  registerAgentTeamTaskCancellation,
  resolveAgentTeamRoleWorkspace,
  validateAgentTeamRoleRuntimeTargets,
} from '../agent-team-runtime-control.js';
import { listCustomBackends } from '../backends/custom-loader.js';
import { parseAgentLinkTarget } from '../backends/agent-link-driver.js';
import { requestWorkspaceCleanup } from '../agent-link/registry.js';
import type {
  AgentTeamRoleResult,
  AgentTeamExecutionPhase,
  AgentTeamTraceEvent,
  AgentTeamRuntimeCheckpoint,
} from '../agent-team-engine.js';
import type { RegisteredGroup } from '../types.js';
import {
  getAgentTeamApproval,
  getAgentTeamArtifact,
  getAgentTeamRun,
  listAgentTeamArtifacts,
  listAgentTeamRunsForMetrics,
  listAgentTeamRuns,
  listAgentTeamApprovals,
  listAgentTeamBlackboard,
  listAgentTeamCheckpoints,
  listAgentTeamTasks,
  listAgentTeamTraceEvents,
  recordAgentTeamApproval,
  recordAgentTeamArtifact,
  recordAgentTeamBlackboard,
  recordAgentTeamCheckpoint,
  recordAgentTeamRun,
  recordAgentTeamTask,
  recordAgentTeamTraceEvent,
} from '../db.js';

const router = new Hono<{ Variables: Variables }>();
const AGENT_TEAM_GENERATION_TIMEOUT_MS = 1_800_000;

type AgentTeamGenerationJobStatus = 'running' | 'success' | 'error';

interface AgentTeamGenerationJob {
  id: string;
  userId: string;
  generatorAgentId: string;
  goal: string;
  shape: AgentTeamShape;
  status: AgentTeamGenerationJobStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  team?: AgentTeam;
  agentMdDefinitions?: ReturnType<typeof createAgentMdDefinition>[];
  error?: string;
}

const agentTeamGenerationJobs = new Map<string, AgentTeamGenerationJob>();

function toPublicGenerationJob(job: AgentTeamGenerationJob): AgentTeamGenerationJob {
  if (job.status !== 'success') return job;
  return {
    ...job,
    agentMdDefinitions: undefined,
  };
}

const ShapeSchema = z.enum([
  'auto',
  'pipeline',
  'parallel',
  'leader-worker',
  'judge-route',
]);
const PermissionLevelSchema = z.enum(['L0', 'L1', 'L2', 'L3', 'L4', 'L5']);
const WorkspacePolicySchema = z.enum([
  'none',
  'read-only',
  'sandbox',
  'worktree',
  'device',
]);

const RoleSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  responsibility: z.string().min(1).max(2000),
  parallelGroup: z.string().min(1).max(64).optional(),
  inputs: z.array(z.string().max(500)).max(12).optional(),
  outputs: z.array(z.string().max(500)).max(12).optional(),
  skills: z.array(z.string().max(500)).max(12).optional(),
  guardrails: z.array(z.string().max(500)).max(12).optional(),
  requiredSkills: z.array(z.string().max(500)).max(12).optional(),
  preferredAgentMd: z.array(z.string().max(500)).max(12).optional(),
  policy: z
    .object({
      permissionLevel: PermissionLevelSchema.optional(),
      workspacePolicy: WorkspacePolicySchema.optional(),
      requiresApproval: z.boolean().optional(),
    })
    .optional(),
  budget: z
    .object({
      maxDurationMs: z.number().int().positive().optional(),
      maxTokens: z.number().int().positive().optional(),
      maxOutputBytes: z.number().int().positive().optional(),
    })
    .optional(),
});

const WorkflowActionSchema = z.object({
  roleId: z.string().min(1).max(64),
  phase: z.string().min(1).max(64).optional(),
  instructions: z.string().max(2000).optional(),
  outputKey: z.string().min(1).max(128).optional(),
});

const WorkflowFailurePolicySchema = z.object({
  action: z.enum(['continue', 'abort', 'run_role', 'retry']),
  targetRoleId: z.string().min(1).max(64).optional(),
  phase: z.string().min(1).max(64).optional(),
  maxIterations: z.number().int().min(1).max(5).optional(),
  instructions: z.string().max(2000).optional(),
});

const WorkflowApprovalPolicySchema = z.object({
  mode: z.enum(['single', 'any_of', 'all_of', 'quorum']),
  approverRoleIds: z.array(z.string().min(1).max(64)).min(1).max(12),
  quorum: z.number().int().min(1).max(12).optional(),
  timeoutMs: z.number().int().positive().optional(),
  onTimeout: z.enum(['reject', 'approve', 'fallback']).optional(),
});

const WorkflowStepSchema = z.object({
  id: z.string().min(1).max(128),
  type: z.enum(['role', 'parallel', 'route', 'verify', 'vote']),
  roleId: z.string().min(1).max(64).optional(),
  phase: z.string().min(1).max(64).optional(),
  instructions: z.string().max(2000).optional(),
  inputKeys: z.array(z.string().max(128)).max(12).optional(),
  outputKey: z.string().min(1).max(128).optional(),
  dependsOn: z.array(z.string().max(128)).max(12).optional(),
  parallel: z
    .array(z.array(WorkflowActionSchema).min(1).max(8))
    .max(8)
    .optional(),
  route: z
    .object({
      judgeRoleId: z.string().min(1).max(64),
      candidateRoleIds: z.array(z.string().min(1).max(64)).min(1).max(12),
      fallbackRoleId: z.string().min(1).max(64).optional(),
      finalRoleId: z.string().min(1).max(64).optional(),
    })
    .optional(),
  verify: z
    .object({
      verifierRoleId: z.string().min(1).max(64),
      subjectKeys: z.array(z.string().min(1).max(128)).min(1).max(12),
      rubric: z.string().max(2000).optional(),
    })
    .optional(),
  vote: z
    .object({
      voterRoleIds: z.array(z.string().min(1).max(64)).min(1).max(12),
      subjectKeys: z.array(z.string().min(1).max(128)).min(1).max(12),
      threshold: z.number().min(0).max(1).optional(),
    })
    .optional(),
  approvalPolicy: WorkflowApprovalPolicySchema.optional(),
  onFailure: WorkflowFailurePolicySchema.optional(),
});

const TeamInputSchema = z.object({
  name: z.string().min(1).max(160),
  goal: z.string().min(1).max(6000),
  shape: ShapeSchema,
  description: z.string().min(1).max(4000),
  roles: z.array(RoleSchema).min(1).max(12),
  workflow: z.string().min(1).max(6000),
  workflowSteps: z.array(WorkflowStepSchema).min(1).max(24).optional(),
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
const AgentMdStoreImportSchema = z.object({
  path: z.string().min(1).max(500),
  createdByAgentId: z.string().min(1).max(128),
});
const GeneratedAgentMdInputSchema = AgentMdInputSchema.omit({
  createdByAgentId: true,
});
const GeneratedTeamSchema = z.union([
  TeamInputSchema,
  z.object({
    team: TeamInputSchema,
    agentMdDefinitionsToCreate: z
      .array(GeneratedAgentMdInputSchema)
      .max(12)
      .optional(),
  }),
]);

const GenerateSchema = z.object({
  generatorAgentId: z.string().min(1).max(128),
  goal: z.string().min(1).max(6000),
  shape: ShapeSchema.default('auto'),
});

const ExecuteSchema = z.object({
  prompt: z.string().min(1).max(10000),
  runtimeContext: z
    .object({
      groupFolder: z.string().min(1).max(256).optional(),
      chatJid: z.string().min(1).max(512).optional(),
      workspacePath: z.string().min(1).max(2000).optional(),
      remoteToolCwd: z.string().min(1).max(2000).optional(),
    })
    .optional(),
  runnerAgentId: z.string().min(1).max(128).optional(),
  roleAssignments: z
    .record(
      z.string().min(1).max(64),
      z.object({
        runnerAgentId: z.string().min(1).max(128),
        linkId: z.string().min(1).max(128).optional(),
        agentClientId: z.string().min(1).max(128).optional(),
      }),
    )
    .optional(),
  maxFeedbackIterations: z.number().int().min(0).max(5).optional(),
});
type ExecuteRequest = z.infer<typeof ExecuteSchema>;

function resolveAgentTeamDeviceLink(input: {
  runnerAgentId: string;
  assignment?: NonNullable<ExecuteRequest['roleAssignments']>[string];
  userId?: string;
}): string | undefined {
  if (input.assignment?.linkId) return input.assignment.linkId;
  const customBackend = listCustomBackends().find(
    (backend) => backend.id === input.runnerAgentId,
  );
  if (customBackend?.deviceLinkId) return customBackend.deviceLinkId;
  return parseAgentLinkTarget(input.runnerAgentId, input.userId)?.linkId;
}

const ApprovalDecisionSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
});

const AgentTeamToolSchema = z.object({
  userId: z.string().min(1),
  operation: z.enum([
    'list_teams',
    'get_team',
    'run_team',
    'get_run',
    'decide_approval',
    'cancel_run',
  ]),
  teamId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  approvalId: z.string().min(1).optional(),
  prompt: z.string().min(1).max(10000).optional(),
  runnerAgentId: z.string().min(1).max(128).optional(),
  roleAssignments: ExecuteSchema.shape.roleAssignments,
  runtimeContext: ExecuteSchema.shape.runtimeContext,
  maxFeedbackIterations: z.number().int().min(0).max(5).optional(),
  decision: z.enum(['approved', 'rejected']).optional(),
});

function agentReferencesForAgentMd(id: string, _ownerUserId: string) {
  return listCustomBackends()
    .filter((backend) => backend.agentMdId === id)
    .map((backend) => ({
      kind: 'agent' as const,
      id: backend.id,
      name: backend.displayName || backend.id,
      detail: 'Agent 身份引用',
    }));
}

function allReferencesForAgentMd(
  id: string,
  ownerUserId: string,
  options: { excludeTeamId?: string } = {},
) {
  return [
    ...findAgentMdTeamReferences(id, ownerUserId, options),
    ...agentReferencesForAgentMd(id, ownerUserId),
  ];
}

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
    return c.json(
      { error: parsed.error.issues[0]?.message || 'invalid team' },
      400,
    );
  }
  if (!isAbstractAgentTeamDefinition(parsed.data)) {
    return c.json(
      {
        error:
          'team must not bind concrete agent cli, provider, device, model, command or path',
      },
      400,
    );
  }
  return c.json(createAgentTeam(parsed.data, user.id), 201);
});

router.post('/generate', authMiddleware, systemConfigMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));
  const parsed = GenerateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        error: parsed.error.issues[0]?.message || 'invalid generation request',
      },
      400,
    );
  }
  const settings = getSystemSettings();
  if (!settings.allowedBackends.includes(parsed.data.generatorAgentId)) {
    return c.json({ error: 'generator agent is not in allowedBackends' }, 403);
  }
  const requestedBackend = getBackend(parsed.data.generatorAgentId);
  if (requestedBackend && !requestedBackend.supportsExecutionMode('host')) {
    return c.json(
      { error: 'generator agent does not support host execution mode' },
      400,
    );
  }
  const fallback = buildAgentTeamDraft({
    generatorAgentId: parsed.data.generatorAgentId,
    goal: parsed.data.goal,
    shape: parsed.data.shape as AgentTeamShape,
  });
  const now = new Date().toISOString();
  const job: AgentTeamGenerationJob = {
    id: `team_gen_${crypto.randomBytes(6).toString('hex')}`,
    userId: user.id,
    generatorAgentId: parsed.data.generatorAgentId,
    goal: parsed.data.goal,
    shape: parsed.data.shape as AgentTeamShape,
    status: 'running',
    createdAt: now,
    updatedAt: now,
  };
  agentTeamGenerationJobs.set(job.id, job);
  void runAgentTeamGenerationJob(job.id, fallback);
  return c.json({ job: toPublicGenerationJob(job) }, 202);
});

router.get('/generation-jobs', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const jobs = [...agentTeamGenerationJobs.values()]
    .filter((job) => job.userId === user.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return c.json({ jobs: jobs.map(toPublicGenerationJob) });
});

router.get('/generation-jobs/:jobId', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const job = agentTeamGenerationJobs.get(c.req.param('jobId'));
  if (!job || job.userId !== user.id) {
    return c.json({ error: 'agent team generation job not found' }, 404);
  }
  return c.json({ job: toPublicGenerationJob(job) });
});

router.get('/templates', authMiddleware, (c) => {
  return c.json({ templates: listAgentTeamTemplates() });
});

router.get('/templates/:templateId', authMiddleware, (c) => {
  const template = getAgentTeamTemplate(c.req.param('templateId'));
  if (!template) return c.json({ error: 'agent team template not found' }, 404);
  return c.json({ template });
});

router.post(
  '/templates/:templateId/teams',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const user = c.get('user') as AuthUser;
    const body = await c.req.json().catch(() => ({}));
    const goal = typeof body.goal === 'string' ? body.goal.trim() : '';
    if (!goal) return c.json({ error: 'goal is required' }, 400);
    try {
      const teamInput = createAgentTeamInputFromTemplate(
        c.req.param('templateId'),
        {
          goal,
          createdByAgentId: String(body.createdByAgentId ?? 'system'),
        },
      );
      return c.json({ team: createAgentTeam(teamInput, user.id) }, 201);
    } catch {
      return c.json({ error: 'agent team template not found' }, 404);
    }
  },
);

router.get('/agent-md', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  return c.json({ definitions: listAgentMdDefinitions(user.id) });
});

router.post('/agent-md', authMiddleware, systemConfigMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));
  const parsed = AgentMdInputSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        error: parsed.error.issues[0]?.message || 'invalid agent.md definition',
      },
      400,
    );
  }
  return c.json(
    { definition: createAgentMdDefinition(parsed.data, user.id) },
    201,
  );
});

router.get('/agent-md-summaries', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  return c.json({ summaries: listAgentMdSummaries(user.id) });
});

router.post(
  '/agent-md-store/import',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const user = c.get('user') as AuthUser;
    const body = await c.req.json().catch(() => ({}));
    const parsed = AgentMdStoreImportSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error:
            parsed.error.issues[0]?.message || 'invalid agent.md store import',
        },
        400,
      );
    }
    try {
      const definition = await createAgentMdDefinitionFromStore(
        parsed.data.path,
        parsed.data.createdByAgentId,
        user.id,
      );
      return c.json({ definition }, 201);
    } catch {
      return c.json({ error: 'failed to import agent.md from store' }, 502);
    }
  },
);

router.get('/agent-md/:id', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const definition = getAgentMdDefinition(c.req.param('id'), user.id);
  if (!definition)
    return c.json({ error: 'agent.md definition not found' }, 404);
  return c.json({ definition });
});

router.patch(
  '/agent-md/:id',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const user = c.get('user') as AuthUser;
    const body = await c.req.json().catch(() => ({}));
    const parsed = AgentMdPatchSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message || 'invalid agent.md patch' },
        400,
      );
    }
    const definition = updateAgentMdDefinition(
      c.req.param('id'),
      parsed.data,
      user.id,
    );
    if (!definition)
      return c.json({ error: 'agent.md definition not found' }, 404);
    return c.json({ definition });
  },
);

router.delete('/agent-md/:id', authMiddleware, systemConfigMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const id = c.req.param('id');
  const existing = getAgentMdDefinition(id, user.id);
  if (!existing) return c.json({ error: 'agent.md definition not found' }, 404);
  const references = allReferencesForAgentMd(id, user.id);
  if (references.length > 0) {
    return c.json(
      {
        error: 'agent.md definition is still referenced',
        references,
      },
      409,
    );
  }
  const deleted = deleteAgentMdDefinition(id, user.id);
  if (!deleted) return c.json({ error: 'agent.md definition not found' }, 404);
  return c.json({ ok: true });
});

router.get('/runs', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const status = c.req.query('status')?.trim();
  const allowedStatuses = new Set([
    'running',
    'waiting_approval',
    'paused',
    'success',
    'error',
    'cancelled',
  ]);
  if (status && !allowedStatuses.has(status))
    return c.json({ error: 'invalid run status' }, 400);
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

function normalizeMetricsDateParam(
  value: string | undefined,
  boundary: 'start' | 'end',
): string | undefined | null {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return boundary === 'start'
      ? `${value}T00:00:00.000Z`
      : `${value}T23:59:59.999Z`;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

router.get('/metrics', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const since = normalizeMetricsDateParam(
    c.req.query('since')?.trim() || undefined,
    'start',
  );
  const until = normalizeMetricsDateParam(
    c.req.query('until')?.trim() || undefined,
    'end',
  );
  if (since === null) {
    return c.json({ error: 'invalid since' }, 400);
  }
  if (until === null) {
    return c.json({ error: 'invalid until' }, 400);
  }
  if (since && until && new Date(since).getTime() > new Date(until).getTime()) {
    return c.json({ error: 'since must be before until' }, 400);
  }
  const limitValue = Number(c.req.query('limit') ?? 100);
  const records = listAgentTeamRunsForMetrics({
    userId: user.id,
    teamId: c.req.query('teamId')?.trim() || undefined,
    since,
    until,
    limit: Number.isFinite(limitValue) ? limitValue : 100,
  });
  return c.json({ metrics: summarizeAgentTeamMetrics(records) });
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

router.get('/runs/:runId/artifacts', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const run = getAgentTeamRun(c.req.param('runId'), user.id);
  if (!run) return c.json({ error: 'agent team run not found' }, 404);
  return c.json({ artifacts: listAgentTeamArtifacts(run.id) });
});

router.get('/runs/:runId/artifacts/:artifactId', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const run = getAgentTeamRun(c.req.param('runId'), user.id);
  if (!run) return c.json({ error: 'agent team run not found' }, 404);
  const artifact = getAgentTeamArtifact(c.req.param('artifactId'), run.id);
  if (!artifact) return c.json({ error: 'artifact not found' }, 404);
  return c.json({ artifact });
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

function cancelAgentTeamRunAndRecord(
  run: NonNullable<ReturnType<typeof getAgentTeamRun>>,
  reason: string,
): ReturnType<typeof cancelAgentTeamRun> {
  const cancellation = cancelAgentTeamRun(run.id, reason);
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
    error: cancellation.errors.length
      ? `${reason}; cancellation errors: ${JSON.stringify(cancellation.errors)}`
      : reason,
    completedAt: new Date().toISOString(),
  });
  return cancellation;
}

router.post('/runs/:runId/cancel', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const run = getAgentTeamRun(c.req.param('runId'), user.id);
  if (!run) return c.json({ error: 'agent team run not found' }, 404);
  const cancellation = cancelAgentTeamRunAndRecord(run, 'cancelled by user');
  return c.json({
    run: getAgentTeamRun(run.id, user.id),
    cancelledTaskIds: cancellation.cancelledTaskIds,
    cancellationErrors: cancellation.errors,
  });
});

router.post(
  '/runs/:runId/approvals/:approvalId',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const user = c.get('user') as AuthUser;
    const run = getAgentTeamRun(c.req.param('runId'), user.id);
    if (!run) return c.json({ error: 'agent team run not found' }, 404);
    const approval = getAgentTeamApproval(c.req.param('approvalId'), run.id);
    if (!approval)
      return c.json({ error: 'agent team approval not found' }, 404);
    const body = await c.req.json().catch(() => ({}));
    const parsed = ApprovalDecisionSchema.safeParse(body);
    if (!parsed.success)
      return c.json(
        {
          error: parsed.error.issues[0]?.message || 'invalid approval decision',
        },
        400,
      );
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
      return c.json({
        run: getAgentTeamRun(run.id, user.id),
        approval: getAgentTeamApproval(String(approval.id), run.id),
      });
    }
    const result = await executeExistingRun(c, run.id, {
      bypassApproval: true,
      approvalDecision: {
        approvalId: String(approval.id),
        status: parsed.data.decision,
        targetRoleId: getApprovalTargetRoleId(approval.payload),
      },
    });
    if ('response' in result) return result.response;
    return c.json({
      run: getAgentTeamRun(run.id, user.id),
      approval: getAgentTeamApproval(String(approval.id), run.id),
      execution: result.execution,
    });
  },
);

router.post('/:id/runs', authMiddleware, systemConfigMiddleware, async (c) => {
  const result = await executeTeamRequest(c, c.req.param('id'));
  if ('response' in result) return result.response;
  return c.json(
    {
      run: getAgentTeamRun(
        result.execution.runId || '',
        (c.get('user') as AuthUser).id,
      ),
      approval: result.execution.waitingApproval
        ? getAgentTeamApproval(result.execution.waitingApproval.approvalId, result.execution.runId || '')
        : undefined,
      execution: result.execution,
    },
    result.execution.status === 'success' ? 201 : result.execution.status === 'waiting_approval' ? 202 : 502,
  );
});

router.post(
  '/:id/execute',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const result = await executeTeamRequest(c, c.req.param('id'));
    if ('response' in result) return result.response;
    return c.json(
      { execution: result.execution },
      result.execution.status === 'success' ? 200 : result.execution.status === 'waiting_approval' ? 202 : 502,
    );
  },
);

async function executeTeamRequest(
  c: any,
  teamId: string,
): Promise<
  | { execution: Awaited<ReturnType<typeof executeAgentTeam>> }
  | { response: Response }
> {
  const user = c.get('user') as AuthUser;
  const team = getAgentTeam(teamId, user.id);
  if (!team) return { response: c.json({ error: 'team not found' }, 404) };
  const body = await c.req.json().catch(() => ({}));
  const parsed = ExecuteSchema.safeParse(body);
  if (!parsed.success) {
    return {
      response: c.json(
        {
          error: parsed.error.issues[0]?.message || 'invalid execution request',
        },
        400,
      ),
    };
  }
  const settings = getSystemSettings();
  const runnerAgentId = parsed.data.runnerAgentId ?? team.createdByAgentId;
  if (!settings.allowedBackends.includes(runnerAgentId)) {
    return {
      response: c.json(
        { error: 'team runner agent is not in allowedBackends' },
        403,
      ),
    };
  }
  const backend = getBackend(runnerAgentId);
  if (!backend)
    return {
      response: c.json({ error: 'team runner backend not found' }, 404),
    };
  if (!backend.supportsExecutionMode('host')) {
    return {
      response: c.json(
        { error: 'team runner agent does not support host execution mode' },
        400,
      ),
    };
  }
  const runtimeTargetValidation = validateAgentTeamRoleRuntimeTargets({
    roles: team.roles,
    roleAssignments: parsed.data.roleAssignments,
    defaultRunnerAgentId: runnerAgentId,
    allowedBackends: settings.allowedBackends,
    resolveBackend: getBackend,
    resolveDeviceLink: (roleRunnerAgentId, assignment) =>
      resolveAgentTeamDeviceLink({
        runnerAgentId: roleRunnerAgentId,
        assignment,
        userId: user.id,
      }),
  });
  if (!runtimeTargetValidation.ok) {
    return {
      response: c.json(
        {
          error: 'invalid role runtime target',
          details: runtimeTargetValidation.errors,
        },
        runtimeTargetValidation.status ?? 400,
      ),
    };
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
      runtimeContext: parsed.data.runtimeContext,
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
      response: c.json(
        {
          run: getAgentTeamRun(runId, user.id),
          approval: getAgentTeamApproval(approval.id, runId),
          checkpoint,
        },
        202,
      ),
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
    runtimeContext: parsed.data.runtimeContext,
    defaultBackend: backend,
  });
}

export async function handleAgentTeamToolRequest(c: any): Promise<Response> {
  const auth = c.req.header('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
  const body = await c.req.json().catch(() => ({}));
  const tokenUser = token
    ? verifyAgentToolToken(token)?.userId ||
      (token === AGENT_RUNNER_SECRET && isRecord(body)
        // Secret-based auth: only allow the system's own agent-runner user.
        // The userId from the request body is validated against the DB.
        ? (() => {
            const bodyUserId = String(body.userId || '');
            const dbUser = getUserById(bodyUserId);
            return dbUser ? dbUser.id : null;
          })()
        : null)
    : null;
  if (!tokenUser) return c.json({ error: 'unauthorized' }, 401);
  return handleAgentTeamToolBody(c, {
    ...(isRecord(body) ? body : {}),
    userId: tokenUser,
  });
}

export async function handleAgentTeamLinkToolRequest(
  c: any,
  userId: string,
  body: unknown,
): Promise<Response> {
  return handleAgentTeamToolBody(c, {
    ...(isRecord(body) ? body : {}),
    userId,
  });
}

async function handleAgentTeamToolBody(
  c: any,
  body: unknown,
): Promise<Response> {
  const parsed = AgentTeamToolSchema.safeParse(body);
  if (!parsed.success)
    return c.json(
      {
        error:
          parsed.error.issues[0]?.message || 'invalid agent team tool request',
      },
      400,
    );
  const user: AuthUser = (() => {
    const dbUser = getUserById(parsed.data.userId);
    if (dbUser) {
      return {
        id: dbUser.id,
        username: dbUser.username,
        role: dbUser.role,
        status: dbUser.status,
        display_name: dbUser.display_name || dbUser.username,
        permissions: dbUser.permissions || [],
        must_change_password: false,
      };
    }
    // Fallback: if user not found in DB (e.g., agent-link device user),
    // create a minimal member user — never default to admin.
    return {
      id: parsed.data.userId,
      username: parsed.data.userId,
      role: 'member',
      status: 'active',
      display_name: parsed.data.userId,
      permissions: [],
      must_change_password: false,
    };
  })();
  const toolContext = createInternalToolContext(c, user, parsed.data);

  switch (parsed.data.operation) {
    case 'list_teams':
      return c.json({ teams: listAgentTeams(user.id) });
    case 'get_team': {
      if (!parsed.data.teamId)
        return c.json({ error: 'teamId is required' }, 400);
      const team = getAgentTeam(parsed.data.teamId, user.id);
      if (!team) return c.json({ error: 'team not found' }, 404);
      return c.json({ team });
    }
    case 'run_team': {
      if (!parsed.data.teamId || !parsed.data.prompt)
        return c.json({ error: 'teamId and prompt are required' }, 400);
      const result = await executeTeamRequest(toolContext, parsed.data.teamId);
      if ('response' in result) return result.response;
      return c.json(
        {
          run: getAgentTeamRun(result.execution.runId || '', user.id),
          execution: result.execution,
        },
        result.execution.status === 'success' ? 201 : result.execution.status === 'waiting_approval' ? 202 : 502,
      );
    }
    case 'get_run': {
      if (!parsed.data.runId)
        return c.json({ error: 'runId is required' }, 400);
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
      if (
        !parsed.data.runId ||
        !parsed.data.approvalId ||
        !parsed.data.decision
      )
        return c.json(
          { error: 'runId, approvalId and decision are required' },
          400,
        );
      const run = getAgentTeamRun(parsed.data.runId, user.id);
      if (!run) return c.json({ error: 'agent team run not found' }, 404);
      const approval = getAgentTeamApproval(parsed.data.approvalId, run.id);
      if (!approval)
        return c.json({ error: 'agent team approval not found' }, 404);
      recordAgentTeamApproval({
        id: String(approval.id),
        runId: run.id,
        taskId:
          typeof approval.taskId === 'string' ? approval.taskId : undefined,
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
        return c.json({
          run: getAgentTeamRun(run.id, user.id),
          approval: getAgentTeamApproval(String(approval.id), run.id),
        });
      }
      const result = await executeExistingRun(toolContext, run.id, {
        bypassApproval: true,
        approvalDecision: {
          approvalId: String(approval.id),
          status: parsed.data.decision,
          targetRoleId: getApprovalTargetRoleId(approval.payload),
        },
      });
      if ('response' in result) return result.response;
      return c.json({
        run: getAgentTeamRun(run.id, user.id),
        approval: getAgentTeamApproval(String(approval.id), run.id),
        execution: result.execution,
      });
    }
    case 'cancel_run': {
      if (!parsed.data.runId)
        return c.json({ error: 'runId is required' }, 400);
      const run = getAgentTeamRun(parsed.data.runId, user.id);
      if (!run) return c.json({ error: 'agent team run not found' }, 404);
      const cancellation = cancelAgentTeamRunAndRecord(
        run,
        'cancelled by agent team MCP tool',
      );
      return c.json({
        run: getAgentTeamRun(run.id, user.id),
        cancelledTaskIds: cancellation.cancelledTaskIds,
        cancellationErrors: cancellation.errors,
      });
    }
  }
}

function createInternalToolContext(
  parent: any,
  user: AuthUser,
  data: z.infer<typeof AgentTeamToolSchema>,
) {
  return {
    ...parent,
    get: (key: string) => (key === 'user' ? user : parent.get?.(key)),
    req: {
      ...parent.req,
      json: async () => ({
        prompt: data.prompt,
        runnerAgentId: data.runnerAgentId,
        roleAssignments: data.roleAssignments,
        maxFeedbackIterations: data.maxFeedbackIterations,
        runtimeContext: data.runtimeContext,
      }),
    },
  };
}

async function executeExistingRun(
  c: any,
  runId: string,
  options: { bypassApproval?: boolean; approvalDecision?: { approvalId: string; status: 'approved' | 'rejected'; targetRoleId?: string; comment?: string } } = {},
): Promise<
  | { execution: Awaited<ReturnType<typeof executeAgentTeam>> }
  | { response: Response }
> {
  const user = c.get('user') as AuthUser;
  const run = getAgentTeamRun(runId, user.id);
  if (!run)
    return { response: c.json({ error: 'agent team run not found' }, 404) };
  if (run.status === 'cancelled')
    return { response: c.json({ error: 'agent team run is cancelled' }, 409) };
  const team = getAgentTeam(run.teamId, user.id);
  if (!team) return { response: c.json({ error: 'team not found' }, 404) };
  const approvalState = getLatestApprovalCheckpointState(run.id);
  const runtimeCheckpoint = getLatestRuntimeCheckpoint(run.id);
  if (!options.bypassApproval && findApprovalRequiredRole(team)) {
    return {
      response: c.json(
        { error: 'agent team run is waiting for approval' },
        409,
      ),
    };
  }
  const runnerAgentId =
    typeof approvalState.runnerAgentId === 'string'
      ? approvalState.runnerAgentId
      : team.createdByAgentId;
  const roleAssignments = isRecord(approvalState.roleAssignments)
    ? (approvalState.roleAssignments as ExecuteRequest['roleAssignments'])
    : (run.roleAssignments as ExecuteRequest['roleAssignments']);
  const maxFeedbackIterations =
    typeof approvalState.maxFeedbackIterations === 'number'
      ? approvalState.maxFeedbackIterations
      : undefined;
  const settings = getSystemSettings();
  if (!settings.allowedBackends.includes(runnerAgentId)) {
    return {
      response: c.json(
        { error: 'team runner agent is not in allowedBackends' },
        403,
      ),
    };
  }
  const backend = getBackend(runnerAgentId);
  if (!backend)
    return {
      response: c.json({ error: 'team runner backend not found' }, 404),
    };
  if (!backend.supportsExecutionMode('host')) {
    return {
      response: c.json(
        { error: 'team runner agent does not support host execution mode' },
        400,
      ),
    };
  }
  const runtimeTargetValidation = validateAgentTeamRoleRuntimeTargets({
    roles: team.roles,
    roleAssignments,
    defaultRunnerAgentId: runnerAgentId,
    allowedBackends: settings.allowedBackends,
    resolveBackend: getBackend,
    resolveDeviceLink: (roleRunnerAgentId, assignment) =>
      resolveAgentTeamDeviceLink({
        runnerAgentId: roleRunnerAgentId,
        assignment,
        userId: user.id,
      }),
  });
  if (!runtimeTargetValidation.ok) {
    return {
      response: c.json(
        {
          error: 'invalid role runtime target',
          details: runtimeTargetValidation.errors,
        },
        runtimeTargetValidation.status ?? 400,
      ),
    };
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
    runtimeContext: approvalState.runtimeContext as ExecuteRequest['runtimeContext'],
    defaultBackend: backend,
    resumeFromCheckpoint: runtimeCheckpoint,
    approvalDecision: options.approvalDecision,
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
    runtimeContext?: ExecuteRequest['runtimeContext'];
    defaultBackend: NonNullable<ReturnType<typeof getBackend>>;
    resumeFromCheckpoint?: AgentTeamRuntimeCheckpoint;
    approvalDecision?: { approvalId: string; status: 'approved' | 'rejected'; targetRoleId?: string; comment?: string };
  },
): Promise<
  | { execution: Awaited<ReturnType<typeof executeAgentTeam>> }
  | { response: Response }
> {
  const {
    team,
    user,
    runId,
    traceId,
    prompt,
    runnerAgentId,
    roleAssignments,
    maxFeedbackIterations,
    runtimeContext,
    defaultBackend,
    resumeFromCheckpoint,
    approvalDecision,
  } = config;
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
  const execution = await executeAgentTeam(
    team,
    {
      prompt,
      maxFeedbackIterations,
      runId,
      traceId,
      sessionId: `system:agent-team:${team.id}`,
      resumeFromCheckpoint,
      approvalDecision,
    },
    async ({
      role,
      prompt,
      phase,
      previousResults,
      feedback,
      instructions,
      busMessages,
      artifacts,
    }) => {
      const assignment = roleAssignments?.[role.id];
      const roleRunnerAgentId = assignment?.runnerAgentId ?? runnerAgentId;
      if (!settings.allowedBackends.includes(roleRunnerAgentId)) {
        return {
          status: 'error',
          result: '',
          error: `role runner ${roleRunnerAgentId} is not in allowedBackends`,
        };
      }
      const roleBackend =
        roleRunnerAgentId === runnerAgentId
          ? defaultBackend
          : getBackend(roleRunnerAgentId);
      if (!roleBackend)
        return {
          status: 'error',
          result: '',
          error: `role runner backend ${roleRunnerAgentId} not found`,
        };
      if (!roleBackend.supportsExecutionMode('host'))
        return {
          status: 'error',
          result: '',
          error: `role runner ${roleRunnerAgentId} does not support host execution mode`,
        };
      const rolePrompt = buildAgentTeamRolePrompt(
        team,
        role,
        prompt,
        phase,
        previousResults,
        feedback,
        {
          instructions,
          busMessages,
          artifacts,
          agentMdDefinitions: resolveRoleAgentMdDefinitions(role, user.id),
          runtimeContext,
        },
      );
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
      const roleWorkspace = resolveAgentTeamRoleWorkspace({
        teamId: team.id,
        runId,
        roleId: role.id,
        roleName: role.name,
        workspacePolicy: role.policy?.workspacePolicy,
        runtimeGroupFolder: runtimeContext?.groupFolder,
        runtimeRemoteToolCwd: runtimeContext?.remoteToolCwd,
      });
      const roleGroupFolder = roleWorkspace.groupFolder;
      const roleTurnId = `${taskId}:turn`;
      const abortController = new AbortController();
      const unregisterCancellation = registerAgentTeamTaskCancellation({
        runId,
        taskId,
        cancel: (reason) => abortController.abort(reason),
      });
      const cleanupDeviceLinkId = resolveAgentTeamDeviceLink({
        runnerAgentId: roleRunnerAgentId,
        assignment,
        userId: user.id,
      });
      const output = await (async () => {
        try {
          return await roleBackend.run({
            group: {
              name: `Agent Team ${team.name}`,
              folder: roleGroupFolder,
              added_at: new Date().toISOString(),
              containerConfig: { timeout: AGENT_TEAM_GENERATION_TIMEOUT_MS },
              executionMode: 'host',
              backend: roleRunnerAgentId,
              created_by: user.id,
            },
            executionMode: 'host',
            signal: abortController.signal,
            input: {
              prompt: rolePrompt,
              groupFolder: roleGroupFolder,
              chatJid: runtimeContext?.chatJid ?? `system:agent-team:${team.id}`,
              isMain: false,
              isHome: false,
              isAdminHome: false,
              turnId: roleTurnId,
              remoteToolCwd: roleWorkspace.remoteToolCwd,
              executionProfile: 'single-turn-json',
            },
            onProcess: () => undefined,
          });
        } finally {
          unregisterCancellation();
          if (cleanupDeviceLinkId) {
            requestWorkspaceCleanup({
              linkId: cleanupDeviceLinkId,
              workspace: roleGroupFolder,
              scope:
                roleWorkspace.cleanupScope === 'run'
                  ? 'workspace'
                  : roleWorkspace.cleanupScope,
              sessionId: roleTurnId,
            });
          }
        }
      })();
      recordAgentTeamTask({
        id: taskId,
        runId,
        roleId: role.id,
        phase,
        actorId: roleRunnerAgentId,
        status: abortController.signal.aborted
          ? 'cancelled'
          : output.status === 'success'
            ? 'success'
            : 'error',
        output: output.result ?? undefined,
        error: abortController.signal.aborted
          ? String(abortController.signal.reason ?? 'cancelled')
          : output.error ?? undefined,
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
    },
  );
  for (const event of execution.traceEvents ?? []) {
    recordAgentTeamTraceEvent(toTraceEventRecord(event));
  }
  persistArtifactWrites(runId, execution.traceEvents ?? [], execution.checkpoint);
  if (execution.checkpoint) {
    recordAgentTeamCheckpoint({
      id: `${runId}:runtime:${execution.checkpoint.workflowNode}:${execution.checkpoint.status}`,
      runId,
      nodeId: execution.checkpoint.workflowNode,
      state: execution.checkpoint,
    });
  }
  if (execution.waitingApproval) {
    recordAgentTeamApproval({
      id: execution.waitingApproval.approvalId,
      runId,
      taskId: execution.waitingApproval.stepId,
      requestedBy: execution.waitingApproval.requestedBy,
      status: 'pending',
      riskLevel: execution.waitingApproval.riskLevel,
      title: `Approve workflow step ${execution.waitingApproval.stepId}`,
      description: execution.waitingApproval.reason,
      payload: execution.waitingApproval.payload,
    });
  }
  const latestRun = getAgentTeamRun(runId, user.id);
  const finalRunStatus =
    latestRun?.status === 'cancelled' ? 'cancelled' : execution.status;
  recordAgentTeamRun({
    id: runId,
    teamId: team.id,
    userId: user.id,
    prompt,
    status: finalRunStatus,
    traceId,
    workflowShape: team.shape,
    roleAssignments: roleAssignments ?? {},
    finalResult: execution.finalResult,
    error: latestRun?.status === 'cancelled' ? latestRun.error : execution.error,
    completedAt:
      finalRunStatus === 'waiting_approval' ? undefined : new Date().toISOString(),
  });
  return { execution };
}

function persistArtifactWrites(
  runId: string,
  traceEvents: AgentTeamTraceEvent[],
  checkpoint?: AgentTeamRuntimeCheckpoint,
): void {
  const artifactValues = checkpoint?.artifacts ?? {};
  const existingArtifacts = listAgentTeamArtifacts(runId);
  const nextVersionByKey = new Map<string, number>();
  const latestArtifactIdByKey = new Map<string, string>();
  for (const artifact of existingArtifacts) {
    const currentVersion = nextVersionByKey.get(artifact.key) ?? 0;
    if (artifact.version >= currentVersion) {
      nextVersionByKey.set(artifact.key, artifact.version);
      latestArtifactIdByKey.set(artifact.key, artifact.id);
    }
  }
  for (const event of traceEvents) {
    if (event.type !== 'artifact.written' || !isRecord(event.payload)) continue;
    const key = event.payload.key;
    if (typeof key !== 'string') continue;
    const value =
      typeof event.payload.value === 'string'
        ? event.payload.value
        : artifactValues[key];
    if (typeof value !== 'string') continue;
    const version = (nextVersionByKey.get(key) ?? 0) + 1;
    nextVersionByKey.set(key, version);
    const artifactId = `${runId}:artifact:${key}:${version}`;
    const sourceStepId = event.payload.sourceStepId;
    const sourceTaskId = event.payload.sourceTaskId;
    const sourceRoleId = event.payload.sourceRoleId;
    const contentType = event.payload.contentType;
    const inputKeys = Array.isArray(event.payload.inputKeys)
      ? event.payload.inputKeys.filter((inputKey): inputKey is string => typeof inputKey === 'string')
      : [];
    const parentArtifactIds = inputKeys
      .map((inputKey) => latestArtifactIdByKey.get(inputKey))
      .filter((id): id is string => Boolean(id));
    recordAgentTeamArtifact({
      id: artifactId,
      runId,
      key,
      version,
      contentType: typeof contentType === 'string' ? contentType : 'text/markdown',
      value,
      sourceStepId: typeof sourceStepId === 'string' ? sourceStepId : undefined,
      sourceTaskId: typeof sourceTaskId === 'string' ? sourceTaskId : undefined,
      sourceRoleId: typeof sourceRoleId === 'string' ? sourceRoleId : undefined,
      parentArtifactIds,
      visibility: 'run',
      createdAt: event.timestamp,
    });
    latestArtifactIdByKey.set(key, artifactId);
  }
}

const PERMISSION_LEVEL_RANK: Record<string, number> = {
  L0: 0,
  L1: 1,
  L2: 2,
  L3: 3,
  L4: 4,
  L5: 5,
};

function findApprovalRequiredRole(
  team: AgentTeam,
): AgentTeam['roles'][number] | undefined {
  return team.roles.find((role) => {
    const policy = role.policy;
    if (!policy) return false;
    if (policy.requiresApproval) return true;
    return (
      (PERMISSION_LEVEL_RANK[policy.permissionLevel ?? 'L0'] ?? 0) >=
      PERMISSION_LEVEL_RANK.L4
    );
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
  runtimeContext?: ExecuteRequest['runtimeContext'];
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
      runtimeContext: input.runtimeContext,
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
  const riskLevel =
    input.role.policy?.permissionLevel ??
    (input.role.policy?.requiresApproval ? 'L4' : 'L0');
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

function getLatestApprovalCheckpointState(
  runId: string,
): Record<string, unknown> {
  const checkpoints = listAgentTeamCheckpoints(runId);
  for (let index = checkpoints.length - 1; index >= 0; index -= 1) {
    const checkpoint = checkpoints[index];
    if (
      typeof checkpoint.nodeId === 'string' &&
      checkpoint.nodeId.startsWith('approval:') &&
      isRecord(checkpoint.state)
    ) {
      return checkpoint.state;
    }
  }
  return {};
}

function getLatestRuntimeCheckpoint(
  runId: string,
): AgentTeamRuntimeCheckpoint | undefined {
  const checkpoints = listAgentTeamCheckpoints(runId);
  for (let index = checkpoints.length - 1; index >= 0; index -= 1) {
    const state = checkpoints[index]?.state;
    if (isRecord(state) && state.schemaVersion === 2 && isRecord(state.stepStatuses)) {
      return state as unknown as AgentTeamRuntimeCheckpoint;
    }
  }
  return undefined;
}

function getApprovalTargetRoleId(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const direct = payload.targetRoleId;
  if (typeof direct === 'string') return direct;
  const scope = payload.scope;
  if (isRecord(scope) && typeof scope.targetRoleId === 'string') return scope.targetRoleId;
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

router.patch('/:id', authMiddleware, systemConfigMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));
  const parsed = TeamPatchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: parsed.error.issues[0]?.message || 'invalid patch' },
      400,
    );
  }
  const existing = getAgentTeam(c.req.param('id'), user.id);
  if (!existing) return c.json({ error: 'team not found' }, 404);
  const merged = { ...existing, ...parsed.data };
  if (!isAbstractAgentTeamDefinition(merged)) {
    return c.json(
      {
        error:
          'team must not bind concrete agent cli, provider, device, model, command or path',
      },
      400,
    );
  }
  const team = updateAgentTeam(c.req.param('id'), parsed.data, user.id);
  if (!team) return c.json({ error: 'team not found' }, 404);
  return c.json({ team });
});

router.delete('/:id', authMiddleware, systemConfigMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const id = c.req.param('id');
  const deleteLinkedAgentMd = c.req.query('deleteLinkedAgentMd') === 'true';
  const linkedAgentMdDefinitions = listAgentMdDefinitions(user.id).filter(
    (definition) => definition.createdByTeamId === id,
  );
  if (deleteLinkedAgentMd) {
    const blockingReferences = linkedAgentMdDefinitions.flatMap((definition) =>
      allReferencesForAgentMd(definition.id, user.id, { excludeTeamId: id }).map(
        (reference) => ({ ...reference, agentMdId: definition.id, agentMdName: definition.name }),
      ),
    );
    if (blockingReferences.length > 0) {
      return c.json(
        {
          error: 'linked agent.md definition is still referenced',
          references: blockingReferences,
        },
        409,
      );
    }
  }
  const result = deleteAgentTeamWithLinkedAgentMd(id, user.id, {
    deleteLinkedAgentMd,
  });
  if (!result.deleted) return c.json({ error: 'team not found' }, 404);
  return c.json({ ok: true, linkedAgentMdDefinitions: result.linkedAgentMdDefinitions });
});

export default router;

async function runAgentTeamGenerationJob(
  jobId: string,
  fallback: AgentTeamInput,
): Promise<void> {
  const job = agentTeamGenerationJobs.get(jobId);
  if (!job) return;
  try {
    const generated = await generateDraftWithAgent(
      job.generatorAgentId,
      fallback,
      job.userId,
    );
    const team = createAgentTeam(generated.draft, job.userId);
    const createdAgentMdDefinitions = generated.agentMdDefinitionsToCreate.map(
      (definition) =>
        createAgentMdDefinition(
          {
            ...definition,
            createdByAgentId: job.generatorAgentId,
            createdByTeamId: team.id,
            createdByTeamName: team.name,
          },
          job.userId,
        ),
    );
    const completedAt = new Date().toISOString();
    agentTeamGenerationJobs.set(jobId, {
      ...job,
      status: 'success',
      team,
      agentMdDefinitions: createdAgentMdDefinitions,
      updatedAt: completedAt,
      completedAt,
    });
  } catch (err) {
    const completedAt = new Date().toISOString();
    agentTeamGenerationJobs.set(jobId, {
      ...job,
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
      updatedAt: completedAt,
      completedAt,
    });
  }
}

async function generateDraftWithAgent(
  generatorAgentId: string,
  fallback: AgentTeamInput,
  ownerUserId: string,
): Promise<AgentTeamGenerationResult> {
  const backend = getBackend(generatorAgentId);
  if (!backend) throw new Error('agent team generator backend not found');

  const prompt = buildAgentTeamGenerationPrompt(
    fallback,
    listAgentMdDefinitions(ownerUserId).map((definition) => ({
      id: definition.id,
      name: definition.name,
      summary: definition.summary,
      content: definition.content,
    })),
  );
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
      if (
        earlyGenerated &&
        agentTeamGeneratorProc &&
        !agentTeamGeneratorProc.killed
      ) {
        agentTeamGeneratorProc.kill('SIGTERM');
      }
    },
  });

  if (earlyGenerated) return earlyGenerated;
  if (output.status !== 'success' || !output.result)
    throw new Error(output.error || 'agent team generator failed');
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
        agentMdDefinitionsToCreate:
          parsed.data.agentMdDefinitionsToCreate ?? [],
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
  options: {
    instructions?: string;
    busMessages?: unknown[];
    artifacts?: Record<string, string>;
    agentMdDefinitions?: Array<{
      id: string;
      name: string;
      summary: string;
      content: string;
    }>;
    runtimeContext?: ExecuteRequest['runtimeContext'];
  } = {},
): string {
  const agentMdBlock = options.agentMdDefinitions?.length
    ? options.agentMdDefinitions
        .map(
          (definition) =>
            `## ${definition.name} (${definition.id})\nSummary: ${definition.summary}\n${definition.content}`,
        )
        .join('\n\n')
    : '';
  const artifactEntries = Object.entries(options.artifacts ?? {}).slice(-20);
  return [
    '你正在作为 Agent Team 中的一个抽象角色执行任务。',
    '请只完成当前角色职责范围内的工作，并输出清晰、可交接的结果。',
    '',
    `Team: ${team.name}`,
    `Goal: ${team.goal}`,
    `Shape: ${team.shape}`,
    `Workflow: ${team.workflow}`,
    team.workflowSteps?.length
      ? `Workflow steps JSON: ${JSON.stringify(team.workflowSteps, null, 2)}`
      : '',
    '',
    `Current role: ${role.name} (${role.id})`,
    `Responsibility: ${role.responsibility}`,
    role.inputs?.length ? `Inputs: ${role.inputs.join('; ')}` : '',
    role.outputs?.length ? `Expected outputs: ${role.outputs.join('; ')}` : '',
    role.skills?.length
      ? `Suggested skills/agent.md: ${role.skills.join('; ')}`
      : '',
    role.guardrails?.length ? `Guardrails: ${role.guardrails.join('; ')}` : '',
    role.requiredSkills?.length
      ? `Required skills: ${role.requiredSkills.join('; ')}`
      : '',
    role.preferredAgentMd?.length
      ? `Preferred agent.md: ${role.preferredAgentMd.join('; ')}`
      : '',
    agentMdBlock ? `\n当前角色可用 agent.md：\n${agentMdBlock}` : '',
    '',
    `Execution phase: ${phase}`,
    options.instructions ? `Step instructions: ${options.instructions}` : '',
    options.runtimeContext
      ? `Runtime context: ${JSON.stringify(options.runtimeContext, null, 2)}`
      : '',
    feedback ? `Feedback or upstream signal: ${feedback}` : '',
    artifactEntries.length ? 'Message bus artifacts:' : '',
    ...artifactEntries.map(([key, value]) => `- ${key}: ${value}`),
    options.busMessages?.length ? 'Recent bus messages:' : '',
    ...(options.busMessages ?? [])
      .slice(-12)
      .map((message) => `- ${JSON.stringify(message)}`),
    previousResults.length ? 'Previous role results:' : '',
    ...previousResults.map(
      (result) =>
        `- ${result.roleName} (${result.phase}, ${result.status}): ${result.result}`,
    ),
    '',
    `User request: ${userPrompt}`,
    '',
    'Agent Team 通信协议（octodeck.agent-team.bus.v1）：',
    '- 你收到的是 orchestrator 从消息总线汇总的 control/context/artifact/status 消息。',
    '- 你的输出会作为 artifact 写回消息总线，供后续角色消费。',
    '- 如果当前 step 需要路由，请输出 JSON：{"action":"run_role|finish|abort","target":"role_id","reason":"...","confidence":0.0-1.0}。',
    '- 如果当前 step 发现失败或需要返工，请输出 JSON：{"status":"needs_revision|failed","summary":"...","issues":["..."],"suggestedFix":"..."}；编排器会根据 workflowSteps.onFailure 决定后续动作。',
    '- 如果当前 step 成功，请输出清晰正文；也可以附加 JSON：{"status":"passed","summary":"..."}。',
    '',
    '通用输出要求：',
    '- 用中文输出。',
    '- 不要依赖固定中文短语表达测试结论；需要控制流程时使用上面的 JSON 协议。',
    '- 按角色 agent.md、workflowSteps 和消息总线中的产物完成交付。',
  ]
    .filter(Boolean)
    .join('\n');
}

function resolveRoleAgentMdDefinitions(
  role: AgentTeamInput['roles'][number],
  ownerUserId: string,
): Array<{ id: string; name: string; summary: string; content: string }> {
  const definitions = listAgentMdDefinitions(ownerUserId);
  const wanted = new Set(
    [...(role.preferredAgentMd ?? []), ...(role.skills ?? [])]
      .map((item) => item.toLowerCase().trim())
      .filter(Boolean),
  );
  if (wanted.size === 0) return [];
  return definitions
    .filter((definition) =>
      [definition.id, definition.name, definition.summary].some(
        (value) =>
          wanted.has(value.toLowerCase()) ||
          Array.from(wanted).some((needle) =>
            value.toLowerCase().includes(needle),
          ),
      ),
    )
    .slice(0, 3)
    .map(({ id, name, summary, content }) => ({ id, name, summary, content }));
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
