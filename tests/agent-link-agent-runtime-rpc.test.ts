import { describe, expect, test, vi } from 'vitest';

import {
  deliverAgentDiscoverResult,
  deliverAgentSessionDeleteResult,
  deliverAgentSessionsResult,
  requestAgentDiscover,
  requestAgentSessionDelete,
  requestAgentSessions,
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
        },
      ],
      error: null,
      durationMs: 12,
    });
    await expect(promise).resolves.toMatchObject({
      ok: true,
      agents: [{ id: 'claude-code' }],
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
});
