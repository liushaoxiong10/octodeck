import { beforeEach, describe, expect, test, vi } from 'vitest';

const getSessionMock = vi.hoisted(() => vi.fn());
const getOnlineMetaMock = vi.hoisted(() => vi.fn());
const listOnlineRuntimesByProviderMock = vi.hoisted(() => vi.fn(() => []));
const registerRunMock = vi.hoisted(() => vi.fn());
const unregisterRunMock = vi.hoisted(() => vi.fn());
const getSystemSettingsMock = vi.hoisted(() =>
  vi.fn(() => ({ containerTimeout: 1000, containerMaxOutputSize: 4096 })),
);

vi.mock('../src/agent-link/registry.js', () => ({
  getSession: getSessionMock,
  getOnlineMeta: getOnlineMetaMock,
  listOnlineRuntimesByProvider: listOnlineRuntimesByProviderMock,
}));
vi.mock('../src/agent-link/run-rpc.js', () => ({
  registerRun: registerRunMock,
  registerAgentRun: registerRunMock,
  unregisterRun: unregisterRunMock,
  unregisterAgentRun: unregisterRunMock,
}));
vi.mock('../src/runtime-config.js', () => ({
  LONG_RUNNING_LOCAL_CLI_TIMEOUT_MS: 7_200_000,
  getSystemSettings: getSystemSettingsMock,
}));
vi.mock('../src/config.js', () => ({
  GROUPS_DIR: '/tmp/octodeck-test/groups',
}));

describe('agent-link run context forwarding', () => {
  beforeEach(() => {
    getSessionMock.mockReset();
    getOnlineMetaMock.mockReset();
    listOnlineRuntimesByProviderMock.mockReset();
    listOnlineRuntimesByProviderMock.mockReturnValue([]);
    registerRunMock.mockClear();
    unregisterRunMock.mockClear();
  });

  test('runViaAgentLink forwards device workspace repo metadata', async () => {
    const sent: any[] = [];
    getSessionMock.mockReturnValue({
      state: 'open',
      send(frame: any) {
        sent.push(frame);
        return true;
      },
    });

    const { runViaAgentLink } =
      await import('../src/backends/agent-link-driver.js');
    const promise = runViaAgentLink(
      {
        group: {
          name: 'Repo Demo',
          folder: 'repo-demo',
          added_at: '2026-01-01T00:00:00.000Z',
          executionMode: 'host',
          executionNode: 'cl_1234567890abcdef',
          repoGitUrl: 'https://github.com/acme/project.git',
        } as any,
        input: { prompt: 'hello' } as any,
        executionMode: 'host',
        onProcess: vi.fn(),
      },
      {
        backendId: 'coco',
        resolveBinary: () => '/bin/echo',
        buildArgv: ({ prompt, cwd }) => [prompt, `--cwd=${cwd}`],
        outputProtocol: 'plain-text',
      },
      'cl_1234567890abcdef',
    );

    expect(sent[0]).toMatchObject({
      type: 'run.request',
      workspaceRepo: {
        kind: 'git',
        gitUrl: 'https://github.com/acme/project.git',
        groupFolder: 'repo-demo',
      },
      remoteCwdPlaceholder: '__OCTODECK_REMOTE_CWD__',
      context: {
        cwd: '__OCTODECK_REMOTE_CWD__',
        repo: {
          gitUrl: 'https://github.com/acme/project.git',
          kind: 'git',
          cwd: '__OCTODECK_REMOTE_CWD__',
        },
        group: { repoGitUrl: 'https://github.com/acme/project.git' },
      },
    });
    expect(sent[0].argv).toContain('--cwd=__OCTODECK_REMOTE_CWD__');

    registerRunMock.mock.calls
      .at(-1)?.[0]
      .finish({ exitCode: 0, signal: null, timedOut: false, durationMs: 1 });
    await promise;
  });

  test('runViaAgentLink includes full container input context and stdinJson', async () => {
    const sent: any[] = [];
    getSessionMock.mockReturnValue({
      state: 'open',
      send(frame: any) {
        sent.push(frame);
        return true;
      },
    });

    const { runViaAgentLink } =
      await import('../src/backends/agent-link-driver.js');
    const promise = runViaAgentLink(
      {
        group: {
          name: 'Demo',
          folder: 'demo',
          added_at: '2026-01-01T00:00:00.000Z',
          executionMode: 'host',
          executionNode: 'cl_1234567890abcdef',
          backend: 'coco',
          is_home: true,
          created_by: 'u1',
        } as any,
        input: {
          prompt: 'hello',
          sessionId: 'sess-1',
          groupFolder: 'demo',
          chatJid: 'web:demo',
          currentSourceJid: 'feishu:chat',
          turnId: 'turn-1',
          isMain: false,
          isHome: true,
          isAdminHome: false,
          agentId: 'agent-1',
          agentName: 'worker',
          images: [{ data: 'abc', mimeType: 'image/png' }],
        } as any,
        executionMode: 'host',
        onProcess: vi.fn(),
      },
      {
        backendId: 'coco',
        resolveBinary: () => '/bin/echo',
        buildArgv: ({ prompt }) => [prompt],
        outputProtocol: 'plain-text',
      },
      'cl_1234567890abcdef',
    );

    expect(sent[0]).toMatchObject({
      type: 'run.request',
      backendId: 'coco',
      context: {
        backendId: 'coco',
        executionMode: 'host',
        input: { prompt: 'hello', sessionId: 'sess-1', agentId: 'agent-1' },
        group: {
          folder: 'demo',
          backend: 'coco',
          executionNode: 'cl_1234567890abcdef',
        },
      },
    });
    expect(sent[0].stdinJson).toContain('"prompt":"hello"');

    registerRunMock.mock.calls
      .at(-1)?.[0]
      .finish({ exitCode: 0, signal: null, timedOut: false, durationMs: 1 });
    await promise;
  });

  test('runViaAgentLink scopes repo worktrees to conversation agent sessions', async () => {
    const sent: any[] = [];
    getSessionMock.mockReturnValue({
      state: 'open',
      send(frame: any) {
        sent.push(frame);
        return true;
      },
    });

    const { runViaAgentLink } =
      await import('../src/backends/agent-link-driver.js');
    const promise = runViaAgentLink(
      {
        group: {
          name: 'Repo Conversation',
          folder: 'repo-conv',
          added_at: '2026-01-01T00:00:00.000Z',
          executionMode: 'host',
          executionNode: 'cl_1234567890abcdef',
          repoGitUrl: 'https://github.com/acme/project.git',
        } as any,
        input: {
          prompt: 'hello',
          agentId: 'conversation-1',
          groupFolder: 'repo-conv',
          chatJid: 'web:repo-conv',
        } as any,
        executionMode: 'host',
        onProcess: vi.fn(),
      },
      {
        backendId: 'claude-device',
        resolveBinary: () => '/bin/echo',
        buildArgv: ({ prompt }) => [prompt],
        outputProtocol: 'plain-text',
      },
      'cl_1234567890abcdef',
    );

    expect(sent[0].workspaceRepo).toMatchObject({
      kind: 'git',
      gitUrl: 'https://github.com/acme/project.git',
      groupFolder: 'repo-conv',
      agentId: 'conversation-1',
      scope: 'session',
      scopeId: 'conversation-1',
    });

    registerRunMock.mock.calls
      .at(-1)?.[0]
      .finish({ exitCode: 0, signal: null, timedOut: false, durationMs: 1 });
    await promise;
  });

  test('runViaAgentLink strips Agent Team MCP config from nested team role runs', async () => {
    const sent: any[] = [];
    getSessionMock.mockReturnValue({
      state: 'open',
      send(frame: any) {
        sent.push(frame);
        return true;
      },
    });

    const { runViaAgentLink } =
      await import('../src/backends/agent-link-driver.js');
    const promise = runViaAgentLink(
      {
        group: {
          name: 'Agent Team Demo',
          folder: 'agent-team-team_123-builder',
          added_at: '2026-01-01T00:00:00.000Z',
          executionMode: 'host',
          executionNode: 'cl_1234567890abcdef',
          backend: 'claude-device',
          created_by: 'u1',
        } as any,
        input: {
          prompt: 'build role output',
          chatJid: 'system:agent-team:team_123',
        } as any,
        executionMode: 'host',
        onProcess: vi.fn(),
      },
      {
        backendId: 'claude-device',
        resolveBinary: () => '/usr/local/bin/claude',
        buildArgv: ({ prompt }) => [
          '-p',
          prompt,
          '--mcp-config',
          '__OCTODECK_AGENT_TEAM_MCP_CONFIG__',
        ],
        outputProtocol: 'jsonline-stream-json',
      },
      'cl_1234567890abcdef',
    );

    expect(sent[0].argv).toEqual(['-p', 'build role output']);

    registerRunMock.mock.calls
      .at(-1)?.[0]
      .finish({ exitCode: 0, signal: null, timedOut: false, durationMs: 1 });
    await promise;
  });

  test('runViaAgentLink forwards TraeCLI Agent Team MCP setup marker to daemon client sessions', async () => {
    const sent: any[] = [];
    getSessionMock.mockReturnValue({
      state: 'open',
      send(frame: any) {
        sent.push(frame);
        return true;
      },
    });

    const { runViaAgentLink } =
      await import('../src/backends/agent-link-driver.js');
    const { normalizeAgentClientBackendDef } =
      await import('../src/backends/agent-client-adapter.js');
    const backendDef = normalizeAgentClientBackendDef({
      id: 'mac-coco-gpt',
      displayName: 'Mac Coco GPT',
      binary: '/Users/me/.local/bin/traecli',
      argvTemplate: ['-p', '{prompt}', '-c', 'model.name={model}'],
      outputProtocol: 'plain-text',
      supportsHost: true,
      supportsContainer: false,
      usesProviderPool: false,
      runtime: 'local-device',
      model: 'GPT-5.5',
      deviceLinkId: 'cl_1234567890abcdef',
      agentClientId: 'traecli',
    });

    const promise = runViaAgentLink(
      {
        group: {
          name: 'Home',
          folder: 'main',
          added_at: '2026-01-01T00:00:00.000Z',
          executionMode: 'host',
          executionNode: 'cl_1234567890abcdef',
        } as any,
        input: { prompt: '看看工具', chatJid: 'web:main' } as any,
        executionMode: 'host',
        onProcess: vi.fn(),
      },
      {
        backendId: backendDef.id,
        resolveBinary: () => backendDef.binary,
        buildArgv: ({ prompt, cwd }) =>
          backendDef.argvTemplate.map((arg) =>
            arg
              .replace('{prompt}', prompt)
              .replace('{cwd}', cwd)
              .replace('{model}', backendDef.model ?? ''),
          ),
        outputProtocol: backendDef.outputProtocol,
      },
      'cl_1234567890abcdef',
    );

    expect(sent[0].argv).toContain(
      '__OCTODECK_AGENT_TEAM_MCP_PROJECT_CONFIG__',
    );

    registerRunMock.mock.calls
      .at(-1)?.[0]
      .finish({ exitCode: 0, signal: null, timedOut: false, durationMs: 1 });
    await promise;
  });

  test('runViaAgentLink gives scheduled background jobs a long default timeout', async () => {
    const sent: any[] = [];
    getSessionMock.mockReturnValue({
      state: 'open',
      send(frame: any) {
        sent.push(frame);
        return true;
      },
    });

    const { runViaAgentLink } =
      await import('../src/backends/agent-link-driver.js');
    const promise = runViaAgentLink(
      {
        group: {
          name: 'Scheduled Demo',
          folder: 'scheduled-demo',
          added_at: '2026-01-01T00:00:00.000Z',
          executionMode: 'host',
          executionNode: 'cl_1234567890abcdef',
        } as any,
        input: {
          prompt: 'run long job',
          isScheduledTask: true,
        } as any,
        executionMode: 'host',
        onProcess: vi.fn(),
      },
      {
        backendId: 'coco',
        resolveBinary: () => '/bin/echo',
        buildArgv: ({ prompt }) => [prompt],
        outputProtocol: 'plain-text',
      },
      'cl_1234567890abcdef',
    );

    expect(sent[0].timeoutMs).toBe(7_200_000);

    registerRunMock.mock.calls
      .at(-1)?.[0]
      .finish({ exitCode: 0, signal: null, timedOut: false, durationMs: 1 });
    await promise;
  });

  test('runViaAgentLink forwards OctoDeck system prompt to device agent.run clients', async () => {
    const sent: any[] = [];
    getOnlineMetaMock.mockImplementation((linkId: string) =>
      linkId === 'cl_1234567890abcdef'
        ? { capabilities: ['agent.run'] }
        : undefined,
    );
    getSessionMock.mockReturnValue({
      state: 'open',
      send(frame: any) {
        sent.push(frame);
        return true;
      },
    });

    const { runViaAgentLink } =
      await import('../src/backends/agent-link-driver.js');
    const promise = runViaAgentLink(
      {
        group: {
          name: 'Device Claude',
          folder: 'device-claude',
          added_at: '2026-01-01T00:00:00.000Z',
          executionMode: 'host',
          executionNode: 'runtime:cl_1234567890abcdef:claude-code',
          runtimeProfile: 'device-cli-agent',
          created_by: 'u1',
        } as any,
        input: {
          prompt: 'hello',
          chatJid: 'web:device-claude',
          currentSourceJid: 'feishu:chat-1',
          isHome: false,
        } as any,
        executionMode: 'host',
        onProcess: vi.fn(),
      },
      {
        backendId: 'mac-claude-code',
        resolveBinary: () => '/usr/local/bin/claude',
        buildArgv: ({ prompt }) => [prompt],
        outputProtocol: 'jsonline-stream-json',
        model: 'sonnet',
      },
      'runtime:cl_1234567890abcdef:claude-code',
    );

    expect(sent[0]).toMatchObject({
      type: 'agent.run.request',
      agentId: 'claude-code',
      policy: { model: 'sonnet' },
    });
    expect(sent[0].policy.systemPrompt).toContain('<behavior>');
    expect(sent[0].policy.systemPrompt).toContain('<skill-routing>');
    expect(sent[0].policy.systemPrompt).toContain('<security>');
    expect(sent[0].policy.systemPrompt).toContain('<memory-system>');
    expect(sent[0].policy.systemPrompt).toContain('<guidelines>');
    expect(sent[0].policy.systemPrompt).toContain('<channel-format>');
    expect(sent[0].policy.systemPrompt).toContain('飞书');

    registerRunMock.mock.calls
      .at(-1)?.[0]
      .finish({ ok: true, result: 'ok', error: null, timedOut: false, durationMs: 1 });
    await promise;
  });

  test('runViaAgentLink appends OctoDeck system prompt to legacy device Claude CLI argv', async () => {
    const sent: any[] = [];
    getSessionMock.mockReturnValue({
      state: 'open',
      send(frame: any) {
        sent.push(frame);
        return true;
      },
    });

    const { runViaAgentLink } =
      await import('../src/backends/agent-link-driver.js');
    const promise = runViaAgentLink(
      {
        group: {
          name: 'Legacy Device Claude',
          folder: 'legacy-device-claude',
          added_at: '2026-01-01T00:00:00.000Z',
          executionMode: 'host',
          executionNode: 'runtime:cl_1234567890abcdef:claude-code',
          runtimeProfile: 'device-cli-agent',
          created_by: 'u1',
        } as any,
        input: {
          prompt: 'hello',
          chatJid: 'web:legacy-device-claude',
          isHome: false,
        } as any,
        executionMode: 'host',
        onProcess: vi.fn(),
      },
      {
        backendId: 'mac-claude-code',
        resolveBinary: () => '/usr/local/bin/claude',
        buildArgv: ({ prompt }) => [
          '-p',
          prompt,
          '--output-format',
          'stream-json',
        ],
        outputProtocol: 'jsonline-stream-json',
      },
      'runtime:cl_1234567890abcdef:claude-code',
    );

    expect(sent[0]).toMatchObject({ type: 'run.request' });
    const appendIdx = sent[0].argv.indexOf('--append-system-prompt');
    expect(appendIdx).toBeGreaterThan(-1);
    expect(sent[0].argv[appendIdx + 1]).toContain('<behavior>');
    expect(sent[0].argv[appendIdx + 1]).toContain('<skill-routing>');
    expect(sent[0].argv[appendIdx + 1]).toContain('<memory-system>');

    registerRunMock.mock.calls
      .at(-1)?.[0]
      .finish({ exitCode: 0, signal: null, timedOut: false, durationMs: 1 });
    await promise;
  });
});
