import { beforeEach, describe, expect, test, vi } from 'vitest';

const getSessionMock = vi.hoisted(() => vi.fn());
const getOnlineMetaMock = vi.hoisted(() => vi.fn());
const listOnlineRuntimesByProviderMock = vi.hoisted(() => vi.fn(() => []));
const registerRunMock = vi.hoisted(() => vi.fn());
const unregisterRunMock = vi.hoisted(() => vi.fn());
const listManagedReposByUserMock = vi.hoisted(() => vi.fn(() => []));
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
  createAgentToolToken: vi.fn(() => 'test-agent-tool-token'),
}));
vi.mock('../src/db.js', () => ({
  listManagedReposByUser: listManagedReposByUserMock,
}));

describe('agent-link run context forwarding', () => {
  beforeEach(() => {
    getSessionMock.mockReset();
    getOnlineMetaMock.mockReset();
    listOnlineRuntimesByProviderMock.mockReset();
    listOnlineRuntimesByProviderMock.mockReturnValue([]);
    listManagedReposByUserMock.mockReset();
    listManagedReposByUserMock.mockReturnValue([]);
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
        agentId: 'coco',
        scope: 'session',
        scopeId: expect.stringMatching(
          /^octodeck-repo-demo-coco-[a-f0-9]{12}$/,
        ),
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
      scopeId: expect.stringMatching(
        /^octodeck-repo-conv-conversation-1-[a-f0-9]{12}$/,
      ),
    });

    registerRunMock.mock.calls
      .at(-1)?.[0]
      .finish({ exitCode: 0, signal: null, timedOut: false, durationMs: 1 });
    await promise;
  });

  test('runViaAgentLink keeps device workspace scope stable across native session changes', async () => {
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
    const commonGroup = {
      name: 'Flow Demo',
      folder: 'flow-mq3z0g6r-d007b379',
      added_at: '2026-01-01T00:00:00.000Z',
      executionMode: 'host',
      executionNode: 'cl_1234567890abcdef',
      repoDevicePath: '/Users/me/work/project',
    } as any;
    const cfg = {
      backendId: 'mac-traecli',
      resolveBinary: () => '/bin/echo',
      buildArgv: ({ prompt }) => [prompt],
      outputProtocol: 'plain-text' as const,
    };

    const first = runViaAgentLink(
      {
        group: commonGroup,
        input: {
          prompt: 'pwd',
          turnId: 'turn-001',
          chatJid: 'web:session-a',
        } as any,
        executionMode: 'host',
        onProcess: vi.fn(),
      },
      cfg,
      'cl_1234567890abcdef',
    );
    registerRunMock.mock.calls
      .at(-1)?.[0]
      .finish({ exitCode: 0, signal: null, timedOut: false, durationMs: 1 });
    await first;

    const second = runViaAgentLink(
      {
        group: commonGroup,
        input: {
          prompt: 'ls',
          turnId: 'turn-002',
          sessionId: 'native-session-001',
          chatJid: 'web:session-a',
        } as any,
        executionMode: 'host',
        onProcess: vi.fn(),
      },
      cfg,
      'cl_1234567890abcdef',
    );
    registerRunMock.mock.calls
      .at(-1)?.[0]
      .finish({ exitCode: 0, signal: null, timedOut: false, durationMs: 1 });
    await second;

    expect(sent[0].workspaceRepo).toMatchObject({
      groupFolder: 'flow-mq3z0g6r-d007b379',
      agentId: 'mac-traecli',
      scope: 'session',
      scopeId: expect.stringMatching(
        /^octodeck-flow-mq3z0g6r-d007b379-mac-traecli-[a-f0-9]{12}$/,
      ),
    });
    expect(sent[1].workspaceRepo).toMatchObject({
      groupFolder: 'flow-mq3z0g6r-d007b379',
      agentId: 'mac-traecli',
      scope: 'session',
      scopeId: sent[0].workspaceRepo.scopeId,
    });
    expect(sent[1].stdinJson).toContain('"sessionId":"native-session-001"');

    const third = runViaAgentLink(
      {
        group: commonGroup,
        input: {
          prompt: 'pwd',
          turnId: 'turn-003',
          chatJid: 'web:session-b',
        } as any,
        executionMode: 'host',
        onProcess: vi.fn(),
      },
      cfg,
      'cl_1234567890abcdef',
    );
    registerRunMock.mock.calls
      .at(-1)?.[0]
      .finish({ exitCode: 0, signal: null, timedOut: false, durationMs: 1 });
    await third;

    expect(sent[2].workspaceRepo).toMatchObject({
      groupFolder: 'flow-mq3z0g6r-d007b379',
      agentId: 'mac-traecli',
      scope: 'session',
      scopeId: expect.stringMatching(
        /^octodeck-flow-mq3z0g6r-d007b379-mac-traecli-[a-f0-9]{12}$/,
      ),
    });
    expect(sent[2].workspaceRepo.scopeId).toBe(sent[0].workspaceRepo.scopeId);
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

  test('runViaAgentLink does not create repo worktrees for scheduled jobs without workspace binding', async () => {
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
          name: 'Scheduled Repo Demo',
          folder: 'scheduled-repo-demo',
          added_at: '2026-01-01T00:00:00.000Z',
          executionMode: 'host',
          executionNode: 'cl_1234567890abcdef',
          repoGitUrl: 'https://github.com/acme/project.git',
        } as any,
        input: {
          prompt: 'run scheduled job',
          isScheduledTask: true,
          taskRunId: 'run-123',
          messageTaskId: 'task-123',
          scheduledTaskHasWorkspace: false,
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

    expect(sent[0].workspaceRepos).toBeUndefined();
    expect(sent[0].workspaceRepo).toMatchObject({
      kind: 'workspace',
      groupFolder: 'scheduled-repo-demo',
      scope: 'task',
      scopeId: 'run-123',
      taskId: 'task-123',
      taskRunId: 'run-123',
    });
    expect(sent[0].workspaceRepo.gitUrl).toBeUndefined();

    registerRunMock.mock.calls
      .at(-1)?.[0]
      .finish({ exitCode: 0, signal: null, timedOut: false, durationMs: 1 });
    await promise;
  });

  test('runViaAgentLink keeps repo worktrees for scheduled jobs with workspace binding', async () => {
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
          name: 'Bound Scheduled Repo Demo',
          folder: 'bound-scheduled-repo-demo',
          added_at: '2026-01-01T00:00:00.000Z',
          executionMode: 'host',
          executionNode: 'cl_1234567890abcdef',
          repoGitUrl: 'https://github.com/acme/project.git',
        } as any,
        input: {
          prompt: 'run bound scheduled job',
          isScheduledTask: true,
          taskRunId: 'run-456',
          messageTaskId: 'task-456',
          scheduledTaskHasWorkspace: true,
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

    expect(sent[0].workspaceRepos).toHaveLength(1);
    expect(sent[0].workspaceRepo).toMatchObject({
      kind: 'git',
      gitUrl: 'https://github.com/acme/project.git',
      groupFolder: 'bound-scheduled-repo-demo',
      scope: 'task',
      scopeId: 'run-456',
      taskId: 'task-456',
      taskRunId: 'run-456',
    });

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
      workspace: {
        folder: 'device-claude',
        scope: 'session',
        scopeId: 'web:device-claude',
      },
      input: {
        metadata: {
          groupFolder: 'device-claude',
          chatId: 'web:device-claude',
          conversationId: 'web:device-claude',
          sessionKey: 'web:device-claude',
          chatJid: 'web:device-claude',
          workspaceId: 'device-claude',
        },
      },
      policy: { model: 'sonnet' },
    });
    expect(sent[0].policy.systemPrompt).toContain('<behavior>');
    expect(sent[0].policy.systemPrompt).toContain('<skill-routing>');
    expect(sent[0].policy.systemPrompt).toContain('<security>');
    expect(sent[0].policy.systemPrompt).toContain('<memory-system>');
    expect(sent[0].policy.systemPrompt).toContain('<guidelines>');
    expect(sent[0].policy.systemPrompt).toContain('<channel-format>');
    expect(sent[0].policy.systemPrompt).toContain('飞书');

    registerRunMock.mock.calls.at(-1)?.[0].finish({
      ok: true,
      result: 'ok',
      error: null,
      timedOut: false,
      durationMs: 1,
    });
    await promise;
  });

  test('runViaAgentLink sends run.cancel when AbortSignal aborts legacy runs', async () => {
    const sent: any[] = [];
    getSessionMock.mockReturnValue({
      state: 'open',
      send(frame: any) {
        sent.push(frame);
        return true;
      },
    });
    const abortController = new AbortController();

    const { runViaAgentLink } =
      await import('../src/backends/agent-link-driver.js');
    const promise = runViaAgentLink(
      {
        group: {
          name: 'Abort Legacy',
          folder: 'abort-legacy',
          added_at: '2026-01-01T00:00:00.000Z',
          executionMode: 'host',
          executionNode: 'cl_1234567890abcdef',
          created_by: 'u1',
        } as any,
        input: { prompt: 'hello' } as any,
        executionMode: 'host',
        onProcess: vi.fn(),
        signal: abortController.signal,
      },
      {
        backendId: 'coco',
        resolveBinary: () => '/bin/echo',
        buildArgv: ({ prompt }) => [prompt],
        outputProtocol: 'plain-text',
      },
      'cl_1234567890abcdef',
    );

    expect(sent[0]).toMatchObject({ type: 'run.request' });
    abortController.abort('agent_team_cancel');
    expect(sent[1]).toMatchObject({
      type: 'run.cancel',
      runId: sent[0].runId,
      reason: 'user_abort',
    });

    registerRunMock.mock.calls
      .at(-1)?.[0]
      .finish({ exitCode: 0, signal: null, timedOut: false, durationMs: 1 });
    await promise;
  });

  test('runViaAgentLink sends agent.run.cancel when AbortSignal aborts agent runtime runs', async () => {
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
    const abortController = new AbortController();

    const { runViaAgentLink } =
      await import('../src/backends/agent-link-driver.js');
    const promise = runViaAgentLink(
      {
        group: {
          name: 'Abort Agent Runtime',
          folder: 'abort-agent-runtime',
          added_at: '2026-01-01T00:00:00.000Z',
          executionMode: 'host',
          executionNode: 'runtime:cl_1234567890abcdef:claude-code',
          runtimeProfile: 'device-cli-agent',
          created_by: 'u1',
        } as any,
        input: { prompt: 'hello', isHome: false } as any,
        executionMode: 'host',
        onProcess: vi.fn(),
        signal: abortController.signal,
      },
      {
        backendId: 'mac-claude-code',
        resolveBinary: () => '/usr/local/bin/claude',
        buildArgv: ({ prompt }) => [prompt],
        outputProtocol: 'jsonline-stream-json',
      },
      'runtime:cl_1234567890abcdef:claude-code',
    );

    expect(sent[0]).toMatchObject({ type: 'agent.run.request' });
    abortController.abort('agent_team_cancel');
    expect(sent[1]).toMatchObject({
      type: 'agent.run.cancel',
      runId: sent[0].runId,
      reason: 'user_abort',
    });

    registerRunMock.mock.calls.at(-1)?.[0].finish({
      ok: true,
      result: 'ok',
      error: null,
      timedOut: false,
      durationMs: 1,
    });
    await promise;
  });

  test('runViaAgentLink forwards device agent.run thinking and tool events separately', async () => {
    const sent: any[] = [];
    const outputs: any[] = [];
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
          name: 'Device Tool Events',
          folder: 'device-tool-events',
          added_at: '2026-01-01T00:00:00.000Z',
          executionMode: 'host',
          executionNode: 'runtime:cl_1234567890abcdef:claude-code',
          runtimeProfile: 'device-cli-agent',
          created_by: 'u1',
        } as any,
        input: {
          prompt: 'hello',
          chatJid: 'web:device-tool-events',
          isHome: false,
        } as any,
        executionMode: 'host',
        onProcess: vi.fn(),
        onOutput: vi.fn(async (output) => {
          outputs.push(output);
        }),
      },
      {
        backendId: 'mac-claude-code',
        resolveBinary: () => '/usr/local/bin/claude',
        buildArgv: ({ prompt }) => [prompt],
        outputProtocol: 'jsonline-stream-json',
      },
      'runtime:cl_1234567890abcdef:claude-code',
    );

    expect(sent[0]).toMatchObject({ type: 'agent.run.request' });
    const controller = registerRunMock.mock.calls.at(-1)?.[0] as any;
    expect(controller).toBeTruthy();

    controller.onEvent({
      type: 'agent.run.event',
      runId: controller.runId,
      eventType: 'thinking_delta',
      text: '需要先检查文件',
      sessionId: 'sess-1',
    });
    controller.onEvent({
      type: 'agent.run.event',
      runId: controller.runId,
      eventType: 'tool_call',
      sessionId: 'sess-1',
      payload: {
        type: 'assistant',
        session_id: 'sess-1',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'Bash',
              input: { command: 'pwd' },
            },
          ],
        },
      },
    });
    controller.onEvent({
      type: 'agent.run.event',
      runId: controller.runId,
      eventType: 'tool_result',
      sessionId: 'sess-1',
      payload: {
        type: 'user',
        session_id: 'sess-1',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-1',
              content: '/repo',
            },
          ],
        },
      },
    });
    controller.onEvent({
      type: 'agent.run.event',
      runId: controller.runId,
      eventType: 'text_delta',
      text: '最终回答',
      sessionId: 'sess-1',
    });
    controller.finish({
      type: 'agent.run.result',
      runId: controller.runId,
      ok: true,
      error: null,
      sessionId: 'sess-1',
      timedOut: false,
      durationMs: 1,
    });

    const result = await promise;
    expect(result.result).toBe('最终回答');
    const streamEvents = outputs
      .map((output) => output.streamEvent)
      .filter(Boolean);
    expect(streamEvents.map((event) => event.eventType)).toEqual(
      expect.arrayContaining([
        'thinking_delta',
        'tool_use_start',
        'tool_use_end',
        'text_delta',
      ]),
    );
    expect(
      streamEvents.find((event) => event.eventType === 'tool_use_start'),
    ).toMatchObject({ toolName: 'Bash', toolUseId: 'tool-1' });
    expect(
      streamEvents.find((event) => event.eventType === 'tool_use_end'),
    ).toMatchObject({ toolUseId: 'tool-1', detail: '/repo' });
  });

  test('runViaAgentLink parses legacy device stream-json thinking and tool events', async () => {
    const sent: any[] = [];
    const outputs: any[] = [];
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
          name: 'Legacy Device Events',
          folder: 'legacy-device-events',
          added_at: '2026-01-01T00:00:00.000Z',
          executionMode: 'host',
          executionNode: 'runtime:cl_1234567890abcdef:claude-code',
          runtimeProfile: 'device-cli-agent',
          created_by: 'u1',
        } as any,
        input: { prompt: 'hello', chatJid: 'web:legacy-device-events' } as any,
        executionMode: 'host',
        onProcess: vi.fn(),
        onOutput: vi.fn(async (output) => outputs.push(output)),
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
    const controller = registerRunMock.mock.calls.at(-1)?.[0] as any;
    controller.onChunk(
      'stdout',
      [
        JSON.stringify({
          type: 'reasoning',
          session_id: 'sess-1',
          reasoning: '先想一下',
        }),
        JSON.stringify({
          type: 'assistant',
          session_id: 'sess-1',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'tool-legacy',
                name: 'Bash',
                input: { command: 'pwd' },
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'user',
          session_id: 'sess-1',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tool-legacy',
                content: '/repo',
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'assistant',
          session_id: 'sess-1',
          message: { content: [{ type: 'text', text: '最终回答' }] },
        }),
        '',
      ].join('\n'),
    );
    controller.finish({
      exitCode: 0,
      signal: null,
      timedOut: false,
      durationMs: 1,
    });

    const result = await promise;
    expect(result.result).toBe('最终回答');
    const streamEvents = outputs
      .map((output) => output.streamEvent)
      .filter(Boolean);
    expect(streamEvents.map((event) => event.eventType)).toEqual(
      expect.arrayContaining([
        'thinking_delta',
        'tool_use_start',
        'tool_use_end',
        'text_delta',
      ]),
    );
    expect(
      streamEvents.find((event) => event.eventType === 'thinking_delta'),
    ).toMatchObject({ text: '先想一下' });
    expect(
      streamEvents.find((event) => event.eventType === 'tool_use_start'),
    ).toMatchObject({ toolName: 'Bash', toolUseId: 'tool-legacy' });
  });

  test('agent runtime tool results keep toolName by toolUseId', async () => {
    const sent: any[] = [];
    const outputs: any[] = [];
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
          name: 'Agent Runtime Tool Names',
          folder: 'agent-runtime-tool-names',
          added_at: '2026-01-01T00:00:00.000Z',
          executionMode: 'host',
          executionNode: 'runtime:cl_1234567890abcdef:claude-code',
          runtimeProfile: 'device-cli-agent',
          created_by: 'u1',
        } as any,
        input: {
          prompt: 'hello',
          chatJid: 'web:agent-runtime-tool-names',
        } as any,
        executionMode: 'host',
        onProcess: vi.fn(),
        onOutput: vi.fn(async (output) => outputs.push(output)),
      },
      {
        backendId: 'mac-claude-code',
        resolveBinary: () => '/usr/local/bin/claude',
        buildArgv: ({ prompt }) => [prompt],
        outputProtocol: 'jsonline-stream-json',
      },
      'runtime:cl_1234567890abcdef:claude-code',
    );

    expect(sent[0]).toMatchObject({ type: 'agent.run.request' });
    const controller = registerRunMock.mock.calls.at(-1)?.[0] as any;
    controller.onEvent({
      type: 'agent.run.event',
      runId: controller.runId,
      eventType: 'tool_call',
      sessionId: 'sess-tool-name',
      payload: {
        id: 'tool-name-1',
        name: 'Read',
        input: { file_path: 'README.md' },
      },
    });
    controller.onEvent({
      type: 'agent.run.event',
      runId: controller.runId,
      eventType: 'tool_result',
      sessionId: 'sess-tool-name',
      payload: { tool_use_id: 'tool-name-1', content: 'ok' },
    });
    controller.finish({
      type: 'agent.run.result',
      runId: controller.runId,
      ok: true,
      result: 'done',
      error: null,
      sessionId: 'sess-tool-name',
      timedOut: false,
      durationMs: 1,
    });

    await promise;
    const streamEvents = outputs
      .map((output) => output.streamEvent)
      .filter(Boolean);
    expect(
      streamEvents.find((event) => event.eventType === 'tool_use_end'),
    ).toMatchObject({
      toolName: 'Read',
      toolUseId: 'tool-name-1',
      detail: 'ok',
    });
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
