import { describe, expect, test, vi } from 'vitest';

import { deliverToolResult, invokeRemoteTool } from '../src/agent-link/tool-rpc.js';

describe('agent-link tool rpc', () => {
  test('sends tool.request and resolves from matching tool.result', async () => {
    const sent: unknown[] = [];
    const session = {
      state: 'open',
      send(frame: unknown) {
        sent.push(frame);
        return true;
      },
    } as any;

    const promise = invokeRemoteTool(session, {
      linkId: 'cl_1234567890abcdef',
      toolName: 'Read',
      input: { file_path: '/tmp/a.txt' },
      cwd: '/tmp',
      timeoutMs: 1000,
      maxOutputBytes: 4096,
    });

    expect(sent[0]).toMatchObject({
      type: 'tool.request',
      toolName: 'Read',
      input: { file_path: '/tmp/a.txt' },
    });

    const requestId = (sent[0] as any).requestId;
    deliverToolResult({
      type: 'tool.result',
      requestId,
      ok: true,
      result: { content: 'hello' },
      error: null,
      durationMs: 10,
    });

    await expect(promise).resolves.toEqual({
      ok: true,
      result: { content: 'hello' },
      error: null,
      durationMs: 10,
    });
  });

  test('rejects when session send fails', async () => {
    const session = {
      state: 'open',
      send: vi.fn(() => false),
    } as any;

    await expect(
      invokeRemoteTool(session, {
        linkId: 'cl_1234567890abcdef',
        toolName: 'Bash',
        input: { command: 'pwd' },
        cwd: '/tmp',
        timeoutMs: 1000,
        maxOutputBytes: 4096,
      }),
    ).rejects.toThrow('send_failed');
  });
});
