import crypto from 'crypto';

import { logger } from '../logger.js';
import type { AgentLinkSession } from './session.js';
import type {
  AgentDiscoverResultFrame,
  AgentInfo,
  RuntimeCapability,
  AgentSessionDeleteResultFrame,
  AgentSessionInfo,
  AgentSessionsResultFrame,
  AgentRunWorkspace,
  WorkspaceGitCommitResultFrame,
  WorkspaceGitStatusResultFrame,
  WorkspaceRepoSpec,
} from './protocol.js';

type RuntimeRequestKind =
  | 'discover'
  | 'sessions'
  | 'delete-session'
  | 'workspace-git-status'
  | 'workspace-git-commit';

interface PendingRuntimeRequest<T> {
  kind: RuntimeRequestKind;
  linkId: string;
  requestId: string;
  resolve: (result: T) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface AgentDiscoverResult {
  ok: boolean;
  agents: AgentInfo[];
  runtimeCapabilities?: RuntimeCapability[];
  error: string | null;
  durationMs: number;
}

export interface AgentSessionsResult {
  ok: boolean;
  sessions: AgentSessionInfo[];
  error: string | null;
  durationMs: number;
}

export interface AgentSessionDeleteResult {
  ok: boolean;
  deleted: boolean;
  error: string | null;
  durationMs: number;
}

export interface WorkspaceGitStatusResult {
  ok: boolean;
  workspacePath?: string;
  branch?: string;
  head?: string;
  clean: boolean;
  files: WorkspaceGitStatusResultFrame['files'];
  diffStat?: string;
  error: string | null;
  durationMs: number;
}

export interface WorkspaceGitCommitResult {
  ok: boolean;
  workspacePath?: string;
  branch?: string;
  commit?: string;
  clean: boolean;
  filesCommitted: number;
  error: string | null;
  durationMs: number;
}

const pendingDiscover = new Map<
  string,
  PendingRuntimeRequest<AgentDiscoverResult>
>();
const pendingSessions = new Map<
  string,
  PendingRuntimeRequest<AgentSessionsResult>
>();
const pendingDeletes = new Map<
  string,
  PendingRuntimeRequest<AgentSessionDeleteResult>
>();
const pendingWorkspaceGitStatus = new Map<
  string,
  PendingRuntimeRequest<WorkspaceGitStatusResult>
>();
const pendingWorkspaceGitCommit = new Map<
  string,
  PendingRuntimeRequest<WorkspaceGitCommitResult>
>();

export function requestAgentDiscover(
  session: AgentLinkSession,
  opts: { linkId: string; timeoutMs: number },
): Promise<AgentDiscoverResult> {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingDiscover.delete(requestId);
      reject(new Error('agent_discover_timeout'));
    }, opts.timeoutMs);
    pendingDiscover.set(requestId, {
      kind: 'discover',
      linkId: opts.linkId,
      requestId,
      resolve,
      reject,
      timer,
    });
    const ok = session.send({
      type: 'agent.discover.request',
      id: 0,
      requestId,
    });
    if (!ok) {
      clearTimeout(timer);
      pendingDiscover.delete(requestId);
      reject(new Error('send_failed'));
    }
  });
}

export function requestAgentSessions(
  session: AgentLinkSession,
  opts: {
    linkId: string;
    agentId?: string;
    workspace?: string;
    timeoutMs: number;
  },
): Promise<AgentSessionsResult> {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingSessions.delete(requestId);
      reject(new Error('agent_sessions_timeout'));
    }, opts.timeoutMs);
    pendingSessions.set(requestId, {
      kind: 'sessions',
      linkId: opts.linkId,
      requestId,
      resolve,
      reject,
      timer,
    });
    const ok = session.send({
      type: 'agent.sessions.request',
      id: 0,
      requestId,
      ...(opts.agentId ? { agentId: opts.agentId } : {}),
      ...(opts.workspace ? { workspace: opts.workspace } : {}),
    });
    if (!ok) {
      clearTimeout(timer);
      pendingSessions.delete(requestId);
      reject(new Error('send_failed'));
    }
  });
}

export function requestAgentSessionDelete(
  session: AgentLinkSession,
  opts: {
    linkId: string;
    agentId: string;
    workspace: string;
    sessionId: string;
    timeoutMs: number;
  },
): Promise<AgentSessionDeleteResult> {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingDeletes.delete(requestId);
      reject(new Error('agent_session_delete_timeout'));
    }, opts.timeoutMs);
    pendingDeletes.set(requestId, {
      kind: 'delete-session',
      linkId: opts.linkId,
      requestId,
      resolve,
      reject,
      timer,
    });
    const ok = session.send({
      type: 'agent.session.delete.request',
      id: 0,
      requestId,
      agentId: opts.agentId,
      workspace: opts.workspace,
      sessionId: opts.sessionId,
    });
    if (!ok) {
      clearTimeout(timer);
      pendingDeletes.delete(requestId);
      reject(new Error('send_failed'));
    }
  });
}

export function requestWorkspaceGitStatus(
  session: AgentLinkSession,
  opts: {
    linkId: string;
    workspace?: AgentRunWorkspace;
    workspaceRepos?: WorkspaceRepoSpec[];
    workspaceRepo?: WorkspaceRepoSpec;
    includeDiffStat?: boolean;
    includePatch?: boolean;
    timeoutMs: number;
  },
): Promise<WorkspaceGitStatusResult> {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingWorkspaceGitStatus.delete(requestId);
      reject(new Error('workspace_git_status_timeout'));
    }, opts.timeoutMs);
    pendingWorkspaceGitStatus.set(requestId, {
      kind: 'workspace-git-status',
      linkId: opts.linkId,
      requestId,
      resolve,
      reject,
      timer,
    });
    const ok = session.send({
      type: 'workspace.git.status.request',
      id: 0,
      requestId,
      ...(opts.workspace ? { workspace: opts.workspace } : {}),
      ...(opts.workspaceRepos ? { workspaceRepos: opts.workspaceRepos } : {}),
      ...(opts.workspaceRepo ? { workspaceRepo: opts.workspaceRepo } : {}),
      ...(opts.includeDiffStat !== undefined ? { includeDiffStat: opts.includeDiffStat } : {}),
      ...(opts.includePatch !== undefined ? { includePatch: opts.includePatch } : {}),
    });
    if (!ok) {
      clearTimeout(timer);
      pendingWorkspaceGitStatus.delete(requestId);
      reject(new Error('send_failed'));
    }
  });
}

export function requestWorkspaceGitCommit(
  session: AgentLinkSession,
  opts: {
    linkId: string;
    workspace?: AgentRunWorkspace;
    workspaceRepos?: WorkspaceRepoSpec[];
    workspaceRepo?: WorkspaceRepoSpec;
    message: string;
    timeoutMs: number;
  },
): Promise<WorkspaceGitCommitResult> {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingWorkspaceGitCommit.delete(requestId);
      reject(new Error('workspace_git_commit_timeout'));
    }, opts.timeoutMs);
    pendingWorkspaceGitCommit.set(requestId, {
      kind: 'workspace-git-commit',
      linkId: opts.linkId,
      requestId,
      resolve,
      reject,
      timer,
    });
    const ok = session.send({
      type: 'workspace.git.commit.request',
      id: 0,
      requestId,
      ...(opts.workspace ? { workspace: opts.workspace } : {}),
      ...(opts.workspaceRepos ? { workspaceRepos: opts.workspaceRepos } : {}),
      ...(opts.workspaceRepo ? { workspaceRepo: opts.workspaceRepo } : {}),
      message: opts.message,
    });
    if (!ok) {
      clearTimeout(timer);
      pendingWorkspaceGitCommit.delete(requestId);
      reject(new Error('send_failed'));
    }
  });
}

export function deliverAgentDiscoverResult(
  frame: AgentDiscoverResultFrame,
): void {
  const req = pendingDiscover.get(frame.requestId);
  if (!req) {
    logger.debug(
      { requestId: frame.requestId },
      'agent-runtime-rpc: drop discover result for unknown request',
    );
    return;
  }
  pendingDiscover.delete(frame.requestId);
  clearTimeout(req.timer);
  req.resolve({
    ok: frame.ok,
    agents: frame.agents,
    runtimeCapabilities: frame.runtimeCapabilities,
    error: frame.error,
    durationMs: frame.durationMs,
  });
}

export function deliverAgentSessionsResult(
  frame: AgentSessionsResultFrame,
): void {
  const req = pendingSessions.get(frame.requestId);
  if (!req) {
    logger.debug(
      { requestId: frame.requestId },
      'agent-runtime-rpc: drop sessions result for unknown request',
    );
    return;
  }
  pendingSessions.delete(frame.requestId);
  clearTimeout(req.timer);
  req.resolve({
    ok: frame.ok,
    sessions: frame.sessions,
    error: frame.error,
    durationMs: frame.durationMs,
  });
}

export function deliverAgentSessionDeleteResult(
  frame: AgentSessionDeleteResultFrame,
): void {
  const req = pendingDeletes.get(frame.requestId);
  if (!req) {
    logger.debug(
      { requestId: frame.requestId },
      'agent-runtime-rpc: drop delete result for unknown request',
    );
    return;
  }
  pendingDeletes.delete(frame.requestId);
  clearTimeout(req.timer);
  req.resolve({
    ok: frame.ok,
    deleted: frame.deleted,
    error: frame.error,
    durationMs: frame.durationMs,
  });
}

export function deliverWorkspaceGitStatusResult(
  frame: WorkspaceGitStatusResultFrame,
): void {
  const req = pendingWorkspaceGitStatus.get(frame.requestId);
  if (!req) {
    logger.debug(
      { requestId: frame.requestId },
      'agent-runtime-rpc: drop workspace git status result for unknown request',
    );
    return;
  }
  pendingWorkspaceGitStatus.delete(frame.requestId);
  clearTimeout(req.timer);
  req.resolve({
    ok: frame.ok,
    workspacePath: frame.workspacePath,
    branch: frame.branch,
    head: frame.head,
    clean: frame.clean,
    files: frame.files,
    diffStat: frame.diffStat,
    error: frame.error,
    durationMs: frame.durationMs,
  });
}

export function deliverWorkspaceGitCommitResult(
  frame: WorkspaceGitCommitResultFrame,
): void {
  const req = pendingWorkspaceGitCommit.get(frame.requestId);
  if (!req) {
    logger.debug(
      { requestId: frame.requestId },
      'agent-runtime-rpc: drop workspace git commit result for unknown request',
    );
    return;
  }
  pendingWorkspaceGitCommit.delete(frame.requestId);
  clearTimeout(req.timer);
  req.resolve({
    ok: frame.ok,
    workspacePath: frame.workspacePath,
    branch: frame.branch,
    commit: frame.commit,
    clean: frame.clean,
    filesCommitted: frame.filesCommitted,
    error: frame.error,
    durationMs: frame.durationMs,
  });
}

export function failAgentRuntimeRequestsForLink(
  linkId: string,
  reason: string,
): void {
  for (const bucket of [
    pendingDiscover,
    pendingSessions,
    pendingDeletes,
    pendingWorkspaceGitStatus,
    pendingWorkspaceGitCommit,
  ]) {
    for (const [requestId, req] of bucket) {
      if (req.linkId !== linkId) continue;
      bucket.delete(requestId);
      clearTimeout(req.timer);
      req.reject(new Error(reason));
    }
  }
}
