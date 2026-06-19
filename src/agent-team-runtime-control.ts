import type { AgentTeamWorkspacePolicy } from './agent-teams.js';

export interface AgentTeamRuntimeValidationRole {
  id: string;
  name: string;
  policy?: { workspacePolicy?: AgentTeamWorkspacePolicy };
}

export interface AgentTeamRuntimeValidationAssignment {
  runnerAgentId: string;
  linkId?: string;
  agentClientId?: string;
}

export interface AgentTeamRuntimeValidationBackend {
  supportsExecutionMode(mode: 'host'): boolean;
}

export interface AgentTeamRoleRuntimeTargetValidationInput {
  roles: AgentTeamRuntimeValidationRole[];
  roleAssignments?: Record<string, AgentTeamRuntimeValidationAssignment>;
  defaultRunnerAgentId: string;
  allowedBackends: string[];
  resolveBackend: (
    backendId: string,
  ) => AgentTeamRuntimeValidationBackend | undefined;
  resolveDeviceLink: (
    runnerAgentId: string,
    assignment?: AgentTeamRuntimeValidationAssignment,
    role?: AgentTeamRuntimeValidationRole,
  ) => string | undefined;
  resolveRuntimeTarget?: (
    runnerAgentId: string,
    assignment?: AgentTeamRuntimeValidationAssignment,
    role?: AgentTeamRuntimeValidationRole,
  ) => {
    ok: boolean;
    runtimeId: string | null;
    executionNode: string | null;
    blockedReason?: string;
    schedulingReason?: string;
  };
}

export interface AgentTeamRoleRuntimeTargetValidationResult {
  ok: boolean;
  errors: string[];
  status?: 400 | 403 | 404 | 409;
}

export interface AgentTeamTaskCancellationRegistration {
  runId: string;
  taskId: string;
  cancel: (reason: string) => void;
}

export interface AgentTeamRoleWorkspaceInput {
  teamId: string;
  runId: string;
  roleId: string;
  roleName: string;
  workspacePolicy?: AgentTeamWorkspacePolicy;
  runtimeGroupFolder?: string;
  runtimeRemoteToolCwd?: string;
}

export interface AgentTeamRoleWorkspaceDescriptor {
  policy: AgentTeamWorkspacePolicy;
  groupFolder: string;
  remoteToolCwd?: string;
  cleanupScope: 'session' | 'run';
}

export interface AgentTeamRunCancelResult {
  cancelledTaskIds: string[];
  errors: Array<{ taskId: string; error: string }>;
}

const cancellations = new Map<string, Map<string, (reason: string) => void>>();

export function registerAgentTeamTaskCancellation(
  registration: AgentTeamTaskCancellationRegistration,
): () => void {
  const runTasks = cancellations.get(registration.runId) ?? new Map();
  runTasks.set(registration.taskId, registration.cancel);
  cancellations.set(registration.runId, runTasks);

  return () => {
    const current = cancellations.get(registration.runId);
    if (!current) return;
    current.delete(registration.taskId);
    if (current.size === 0) cancellations.delete(registration.runId);
  };
}

export function cancelAgentTeamRun(
  runId: string,
  reason: string,
): AgentTeamRunCancelResult {
  const runTasks = cancellations.get(runId);
  if (!runTasks) return { cancelledTaskIds: [], errors: [] };

  cancellations.delete(runId);
  const cancelledTaskIds: string[] = [];
  const errors: AgentTeamRunCancelResult['errors'] = [];

  for (const [taskId, cancel] of runTasks.entries()) {
    try {
      cancel(reason);
      cancelledTaskIds.push(taskId);
    } catch (error) {
      errors.push({
        taskId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { cancelledTaskIds, errors };
}

export function clearAgentTeamRuntimeControlsForTests(): void {
  cancellations.clear();
}

function safeWorkspaceSegment(value: string): string {
  return (
    value
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'role'
  );
}

function joinWorkspacePath(base: string, ...parts: string[]): string {
  return [
    base.replace(/\/+$/g, ''),
    ...parts.map((part) => part.replace(/^\/+|\/+$/g, '')),
  ].join('/');
}

export function resolveAgentTeamRoleWorkspace(
  input: AgentTeamRoleWorkspaceInput,
): AgentTeamRoleWorkspaceDescriptor {
  const policy = input.workspacePolicy ?? 'none';
  const roleSegment = safeWorkspaceSegment(input.roleId || input.roleName);
  if (policy === 'sandbox' || policy === 'worktree' || policy === 'device') {
    const baseGroup = input.runtimeGroupFolder ?? `agent-team-${input.teamId}`;
    const groupFolder = joinWorkspacePath(baseGroup, input.runId, roleSegment);
    const remoteToolCwd = input.runtimeRemoteToolCwd
      ? joinWorkspacePath(
          input.runtimeRemoteToolCwd,
          '.octodeck',
          'agent-team-runs',
          input.runId,
          roleSegment,
        )
      : undefined;
    return { policy, groupFolder, remoteToolCwd, cleanupScope: 'run' };
  }

  return {
    policy,
    groupFolder:
      input.runtimeGroupFolder ?? `agent-team-${input.teamId}-${roleSegment}`,
    remoteToolCwd: input.runtimeRemoteToolCwd,
    cleanupScope: 'session',
  };
}

export function validateAgentTeamRoleRuntimeTargets(
  input: AgentTeamRoleRuntimeTargetValidationInput,
): AgentTeamRoleRuntimeTargetValidationResult {
  const errors: string[] = [];
  const rolesById = new Map(input.roles.map((role) => [role.id, role]));
  const assignments = input.roleAssignments ?? {};
  let status: AgentTeamRoleRuntimeTargetValidationResult['status'];

  const setStatus = (
    next: NonNullable<AgentTeamRoleRuntimeTargetValidationResult['status']>,
  ): void => {
    if (status === 403) return;
    if (next === 403) {
      status = 403;
      return;
    }
    if (status === 404) return;
    if (next === 404) {
      status = 404;
      return;
    }
    if (status === 409) return;
    if (next === 409) {
      status = 409;
      return;
    }
    status = status ?? next;
  };

  for (const roleId of Object.keys(assignments)) {
    if (!rolesById.has(roleId)) {
      errors.push(`role assignment ${roleId} does not match any team role`);
      setStatus(400);
    }
  }

  for (const role of input.roles) {
    const assignment = assignments[role.id];
    const runnerAgentId = assignment?.runnerAgentId ?? input.defaultRunnerAgentId;
    if (!input.allowedBackends.includes(runnerAgentId)) {
      errors.push(
        `role ${role.id} runner ${runnerAgentId} is not in allowedBackends`,
      );
      setStatus(403);
      continue;
    }

    const backend = input.resolveBackend(runnerAgentId);
    if (!backend) {
      errors.push(`role ${role.id} runner backend ${runnerAgentId} not found`);
      setStatus(404);
      continue;
    }

    if (!backend.supportsExecutionMode('host')) {
      errors.push(
        `role ${role.id} runner ${runnerAgentId} does not support host execution mode`,
      );
      setStatus(400);
    }

    if (
      role.policy?.workspacePolicy === 'device' &&
      !input.resolveDeviceLink(runnerAgentId, assignment, role)
    ) {
      errors.push(
        `role ${role.id} requires a device link for workspacePolicy=device`,
      );
      setStatus(409);
    }

    const runtimeDecision = input.resolveRuntimeTarget?.(runnerAgentId, assignment, role);
    if (runtimeDecision && !runtimeDecision.ok) {
      errors.push(
        `role ${role.id} runtime ${runtimeDecision.runtimeId ?? runtimeDecision.executionNode ?? 'unknown'} is not schedulable: ${runtimeDecision.blockedReason ?? runtimeDecision.schedulingReason ?? 'runtime_not_found'}`,
      );
      setStatus(409);
    }
  }

  return errors.length ? { ok: false, errors, status: status ?? 400 } : { ok: true, errors: [] };
}
