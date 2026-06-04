import { Hono } from 'hono';
import * as crypto from 'node:crypto';

import { IssueAttachmentCreateSchema, IssueCreateSchema, IssuePatchSchema, IssueRunSchema } from '../schemas.js';
import { authMiddleware } from '../middleware/auth.js';
import type { AuthUser, IssueAgentRun, IssuePriority, IssueStatus, WorkspaceIssue } from '../types.js';
import type { Variables } from '../web-context.js';
import {
  canAccessGroup,
  getWebDeps,
  hasHostExecutionPermission,
  isHostExecutionGroup,
} from '../web-context.js';
import {
  createIssue,
  createIssueAttachment,
  createIssueAgentRun,
  createIssueAgentRunEvent,
  deleteIssueAttachment,
  deleteIssue,
  getAgentLinkById,
  getIssueAttachmentById,
  getIssueById,
  getManagedRepoById,
  getRegisteredGroup,
  getUserHomeGroup,
  listIssueAgentRuns,
  listIssueAgentRunEvents,
  listIssueAttachments,
  listIssues,
  updateIssue,
  updateIssueAgentRun,
  updateIssueLastRun,
} from '../db.js';
import { runIssueAgent } from '../issue-runner.js';

const issueRoutes = new Hono<{ Variables: Variables }>();

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

function parseCsv<T extends string>(value: string | undefined | null): T[] | undefined {
  if (!value) return undefined;
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean) as T[];
  return items.length ? items : undefined;
}

function ensureIssueAccess(issue: WorkspaceIssue, authUser: AuthUser): boolean {
  const group = getRegisteredGroup(issue.workspace_jid);
  if (!group) return authUser.role === 'admin';
  if (!canAccessGroup({ id: authUser.id, role: authUser.role }, group)) return false;
  if (isHostExecutionGroup(group) && !hasHostExecutionPermission(authUser)) return false;
  return true;
}

async function validateAndBuildRunInput(
  authUser: AuthUser,
  issue: WorkspaceIssue,
  input: {
    agent_link_id?: string | null;
    agent_client_id?: string | null;
    execution_node?: string | null;
    backend?: string | null;
    selected_skills?: string[] | null;
  } = {},
): Promise<Pick<IssueAgentRun, 'agent_link_id' | 'agent_client_id' | 'execution_node' | 'backend' | 'selected_skills'>> {
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

function enqueueIssueRun(issueId: string, runId: string): void {
  const deps = getWebDeps();
  if (!deps?.queue) {
    updateIssueAgentRunError(issueId, runId, 'Server not initialized');
    return;
  }
  const issue = getIssueById(issueId);
  if (!issue) return;
  deps.queue.enqueueTask(issue.workspace_jid, `issue:${runId}`, async () => {
    await runIssueAgent(issueId, runId, {
      queue: deps.queue,
      broadcastStreamEvent: deps.broadcastStreamEvent,
    });
  });
}

function updateIssueAgentRunError(issueId: string, runId: string, error: string): void {
  const now = new Date().toISOString();
  updateIssueAgentRun(runId, { status: 'error', error, run_completed_at: now });
  updateIssueLastRun(issueId, runId, 'error');
  recordIssueRunEvent(issueId, runId, 'run_failed', 'Run failed', error, error);
}

function recordIssueRunEvent(
  issueId: string,
  runId: string,
  eventType: string,
  title: string,
  summary?: string | null,
  detail?: string | null,
  payload?: Record<string, unknown> | null,
): void {
  createIssueAgentRunEvent({
    id: `irev_${crypto.randomBytes(8).toString('hex')}`,
    issue_id: issueId,
    run_id: runId,
    event_type: eventType,
    title,
    summary: summary ?? null,
    detail: detail ?? null,
    payload: payload ?? null,
    created_at: new Date().toISOString(),
  });
}

issueRoutes.get('/', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const statuses = parseCsv<IssueStatus>(c.req.query('status'));
  const priorities = parseCsv<IssuePriority>(c.req.query('priority'));
  const showDone = c.req.query('show_done') === 'true' || c.req.query('showDone') === 'true';
  const { issues, total } = listIssues({
    workspaceJid: c.req.query('workspace_jid') || undefined,
    query: c.req.query('q') || undefined,
    statuses,
    priorities,
    assigneeUserId: c.req.query('assignee') || undefined,
    projectRepoId: c.req.query('project') || undefined,
    showDone,
    sort: (c.req.query('sort') as any) || 'updated',
    direction: c.req.query('direction') === 'asc' ? 'asc' : 'desc',
    limit: Number(c.req.query('limit') || 100),
    offset: Number(c.req.query('offset') || 0),
  });
  const visible = issues.filter((issue) => ensureIssueAccess(issue, authUser));
  return c.json({ issues: visible, total: visible.length < issues.length ? visible.length : total });
});

issueRoutes.post('/', authMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const validation = IssueCreateSchema.safeParse(body);
  if (!validation.success) {
    return c.json({ error: 'Invalid request body', details: validation.error.format() }, 400);
  }
  const authUser = c.get('user') as AuthUser;
  let workspaceJid = validation.data.workspace_jid;
  let workspaceFolder = validation.data.workspace_folder;
  if (!workspaceJid || !workspaceFolder) {
    const home = getUserHomeGroup(authUser.id);
    if (!home) return c.json({ error: 'User has no home workspace' }, 400);
    workspaceJid = workspaceJid || home.jid;
    workspaceFolder = workspaceFolder || home.folder;
  }
  const group = getRegisteredGroup(workspaceJid);
  if (!group) return c.json({ error: 'Workspace not found' }, 404);
  if (group.folder !== workspaceFolder) {
    return c.json({ error: 'workspace_folder does not match workspace_jid' }, 400);
  }
  if (!canAccessGroup({ id: authUser.id, role: authUser.role }, group)) {
    return c.json({ error: 'Workspace not found' }, 404);
  }
  if (isHostExecutionGroup(group) && !hasHostExecutionPermission(authUser)) {
    return c.json({ error: 'Insufficient permissions for host execution mode' }, 403);
  }

  let repoFields: Partial<WorkspaceIssue> = {};
  if (validation.data.project_repo_id) {
    const repo = getManagedRepoById(validation.data.project_repo_id);
    if (!repo || repo.createdBy !== authUser.id) return c.json({ error: 'Project not found' }, 400);
    repoFields = {
      project_repo_id: repo.id,
      project_git_url: repo.gitUrl ?? null,
      project_device_path: repo.devicePath ?? null,
      project_device_link_id: repo.deviceLinkId ?? null,
    };
  }

  const now = new Date().toISOString();
  const issue = createIssue({
    id: `iss_${crypto.randomBytes(8).toString('hex')}`,
    workspace_jid: workspaceJid,
    workspace_folder: workspaceFolder,
    title: validation.data.title,
    description: validation.data.description,
    status: validation.data.status,
    priority: validation.data.priority,
    assignee_user_id: validation.data.assignee_user_id ?? null,
    due_date: validation.data.due_date ?? null,
    ...repoFields,
    agent_link_id: validation.data.agent_link_id ?? null,
    agent_client_id: validation.data.agent_client_id ?? null,
    execution_node: validation.data.execution_node ?? null,
    backend: validation.data.backend ?? null,
    selected_skills: validation.data.selected_skills,
    created_by: authUser.id,
    created_at: now,
    updated_at: now,
  });

  let run: IssueAgentRun | null = null;
  if (validation.data.start_agent) {
    try {
      const runInput = await validateAndBuildRunInput(authUser, issue, validation.data);
      run = createIssueAgentRun({
        id: `irun_${crypto.randomBytes(8).toString('hex')}`,
        issue_id: issue.id,
        workspace_jid: issue.workspace_jid,
        workspace_folder: issue.workspace_folder,
        ...runInput,
        status: 'queued',
        created_by: authUser.id,
        created_at: new Date().toISOString(),
      });
      updateIssueLastRun(issue.id, run.id, 'queued');
      recordIssueRunEvent(issue.id, run.id, 'run_queued', 'Run queued', 'Created from issue creation', null, {
        trigger: 'issue_create',
        issueId: issue.id,
      });
      enqueueIssueRun(issue.id, run.id);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  }

  return c.json({ issue, run });
});

issueRoutes.get('/:id', authMiddleware, async (c) => {
  const issue = getIssueById(c.req.param('id'));
  const authUser = c.get('user') as AuthUser;
  if (!issue || !ensureIssueAccess(issue, authUser)) return c.json({ error: 'Issue not found' }, 404);
  return c.json({ issue });
});

issueRoutes.patch('/:id', authMiddleware, async (c) => {
  const issue = getIssueById(c.req.param('id'));
  const authUser = c.get('user') as AuthUser;
  if (!issue || !ensureIssueAccess(issue, authUser)) return c.json({ error: 'Issue not found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const validation = IssuePatchSchema.safeParse(body);
  if (!validation.success) {
    return c.json({ error: 'Invalid request body', details: validation.error.format() }, 400);
  }
  const patch: Partial<WorkspaceIssue> = { ...validation.data };
  if (validation.data.project_repo_id !== undefined) {
    if (validation.data.project_repo_id) {
      const repo = getManagedRepoById(validation.data.project_repo_id);
      if (!repo || repo.createdBy !== authUser.id) return c.json({ error: 'Project not found' }, 400);
      patch.project_repo_id = repo.id;
      patch.project_git_url = repo.gitUrl ?? null;
      patch.project_device_path = repo.devicePath ?? null;
      patch.project_device_link_id = repo.deviceLinkId ?? null;
    } else {
      patch.project_git_url = null;
      patch.project_device_path = null;
      patch.project_device_link_id = null;
    }
  }
  updateIssue(issue.id, patch);
  return c.json({ issue: getIssueById(issue.id) });
});

issueRoutes.delete('/:id', authMiddleware, async (c) => {
  const issue = getIssueById(c.req.param('id'));
  const authUser = c.get('user') as AuthUser;
  if (!issue || !ensureIssueAccess(issue, authUser)) return c.json({ error: 'Issue not found' }, 404);
  deleteIssue(issue.id);
  return c.json({ success: true });
});

issueRoutes.get('/:id/runs', authMiddleware, async (c) => {
  const issue = getIssueById(c.req.param('id'));
  const authUser = c.get('user') as AuthUser;
  if (!issue || !ensureIssueAccess(issue, authUser)) return c.json({ error: 'Issue not found' }, 404);
  return c.json({ runs: listIssueAgentRuns(issue.id) });
});

issueRoutes.get('/:id/runs/:runId/events', authMiddleware, async (c) => {
  const issue = getIssueById(c.req.param('id'));
  const authUser = c.get('user') as AuthUser;
  if (!issue || !ensureIssueAccess(issue, authUser)) return c.json({ error: 'Issue not found' }, 404);
  const run = listIssueAgentRuns(issue.id).find((item) => item.id === c.req.param('runId'));
  if (!run) return c.json({ error: 'Run not found' }, 404);
  return c.json({ events: listIssueAgentRunEvents(run.id) });
});

issueRoutes.get('/:id/attachments', authMiddleware, async (c) => {
  const issue = getIssueById(c.req.param('id'));
  const authUser = c.get('user') as AuthUser;
  if (!issue || !ensureIssueAccess(issue, authUser)) return c.json({ error: 'Issue not found' }, 404);
  return c.json({ attachments: listIssueAttachments(issue.id) });
});

issueRoutes.post('/:id/attachments', authMiddleware, async (c) => {
  const issue = getIssueById(c.req.param('id'));
  const authUser = c.get('user') as AuthUser;
  if (!issue || !ensureIssueAccess(issue, authUser)) return c.json({ error: 'Issue not found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const validation = IssueAttachmentCreateSchema.safeParse(body);
  if (!validation.success) {
    return c.json({ error: 'Invalid request body', details: validation.error.format() }, 400);
  }
  const attachment = createIssueAttachment({
    id: `iatt_${crypto.randomBytes(8).toString('hex')}`,
    issue_id: issue.id,
    filename: validation.data.filename,
    mime_type: validation.data.mime_type,
    size_bytes: validation.data.size_bytes,
    data_url: validation.data.data_url,
    created_by: authUser.id,
  });
  return c.json({ attachment });
});

issueRoutes.delete('/:id/attachments/:attachmentId', authMiddleware, async (c) => {
  const issue = getIssueById(c.req.param('id'));
  const authUser = c.get('user') as AuthUser;
  if (!issue || !ensureIssueAccess(issue, authUser)) return c.json({ error: 'Issue not found' }, 404);
  const attachment = getIssueAttachmentById(c.req.param('attachmentId'));
  if (!attachment || attachment.issue_id !== issue.id) return c.json({ error: 'Attachment not found' }, 404);
  deleteIssueAttachment(attachment.id);
  return c.json({ success: true });
});

issueRoutes.post('/:id/run', authMiddleware, async (c) => {
  const issue = getIssueById(c.req.param('id'));
  const authUser = c.get('user') as AuthUser;
  if (!issue || !ensureIssueAccess(issue, authUser)) return c.json({ error: 'Issue not found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const validation = IssueRunSchema.safeParse(body);
  if (!validation.success) {
    return c.json({ error: 'Invalid request body', details: validation.error.format() }, 400);
  }
  try {
    const runInput = await validateAndBuildRunInput(authUser, issue, validation.data);
    const run = createIssueAgentRun({
      id: `irun_${crypto.randomBytes(8).toString('hex')}`,
      issue_id: issue.id,
      workspace_jid: issue.workspace_jid,
      workspace_folder: issue.workspace_folder,
      ...runInput,
      status: 'queued',
      created_by: authUser.id,
      created_at: new Date().toISOString(),
    });
    updateIssueLastRun(issue.id, run.id, 'queued');
    recordIssueRunEvent(issue.id, run.id, 'run_queued', 'Run queued', 'Started manually', null, {
      trigger: 'manual',
      issueId: issue.id,
    });
    enqueueIssueRun(issue.id, run.id);
    return c.json({ run });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

issueRoutes.post('/:id/runs/:runId/cancel', authMiddleware, async (c) => {
  const issue = getIssueById(c.req.param('id'));
  const authUser = c.get('user') as AuthUser;
  if (!issue || !ensureIssueAccess(issue, authUser)) return c.json({ error: 'Issue not found' }, 404);

  const run = listIssueAgentRuns(issue.id).find((item) => item.id === c.req.param('runId'));
  if (!run) return c.json({ error: 'Run not found' }, 404);
  if (run.status === 'success' || run.status === 'error' || run.status === 'canceled') {
    return c.json({ run });
  }

  const now = new Date().toISOString();
  const deps = getWebDeps();
  if (deps?.queue) {
    try {
      await deps.queue.cancelTaskRun(issue.workspace_jid, run.id);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  }

  updateIssueAgentRun(run.id, {
    status: 'canceled',
    error: 'Canceled by user',
    run_completed_at: now,
  });
  updateIssueLastRun(issue.id, run.id, 'canceled');
  recordIssueRunEvent(issue.id, run.id, 'run_canceled', 'Run canceled', 'Canceled by user', null, {
    userId: authUser.id,
  });
  const updatedRun = listIssueAgentRuns(issue.id).find((item) => item.id === run.id) ?? run;
  return c.json({ run: updatedRun });
});

export default issueRoutes;
