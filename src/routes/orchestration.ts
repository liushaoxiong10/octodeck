import { Hono } from 'hono';

import {
  getAllTasks,
  getIssueById,
  getRegisteredGroup,
  getTaskById,
  getTaskRunLogs,
  listAgentTasks,
  listAgentTeamApprovals,
  listAgentTeamRuns,
  listIssueAgentRequests,
  listIssueAgentRunEvents,
  listIssueAgentRuns,
  listIssues,
} from '../db.js';
import { buildOrchestrationControlSnapshot, type OrchestrationControlSource } from '../orchestration-control.js';
import { evaluateOrchestrationPolicy } from '../orchestration-policy.js';
import { authMiddleware } from '../middleware/auth.js';
import type { AuthUser, ScheduledTask, WorkspaceIssue } from '../types.js';
import type { Variables } from '../web-context.js';
import { canAccessGroup, hasHostExecutionPermission, isHostExecutionGroup } from '../web-context.js';
import { buildRegistryGovernanceSnapshot } from './registry.js';

const orchestrationRoutes = new Hono<{ Variables: Variables }>();

function canAccessIssue(issue: WorkspaceIssue, authUser: AuthUser): boolean {
  const group = getRegisteredGroup(issue.workspace_jid);
  if (!group) return authUser.role === 'admin';
  if (!canAccessGroup({ id: authUser.id, role: authUser.role }, group)) return false;
  if (isHostExecutionGroup(group) && !hasHostExecutionPermission(authUser)) return false;
  return true;
}

function canAccessTask(task: ScheduledTask, authUser: AuthUser): boolean {
  if (task.execution_mode === 'host' && authUser.role !== 'admin') return false;
  const group = getRegisteredGroup(task.chat_jid);
  if (!group) return authUser.role === 'admin';
  if (!canAccessGroup({ id: authUser.id, role: authUser.role }, group)) return false;
  if (isHostExecutionGroup(group) && !hasHostExecutionPermission(authUser)) return false;
  return true;
}

function sourceFilter(value: string | undefined | null): OrchestrationControlSource | undefined {
  return value === 'issue' || value === 'task' || value === 'agent_team' ? value : undefined;
}

orchestrationRoutes.get('/preview', authMiddleware, (c) => {
  // Supports query examples: /api/orchestration/preview?source=issue&id=iss_1 and source=task.
  const source = c.req.query('source');
  const id = c.req.query('id');
  if ((source !== 'issue' && source !== 'task') || !id) {
    return c.json({ error: 'source=issue|task and id are required' }, 400);
  }

  const user = c.get('user') as AuthUser;
  const { registry } = buildRegistryGovernanceSnapshot(user);

  if (source === 'issue') {
    const issue = getIssueById(id);
    if (!issue || !canAccessIssue(issue, user)) return c.json({ error: 'issue not found' }, 404);
    const decision = evaluateOrchestrationPolicy({
      source,
      item: {
        id: issue.id,
        title: issue.title,
        description: issue.description,
        priority: issue.priority,
        selectedSkillIds: issue.selected_skills,
        agentClientId: issue.agent_client_id ?? null,
        executionNode: issue.execution_node ?? null,
      },
      registry,
    });
    return c.json({ decision });
  }

  const task = getTaskById(id);
  if (!task || !canAccessTask(task, user)) return c.json({ error: 'task not found' }, 404);
  const decision = evaluateOrchestrationPolicy({
    source,
    item: {
      id: task.id,
      title: task.prompt,
      description: task.script_command,
      priority: null,
      selectedSkillIds: null,
      agentClientId: task.agent_client_id ?? null,
      executionNode: task.execution_node ?? null,
    },
    registry,
  });

  return c.json({ decision });
});

orchestrationRoutes.get('/events', authMiddleware, (c) => {
  const authUser = c.get('user') as AuthUser;
  const limitRaw = Number.parseInt(c.req.query('limit') || '100', 10);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, 500)) : 100;
  const timelineSource = sourceFilter(c.req.query('source'));
  const timelineSourceId = c.req.query('sourceId') || c.req.query('id') || undefined;

  const issues = listIssues({ limit: 300, showDone: true }).issues.filter((issue) => canAccessIssue(issue, authUser));
  const tasks = getAllTasks().filter((task) => canAccessTask(task, authUser));
  const visibleIssueIds = new Set(issues.map((issue) => issue.id));
  const visibleTaskIds = new Set(tasks.map((task) => task.id));
  const issueRunsByIssue = Object.fromEntries(issues.map((issue) => [issue.id, listIssueAgentRuns(issue.id)]));
  const issueEventsByRun: Record<string, ReturnType<typeof listIssueAgentRunEvents>> = {};
  for (const runs of Object.values(issueRunsByIssue)) {
    for (const run of runs) issueEventsByRun[run.id] = listIssueAgentRunEvents(run.id);
  }
  const issueRequestsByIssue = Object.fromEntries(issues.map((issue) => [issue.id, listIssueAgentRequests(issue.id)]));
  const taskLogsByTask = Object.fromEntries(tasks.map((task) => [task.id, getTaskRunLogs(task.id, 50)]));
  const agentTasks = listAgentTasks({ limit: 500 }).filter((task) => {
    if (task.source_type === 'issue_run') return visibleIssueIds.has(task.source_ref);
    if (task.source_type === 'scheduled_task') return visibleTaskIds.has(task.source_ref);
    return authUser.role === 'admin' || task.actor_user_id === authUser.id;
  });
  const teamRuns = [
    ...listAgentTeamRuns({ userId: authUser.id, status: 'waiting_approval', limit: 100 }),
    ...listAgentTeamRuns({ userId: authUser.id, status: 'running', limit: 100 }),
    ...listAgentTeamRuns({ userId: authUser.id, status: 'success', limit: 100 }),
    ...listAgentTeamRuns({ userId: authUser.id, status: 'cancelled', limit: 100 }),
  ];
  const seenTeamRuns = new Set<string>();
  const uniqueTeamRuns = teamRuns.filter((run) => {
    if (seenTeamRuns.has(run.id)) return false;
    seenTeamRuns.add(run.id);
    return true;
  });
  const agentTeamApprovalsByRun = Object.fromEntries(uniqueTeamRuns.map((run) => [run.id, listAgentTeamApprovals(run.id)]));
  const snapshot = buildOrchestrationControlSnapshot({
    issues,
    issueRunsByIssue,
    issueEventsByRun,
    issueRequestsByIssue,
    tasks,
    taskLogsByTask,
    agentTasks,
    agentTeamRuns: uniqueTeamRuns,
    agentTeamApprovalsByRun,
    limit,
    timeline: timelineSource && timelineSourceId ? { source: timelineSource, sourceId: timelineSourceId } : undefined,
  });
  return c.json(snapshot);
});

orchestrationRoutes.get('/timeline', authMiddleware, (c) => {
  const source = sourceFilter(c.req.query('source'));
  const id = c.req.query('id') || c.req.query('sourceId');
  if (!source || !id) return c.json({ error: 'source=issue|task|agent_team and id are required' }, 400);
  const params = new URLSearchParams({ source, id, limit: c.req.query('limit') || '100' });
  return c.redirect(`/api/orchestration/events?${params.toString()}`);
});

orchestrationRoutes.post('/re-evaluate', authMiddleware, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { source?: string; id?: string };
  if ((body.source !== 'issue' && body.source !== 'task') || !body.id) {
    return c.json({ error: 'source=issue|task and id are required' }, 400);
  }
  const user = c.get('user') as AuthUser;
  if (body.source === 'issue') {
    const issue = getIssueById(body.id);
    if (!issue || !canAccessIssue(issue, user)) return c.json({ error: 'issue not found' }, 404);
    const { registry } = buildRegistryGovernanceSnapshot(user);
    const decision = evaluateOrchestrationPolicy({
      source: 'issue',
      item: {
        id: issue.id,
        title: issue.title,
        description: issue.description,
        priority: issue.priority,
        selectedSkillIds: issue.selected_skills,
        agentClientId: issue.agent_client_id ?? null,
        executionNode: issue.execution_node ?? null,
      },
      registry,
    });
    return c.json({ decision, sideEffect: 'none', evaluatedAt: new Date().toISOString() });
  }

  const task = getTaskById(body.id);
  if (!task || !canAccessTask(task, user)) return c.json({ error: 'task not found' }, 404);
  const { registry } = buildRegistryGovernanceSnapshot(user);
  const decision = evaluateOrchestrationPolicy({
    source: 'task',
    item: {
      id: task.id,
      title: task.prompt,
      description: task.script_command,
      priority: null,
      selectedSkillIds: null,
      agentClientId: task.agent_client_id ?? null,
      executionNode: task.execution_node ?? null,
    },
    registry,
  });
  return c.json({ decision, sideEffect: 'none', evaluatedAt: new Date().toISOString() });
});

export default orchestrationRoutes;
