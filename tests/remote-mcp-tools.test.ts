import { describe, expect, test, vi } from 'vitest';

import { REMOTE_LOCAL_TOOL_NAMES, createRemoteMcpTools } from '../container/agent-runner/src/remote-mcp-tools.js';

describe('remote MCP tools', () => {
  test('creates remote filesystem and shell tool definitions', () => {
    const tools = createRemoteMcpTools({
      linkId: 'cl_1234567890abcdef',
      cwd: '/workspace/project',
      serverBaseUrl: 'http://127.0.0.1:3000',
      secret: 'secret',
      timeoutMs: 1000,
      maxOutputBytes: 4096,
    });

    expect(tools.map((t: any) => t.name)).toEqual(
      expect.arrayContaining(['remote_bash', 'remote_read', 'remote_write', 'remote_edit', 'remote_glob', 'remote_grep']),
    );
    expect(REMOTE_LOCAL_TOOL_NAMES).toContain('Bash');
    expect(REMOTE_LOCAL_TOOL_NAMES).toContain('Read');
    expect(REMOTE_LOCAL_TOOL_NAMES).not.toContain('WebFetch');
    expect(REMOTE_LOCAL_TOOL_NAMES).not.toContain('WebSearch');
  });

  test('remote_bash posts to agent-link tool bridge', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, result: { stdout: 'hi\n' }, error: null, durationMs: 3 }),
    }));

    const tools = createRemoteMcpTools({
      linkId: 'cl_1234567890abcdef',
      cwd: '/workspace/project',
      serverBaseUrl: 'http://127.0.0.1:3000',
      secret: 'secret',
      timeoutMs: 1000,
      maxOutputBytes: 4096,
      fetchImpl: fetchMock as any,
    });
    const bash = tools.find((t: any) => t.name === 'remote_bash') as any;

    const result = await bash.handler({ command: 'printf hi' });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/api/agent-link/tool',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer secret' }),
      }),
    );
    expect(result.content[0].text).toContain('hi');
  });

  test('remote_bash forwards per-call long timeout to server bridge', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, result: { stdout: 'done\n' }, error: null, durationMs: 3 }),
    }));

    const tools = createRemoteMcpTools({
      linkId: 'cl_1234567890abcdef',
      cwd: '/workspace/project',
      serverBaseUrl: 'http://127.0.0.1:3000',
      secret: 'secret',
      timeoutMs: 1000,
      maxOutputBytes: 4096,
      fetchImpl: fetchMock as any,
    });
    const bash = tools.find((t: any) => t.name === 'remote_bash') as any;

    await bash.handler({ command: 'long-running-cli', timeout_ms: 7_200_000 });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.timeoutMs).toBe(7_200_000);
  });

  test('remote_bash uses a long default server wait for local CLI commands', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, result: { stdout: 'done\n' }, error: null, durationMs: 3 }),
    }));

    const tools = createRemoteMcpTools({
      linkId: 'cl_1234567890abcdef',
      cwd: '/workspace/project',
      serverBaseUrl: 'http://127.0.0.1:3000',
      secret: 'secret',
      timeoutMs: 7_200_000,
      maxOutputBytes: 4096,
      fetchImpl: fetchMock as any,
    });
    const bash = tools.find((t: any) => t.name === 'remote_bash') as any;

    await bash.handler({ command: 'long-running-background-job' });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.timeoutMs).toBe(7_200_000);
  });
});
