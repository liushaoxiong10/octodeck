import { Hono } from 'hono';

import {
  getAllTasks,
  getRegisteredGroup,
  getTaskRunLogs,
  listAgentTasks,
  listAgentTeamApprovals,
  listAgentTeamRuns,
  listIssueAgentRequests,
  listIssueAgentRunEvents,
  listIssueAgentRuns,
  listIssues,
} from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import { buildOrchestrationQualityEvaluations } from '../orchestration-control.js';
import { buildQualityScorecards } from '../quality-scorecards.js';
import type { QualityOutcome } from '../quality-evaluator.js';
import type { AuthUser, ScheduledTask, WorkspaceIssue } from '../types.js';
import type { Variables } from '../web-context.js';
import { canAccessGroup, hasHostExecutionPermission, isHostExecutionGroup } from '../web-context.js';

const qualityRoutes = new Hono<{ Variables: Variables }>();

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

function outcomeFilter(value: string | undefined): QualityOutcome | undefined {
  return value === 'passed' || value === 'failed' || value === 'partial' || value === 'needs_review' || value === 'inconclusive'
    ? value
    : undefined;
}

function collectQualityEvaluations(authUser: AuthUser) {
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
  const uniqueTeamRuns = teamRuns.filter((run, index, runs) => runs.findIndex((item) => item.id === run.id) === index);
  return buildOrchestrationQualityEvaluations({
    issues,
    issueRunsByIssue,
    issueEventsByRun,
    issueRequestsByIssue,
    tasks,
    taskLogsByTask,
    agentTasks,
    agentTeamRuns: uniqueTeamRuns,
    agentTeamApprovalsByRun: Object.fromEntries(uniqueTeamRuns.map((run) => [run.id, listAgentTeamApprovals(run.id)])),
  });
}

qualityRoutes.get('/evaluations', authMiddleware, (c) => {
  const authUser = c.get('user') as AuthUser;
  const outcome = outcomeFilter(c.req.query('outcome'));
  const source = c.req.query('source');
  const limitRaw = Number.parseInt(c.req.query('limit') || '100', 10);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, 500)) : 100;
  const evaluations = collectQualityEvaluations(authUser)
    .filter((evaluation) => !outcome || evaluation.outcome === outcome)
    .filter((evaluation) => !source || evaluation.source === source)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
  return c.json({ evaluations });
});

qualityRoutes.get('/scorecards', authMiddleware, (c) => {
  const authUser = c.get('user') as AuthUser;
  return c.json(buildQualityScorecards(collectQualityEvaluations(authUser)));
});

export default qualityRoutes;
