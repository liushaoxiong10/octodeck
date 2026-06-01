import { describe, expect, test, vi } from 'vitest';

const getSessionMock = vi.hoisted(() => vi.fn());
const invokeRemoteToolMock = vi.hoisted(() => vi.fn());

vi.mock('../src/agent-link/registry.js', () => ({
  getSession: getSessionMock,
}));

vi.mock('../src/agent-link/tool-rpc.js', () => ({
  invokeRemoteTool: invokeRemoteToolMock,
}));

describe('agent-link tool HTTP bridge', () => {
  test('devices tool endpoint remains compatible with agent-link tool bridge', async () => {
    process.env.HAPPYCLAW_AGENT_RUNNER_SECRET = 'secret';
    getSessionMock.mockReturnValue({ state: 'open', send: vi.fn() });
    invokeRemoteToolMock.mockResolvedValue({
      ok: true,
      result: { content: 'from-device' },
      error: null,
      durationMs: 5,
    });
    const { handleAgentLinkToolHttpRequest } = await import('../src/routes/agent-link-tool.js');

    const res = await handleAgentLinkToolHttpRequest(
      new Request('http://localhost/api/devices/tool', {
        method: 'POST',
        headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
        body: JSON.stringify({
          linkId: 'cl_1234567890abcdef',
          toolName: 'Read',
          input: { file_path: '/tmp/a.txt' },
          cwd: '/tmp',
          timeoutMs: 1000,
          maxOutputBytes: 4096,
        }),
      }),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      result: { content: 'from-device' },
      error: null,
      durationMs: 5,
    });
  });

  test('rejects requests without runner secret', async () => {
    process.env.HAPPYCLAW_AGENT_RUNNER_SECRET = 'secret';
    const { handleAgentLinkToolHttpRequest } = await import('../src/routes/agent-link-tool.js');
    const res = await handleAgentLinkToolHttpRequest(
      new Request('http://localhost/api/agent-link/tool', { method: 'POST' }),
    );
    expect(res.status).toBe(401);
  });

  test('invokes remote tool for online link', async () => {
    process.env.HAPPYCLAW_AGENT_RUNNER_SECRET = 'secret';
    getSessionMock.mockReturnValue({ state: 'open', send: vi.fn() });
    invokeRemoteToolMock.mockResolvedValue({
      ok: true,
      result: { content: 'hello' },
      error: null,
      durationMs: 3,
    });
    const { handleAgentLinkToolHttpRequest } = await import('../src/routes/agent-link-tool.js');

    const res = await handleAgentLinkToolHttpRequest(
      new Request('http://localhost/api/agent-link/tool', {
        method: 'POST',
        headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
        body: JSON.stringify({
          linkId: 'cl_1234567890abcdef',
          toolName: 'Read',
          input: { file_path: '/tmp/a.txt' },
          cwd: '/tmp',
          timeoutMs: 1000,
          maxOutputBytes: 4096,
        }),
      }),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      result: { content: 'hello' },
      error: null,
      durationMs: 3,
    });
  });
});
