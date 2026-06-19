import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-runner-token-'));
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

const captured = vi.hoisted(() => ({ input: undefined as unknown }));

vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return { ...actual, DATA_DIR: tmpDir, STORE_DIR: tmpStoreDir, GROUPS_DIR: tmpGroupsDir };
});

vi.mock('../src/backends/registry.js', () => ({
  resolveBackend: () => ({
    id: 'fake-device-backend',
    displayName: 'Fake Device Backend',
    usesProviderPool: false,
    supportsExecutionMode: () => true,
    run: async (args: { input: unknown }) => {
      captured.input = args.input;
      return { status: 'success', result: 'done' };
    },
  }),
}));

const db = await import('../src/db.js');
const { runIssueAgent } = await import('../src/issue-runner.js');

beforeAll(() => {
  db.initDatabase();
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('issue runner task-scoped token', () => {
  test('issues a token bound to the issue run and passes its permission policy to backend input', async () => {
    db.setRegisteredGroup('web:main', {
      name: 'Main',
      folder: 'main',
      added_at: '2026-06-12T00:00:00.000Z',
      created_by: 'user_1',
      executionMode: 'host',
      executionNode: 'runtime:cl_1234567890abcdef:claude-code',
      deviceLinkId: 'cl_1234567890abcdef',
      agentClientId: 'claude-code',
      backend: 'fake-device-backend',
    });
    db.createIssue({
      id: 'iss_token_1',
      workspace_jid: 'web:main',
      workspace_folder: 'main',
      title: 'Scoped token task',
      description: 'Verify token scope',
      status: 'todo',
      priority: 'medium',
      project_repo_id: 'repo_1',
      agent_link_id: 'cl_1234567890abcdef',
      agent_client_id: 'claude-code',
      execution_node: 'runtime:cl_1234567890abcdef:claude-code',
      backend: 'fake-device-backend',
      created_by: 'user_1',
      created_at: '2026-06-12T00:00:00.000Z',
      updated_at: '2026-06-12T00:00:00.000Z',
    });
    db.createIssueAgentRun({
      id: 'irun_token_1',
      issue_id: 'iss_token_1',
      workspace_jid: 'web:main',
      workspace_folder: 'main',
      agent_link_id: 'cl_1234567890abcdef',
      agent_client_id: 'claude-code',
      execution_node: 'runtime:cl_1234567890abcdef:claude-code',
      backend: 'fake-device-backend',
      status: 'queued',
      created_by: 'user_1',
      created_at: '2026-06-12T00:00:00.000Z',
    });

    await runIssueAgent('iss_token_1', 'irun_token_1', {
      queue: { registerProcess: vi.fn() } as any,
      broadcastIssueRequest: vi.fn(),
    });

    const input = captured.input as { taskScopedToken?: string; runPermissionPolicy?: Record<string, unknown> };
    expect(input.taskScopedToken).toMatch(/^ott_/);
    expect(input.runPermissionPolicy).toMatchObject({
      filesystem: 'workspace',
      workspaceFolder: 'main',
      repoId: 'repo_1',
      network: 'disabled',
      secrets: 'none',
      shell: 'approval',
      git: 'push_approval',
    });
    const createdAudit = db.queryAuthAuditLogs({
      username: 'user_1',
      event_type: 'agent_task_token_created',
    }).logs[0];
    const tokenId = (createdAudit?.details as { tokenId?: string } | null)?.tokenId;
    expect(db.getAgentTaskScopedTokenById(tokenId!)?.policy).toMatchObject(input.runPermissionPolicy!);
  });

  test('revokes the task-scoped token when the issue run reaches a terminal state', async () => {
    db.setRegisteredGroup('web:terminal', {
      name: 'Terminal',
      folder: 'terminal',
      added_at: '2026-06-12T00:00:00.000Z',
      created_by: 'user_2',
      executionMode: 'host',
      executionNode: 'runtime:cl_1234567890abc0:claude-code',
      deviceLinkId: 'cl_1234567890abc0',
      agentClientId: 'claude-code',
      backend: 'fake-device-backend',
    });
    db.createIssue({
      id: 'iss_token_terminal',
      workspace_jid: 'web:terminal',
      workspace_folder: 'terminal',
      title: 'Scoped token terminal revoke',
      description: 'Verify token revocation at terminal state',
      status: 'todo',
      priority: 'medium',
      project_repo_id: 'repo_terminal',
      agent_link_id: 'cl_1234567890abc0',
      agent_client_id: 'claude-code',
      execution_node: 'runtime:cl_1234567890abc0:claude-code',
      backend: 'fake-device-backend',
      created_by: 'user_2',
      created_at: '2026-06-12T00:00:00.000Z',
      updated_at: '2026-06-12T00:00:00.000Z',
    });
    db.createIssueAgentRun({
      id: 'irun_token_terminal',
      issue_id: 'iss_token_terminal',
      workspace_jid: 'web:terminal',
      workspace_folder: 'terminal',
      agent_link_id: 'cl_1234567890abc0',
      agent_client_id: 'claude-code',
      execution_node: 'runtime:cl_1234567890abc0:claude-code',
      backend: 'fake-device-backend',
      status: 'queued',
      created_by: 'user_2',
      created_at: '2026-06-12T00:00:00.000Z',
    });

    await runIssueAgent('iss_token_terminal', 'irun_token_terminal', {
      queue: { registerProcess: vi.fn() } as any,
      broadcastIssueRequest: vi.fn(),
    });

    const input = captured.input as { taskScopedToken?: string };
    const createdAudit = db.queryAuthAuditLogs({
      username: 'user_2',
      event_type: 'agent_task_token_created',
    }).logs[0];
    const tokenId = (createdAudit?.details as { tokenId?: string } | null)?.tokenId;
    expect(tokenId).toMatch(/^agttok_/);
    expect(db.getAgentTaskScopedTokenById(tokenId!)?.revoked_at).toBeTruthy();
    expect(db.getAgentTaskScopedTokenById(tokenId!)?.revoke_reason).toBe('issue_run_terminal_success');
    expect(
      db.verifyAgentTaskScopedToken(input.taskScopedToken!, {
        task_id: 'agtask_irun_token_terminal',
        agent_link_id: 'cl_1234567890abc0',
        agent_client_id: 'claude-code',
        workspace_folder: 'terminal',
        repo_id: 'repo_terminal',
      }),
    ).toBeNull();

    const revokedAudit = db.queryAuthAuditLogs({
      username: 'user_2',
      event_type: 'agent_task_token_revoked',
    }).logs[0];
    expect(revokedAudit?.details).toMatchObject({
      tokenId,
      taskId: 'agtask_irun_token_terminal',
      reason: 'issue_run_terminal_success',
    });
  });

  test('injects the review draft prompt when executing a Review Agent child run', async () => {
    db.setRegisteredGroup('web:review', {
      name: 'Review',
      folder: 'review',
      added_at: '2026-06-12T00:00:00.000Z',
      created_by: 'user_review',
      executionMode: 'host',
      executionNode: 'runtime:cl_1234567890abcf:claude-code',
      deviceLinkId: 'cl_1234567890abcf',
      agentClientId: 'claude-code',
      backend: 'fake-device-backend',
    });
    db.createIssue({
      id: 'iss_review_prompt',
      workspace_jid: 'web:review',
      workspace_folder: 'review',
      title: 'Review prompt issue',
      description: 'Verify review prompt injection',
      status: 'review',
      priority: 'medium',
      project_repo_id: 'repo_review',
      agent_link_id: 'cl_1234567890abcf',
      agent_client_id: 'claude-code',
      execution_node: 'runtime:cl_1234567890abcf:claude-code',
      backend: 'fake-device-backend',
      created_by: 'user_review',
      created_at: '2026-06-12T00:00:00.000Z',
      updated_at: '2026-06-12T00:00:00.000Z',
    });
    db.createIssueAgentRun({
      id: 'irun_review_parent',
      issue_id: 'iss_review_prompt',
      workspace_jid: 'web:review',
      workspace_folder: 'review',
      agent_link_id: 'cl_1234567890abcf',
      agent_client_id: 'claude-code',
      execution_node: 'runtime:cl_1234567890abcf:claude-code',
      backend: 'fake-device-backend',
      status: 'success',
      created_by: 'user_review',
      created_at: '2026-06-12T00:00:00.000Z',
    });
    db.createIssueAgentRun({
      id: 'irun_review_child',
      issue_id: 'iss_review_prompt',
      workspace_jid: 'web:review',
      workspace_folder: 'review',
      agent_link_id: 'cl_1234567890abcf',
      agent_client_id: 'claude-code',
      execution_node: 'runtime:cl_1234567890abcf:claude-code',
      backend: 'fake-device-backend',
      parent_run_id: 'irun_review_parent',
      status: 'queued',
      created_by: 'user_review',
      created_at: '2026-06-12T00:00:00.000Z',
    });
    db.createIssueAgentRunEvent({
      id: 'irev_review_prompt',
      issue_id: 'iss_review_prompt',
      run_id: 'irun_review_child',
      event_type: 'run_queued',
      title: 'Review run queued',
      summary: 'Review Agent',
      detail: 'Review src/login.ts for correctness and security regressions.',
      payload: { trigger: 'review_agent', parentRunId: 'irun_review_parent' },
      created_at: '2026-06-12T00:00:00.000Z',
    });

    await runIssueAgent('iss_review_prompt', 'irun_review_child', {
      queue: { registerProcess: vi.fn() } as any,
      broadcastIssueRequest: vi.fn(),
    });

    const input = captured.input as { prompt?: string };
    expect(input.prompt).toContain('[REVIEW AGENT TASK]');
    expect(input.prompt).toContain('Review src/login.ts for correctness and security regressions.');
    expect(input.prompt).toContain('Parent run: irun_review_parent');
  });

  test('injects the fix-run draft prompt when executing a fix-run child run', async () => {
    db.createIssue({
      id: 'iss_fix_run_prompt',
      workspace_jid: 'web:review',
      workspace_folder: 'review',
      title: 'Fix run prompt issue',
      description: 'Use the reusable runbook context.',
      status: 'todo',
      priority: 'high',
      project_repo_id: 'repo_fix_run',
      agent_link_id: 'cl_1234567890abcf',
      agent_client_id: 'claude-code',
      execution_node: 'runtime:cl_1234567890abcf:claude-code',
      backend: 'fake-device-backend',
      created_by: 'user_fix_run',
      created_at: '2026-06-12T00:00:00.000Z',
      updated_at: '2026-06-12T00:00:00.000Z',
    });
    db.createIssueAgentRun({
      id: 'irun_fix_run_parent',
      issue_id: 'iss_fix_run_prompt',
      workspace_jid: 'web:review',
      workspace_folder: 'review',
      agent_link_id: 'cl_1234567890abcf',
      agent_client_id: 'claude-code',
      execution_node: 'runtime:cl_1234567890abcf:claude-code',
      backend: 'fake-device-backend',
      status: 'success',
      created_by: 'user_fix_run',
      created_at: '2026-06-12T00:00:00.000Z',
    });
    db.createIssueAgentRun({
      id: 'irun_fix_run_child',
      issue_id: 'iss_fix_run_prompt',
      workspace_jid: 'web:review',
      workspace_folder: 'review',
      agent_link_id: 'cl_1234567890abcf',
      agent_client_id: 'claude-code',
      execution_node: 'runtime:cl_1234567890abcf:claude-code',
      backend: 'fake-device-backend',
      parent_run_id: 'irun_fix_run_parent',
      status: 'queued',
      created_by: 'user_fix_run',
      created_at: '2026-06-12T00:00:00.000Z',
    });
    db.createIssueAgentRunEvent({
      id: 'irev_fix_run_prompt',
      issue_id: 'iss_fix_run_prompt',
      run_id: 'irun_fix_run_child',
      event_type: 'run_queued',
      title: 'Fix run queued',
      summary: 'Apply reusable remediation safely',
      detail: [
        'Historical remediation actions to reuse carefully:',
        '- Patch checkout null guard.',
        'Verification checklist:',
        '- Run targeted unit tests.',
      ].join('\n'),
      payload: { trigger: 'fix_run_spawner', parentRunId: 'irun_fix_run_parent' },
      created_at: '2026-06-12T00:00:00.000Z',
    });

    await runIssueAgent('iss_fix_run_prompt', 'irun_fix_run_child', {
      queue: { registerProcess: vi.fn() } as any,
      broadcastIssueRequest: vi.fn(),
    });

    const input = captured.input as { prompt?: string };
    expect(input.prompt).toContain('[FIX RUN TASK]');
    expect(input.prompt).toContain('Parent run: irun_fix_run_parent');
    expect(input.prompt).toContain('Historical remediation actions to reuse carefully:');
    expect(input.prompt).toContain('Patch checkout null guard.');
    expect(input.prompt).toContain('Verification checklist:');
  });
});
