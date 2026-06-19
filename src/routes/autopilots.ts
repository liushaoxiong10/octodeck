import { Hono } from 'hono';
import * as crypto from 'node:crypto';
import { CronExpressionParser } from 'cron-parser';

import {
  AutopilotCreateSchema,
  AutopilotPatchSchema,
  AutopilotTriggerRequestSchema,
} from '../schemas.js';
import { authMiddleware } from '../middleware/auth.js';
import type {
  AuthUser,
  Autopilot,
  AutopilotActionType,
  AutopilotTriggerType,
  IssueAgentRun,
  WorkspaceIssue,
} from '../types.js';
import type { Variables } from '../web-context.js';
import {
  canAccessGroup,
  getWebDeps,
  hasHostExecutionPermission,
  isHostExecutionGroup,
} from '../web-context.js';
import {
  createAutopilot,
  createAutopilotRun,
  createIssue,
  createIssueAgentRun,
  createIssueAgentRunEvent,
  createIssueEvent,
  deleteAutopilot,
  getAgentLinkById,
  getAutopilotById,
  getAutopilotRunById,
  listDueScheduledAutopilots,
  hasRunningAutopilotRun,
  getManagedRepoById,
  getRegisteredGroup,
  getUserHomeGroup,
  listAutopilotRuns,
  listAutopilotsByUser,
  updateAutopilot,
  updateAutopilotRun,
  updateIssueAgentRun,
  updateIssueLastRun,
} from '../db.js';
import { TIMEZONE } from '../config.js';
import { afterIssueEventCreated } from '../issue-notifier.js';
import { runIssueAgent } from '../issue-runner.js';
import { createOctoDeckEvent } from '../octodeck-events.js';
import { executeTeamRequest } from './agent-teams.js';

const autopilotRoutes = new Hono<{ Variables: Variables }>();

const webhookUsers = new Map<string, AuthUser>();

type ResolveWorkspaceResult =
  | { ok: true; workspaceJid: string; workspaceFolder: string }
  | { ok: false; error: { message: string; status: number } };

interface AutopilotTemplate {
  id: string;
  name: string;
  description: string;
  triggerType: AutopilotTriggerType;
  actionType: AutopilotActionType;
  trigger: Record<string, unknown> & { type: AutopilotTriggerType };
  action: Record<string, unknown> & { type: AutopilotActionType };
}

const BUILTIN_AUTOPILOT_TEMPLATES: AutopilotTemplate[] = [
  {
    id: 'daily-repo-health-check',
    name: '每日 repo health check',
    description: '每天上午创建一次仓库健康检查 Issue，提示 Agent 汇总构建、测试、未提交变更与风险点。',
    triggerType: 'schedule',
    actionType: 'create_issue',
    trigger: { type: 'schedule', schedule_type: 'cron', schedule_value: '0 9 * * *' },
    action: {
      type: 'create_issue',
      issue: {
        title: 'Daily repo health check',
        description: 'Check repo status, failing tests, stale branches, dependency risk, and summarize follow-up actions.',
        priority: 'medium',
      },
    },
  },
  {
    id: 'weekly-dependency-todo-scan',
    name: '每周 dependency/TODO scan',
    description: '每周一创建依赖与 TODO 扫描任务，适合定期治理技术债。',
    triggerType: 'schedule',
    actionType: 'create_issue',
    trigger: { type: 'schedule', schedule_type: 'cron', schedule_value: '0 10 * * 1' },
    action: {
      type: 'create_issue',
      issue: {
        title: 'Weekly dependency/TODO scan',
        description: 'Scan dependency updates, TODO/FIXME markers, deprecated APIs, and propose a prioritized cleanup plan.',
        priority: 'medium',
      },
    },
  },
  {
    id: 'webhook-code-review',
    name: 'webhook code review',
    description: '暴露 webhook 入口，收到外部代码变更事件后创建代码审查 Issue。',
    triggerType: 'webhook',
    actionType: 'create_issue',
    trigger: { type: 'webhook', token: 'change-me' },
    action: {
      type: 'create_issue',
      issue: {
        title: 'Webhook code review',
        description: 'Review the incoming webhook payload, identify risky code changes, and prepare review comments.',
        priority: 'high',
      },
    },
  },
];

function publicTemplate(template: AutopilotTemplate) {
  return {
    id: template.id,
    name: template.name,
    description: template.description,
    triggerType: template.triggerType,
    actionType: template.actionType,
    trigger: template.trigger,
    action: template.action,
  };
}

function isAgentLinkExecutionTarget(value: string | undefined | null): boolean {
  return (
    typeof value === 'string' &&
    (/^cl_[0-9a-f]{16}$/.test(value) ||
      /^runtime:cl_[0-9a-f]{16}:[^:]+$/.test(value) ||
      /^cl_[0-9a-f]{16}:[^:]+$/.test(value) ||
      /^provider:[^:]+$/.test(value))
  );
}

function deviceLinkIdFromExecutionTarget(value: string | undefined | null): string | undefined {
  if (typeof value !== 'string') return undefined;
  const direct = /^(cl_[0-9a-f]{16})$/.exec(value);
  if (direct) return direct[1];
  const runtime = /^runtime:(cl_[0-9a-f]{16}):[^:]+$/.exec(value);
  if (runtime) return runtime[1];
  const legacyRuntime = /^(cl_[0-9a-f]{16}):[^:]+$/.exec(value);
  if (legacyRuntime) return legacyRuntime[1];
  return undefined;
}

function ensureAutopilotOwner(autopilot: Autopilot | undefined, authUser: AuthUser): Autopilot | null {
  if (!autopilot || autopilot.created_by !== authUser.id) return null;
  return autopilot;
}

function actionType(action: Record<string, unknown>): AutopilotActionType {
  return action.type as AutopilotActionType;
}

function calculateNextScheduleRun(
  trigger: Record<string, unknown>,
  fromIso: string,
): string | null {
  if (trigger.type !== 'schedule') return null;
  const scheduleType = trigger.schedule_type;
  const scheduleValue = String(trigger.schedule_value ?? '').trim();
  if (scheduleType === 'once') return scheduleValue;
  if (scheduleType === 'interval') {
    return new Date(new Date(fromIso).getTime() + Number(scheduleValue)).toISOString();
  }
  if (scheduleType === 'cron') {
    return CronExpressionParser.parse(scheduleValue, {
      currentDate: new Date(fromIso),
      tz: TIMEZONE,
    }).next().toDate().toISOString();
  }
  return null;
}

function advanceScheduleTrigger(
  trigger: Record<string, unknown>,
  firedAtIso: string,
): Record<string, unknown> {
  if (trigger.type !== 'schedule') return trigger;
  const nextRun = trigger.schedule_type === 'once'
    ? null
    : calculateNextScheduleRun(trigger, firedAtIso);
  return { ...trigger, next_run: nextRun };
}

function withInitialSchedule(trigger: Record<string, unknown>, nowIso: string): Record<string, unknown> {
  if (trigger.type !== 'schedule') return trigger;
  return { ...trigger, next_run: calculateNextScheduleRun(trigger, nowIso) };
}

function autopilotOwnerAsUser(autopilot: Autopilot): AuthUser {
  return webhookUsers.get(autopilot.id) ?? {
    id: autopilot.created_by,
    username: autopilot.created_by,
    role: 'member',
    status: 'active',
    display_name: autopilot.created_by,
    permissions: [],
    must_change_password: false,
  } satisfies AuthUser;
}

function resolveWorkspace(
  authUser: AuthUser,
  input: { workspace_jid?: string; workspace_folder?: string },
): ResolveWorkspaceResult {
  let workspaceJid = input.workspace_jid;
  let workspaceFolder = input.workspace_folder;
  if (!workspaceJid || !workspaceFolder) {
    const home = getUserHomeGroup(authUser.id);
    if (!home) return { ok: false, error: { message: 'User has no home workspace', status: 400 } };
    workspaceJid = workspaceJid || home.jid;
    workspaceFolder = workspaceFolder || home.folder;
  }
  const group = getRegisteredGroup(workspaceJid);
  if (!group) return { ok: false, error: { message: 'Workspace not found', status: 404 } };
  if (group.folder !== workspaceFolder) {
    return { ok: false, error: { message: 'workspace_folder does not match workspace_jid', status: 400 } };
  }
  if (!canAccessGroup({ id: authUser.id, role: authUser.role }, group)) {
    return { ok: false, error: { message: 'Workspace not found', status: 404 } };
  }
  if (isHostExecutionGroup(group) && !hasHostExecutionPermission(authUser)) {
    return { ok: false, error: { message: 'Insufficient permissions for host execution mode', status: 403 } };
  }
  return { ok: true, workspaceJid, workspaceFolder };
}

function buildRunInput(
  authUser: AuthUser,
  issue: WorkspaceIssue,
  input: {
    agent_link_id?: string | null;
    agent_client_id?: string | null;
    execution_node?: string | null;
    backend?: string | null;
    selected_skills?: string[] | null;
  } = {},
): Pick<IssueAgentRun, 'agent_link_id' | 'agent_client_id' | 'execution_node' | 'backend' | 'selected_skills'> {
  const executionNode =
    input.execution_node ??
    issue.execution_node ??
    (input.agent_link_id || issue.agent_link_id
      ? `runtime:${input.agent_link_id ?? issue.agent_link_id}:${input.agent_client_id ?? issue.agent_client_id ?? 'claude-code'}`
      : null);
  if (executionNode && !isAgentLinkExecutionTarget(executionNode)) {
    throw new Error('Invalid execution_node format');
  }
  const resolvedLinkId = deviceLinkIdFromExecutionTarget(executionNode) ?? input.agent_link_id ?? issue.agent_link_id ?? null;
  if (resolvedLinkId) {
    const link = getAgentLinkById(resolvedLinkId);
    if (!link || link.userId !== authUser.id || link.revokedAt) {
      throw new Error('Selected agent not found');
    }
  }
  if (issue.project_device_link_id && resolvedLinkId && issue.project_device_link_id !== resolvedLinkId) {
    throw new Error('Project device path must run on its bound device');
  }
  return {
    agent_link_id: resolvedLinkId,
    agent_client_id: input.agent_client_id ?? issue.agent_client_id ?? null,
    execution_node: executionNode,
    backend: input.backend ?? issue.backend ?? null,
    selected_skills: input.selected_skills ?? issue.selected_skills ?? null,
  };
}

function enqueueIssueRun(issueId: string, runId: string): { ok: true } | { ok: false; error: string } {
  const deps = getWebDeps();
  if (!deps?.queue) return { ok: false, error: 'Server not initialized' };
  const runChatJid = `autopilot#issue:${runId}`;
  deps.queue.enqueueTask(runChatJid, `issue:${runId}`, async () => {
    await runIssueAgent(issueId, runId, {
      queue: deps.queue,
      broadcastStreamEvent: deps.broadcastStreamEvent,
    });
  });
  return { ok: true };
}

function createIssueFromAutopilot(
  authUser: AuthUser,
  issueInput: Record<string, unknown>,
  now: string,
): WorkspaceIssue {
  const workspace = resolveWorkspace(authUser, {
    workspace_jid: issueInput.workspace_jid as string | undefined,
    workspace_folder: issueInput.workspace_folder as string | undefined,
  });
  if (!workspace.ok) throw new Error(workspace.error.message);

  let repoFields: Partial<WorkspaceIssue> = {};
  const projectRepoId = issueInput.project_repo_id as string | null | undefined;
  if (projectRepoId) {
    const repo = getManagedRepoById(projectRepoId);
    if (!repo || repo.createdBy !== authUser.id) throw new Error('Project not found');
    repoFields = {
      project_repo_id: repo.id,
      project_git_url: repo.gitUrl ?? null,
      project_device_path: repo.devicePath ?? null,
      project_device_link_id: repo.deviceLinkId ?? null,
    };
  }

  const issue = createIssue({
    id: `iss_${crypto.randomBytes(8).toString('hex')}`,
    workspace_jid: workspace.workspaceJid,
    workspace_folder: workspace.workspaceFolder,
    title: String(issueInput.title),
    description: String(issueInput.description ?? ''),
    status: 'todo',
    priority: (issueInput.priority as WorkspaceIssue['priority']) ?? 'medium',
    assignee_user_id: null,
    due_date: null,
    ...repoFields,
    agent_link_id: (issueInput.agent_link_id as string | null | undefined) ?? null,
    agent_client_id: (issueInput.agent_client_id as string | null | undefined) ?? null,
    execution_node: (issueInput.execution_node as string | null | undefined) ?? null,
    backend: (issueInput.backend as string | null | undefined) ?? null,
    selected_skills: (issueInput.selected_skills as string[] | undefined) ?? [],
    created_by: authUser.id,
    created_at: now,
    updated_at: now,
  });
  const event = createIssueEvent({
    issue_id: issue.id,
    event_type: 'created',
    actor_id: authUser.id,
    actor_type: 'user',
    title: 'Issue created',
    summary: `${issue.status} · ${issue.priority}`,
    detail: { trigger: 'autopilot' },
    created_at: now,
  });
  afterIssueEventCreated(event, issue);
  return issue;
}

function startIssueRunFromAutopilot(
  authUser: AuthUser,
  issue: WorkspaceIssue,
  runInput: Record<string, unknown>,
  autopilotId: string,
): IssueAgentRun {
  const now = new Date().toISOString();
  const resolved = buildRunInput(authUser, issue, runInput);
  const run = createIssueAgentRun({
    id: `irun_${crypto.randomBytes(8).toString('hex')}`,
    issue_id: issue.id,
    workspace_jid: issue.workspace_jid,
    workspace_folder: issue.workspace_folder,
    ...resolved,
    status: 'queued',
    created_by: authUser.id,
    created_at: now,
  });
  updateIssueLastRun(issue.id, run.id, 'queued');
  createIssueAgentRunEvent({
    id: `irev_${crypto.randomBytes(8).toString('hex')}`,
    issue_id: issue.id,
    run_id: run.id,
    event_type: 'run_queued',
    title: 'Run queued',
    summary: 'Started by autopilot',
    detail: null,
    payload: { trigger: 'autopilot', autopilotId, issueId: issue.id },
    created_at: now,
  });
  const queued = enqueueIssueRun(issue.id, run.id);
  if (!queued.ok) {
    const completedAt = new Date().toISOString();
    updateIssueAgentRun(run.id, { status: 'error', error: queued.error, run_completed_at: completedAt });
    updateIssueLastRun(issue.id, run.id, 'error');
    throw new Error(queued.error);
  }
  return run;
}

function makeSyntheticContext(user: AuthUser, body: Record<string, unknown>) {
  return {
    get: (key: string) => (key === 'user' ? user : undefined),
    req: {
      json: async () => body,
    },
    json: (payload: unknown, status?: number) =>
      new Response(JSON.stringify(payload), {
        status: status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  };
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function getWebhookToken(c: any): string {
  const header = c.req.header?.('x-autopilot-token') ?? '';
  if (header) return header;
  const auth = c.req.header?.('authorization') ?? '';
  return auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
}

function broadcastAutopilotRunEvent(
  autopilot: Autopilot,
  runId: string,
  authUser: AuthUser,
): void {
  const run = getAutopilotRunByIdOrThrow(runId);
  getWebDeps()?.broadcastOctoDeckEvent?.(
    createOctoDeckEvent({
      type: `autopilot.run.${run.status}`,
      domain: 'autopilot',
      action: run.status,
      userId: authUser.id,
      runId: run.id,
      correlationId: autopilot.id,
      payload: {
        autopilotId: autopilot.id,
        autopilotName: autopilot.name,
        run,
        trigger: autopilot.trigger,
        action: autopilot.action,
      },
    }),
    new Set([authUser.id]),
  );
}

async function triggerAutopilot(
  autopilot: Autopilot,
  authUser: AuthUser,
  triggerType: AutopilotTriggerType,
  payload: Record<string, unknown>,
  retry?: { retryOf: string; attempt: number },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const now = new Date().toISOString();
  const run = createAutopilotRun({
    id: `aprun_${crypto.randomBytes(8).toString('hex')}`,
    autopilot_id: autopilot.id,
    trigger_type: triggerType,
    status: 'running',
    retry_of: retry?.retryOf ?? null,
    attempt: retry?.attempt ?? 1,
    payload,
    result: null,
    error: null,
    created_by: authUser.id,
    created_at: now,
  });

  try {
    const action = autopilot.action;
    const type = actionType(action);
    let response: Record<string, unknown> = {};
    if (type === 'create_issue') {
      const issue = createIssueFromAutopilot(authUser, action.issue as Record<string, unknown>, now);
      response = { issue };
      updateAutopilotRun(run.id, {
        status: 'success',
        result: { issueId: issue.id },
        completed_at: new Date().toISOString(),
      });
      broadcastAutopilotRunEvent(autopilot, run.id, authUser);
    } else if (type === 'run_agent') {
      const issue = createIssueFromAutopilot(authUser, action.issue as Record<string, unknown>, now);
      const issueRun = startIssueRunFromAutopilot(authUser, issue, (action.run as Record<string, unknown>) ?? {}, autopilot.id);
      response = { issue, issueRun };
      updateAutopilotRun(run.id, {
        status: 'success',
        result: { issueId: issue.id, issueRunId: issueRun.id },
        completed_at: new Date().toISOString(),
      });
      broadcastAutopilotRunEvent(autopilot, run.id, authUser);
    } else if (type === 'run_agent_team') {
      const syntheticContext = makeSyntheticContext(authUser, {
        prompt: String(action.prompt),
        roleAssignments: action.role_assignments ?? {},
      });
      const result = await executeTeamRequest(syntheticContext, String(action.team_id));
      if ('response' in result) {
        const body = (await result.response.json().catch(() => ({}))) as { error?: unknown };
        throw new Error(typeof body.error === 'string' ? body.error : `Agent team execution failed with ${result.response.status}`);
      }
      const teamRun = result.execution.runId ? { id: result.execution.runId } : null;
      response = { teamRun, execution: result.execution };
      updateAutopilotRun(run.id, {
        status: 'success',
        result: { teamRunId: result.execution.runId, status: result.execution.status },
        completed_at: new Date().toISOString(),
      });
      broadcastAutopilotRunEvent(autopilot, run.id, authUser);
    } else {
      throw new Error(`Unsupported autopilot action: ${type}`);
    }
    return { status: 200, body: { run: getAutopilotRunByIdOrThrow(run.id), ...response } };
  } catch (err) {
    updateAutopilotRun(run.id, {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
      completed_at: new Date().toISOString(),
    });
    broadcastAutopilotRunEvent(autopilot, run.id, authUser);
    return {
      status: 400,
      body: { run: getAutopilotRunByIdOrThrow(run.id), error: err instanceof Error ? err.message : String(err) },
    };
  }
}

export async function runDueAutopilots(options: { now?: string } = {}) {
  const now = options.now ?? new Date().toISOString();
  const results: Array<Record<string, unknown>> = [];
  for (const autopilot of listDueScheduledAutopilots(now)) {
    const scheduledAt = String(autopilot.trigger.next_run);
    const authUser = autopilotOwnerAsUser(autopilot);
    const nextTrigger = advanceScheduleTrigger(autopilot.trigger, scheduledAt);
    if (hasRunningAutopilotRun(autopilot.id)) {
      const skipRun = createAutopilotRun({
        id: `aprun_${crypto.randomBytes(8).toString('hex')}`,
        autopilot_id: autopilot.id,
        trigger_type: 'schedule',
        status: 'skipped',
        retry_of: null,
        attempt: 1,
        payload: { scheduledAt },
        result: null,
        error: null,
        skip_reason: 'previous run still running',
        created_by: authUser.id,
        created_at: now,
        completed_at: now,
      });
      updateAutopilot(autopilot.id, { trigger: nextTrigger }, new Date().toISOString());
      broadcastAutopilotRunEvent(autopilot, skipRun.id, authUser);
      results.push({
        run: skipRun,
        status: 200,
        autopilot: getAutopilotById(autopilot.id),
      });
      continue;
    }
    const result = await triggerAutopilot(autopilot, authUser, 'schedule', { scheduledAt });
    updateAutopilot(autopilot.id, { trigger: nextTrigger }, new Date().toISOString());
    results.push({
      ...result.body,
      status: result.status,
      autopilot: getAutopilotById(autopilot.id),
    });
  }
  return results;
}

autopilotRoutes.get('/', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  return c.json({ autopilots: listAutopilotsByUser(authUser.id) });
});

autopilotRoutes.get('/templates', authMiddleware, async (c) => {
  return c.json({ templates: BUILTIN_AUTOPILOT_TEMPLATES.map(publicTemplate) });
});

autopilotRoutes.post('/templates/:templateId/install', authMiddleware, async (c) => {
  const template = BUILTIN_AUTOPILOT_TEMPLATES.find(
    (item) => item.id === c.req.param('templateId'),
  );
  if (!template) return c.json({ error: 'Autopilot template not found' }, 404);

  const body = await c.req.json().catch(() => ({}));
  const authUser = c.get('user') as AuthUser;
  const now = new Date().toISOString();
  const name = typeof body.name === 'string' && body.name.trim()
    ? body.name.trim()
    : template.name;
  const description = typeof body.description === 'string'
    ? body.description
    : template.description;
  const triggerOverrides = body.trigger && typeof body.trigger === 'object' && !Array.isArray(body.trigger)
    ? body.trigger as Record<string, unknown>
    : {};
  const actionOverrides = body.action && typeof body.action === 'object' && !Array.isArray(body.action)
    ? body.action as Record<string, unknown>
    : {};
  const autopilot = createAutopilot({
    id: `ap_${crypto.randomBytes(8).toString('hex')}`,
    name,
    description,
    trigger: withInitialSchedule({ ...template.trigger, ...triggerOverrides }, now),
    action: { ...template.action, ...actionOverrides },
    status: 'active',
    created_by: authUser.id,
    created_at: now,
    updated_at: now,
  });
  webhookUsers.set(autopilot.id, authUser);
  return c.json({ autopilot, template: publicTemplate(template) });
});

autopilotRoutes.post('/', authMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const validation = AutopilotCreateSchema.safeParse(body);
  if (!validation.success) {
    return c.json({ error: 'Invalid request body', details: validation.error.format() }, 400);
  }
  const authUser = c.get('user') as AuthUser;
  const now = new Date().toISOString();
  const trigger = withInitialSchedule(validation.data.trigger, now);
  const autopilot = createAutopilot({
    id: `ap_${crypto.randomBytes(8).toString('hex')}`,
    name: validation.data.name,
    description: validation.data.description ?? null,
    trigger,
    action: validation.data.action,
    status: validation.data.status,
    created_by: authUser.id,
    created_at: now,
    updated_at: now,
  });
  webhookUsers.set(autopilot.id, authUser);
  return c.json({ autopilot });
});

autopilotRoutes.get('/:id', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const autopilot = ensureAutopilotOwner(getAutopilotById(c.req.param('id')), authUser);
  if (!autopilot) return c.json({ error: 'Autopilot not found' }, 404);
  return c.json({ autopilot });
});

autopilotRoutes.patch('/:id', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const autopilot = ensureAutopilotOwner(getAutopilotById(c.req.param('id')), authUser);
  if (!autopilot) return c.json({ error: 'Autopilot not found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const validation = AutopilotPatchSchema.safeParse(body);
  if (!validation.success) {
    return c.json({ error: 'Invalid request body', details: validation.error.format() }, 400);
  }
  const patch = { ...validation.data };
  if (patch.trigger) patch.trigger = withInitialSchedule(patch.trigger, new Date().toISOString()) as any;
  updateAutopilot(autopilot.id, patch);
  return c.json({ autopilot: getAutopilotById(autopilot.id) });
});

autopilotRoutes.delete('/:id', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const autopilot = ensureAutopilotOwner(getAutopilotById(c.req.param('id')), authUser);
  if (!autopilot) return c.json({ error: 'Autopilot not found' }, 404);
  deleteAutopilot(autopilot.id);
  return c.json({ success: true });
});

autopilotRoutes.get('/:id/runs', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const autopilot = ensureAutopilotOwner(getAutopilotById(c.req.param('id')), authUser);
  if (!autopilot) return c.json({ error: 'Autopilot not found' }, 404);
  return c.json({ runs: listAutopilotRuns(autopilot.id) });
});

autopilotRoutes.post('/:id/runs/:runId/retry', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const autopilot = ensureAutopilotOwner(getAutopilotById(c.req.param('id')), authUser);
  if (!autopilot) return c.json({ error: 'Autopilot not found' }, 404);
  if (autopilot.status !== 'active') return c.json({ error: 'Autopilot is not active' }, 409);

  const previousRun = getAutopilotRunById(c.req.param('runId'));
  if (!previousRun || previousRun.autopilot_id !== autopilot.id) {
    return c.json({ error: 'Autopilot run not found' }, 404);
  }
  if (previousRun.status !== 'error') {
    return c.json({ error: 'Only failed autopilot runs can be retried' }, 409);
  }
  if (hasRunningAutopilotRun(autopilot.id)) {
    return c.json({ error: 'Autopilot already has a running run' }, 409);
  }

  const result = await triggerAutopilot(
    autopilot,
    authUser,
    previousRun.trigger_type,
    previousRun.payload ?? {},
    { retryOf: previousRun.id, attempt: previousRun.attempt + 1 },
  );
  return c.json(result.body, result.status as any);
});

autopilotRoutes.post('/:id/trigger', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const autopilot = ensureAutopilotOwner(getAutopilotById(c.req.param('id')), authUser);
  if (!autopilot) return c.json({ error: 'Autopilot not found' }, 404);
  if (autopilot.status !== 'active') return c.json({ error: 'Autopilot is not active' }, 409);

  const body = await c.req.json().catch(() => ({}));
  const validation = AutopilotTriggerRequestSchema.safeParse(body);
  if (!validation.success) {
    return c.json({ error: 'Invalid request body', details: validation.error.format() }, 400);
  }
  const configuredType = autopilot.trigger.type as AutopilotTriggerType | undefined;
  const triggerType = validation.data.trigger_type ?? configuredType ?? 'manual';
  if (configuredType && configuredType !== triggerType) {
    return c.json({ error: 'trigger_type does not match autopilot trigger' }, 400);
  }
  const result = await triggerAutopilot(autopilot, authUser, triggerType, validation.data.payload);
  return c.json(result.body, result.status as any);
});

autopilotRoutes.post('/:id/webhook', async (c) => {
  const autopilot = getAutopilotById(c.req.param('id'));
  if (!autopilot || autopilot.status !== 'active' || autopilot.trigger.type !== 'webhook') {
    return c.json({ error: 'Webhook not found' }, 404);
  }
  const expectedToken = typeof autopilot.trigger.token === 'string' ? autopilot.trigger.token : '';
  const actualToken = getWebhookToken(c);
  if (!expectedToken || !constantTimeEquals(actualToken, expectedToken)) {
    return c.json({ error: 'Unauthorized webhook' }, 401);
  }
  const authUser = autopilotOwnerAsUser(autopilot);
  const payload = await c.req.json().catch(() => ({}));
  const normalizedPayload = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : { value: payload };
  const result = await triggerAutopilot(autopilot, authUser, 'webhook', normalizedPayload);
  return c.json(result.body, result.status as any);
});

autopilotRoutes.post('/:id/api', async (c) => {
  const autopilot = getAutopilotById(c.req.param('id'));
  if (!autopilot || autopilot.status !== 'active' || autopilot.trigger.type !== 'api') {
    return c.json({ error: 'API trigger not found' }, 404);
  }
  const expectedToken = typeof autopilot.trigger.token === 'string' ? autopilot.trigger.token : '';
  const actualToken = getWebhookToken(c);
  if (!expectedToken || !constantTimeEquals(actualToken, expectedToken)) {
    return c.json({ error: 'Unauthorized API trigger' }, 401);
  }
  const authUser = autopilotOwnerAsUser(autopilot);
  const payload = await c.req.json().catch(() => ({}));
  const normalizedPayload = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : { value: payload };
  const result = await triggerAutopilot(autopilot, authUser, 'api', normalizedPayload);
  return c.json(result.body, result.status as any);
});

function getAutopilotRunByIdOrThrow(id: string) {
  const run = getAutopilotRunById(id);
  if (run) return run;
  throw new Error('Autopilot run not found');
}

export default autopilotRoutes;
