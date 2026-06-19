import { describe, expect, test } from 'vitest';

import {
  evaluateAgentTaskScopedApprovalRequest,
  evaluateAgentTaskScopedTokenPermission,
  evaluateRunPermissionPolicy,
} from '../src/permissions.js';

describe('run permission policy evaluator', () => {
  test('allows scoped workspace operations while denying access outside token scope', () => {
    const policy = {
      filesystem: 'workspace',
      workspaceFolder: 'main',
      repoId: 'repo_1',
      network: 'disabled',
      secrets: 'none',
      shell: 'safe',
      git: 'commit',
    } as const;

    expect(
      evaluateRunPermissionPolicy(policy, {
        operation: 'filesystem.write',
        workspaceFolder: 'main',
        repoId: 'repo_1',
      }),
    ).toMatchObject({ decision: 'allow', reason: 'workspace_scope_matched' });

    expect(
      evaluateRunPermissionPolicy(policy, {
        operation: 'filesystem.write',
        workspaceFolder: 'other',
        repoId: 'repo_1',
      }),
    ).toMatchObject({ decision: 'deny', reason: 'workspace_scope_mismatch' });
  });

  test('routes high-risk shell git push and secret access to approval or denial', () => {
    const policy = {
      filesystem: 'workspace',
      workspaceFolder: 'main',
      network: 'allowlist',
      networkAllowlist: ['api.github.com'],
      secrets: 'scoped',
      allowedSecretKeys: ['GITHUB_TOKEN'],
      shell: 'approval',
      git: 'push_approval',
    } as const;

    expect(
      evaluateRunPermissionPolicy(policy, {
        operation: 'shell.exec',
        command: 'rm -rf dist',
        workspaceFolder: 'main',
      }),
    ).toMatchObject({ decision: 'approval_required', riskLevel: 'high', reason: 'shell_requires_approval' });

    expect(
      evaluateRunPermissionPolicy(policy, {
        operation: 'git.push',
        workspaceFolder: 'main',
      }),
    ).toMatchObject({ decision: 'approval_required', riskLevel: 'high', reason: 'git_push_requires_approval' });

    expect(
      evaluateRunPermissionPolicy(policy, {
        operation: 'pull_request.create',
        workspaceFolder: 'main',
        repoId: 'repo_1',
      }),
    ).toMatchObject({
      decision: 'approval_required',
      riskLevel: 'high',
      reason: 'pull_request_create_requires_approval',
    });

    expect(
      evaluateRunPermissionPolicy(policy, {
        operation: 'secret.read',
        secretKey: 'AWS_SECRET_ACCESS_KEY',
        workspaceFolder: 'main',
      }),
    ).toMatchObject({ decision: 'deny', reason: 'secret_not_in_scope' });
  });

  test('evaluates operations through task-scoped token runtime and workspace bindings', () => {
    const token = {
      id: 'tok_1',
      task_id: 'agtask_irun_1',
      actor_user_id: 'user_1',
      agent_link_id: 'cl_1234567890abcdef',
      agent_client_id: 'claude-code',
      workspace_folder: 'main',
      repo_id: 'repo_1',
      policy: {
        filesystem: 'workspace',
        workspaceFolder: 'main',
        repoId: 'repo_1',
        network: 'disabled',
        secrets: 'none',
        shell: 'approval',
        git: 'push_approval',
      },
      expires_at: '2026-06-12T01:00:00.000Z',
      created_at: '2026-06-12T00:00:00.000Z',
    } as const;

    expect(
      evaluateAgentTaskScopedTokenPermission(token, {
        task_id: 'agtask_irun_1',
        agent_link_id: 'cl_1234567890abcdef',
        agent_client_id: 'claude-code',
        workspace_folder: 'main',
        repo_id: 'repo_1',
        request: {
          operation: 'filesystem.write',
          workspaceFolder: 'main',
          repoId: 'repo_1',
        },
      }),
    ).toMatchObject({ decision: 'allow', reason: 'workspace_scope_matched' });

    expect(
      evaluateAgentTaskScopedTokenPermission(token, {
        task_id: 'agtask_other',
        agent_link_id: 'cl_1234567890abcdef',
        agent_client_id: 'claude-code',
        workspace_folder: 'main',
        repo_id: 'repo_1',
        request: { operation: 'git.status', workspaceFolder: 'main', repoId: 'repo_1' },
      }),
    ).toMatchObject({ decision: 'deny', reason: 'token_task_mismatch' });

    expect(
      evaluateAgentTaskScopedTokenPermission(token, {
        task_id: 'agtask_irun_1',
        agent_link_id: 'cl_other0000000000',
        agent_client_id: 'claude-code',
        workspace_folder: 'main',
        repo_id: 'repo_1',
        request: { operation: 'git.status', workspaceFolder: 'main', repoId: 'repo_1' },
      }),
    ).toMatchObject({ decision: 'deny', reason: 'token_agent_link_mismatch' });

    expect(
      evaluateAgentTaskScopedTokenPermission(token, {
        task_id: 'agtask_irun_1',
        agent_link_id: 'cl_1234567890abcdef',
        agent_client_id: 'claude-code',
        workspace_folder: 'main',
        repo_id: 'repo_1',
        request: { operation: 'git.push', workspaceFolder: 'main', repoId: 'repo_1' },
      }),
    ).toMatchObject({ decision: 'approval_required', reason: 'git_push_requires_approval' });

    expect(
      evaluateAgentTaskScopedTokenPermission(token, {
        task_id: 'agtask_irun_1',
        agent_link_id: 'cl_1234567890abcdef',
        agent_client_id: 'claude-code',
        workspace_folder: 'main',
        repo_id: 'repo_1',
        request: { operation: 'pull_request.create', workspaceFolder: 'main', repoId: 'repo_1' },
      }),
    ).toMatchObject({ decision: 'approval_required', reason: 'pull_request_create_requires_approval' });
  });

  test('accepts approval flow only when the task-scoped token policy requires human approval', () => {
    const token = {
      id: 'agttok_approval',
      task_id: 'agtask_irun_1',
      actor_user_id: 'user_1',
      agent_link_id: 'cl_1234567890abcdef',
      agent_client_id: 'claude-code',
      workspace_folder: 'main',
      repo_id: 'repo_1',
      policy: {
        filesystem: 'workspace',
        workspaceFolder: 'main',
        repoId: 'repo_1',
        network: 'disabled',
        secrets: 'none',
        shell: 'approval',
        git: 'push_approval',
      },
      expires_at: '2026-06-12T01:00:00.000Z',
      created_at: '2026-06-12T00:00:00.000Z',
      last_used_at: null,
      revoked_at: null,
      revoke_reason: null,
    } as const;

    const approved = evaluateAgentTaskScopedApprovalRequest(token, {
      task_id: 'agtask_irun_1',
      agent_link_id: 'cl_1234567890abcdef',
      agent_client_id: 'claude-code',
      workspace_folder: 'main',
      repo_id: 'repo_1',
      payload: {
        taskScopedTokenId: 'agttok_approval',
        operation: 'git.push',
        workspaceFolder: 'main',
        repoId: 'repo_1',
      },
    });
    expect(approved).toMatchObject({
      ok: true,
      evaluation: { decision: 'approval_required', reason: 'git_push_requires_approval' },
      request: { operation: 'git.push', workspaceFolder: 'main', repoId: 'repo_1' },
    });

    const approvedPrCreate = evaluateAgentTaskScopedApprovalRequest(token, {
      task_id: 'agtask_irun_1',
      agent_link_id: 'cl_1234567890abcdef',
      agent_client_id: 'claude-code',
      workspace_folder: 'main',
      repo_id: 'repo_1',
      payload: {
        taskScopedTokenId: 'agttok_approval',
        operation: 'pull_request.create',
        workspaceFolder: 'main',
        repoId: 'repo_1',
      },
    });
    expect(approvedPrCreate).toMatchObject({
      ok: true,
      evaluation: { decision: 'approval_required', reason: 'pull_request_create_requires_approval' },
      request: { operation: 'pull_request.create', workspaceFolder: 'main', repoId: 'repo_1' },
    });

    expect(
      evaluateAgentTaskScopedApprovalRequest(token, {
        task_id: 'agtask_irun_1',
        agent_link_id: 'cl_1234567890abcdef',
        agent_client_id: 'claude-code',
        workspace_folder: 'other',
        repo_id: 'repo_1',
        payload: {
          taskScopedTokenId: 'agttok_approval',
          operation: 'git.push',
          workspaceFolder: 'other',
          repoId: 'repo_1',
        },
      }),
    ).toMatchObject({ ok: false, evaluation: { decision: 'deny', reason: 'token_workspace_mismatch' } });

    expect(
      evaluateAgentTaskScopedApprovalRequest(token, {
        task_id: 'agtask_irun_1',
        agent_link_id: 'cl_1234567890abcdef',
        agent_client_id: 'claude-code',
        workspace_folder: 'main',
        repo_id: 'repo_1',
        payload: {
          taskScopedTokenId: 'agttok_approval',
          operation: 'git.status',
          workspaceFolder: 'main',
          repoId: 'repo_1',
        },
      }),
    ).toMatchObject({ ok: false, evaluation: { decision: 'allow', reason: 'git_read_allowed' } });
  });
});
