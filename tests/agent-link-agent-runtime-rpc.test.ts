import { describe, expect, test, vi } from 'vitest';

import {
  deliverAgentDiscoverResult,
  deliverAgentSessionDeleteResult,
  deliverAgentSessionsResult,
  deliverWorkspaceGitStatusResult,
  deliverWorkspaceGitCommitResult,
  requestAgentDiscover,
  requestAgentSessionDelete,
  requestAgentSessions,
  requestWorkspaceGitStatus,
  requestWorkspaceGitCommit,
} from '../src/agent-link/agent-runtime-rpc.js';

describe('agent-link agent runtime rpc', () => {
  test('sends discover request and resolves matching result', async () => {
    const sent: unknown[] = [];
    const session = {
      send: (frame: unknown) => (sent.push(frame), true),
    } as any;
    const promise = requestAgentDiscover(session, {
      linkId: 'cl_1234567890abcdef',
      timeoutMs: 1000,
    });
    expect(sent[0]).toMatchObject({ type: 'agent.discover.request' });
    deliverAgentDiscoverResult({
      type: 'agent.discover.result',
      requestId: (sent[0] as any).requestId,
      ok: true,
      agents: [
        {
          id: 'claude-code',
          displayName: 'Claude Code',
          binary: '/usr/bin/claude',
          family: 'claude',
        },
      ],
      error: null,
      durationMs: 12,
    });
    await expect(promise).resolves.toMatchObject({
      ok: true,
      agents: [{ id: 'claude-code', family: 'claude' }],
    });
  });

  test('sends sessions request and delete request', async () => {
    const sent: unknown[] = [];
    const session = {
      send: (frame: unknown) => (sent.push(frame), true),
    } as any;
    const sessionsPromise = requestAgentSessions(session, {
      linkId: 'cl_1234567890abcdef',
      agentId: 'claude-code',
      workspace: 'demo',
      timeoutMs: 1000,
    });
    deliverAgentSessionsResult({
      type: 'agent.sessions.result',
      requestId: (sent[0] as any).requestId,
      ok: true,
      sessions: [
        {
          id: 's1',
          agentId: 'claude-code',
          workspace: 'demo',
          path: '/tmp/s1',
        },
      ],
      error: null,
      durationMs: 1,
    });
    await expect(sessionsPromise).resolves.toMatchObject({
      sessions: [{ id: 's1' }],
    });

    const deletePromise = requestAgentSessionDelete(session, {
      linkId: 'cl_1234567890abcdef',
      agentId: 'claude-code',
      workspace: 'demo',
      sessionId: 's1',
      timeoutMs: 1000,
    });
    expect(sent[1]).toMatchObject({
      type: 'agent.session.delete.request',
      sessionId: 's1',
    });
    deliverAgentSessionDeleteResult({
      type: 'agent.session.delete.result',
      requestId: (sent[1] as any).requestId,
      ok: true,
      deleted: true,
      error: null,
      durationMs: 2,
    });
    await expect(deletePromise).resolves.toMatchObject({ deleted: true });
  });

  test('rejects when send fails', async () => {
    const session = { send: vi.fn(() => false) } as any;
    await expect(
      requestAgentDiscover(session, {
        linkId: 'cl_1234567890abcdef',
        timeoutMs: 1000,
      }),
    ).rejects.toThrow('send_failed');
  });

  test('sends workspace git status request and resolves matching result', async () => {
    const sent: unknown[] = [];
    const session = {
      send: (frame: unknown) => (sent.push(frame), true),
    } as any;

    const promise = requestWorkspaceGitStatus(session, {
      linkId: 'cl_1234567890abcdef',
      workspace: {
        kind: 'workspace',
        folder: 'demo',
        agentId: 'claude-code',
        scope: 'session',
        scopeId: 'issue-run-1',
      },
      workspaceRepos: [
        {
          kind: 'git',
          gitUrl: 'https://example.com/acme/demo.git',
          groupFolder: 'demo',
          name: 'demo',
          agentId: 'claude-code',
          scope: 'session',
          scopeId: 'issue-run-1',
        },
      ],
      includeDiffStat: true,
      timeoutMs: 1000,
    });

    expect(sent[0]).toMatchObject({
      type: 'workspace.git.status.request',
      workspaceRepos: [{ name: 'demo' }],
      includeDiffStat: true,
    });

    deliverWorkspaceGitStatusResult({
      type: 'workspace.git.status.result',
      requestId: (sent[0] as any).requestId,
      ok: true,
      workspacePath: '/tmp/demo',
      branch: 'main',
      head: 'abc1234',
      clean: false,
      files: [{ path: 'src/app.ts', status: 'modified', additions: 3, deletions: 1 }],
      diffStat: 'src/app.ts | 4 +++-',
      error: null,
      durationMs: 9,
    });

    await expect(promise).resolves.toMatchObject({
      ok: true,
      clean: false,
      files: [{ path: 'src/app.ts', additions: 3 }],
    });
  });

  test('sends workspace git commit request and resolves matching result', async () => {
    const sent: unknown[] = [];
    const session = {
      send: (frame: unknown) => (sent.push(frame), true),
    } as any;

    const promise = requestWorkspaceGitCommit(session, {
      linkId: 'cl_1234567890abcdef',
      workspace: {
        kind: 'workspace',
        folder: 'demo',
        agentId: 'claude-code',
        scope: 'task',
        taskId: 'iss_1',
        taskRunId: 'irun_1',
      },
      workspaceRepo: {
        kind: 'git',
        gitUrl: 'https://example.com/acme/demo.git',
        groupFolder: 'demo',
        name: 'demo',
        agentId: 'claude-code',
        scope: 'task',
        taskId: 'iss_1',
        taskRunId: 'irun_1',
      },
      message: 'fix: update app',
      timeoutMs: 1000,
    });

    expect(sent[0]).toMatchObject({
      type: 'workspace.git.commit.request',
      message: 'fix: update app',
      workspaceRepo: { name: 'demo' },
    });

    deliverWorkspaceGitCommitResult({
      type: 'workspace.git.commit.result',
      requestId: (sent[0] as any).requestId,
      ok: true,
      workspacePath: '/tmp/demo',
      branch: 'main',
      commit: 'abc1234',
      clean: true,
      filesCommitted: 1,
      error: null,
      durationMs: 10,
    });

    await expect(promise).resolves.toMatchObject({
      ok: true,
      commit: 'abc1234',
      filesCommitted: 1,
    });
  });
});
