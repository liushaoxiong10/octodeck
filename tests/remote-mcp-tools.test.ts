import { describe, expect, test, vi } from 'vitest';

import { createMcpTools } from '../container/agent-runner/src/mcp-tools.js';
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

  test('built-in MCP exposes agent team tools for session agents', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ run: { id: 'team_run_1', status: 'success' }, execution: { status: 'success' } }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    try {
      const tools = createMcpTools({
        chatJid: 'web:main',
        groupFolder: 'main',
        isHome: true,
        isAdminHome: true,
        workspaceIpc: '/tmp/octodeck-ipc-test',
        workspaceGroup: '/tmp/octodeck-group-test',
        workspaceGlobal: '/tmp/octodeck-global-test',
        workspaceMemory: '/tmp/octodeck-memory-test',
        ownerUserId: 'alice',
        serverBaseUrl: 'http://127.0.0.1:3000',
        agentRunnerSecret: 'secret',
      });
      expect(tools.map((tool: any) => tool.name)).toEqual(expect.arrayContaining([
        'agent_team_list',
        'agent_team_get',
        'agent_team_run',
        'agent_team_get_run',
        'agent_team_decide_approval',
        'agent_team_cancel_run',
      ]));

      const runTool = tools.find((tool: any) => tool.name === 'agent_team_run') as any;
      const result = await runTool.handler({
        team_id: 'team_123',
        prompt: '实现登录页',
        runner_agent_id: 'claude-sdk',
        role_assignments: { builder: { runnerAgentId: 'runner_b' } },
      });

      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:3000/api/agent-teams/tool',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ authorization: 'Bearer secret' }),
        }),
      );
      const posted = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(posted).toMatchObject({
        userId: 'alice',
        operation: 'run_team',
        teamId: 'team_123',
        prompt: '实现登录页',
        runnerAgentId: 'claude-sdk',
      });
      expect(posted.roleAssignments).toEqual({ builder: { runnerAgentId: 'runner_b' } });
      expect(result.content[0].text).toContain('team_run_1');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('built-in MCP hides agent team tools for nested team agents', () => {
    const tools = createMcpTools({
      chatJid: 'system:agent-team:team_123',
      groupFolder: 'agent-team-team_123-builder',
      isHome: false,
      isAdminHome: false,
      workspaceIpc: '/tmp/octodeck-ipc-test',
      workspaceGroup: '/tmp/octodeck-group-test',
      workspaceGlobal: '/tmp/octodeck-global-test',
      workspaceMemory: '/tmp/octodeck-memory-test',
      ownerUserId: 'alice',
      serverBaseUrl: 'http://127.0.0.1:3000',
      agentRunnerSecret: 'secret',
    });

    expect(tools.map((tool: any) => tool.name)).not.toEqual(expect.arrayContaining([
      'agent_team_list',
      'agent_team_run',
      'agent_team_cancel_run',
    ]));
  });
});
