import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-task-ledger-'));
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return {
    ...actual,
    DATA_DIR: tmpDir,
    STORE_DIR: tmpStoreDir,
    GROUPS_DIR: tmpGroupsDir,
  };
});

const db = await import('../src/db.js');

beforeAll(() => {
  db.initDatabase();
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('agent task ledger', () => {
  test('upserts and lists an issue run ledger row with context metadata', () => {
    const created = db.upsertAgentTask({
      id: 'agtask_irun_1',
      source_type: 'issue_run',
      source_ref: 'issue_1',
      run_ref: 'irun_1',
      status: 'queued',
      workspace_jid: 'web:main',
      workspace_folder: 'main',
      actor_user_id: 'user_1',
      agent_link_id: 'cl_1234567890abcdef',
      agent_client_id: 'claude-code',
      execution_node: 'runtime:cl_1234567890abcdef:claude-code',
      backend: 'mac-claude-code',
      context: { issueId: 'issue_1', trigger: 'manual' },
      created_at: '2026-06-11T00:00:00.000Z',
      updated_at: '2026-06-11T00:00:00.000Z',
    });

    expect(created.id).toBe('agtask_irun_1');
    expect(created.status).toBe('queued');
    expect(created.context).toEqual({ issueId: 'issue_1', trigger: 'manual' });

    const updated = db.upsertAgentTask({
      id: 'agtask_irun_1',
      source_type: 'issue_run',
      source_ref: 'issue_1',
      run_ref: 'irun_1',
      status: 'running',
      workspace_jid: 'web:main',
      workspace_folder: 'main',
      started_at: '2026-06-11T00:00:01.000Z',
      context: { issueId: 'issue_1', trigger: 'manual', phase: 'started' },
      updated_at: '2026-06-11T00:00:01.000Z',
    });

    expect(updated.status).toBe('running');
    expect(updated.started_at).toBe('2026-06-11T00:00:01.000Z');
    expect(updated.agent_client_id).toBe('claude-code');
    expect(updated.context).toEqual({ issueId: 'issue_1', trigger: 'manual', phase: 'started' });

    const listed = db.listAgentTasks({ source_type: 'issue_run', source_ref: 'issue_1' });
    expect(listed.map((item) => item.id)).toContain('agtask_irun_1');
    expect(db.getAgentTaskById('agtask_irun_1')?.run_ref).toBe('irun_1');
  });

  test('represents scheduled task run UUIDs as ledger rows', () => {
    db.upsertAgentTask({
      id: 'agtask_scheduled_task_run_1',
      source_type: 'scheduled_task',
      source_ref: 'task_1',
      run_ref: 'task-run-uuid-1',
      status: 'running',
      workspace_jid: 'web:main',
      workspace_folder: 'main',
      context: { scheduleType: 'manual' },
      created_at: '2026-06-11T00:01:00.000Z',
      updated_at: '2026-06-11T00:01:00.000Z',
    });

    db.upsertAgentTask({
      id: 'agtask_scheduled_task_run_1',
      source_type: 'scheduled_task',
      source_ref: 'task_1',
      run_ref: 'task-run-uuid-1',
      status: 'success',
      workspace_jid: 'web:main',
      workspace_folder: 'main',
      result: 'done',
      completed_at: '2026-06-11T00:01:03.000Z',
      updated_at: '2026-06-11T00:01:03.000Z',
    });

    const row = db.getAgentTaskById('agtask_scheduled_task_run_1');
    expect(row?.source_type).toBe('scheduled_task');
    expect(row?.source_ref).toBe('task_1');
    expect(row?.run_ref).toBe('task-run-uuid-1');
    expect(row?.status).toBe('success');
    expect(row?.result).toBe('done');
  });

  test('agent team run and task recorders mirror rows into the ledger', () => {
    db.recordAgentTeamRun({
      id: 'team_run_1',
      teamId: 'team_1',
      userId: 'user_1',
      prompt: 'ship it',
      status: 'running',
      traceId: 'trace_1',
      workflowShape: 'pipeline',
      createdAt: '2026-06-11T00:02:00.000Z',
      startedAt: '2026-06-11T00:02:00.000Z',
      updatedAt: '2026-06-11T00:02:00.000Z',
    });
    db.recordAgentTeamTask({
      id: 'team_run_1:dev:implementation',
      runId: 'team_run_1',
      roleId: 'dev',
      phase: 'implementation',
      actorId: 'agent_dev',
      status: 'success',
      input: 'build',
      output: 'built',
      startedAt: '2026-06-11T00:02:01.000Z',
      completedAt: '2026-06-11T00:02:05.000Z',
      updatedAt: '2026-06-11T00:02:05.000Z',
    });

    const runLedger = db.getAgentTaskById('agtask_team_run_1');
    const taskLedger = db.getAgentTaskById('agtask_team_run_1_dev_implementation');
    expect(runLedger?.source_type).toBe('agent_team_run');
    expect(runLedger?.source_ref).toBe('team_1');
    expect(runLedger?.run_ref).toBe('team_run_1');
    expect(taskLedger?.source_type).toBe('agent_team_task');
    expect(taskLedger?.source_ref).toBe('team_run_1');
    expect(taskLedger?.run_ref).toBe('team_run_1:dev:implementation');
    expect(taskLedger?.status).toBe('success');
    expect(taskLedger?.result).toBe('built');
  });

  test('issues task-scoped tokens bound to task runtime workspace and policy', () => {
    const issued = db.createAgentTaskScopedToken({
      task_id: 'agtask_irun_1',
      actor_user_id: 'user_1',
      agent_link_id: 'cl_1234567890abcdef',
      agent_client_id: 'codex',
      workspace_folder: 'main',
      repo_id: 'repo_1',
      policy: { filesystem: 'workspace', git: 'commit', network: 'disabled' },
      ttl_ms: 60_000,
      now: '2026-06-11T00:10:00.000Z',
    });

    expect(issued.id).toMatch(/^agttok_/);
    expect(issued.token).toMatch(/^ott_/);
    expect(issued.token_hash).toBeUndefined();
    expect(issued.expires_at).toBe('2026-06-11T00:11:00.000Z');

    const verified = db.verifyAgentTaskScopedToken(issued.token, {
      task_id: 'agtask_irun_1',
      agent_link_id: 'cl_1234567890abcdef',
      workspace_folder: 'main',
      now: '2026-06-11T00:10:05.000Z',
    });
    expect(verified?.id).toBe(issued.id);
    expect(verified?.policy).toEqual({ filesystem: 'workspace', git: 'commit', network: 'disabled' });
    expect(verified?.last_used_at).toBe('2026-06-11T00:10:05.000Z');

    expect(
      db.verifyAgentTaskScopedToken(issued.token, {
        task_id: 'agtask_irun_1',
        workspace_folder: 'other-workspace',
        now: '2026-06-11T00:10:06.000Z',
      }),
    ).toBeNull();
    expect(
      db.verifyAgentTaskScopedToken(issued.token, {
        task_id: 'agtask_irun_1',
        workspace_folder: 'main',
        now: '2026-06-11T00:12:00.000Z',
      }),
    ).toBeNull();

    db.revokeAgentTaskScopedToken(issued.id, 'user_abort', '2026-06-11T00:10:10.000Z');
    expect(
      db.verifyAgentTaskScopedToken(issued.token, {
        task_id: 'agtask_irun_1',
        workspace_folder: 'main',
        now: '2026-06-11T00:10:11.000Z',
      }),
    ).toBeNull();

    const audits = db.queryAuthAuditLogs({ username: 'user_1', event_type: 'agent_task_token_created' });
    expect(audits.logs[0]?.details).toMatchObject({
      taskId: 'agtask_irun_1',
      tokenId: issued.id,
      workspaceFolder: 'main',
      repoId: 'repo_1',
    });
  });
});
