import { beforeEach, describe, expect, test, vi } from 'vitest';

const getSessionMock = vi.hoisted(() => vi.fn());
const invokeRemoteToolMock = vi.hoisted(() => vi.fn());
const getAgentLinkByIdMock = vi.hoisted(() => vi.fn());

vi.mock('../src/agent-link/registry.js', () => ({
  getSession: getSessionMock,
}));

vi.mock('../src/agent-link/tool-rpc.js', () => ({
  invokeRemoteTool: invokeRemoteToolMock,
}));

vi.mock('../src/db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/db.js')>();
  return {
    ...actual,
    getAgentLinkById: getAgentLinkByIdMock,
  };
});

describe('agent-link tool HTTP bridge', () => {
  beforeEach(() => {
    getSessionMock.mockReset();
    invokeRemoteToolMock.mockReset();
    getAgentLinkByIdMock.mockReset();
    getAgentLinkByIdMock.mockReturnValue({
      id: 'cl_1234567890abcdef',
      userId: 'test-user',
      revokedAt: null,
    });
  });

  async function authHeaders(): Promise<Record<string, string>> {
    const { createAgentToolToken } = await import('../src/config.js');
    return {
      authorization: `Bearer ${createAgentToolToken('test-user')}`,
      'content-type': 'application/json',
    };
  }

  test('devices tool endpoint remains compatible with agent-link tool bridge', async () => {
    process.env.OCTODECK_AGENT_RUNNER_SECRET = 'secret';
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
        headers: await authHeaders(),
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
    process.env.OCTODECK_AGENT_RUNNER_SECRET = 'secret';
    const { handleAgentLinkToolHttpRequest } = await import('../src/routes/agent-link-tool.js');
    const res = await handleAgentLinkToolHttpRequest(
      new Request('http://localhost/api/agent-link/tool', { method: 'POST' }),
    );
    expect(res.status).toBe(401);
  });

  test('invokes remote tool for online link', async () => {
    process.env.OCTODECK_AGENT_RUNNER_SECRET = 'secret';
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
        headers: await authHeaders(),
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

  test('uses a long server-side wait when bridge request omits timeout', async () => {
    process.env.OCTODECK_AGENT_RUNNER_SECRET = 'secret';
    getSessionMock.mockReturnValue({ state: 'open', send: vi.fn() });
    invokeRemoteToolMock.mockResolvedValue({
      ok: true,
      result: { stdout: 'done\n' },
      error: null,
      durationMs: 3,
    });
    const { handleAgentLinkToolHttpRequest } = await import('../src/routes/agent-link-tool.js');

    const res = await handleAgentLinkToolHttpRequest(
      new Request('http://localhost/api/agent-link/tool', {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({
          linkId: 'cl_1234567890abcdef',
          toolName: 'Bash',
          input: { command: 'long-running-background-job' },
          cwd: '/tmp',
        }),
      }),
    );

    expect(res.status).toBe(200);
    expect(invokeRemoteToolMock.mock.calls[0][1].timeoutMs).toBe(7_200_000);
  });

  test('falls back to Bash directory listing for older daemons without ListDirectories', async () => {
    getSessionMock.mockReturnValue({ state: 'open', send: vi.fn() });
    invokeRemoteToolMock
      .mockResolvedValueOnce({
        ok: false,
        result: null,
        error: 'unsupported tool: ListDirectories',
        durationMs: 1,
      })
      .mockResolvedValueOnce({
        ok: true,
        result: {
          stdout: JSON.stringify({
            currentPath: '/Users/me/code',
            parentPath: '/Users/me',
            directories: [{ name: 'app', path: '/Users/me/code/app', hasChildren: false }],
            hasAllowlist: false,
          }),
          stderr: '',
        },
        error: null,
        durationMs: 2,
      });

    const { listDeviceDirectories } = await import('../src/routes/repos.js');
    const result = await listDeviceDirectories('cl_1234567890abcdef', '/Users/me/code');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.payload.currentPath).toBe('/Users/me/code');
    expect(invokeRemoteToolMock).toHaveBeenCalledTimes(2);
    expect(invokeRemoteToolMock.mock.calls[1][1].toolName).toBe('Bash');
  });
});
