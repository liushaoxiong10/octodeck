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
});
