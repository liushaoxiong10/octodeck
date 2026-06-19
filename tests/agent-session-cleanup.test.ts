import { describe, expect, test, vi } from 'vitest';

import { cleanupDeletedConversationAgentDaemonSessions } from '../src/agent-session-cleanup.js';

describe('cleanupDeletedConversationAgentDaemonSessions', () => {
  test('deletes provider and workspace conversation sessions from the daemon before agent removal', async () => {
    const requestDelete = vi.fn(async () => ({
      ok: true,
      deleted: true,
      error: null,
      durationMs: 1,
    }));
    const runtimeSession = {
      state: 'open',
      send: vi.fn(() => true),
    } as any;

    await cleanupDeletedConversationAgentDaemonSessions({
      group: {
        name: 'Demo',
        folder: 'demo',
        added_at: '2026-01-01T00:00:00.000Z',
        deviceLinkId: 'cl_1234567890abcdef',
        agentClientId: 'traex-acp',
      },
      agentId: 'conversation-agent-1',
      providerSessionId: 'provider-session-1',
      workspaceSessionId: 'workspace-session-1',
      getRuntimeSession: vi.fn(() => runtimeSession),
      requestDelete,
    });

    expect(requestDelete).toHaveBeenCalledTimes(2);
    expect(requestDelete).toHaveBeenNthCalledWith(
      1,
      runtimeSession,
      expect.objectContaining({
        linkId: 'cl_1234567890abcdef',
        agentId: 'traex-acp',
        workspace: 'demo',
        sessionId: 'provider-session-1',
      }),
    );
    expect(requestDelete).toHaveBeenNthCalledWith(
      2,
      runtimeSession,
      expect.objectContaining({
        linkId: 'cl_1234567890abcdef',
        agentId: 'traex-acp',
        workspace: 'demo',
        sessionId: 'workspace-session-1',
      }),
    );
  });

  test('deduplicates when provider and workspace session ids match', async () => {
    const requestDelete = vi.fn(async () => ({
      ok: true,
      deleted: true,
      error: null,
      durationMs: 1,
    }));

    await cleanupDeletedConversationAgentDaemonSessions({
      group: {
        name: 'Demo',
        folder: 'demo',
        added_at: '2026-01-01T00:00:00.000Z',
        executionNode: 'runtime:cl_1234567890abcdef:codex-acp',
      },
      agentId: 'conversation-agent-1',
      providerSessionId: 'same-session',
      workspaceSessionId: 'same-session',
      getRuntimeSession: vi.fn(() => ({ state: 'open', send: vi.fn(() => true) } as any)),
      requestDelete,
    });

    expect(requestDelete).toHaveBeenCalledTimes(1);
    expect(requestDelete.mock.calls[0]?.[1]).toMatchObject({
      linkId: 'cl_1234567890abcdef',
      agentId: 'codex-acp',
      workspace: 'demo',
      sessionId: 'same-session',
    });
  });
});
