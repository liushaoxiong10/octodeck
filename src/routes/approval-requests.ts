import { Hono } from 'hono';

import { authMiddleware } from '../middleware/auth.js';
import type { AuthUser, IssueAgentRequest, WorkspaceIssue } from '../types.js';
import type { Variables } from '../web-context.js';
import { canAccessGroup, hasHostExecutionPermission, isHostExecutionGroup } from '../web-context.js';
import {
  getRegisteredGroup,
  listAgentTeamApprovals,
  listAgentTeamRuns,
  listIssueAgentRequests,
  listIssues,
} from '../db.js';

type ApprovalStatus = 'pending' | 'answered' | 'expired' | 'canceled' | 'approved' | 'rejected';

interface ApprovalCenterItem {
  id: string;
  source: 'issue' | 'agent_team';
  sourceId: string;
  runId?: string | null;
  taskId?: string;
  status: ApprovalStatus;
  title: string;
  summary?: string;
  riskLevel?: string;
  createdAt: string;
  updatedAt: string;
  href: string;
  decisionUrl: string;
  payload: unknown;
}

const approvalRoutes = new Hono<{ Variables: Variables }>();

function statusFilter(value: string | undefined | null): ApprovalStatus | undefined {
  return value === 'pending' ||
    value === 'answered' ||
    value === 'expired' ||
    value === 'canceled' ||
    value === 'approved' ||
    value === 'rejected'
    ? value
    : undefined;
}

function canAccessIssue(issue: WorkspaceIssue, authUser: AuthUser): boolean {
  const group = getRegisteredGroup(issue.workspace_jid);
  if (!group) return authUser.role === 'admin';
  if (!canAccessGroup({ id: authUser.id, role: authUser.role }, group)) return false;
  if (isHostExecutionGroup(group) && !hasHostExecutionPermission(authUser)) return false;
  return true;
}

function issueApprovalItem(issue: WorkspaceIssue, request: IssueAgentRequest): ApprovalCenterItem {
  const title = request.title?.trim() || (request.kind === 'permission' ? 'Permission approval required' : 'Clarification required');
  return {
    id: request.id,
    source: 'issue',
    sourceId: issue.id,
    runId: request.run_id,
    status: request.status,
    title,
    summary: request.summary ?? request.detail ?? request.answer ?? undefined,
    createdAt: request.created_at,
    updatedAt: request.answered_at ?? request.created_at,
    href: `/issues/${issue.id}`,
    decisionUrl: `/api/issues/${issue.id}/runs/${request.run_id}/approval-requests/${request.id}/decision`,
    payload: request,
  };
}

function agentTeamApprovalItem(approval: Record<string, unknown>): ApprovalCenterItem | null {
  const id = typeof approval.id === 'string' ? approval.id : null;
  const runId = typeof approval.runId === 'string' ? approval.runId : null;
  if (!id || !runId) return null;
  const status = approval.status === 'approved' || approval.status === 'rejected' ? approval.status : 'pending';
  const title = typeof approval.title === 'string' && approval.title.trim() ? approval.title : 'Agent Team approval required';
  const description = typeof approval.description === 'string' ? approval.description : undefined;
  const createdAt = typeof approval.createdAt === 'string' ? approval.createdAt : new Date(0).toISOString();
  const resolvedAt = typeof approval.resolvedAt === 'string' ? approval.resolvedAt : undefined;
  return {
    id,
    source: 'agent_team',
    sourceId: runId,
    runId,
    taskId: typeof approval.taskId === 'string' ? approval.taskId : undefined,
    status,
    title,
    summary: description,
    riskLevel: typeof approval.riskLevel === 'string' ? approval.riskLevel : undefined,
    createdAt,
    updatedAt: resolvedAt ?? createdAt,
    href: `/agents?runId=${encodeURIComponent(runId)}`,
    decisionUrl: `/api/agent-teams/runs/${runId}/approvals/${id}`,
    payload: approval,
  };
}

approvalRoutes.get('/', authMiddleware, (c) => {
  const authUser = c.get('user') as AuthUser;
  const status = statusFilter(c.req.query('status'));
  const limitRaw = Number.parseInt(c.req.query('limit') || '100', 10);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, 200)) : 100;
  const approvals: ApprovalCenterItem[] = [];

  const issues = listIssues({ limit: 200, showDone: true }).issues.filter((issue) => canAccessIssue(issue, authUser));
  for (const issue of issues) {
    const issueStatus = status === 'approved' || status === 'rejected' ? undefined : status;
    const requests = listIssueAgentRequests(issue.id, issueStatus ? { status: issueStatus as IssueAgentRequest['status'] } : {});
    for (const request of requests) {
      if (request.kind === 'permission') approvals.push(issueApprovalItem(issue, request));
    }
  }

  const teamRuns = [
    ...listAgentTeamRuns({ userId: authUser.id, status: 'waiting_approval', limit: 100 }),
    ...listAgentTeamRuns({ userId: authUser.id, status: 'running', limit: 100 }),
    ...listAgentTeamRuns({ userId: authUser.id, status: 'cancelled', limit: 100 }),
    ...listAgentTeamRuns({ userId: authUser.id, status: 'success', limit: 100 }),
  ];
  const seenRuns = new Set<string>();
  for (const run of teamRuns) {
    if (seenRuns.has(run.id)) continue;
    seenRuns.add(run.id);
    for (const approval of listAgentTeamApprovals(run.id)) {
      const item = agentTeamApprovalItem(approval);
      if (item && (!status || item.status === status)) approvals.push(item);
    }
  }

  approvals.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return c.json({ approvals: approvals.slice(0, limit) });
});

export default approvalRoutes;
