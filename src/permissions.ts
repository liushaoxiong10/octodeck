import { Permission, PermissionTemplateKey, UserRole } from './types.js';
import type { AgentTaskScopedToken } from './types.js';

export type RunPermissionOperation =
  | 'filesystem.read'
  | 'filesystem.write'
  | 'network.request'
  | 'secret.read'
  | 'shell.exec'
  | 'git.status'
  | 'git.commit'
  | 'git.push'
  | 'pull_request.create';

export type RunPermissionDecision = 'allow' | 'deny' | 'approval_required';
export type RunPermissionRiskLevel = 'low' | 'medium' | 'high';

export interface RunPermissionPolicy {
  filesystem?: 'none' | 'read' | 'workspace' | 'write';
  workspaceFolder?: string | null;
  repoId?: string | null;
  network?: 'disabled' | 'allowlist' | 'enabled';
  networkAllowlist?: string[];
  secrets?: 'none' | 'scoped' | 'all';
  allowedSecretKeys?: string[];
  shell?: 'disabled' | 'safe' | 'approval' | 'enabled';
  git?: 'read' | 'commit' | 'push_approval' | 'push';
}

export interface RunPermissionRequest {
  operation: RunPermissionOperation;
  workspaceFolder?: string | null;
  repoId?: string | null;
  host?: string | null;
  secretKey?: string | null;
  command?: string | null;
}

export interface RunPermissionEvaluation {
  decision: RunPermissionDecision;
  reason: string;
  riskLevel: RunPermissionRiskLevel;
}

export interface AgentTaskScopedTokenPermissionInput {
  task_id: string;
  agent_link_id?: string | null;
  agent_client_id?: string | null;
  workspace_folder?: string | null;
  repo_id?: string | null;
  request: RunPermissionRequest;
}

export interface AgentTaskScopedApprovalRequestInput
  extends Omit<AgentTaskScopedTokenPermissionInput, 'request'> {
  payload?: Record<string, unknown> | null;
}

export type AgentTaskScopedApprovalRequestEvaluation = {
  ok: boolean;
  tokenId: string | null;
  request: RunPermissionRequest | null;
  evaluation: RunPermissionEvaluation;
};

export const ALL_PERMISSIONS: Permission[] = [
  'manage_system_config',
  'manage_group_env',
  'manage_users',
  'manage_invites',
  'view_audit_log',
  'manage_billing',
];

export const PERMISSION_TEMPLATES: Record<
  PermissionTemplateKey,
  {
    key: PermissionTemplateKey;
    label: string;
    role: UserRole;
    permissions: Permission[];
  }
> = {
  admin_full: {
    key: 'admin_full',
    label: '管理员（全权限）',
    role: 'admin',
    permissions: [...ALL_PERMISSIONS],
  },
  member_basic: {
    key: 'member_basic',
    label: '普通成员（基础权限）',
    role: 'member',
    permissions: [],
  },
  ops_manager: {
    key: 'ops_manager',
    label: '运维管理员（配置+工作区环境）',
    role: 'member',
    permissions: ['manage_system_config', 'manage_group_env'],
  },
  user_admin: {
    key: 'user_admin',
    label: '用户管理员（用户+邀请码+审计）',
    role: 'member',
    permissions: ['manage_users', 'manage_invites', 'view_audit_log'],
  },
};

export const ROLE_DEFAULT_PERMISSIONS: Record<UserRole, Permission[]> = {
  admin: [...ALL_PERMISSIONS],
  member: [],
};

export function normalizePermissions(input: unknown): Permission[] {
  if (!Array.isArray(input)) return [];
  const set = new Set<Permission>();
  for (const value of input) {
    if (typeof value !== 'string') continue;
    if ((ALL_PERMISSIONS as string[]).includes(value)) {
      set.add(value as Permission);
    }
  }
  return Array.from(set);
}

export function getDefaultPermissions(role: UserRole): Permission[] {
  return [...(ROLE_DEFAULT_PERMISSIONS[role] || [])];
}

export function resolveTemplate(
  template: PermissionTemplateKey | undefined,
): { role: UserRole; permissions: Permission[] } | null {
  if (!template) return null;
  const item = PERMISSION_TEMPLATES[template];
  if (!item) return null;
  return { role: item.role, permissions: [...item.permissions] };
}

export function hasPermission(
  user: { role: UserRole; permissions: Permission[] },
  permission: Permission,
): boolean {
  if (user.role === 'admin') return true;
  return user.permissions.includes(permission);
}

function scopeMatches(
  policy: RunPermissionPolicy,
  request: RunPermissionRequest,
): RunPermissionEvaluation | null {
  if (
    policy.workspaceFolder &&
    request.workspaceFolder &&
    request.workspaceFolder !== policy.workspaceFolder
  ) {
    return {
      decision: 'deny',
      reason: 'workspace_scope_mismatch',
      riskLevel: 'medium',
    };
  }
  if (policy.repoId && request.repoId && request.repoId !== policy.repoId) {
    return { decision: 'deny', reason: 'repo_scope_mismatch', riskLevel: 'medium' };
  }
  return null;
}

function shellLooksHighRisk(command: string | null | undefined): boolean {
  if (!command) return false;
  return /\b(rm\s+-rf|sudo|chmod\s+777|curl\b.*\|\s*sh|wget\b.*\|\s*sh)\b/i.test(command);
}

export function evaluateRunPermissionPolicy(
  policy: RunPermissionPolicy,
  request: RunPermissionRequest,
): RunPermissionEvaluation {
  const scopedDenied = scopeMatches(policy, request);
  if (scopedDenied) return scopedDenied;

  if (request.operation.startsWith('filesystem.')) {
    const mode = policy.filesystem ?? 'workspace';
    if (mode === 'none') return { decision: 'deny', reason: 'filesystem_disabled', riskLevel: 'low' };
    if (request.operation === 'filesystem.write' && mode === 'read') {
      return { decision: 'deny', reason: 'filesystem_readonly', riskLevel: 'medium' };
    }
    if (mode === 'workspace' && policy.workspaceFolder && request.workspaceFolder === policy.workspaceFolder) {
      return { decision: 'allow', reason: 'workspace_scope_matched', riskLevel: 'low' };
    }
    return { decision: 'allow', reason: 'filesystem_allowed', riskLevel: request.operation === 'filesystem.write' ? 'medium' : 'low' };
  }

  if (request.operation === 'network.request') {
    const mode = policy.network ?? 'disabled';
    if (mode === 'disabled') return { decision: 'deny', reason: 'network_disabled', riskLevel: 'medium' };
    if (mode === 'allowlist') {
      const allowed = !!request.host && (policy.networkAllowlist ?? []).includes(request.host);
      return allowed
        ? { decision: 'allow', reason: 'network_host_allowed', riskLevel: 'medium' }
        : { decision: 'deny', reason: 'network_host_not_allowed', riskLevel: 'medium' };
    }
    return { decision: 'allow', reason: 'network_allowed', riskLevel: 'medium' };
  }

  if (request.operation === 'secret.read') {
    const mode = policy.secrets ?? 'none';
    if (mode === 'none') return { decision: 'deny', reason: 'secrets_disabled', riskLevel: 'high' };
    if (mode === 'scoped') {
      const allowed = !!request.secretKey && (policy.allowedSecretKeys ?? []).includes(request.secretKey);
      return allowed
        ? { decision: 'allow', reason: 'secret_in_scope', riskLevel: 'high' }
        : { decision: 'deny', reason: 'secret_not_in_scope', riskLevel: 'high' };
    }
    return { decision: 'approval_required', reason: 'secret_access_requires_approval', riskLevel: 'high' };
  }

  if (request.operation === 'shell.exec') {
    const mode = policy.shell ?? 'approval';
    if (mode === 'disabled') return { decision: 'deny', reason: 'shell_disabled', riskLevel: 'high' };
    if (mode === 'enabled') return { decision: 'allow', reason: 'shell_allowed', riskLevel: 'high' };
    if (mode === 'safe' && !shellLooksHighRisk(request.command)) {
      return { decision: 'allow', reason: 'shell_safe_command_allowed', riskLevel: 'medium' };
    }
    return { decision: 'approval_required', reason: 'shell_requires_approval', riskLevel: 'high' };
  }

  if (request.operation.startsWith('git.')) {
    const mode = policy.git ?? 'read';
    if (request.operation === 'git.status') return { decision: 'allow', reason: 'git_read_allowed', riskLevel: 'low' };
    if (request.operation === 'git.commit') {
      return mode === 'commit' || mode === 'push_approval' || mode === 'push'
        ? { decision: 'allow', reason: 'git_commit_allowed', riskLevel: 'medium' }
        : { decision: 'deny', reason: 'git_commit_disabled', riskLevel: 'medium' };
    }
    if (request.operation === 'git.push') {
      if (mode === 'push') return { decision: 'allow', reason: 'git_push_allowed', riskLevel: 'high' };
      if (mode === 'push_approval') return { decision: 'approval_required', reason: 'git_push_requires_approval', riskLevel: 'high' };
      return { decision: 'deny', reason: 'git_push_disabled', riskLevel: 'high' };
    }
  }

  if (request.operation === 'pull_request.create') {
    const mode = policy.git ?? 'read';
    if (mode === 'push') return { decision: 'allow', reason: 'pull_request_create_allowed', riskLevel: 'high' };
    if (mode === 'push_approval') {
      return { decision: 'approval_required', reason: 'pull_request_create_requires_approval', riskLevel: 'high' };
    }
    return { decision: 'deny', reason: 'pull_request_create_disabled', riskLevel: 'high' };
  }

  return { decision: 'deny', reason: 'operation_not_allowed', riskLevel: 'medium' };
}

function tokenScopeDenied(
  reason: string,
  riskLevel: RunPermissionRiskLevel = 'high',
): RunPermissionEvaluation {
  return { decision: 'deny', reason, riskLevel };
}

export function evaluateAgentTaskScopedTokenPermission(
  token: AgentTaskScopedToken,
  input: AgentTaskScopedTokenPermissionInput,
): RunPermissionEvaluation {
  if (token.task_id !== input.task_id) return tokenScopeDenied('token_task_mismatch');
  if (token.agent_link_id && input.agent_link_id && token.agent_link_id !== input.agent_link_id) {
    return tokenScopeDenied('token_agent_link_mismatch');
  }
  if (token.agent_client_id && input.agent_client_id && token.agent_client_id !== input.agent_client_id) {
    return tokenScopeDenied('token_agent_client_mismatch');
  }
  if (token.workspace_folder && input.workspace_folder && token.workspace_folder !== input.workspace_folder) {
    return tokenScopeDenied('token_workspace_mismatch');
  }
  if (token.repo_id && input.repo_id && token.repo_id !== input.repo_id) {
    return tokenScopeDenied('token_repo_mismatch');
  }

  return evaluateRunPermissionPolicy(token.policy as RunPermissionPolicy, input.request);
}

function stringFromPayload(payload: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function normalizeRunPermissionOperation(value: unknown): RunPermissionOperation | null {
  if (typeof value !== 'string') return null;
  if (
    value === 'filesystem.read' ||
    value === 'filesystem.write' ||
    value === 'network.request' ||
    value === 'secret.read' ||
    value === 'shell.exec' ||
    value === 'git.status' ||
    value === 'git.commit' ||
    value === 'git.push' ||
    value === 'pull_request.create'
  ) {
    return value;
  }
  return null;
}

export function normalizeRunPermissionRequestPayload(
  payload?: Record<string, unknown> | null,
): { tokenId: string | null; request: RunPermissionRequest | null } {
  if (!payload) return { tokenId: null, request: null };
  const tokenId = stringFromPayload(payload, [
    'taskScopedTokenId',
    'task_scoped_token_id',
    'agentTaskScopedTokenId',
    'tokenId',
    'token_id',
  ]);
  const operation = normalizeRunPermissionOperation(payload.operation);
  if (!operation) return { tokenId, request: null };
  return {
    tokenId,
    request: {
      operation,
      workspaceFolder: stringFromPayload(payload, ['workspaceFolder', 'workspace_folder']),
      repoId: stringFromPayload(payload, ['repoId', 'repo_id']),
      host: stringFromPayload(payload, ['host']),
      secretKey: stringFromPayload(payload, ['secretKey', 'secret_key']),
      command: stringFromPayload(payload, ['command']),
    },
  };
}

export function evaluateAgentTaskScopedApprovalRequest(
  token: AgentTaskScopedToken,
  input: AgentTaskScopedApprovalRequestInput,
): AgentTaskScopedApprovalRequestEvaluation {
  const { tokenId, request } = normalizeRunPermissionRequestPayload(input.payload);
  if (tokenId && tokenId !== token.id) {
    return {
      ok: false,
      tokenId,
      request,
      evaluation: tokenScopeDenied('token_id_mismatch'),
    };
  }
  if (!request) {
    return {
      ok: false,
      tokenId,
      request,
      evaluation: tokenScopeDenied('permission_request_payload_invalid', 'medium'),
    };
  }
  const evaluation = evaluateAgentTaskScopedTokenPermission(token, { ...input, request });
  return {
    ok: evaluation.decision === 'approval_required',
    tokenId: tokenId ?? token.id,
    request,
    evaluation,
  };
}
