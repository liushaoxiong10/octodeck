import { describe, expect, test, vi } from 'vitest';

const runHostCliMock = vi.hoisted(() => vi.fn(async () => ({ status: 'success', result: 'host' })));
const runViaAgentLinkMock = vi.hoisted(() => vi.fn(async () => ({ status: 'success', result: 'device' })));
const runHostAgentMock = vi.hoisted(() => vi.fn(async () => ({ status: 'success', result: 'host-agent' })));
const runContainerAgentMock = vi.hoisted(() => vi.fn(async () => ({ status: 'success', result: 'container-agent' })));
const sdkQueryMock = vi.hoisted(() => vi.fn(async () => '{"ok":true}'));

vi.mock('../src/container-runner.js', () => ({
  runHostAgent: runHostAgentMock,
  runContainerAgent: runContainerAgentMock,
}));

vi.mock('../src/sdk-query.js', () => ({
  sdkQuery: sdkQueryMock,
}));

vi.mock('../src/backends/host-cli-driver.js', () => ({
  runHostCli: runHostCliMock,
}));

vi.mock('../src/backends/agent-link-driver.js', () => ({
  runViaAgentLink: runViaAgentLinkMock,
}));

describe('device-backed agent backend', () => {
  test('uses lightweight SDK query for single-turn json cloud SDK runs', async () => {
    runHostAgentMock.mockClear();
    runContainerAgentMock.mockClear();
    sdkQueryMock.mockClear();
    sdkQueryMock.mockResolvedValueOnce('{"team":{"name":"Demo"}}');

    const { claudeSdkBackend } = await import('../src/backends/claude-sdk.js');
    const result = await claudeSdkBackend.run({
      group: {
        name: 'Agent Team Generator',
        folder: 'agent-team-generator',
        created_by: 'alice',
        containerConfig: { timeout: 12345 },
      } as any,
      input: {
        prompt: 'return json',
        executionProfile: 'single-turn-json',
      } as any,
      executionMode: 'host',
      onProcess: vi.fn(),
      onOutput: vi.fn(),
    });

    expect(result).toEqual({ status: 'success', result: '{"team":{"name":"Demo"}}' });
    expect(sdkQueryMock).toHaveBeenCalledWith('return json', { timeout: 12345, userId: 'alice' });
    expect(runHostAgentMock).not.toHaveBeenCalled();
    expect(runContainerAgentMock).not.toHaveBeenCalled();
  });

  test('server-agent cloud SDK runs on server runner with local execution disabled', async () => {
    runHostAgentMock.mockClear();
    runContainerAgentMock.mockClear();

    const { claudeSdkBackend } = await import('../src/backends/claude-sdk.js');
    await claudeSdkBackend.run({
      group: {
        name: 'Server Agent',
        folder: 'server-agent',
        runtimeProfile: 'server-agent',
      } as any,
      input: { prompt: 'hello' } as any,
      executionMode: 'host',
      onProcess: vi.fn(),
      onOutput: vi.fn(),
    });

    expect(runHostAgentMock).toHaveBeenCalledTimes(1);
    expect(runHostAgentMock.mock.calls[0][1]).toMatchObject({
      localToolPolicy: 'none',
      remoteExecutionLinkId: undefined,
    });
    expect(runContainerAgentMock).not.toHaveBeenCalled();
  });

  test('server-agent-device-tools keeps SDK runner on server and routes tools to device', async () => {
    runHostAgentMock.mockClear();
    runContainerAgentMock.mockClear();

    const { claudeSdkBackend } = await import('../src/backends/claude-sdk.js');
    await claudeSdkBackend.run({
      group: {
        name: 'Server With Device',
        folder: 'server-with-device',
        runtimeProfile: 'server-agent-device-tools',
        deviceLinkId: 'cl_1234567890abcdef',
      } as any,
      input: { prompt: 'hello' } as any,
      executionMode: 'host',
      onProcess: vi.fn(),
      onOutput: vi.fn(),
    });

    expect(runHostAgentMock).toHaveBeenCalledTimes(1);
    expect(runHostAgentMock.mock.calls[0][1]).toMatchObject({
      localToolPolicy: 'device-remote',
      remoteExecutionLinkId: 'cl_1234567890abcdef',
    });
    expect(runContainerAgentMock).not.toHaveBeenCalled();
  });

  test('server runtime profiles resolve the cloud SDK even when default backend is device CLI', async () => {
    vi.resetModules();
    vi.doMock('../src/runtime-config.js', () => ({
      getSystemSettings: () => ({
        defaultBackend: 'mac-codex',
        allowedBackends: ['claude-sdk', 'mac-codex'],
      }),
    }));

    try {
      const { registerBackend, resolveBackend } = await import('../src/backends/registry.js');
      registerBackend({
        id: 'mac-codex',
        displayName: 'Mac Codex',
        usesProviderPool: false,
        supportsExecutionMode: () => true,
        run: vi.fn(),
      } as any);

      const backend = resolveBackend({
        name: 'Server With Device',
        folder: 'server-with-device',
        runtimeProfile: 'server-agent-device-tools',
        backend: 'mac-codex',
        deviceLinkId: 'cl_1234567890abcdef',
      } as any);

      expect(backend.id).toBe('claude-sdk');
    } finally {
      vi.doUnmock('../src/runtime-config.js');
      vi.resetModules();
    }
  });

  test('does not expose TraeCLI as a builtin backend', async () => {
    const { listBackends, isBuiltinBackend } = await import('../src/backends/registry.js');
    const backendIds = listBackends().map((backend) => backend.id);

    expect(backendIds).toContain('claude-sdk');
    expect(backendIds).not.toContain('traecli');
    expect(backendIds).not.toContain('coco');
    expect(isBuiltinBackend('traecli')).toBe(false);
    expect(isBuiltinBackend('coco')).toBe(false);
  });

  test('accepts runtime model and workdir settings on custom backend create schema', async () => {
    const { CustomBackendCreateSchema } = await import('../src/schemas.js');

    const parsed = CustomBackendCreateSchema.parse({
      displayName: 'Mac Codex',
      runtime: 'local-device',
      deviceLinkId: 'cl_1234567890abcdef',
      agentClientId: 'codex',
      model: 'gpt-5',
      workdirMode: 'custom',
      workdir: '/Users/lsx/code/app/octodeck',
    });

    expect(parsed.runtime).toBe('local-device');
    expect(parsed.model).toBe('gpt-5');
    expect(parsed.workdirMode).toBe('custom');
    expect(parsed.workdir).toBe('/Users/lsx/code/app/octodeck');
  });

  test('accepts agent create schema without binding a workdir', async () => {
    const { CustomBackendCreateSchema } = await import('../src/schemas.js');

    const parsed = CustomBackendCreateSchema.parse({
      displayName: 'Mac Codex',
      runtime: 'local-device',
      deviceLinkId: 'cl_1234567890abcdef',
      agentClientId: 'codex',
      model: 'gpt-5',
    });

    expect(parsed.runtime).toBe('local-device');
    expect(parsed.model).toBe('gpt-5');
    expect(parsed.workdirMode).toBeUndefined();
    expect(parsed.workdir).toBeUndefined();
  });

  test('rejects client supplied id on custom backend create schema', async () => {
    const { CustomBackendCreateSchema } = await import('../src/schemas.js');

    const result = CustomBackendCreateSchema.safeParse({
      id: 'mac-codex',
      displayName: 'Mac Codex',
      runtime: 'local-device',
      deviceLinkId: 'cl_1234567890abcdef',
      agentClientId: 'codex',
      model: 'gpt-5',
    });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.format())).toContain('id');
  });

  test('rejects custom workdir unless it is an absolute path', async () => {
    const { CustomBackendCreateSchema } = await import('../src/schemas.js');

    const result = CustomBackendCreateSchema.safeParse({
      displayName: 'Bad Workdir',
      runtime: 'local-device',
      deviceLinkId: 'cl_1234567890abcdef',
      agentClientId: 'codex',
      model: 'gpt-5',
      workdirMode: 'custom',
      workdir: 'relative/path',
    });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.format())).toContain('workdir');
  });

  test('routes custom backend runs through the selected device when deviceLinkId is set', async () => {
    const { buildDynamicBackend } = await import('../src/backends/dynamic.js');
    const backend = buildDynamicBackend({
      id: 'mac-custom-cli',
      displayName: 'Mac Custom CLI',
      binary: 'custom-cli',
      argvTemplate: ['-p', '{prompt}'],
      outputProtocol: 'plain-text',
      supportsHost: true,
      supportsContainer: false,
      usesProviderPool: false,
      deviceLinkId: 'cl_1234567890abcdef',
    });

    await backend.run({
      group: { name: 'Demo', folder: 'demo', executionNode: 'cl_1234567890abcdef' } as any,
      input: { prompt: 'hello' } as any,
      executionMode: 'host',
      onProcess: vi.fn(),
    });

    expect(runViaAgentLinkMock).toHaveBeenCalledTimes(1);
    expect(runViaAgentLinkMock.mock.calls[0][2]).toBe('cl_1234567890abcdef');
    expect(runHostCliMock).not.toHaveBeenCalled();
  });

  test('uses workspace execution device instead of custom backend default device', async () => {
    const { buildDynamicBackend } = await import('../src/backends/dynamic.js');
    runHostCliMock.mockClear();
    runViaAgentLinkMock.mockClear();

    const backend = buildDynamicBackend({
      id: 'mac-custom-cli',
      displayName: 'Mac Custom CLI',
      binary: 'custom-cli',
      argvTemplate: ['-p', '{prompt}'],
      outputProtocol: 'plain-text',
      supportsHost: true,
      supportsContainer: false,
      usesProviderPool: false,
      runtime: 'local-device',
      deviceLinkId: 'cl_backend_default',
    });

    await backend.run({
      group: { name: 'Demo', folder: 'demo', executionNode: 'cl_workspace_repo_device', repoDevicePath: '/Users/me/code/project' } as any,
      input: { prompt: 'hello' } as any,
      executionMode: 'host',
      onProcess: vi.fn(),
    });

    expect(runViaAgentLinkMock).toHaveBeenCalledTimes(1);
    expect(runViaAgentLinkMock.mock.calls[0][2]).toBe('cl_workspace_repo_device');
    expect(runHostCliMock).not.toHaveBeenCalled();
  });

  test('renders selected model into local-device argv before RPC dispatch', async () => {
    const { buildDynamicBackend } = await import('../src/backends/dynamic.js');
    runHostCliMock.mockClear();
    runViaAgentLinkMock.mockClear();

    const backend = buildDynamicBackend({
      id: 'mac-codex',
      displayName: 'Mac Codex',
      binary: 'codex',
      argvTemplate: ['exec', '-m', '{model}', '{prompt}'],
      outputProtocol: 'plain-text',
      supportsHost: true,
      supportsContainer: false,
      usesProviderPool: false,
      runtime: 'local-device',
      deviceLinkId: 'cl_1234567890abcdef',
      model: 'gpt-5-codex',
    });

    await backend.run({
      group: { name: 'Demo', folder: 'demo', executionNode: 'cl_1234567890abcdef' } as any,
      input: { prompt: 'hello' } as any,
      executionMode: 'host',
      onProcess: vi.fn(),
    });

    const cfg = runViaAgentLinkMock.mock.calls[0][1];
    expect(cfg.buildArgv({ prompt: 'hello', cwd: '/tmp/demo', folder: 'demo', backendId: 'mac-codex' })).toEqual([
      'exec',
      '-m',
      'gpt-5-codex',
      'hello',
    ]);
  });

  test('appends native session resume argv only when session id exists', async () => {
    const { buildDynamicBackend } = await import('../src/backends/dynamic.js');
    runHostCliMock.mockClear();
    runViaAgentLinkMock.mockClear();

    const backend = buildDynamicBackend({
      id: 'mac-custom-cli',
      displayName: 'Mac Custom CLI',
      binary: 'custom-cli',
      argvTemplate: ['-p', '{prompt}', '--output-format=stream-json', '-y'],
      sessionArgvTemplate: ['--resume={sessionId}'],
      outputProtocol: 'jsonline-stream-json',
      supportsHost: true,
      supportsContainer: false,
      usesProviderPool: false,
      supportsNativeSessions: true,
      runtime: 'local-device',
      deviceLinkId: 'cl_1234567890abcdef',
    });

    expect(backend.supportsNativeSessions).toBe(true);

    await backend.run({
      group: { name: 'Demo', folder: 'demo', executionNode: 'cl_1234567890abcdef' } as any,
      input: { prompt: 'hello', sessionId: 'sess-123' } as any,
      executionMode: 'host',
      onProcess: vi.fn(),
    });

    const cfg = runViaAgentLinkMock.mock.calls[0][1];
    expect(cfg.buildArgv({ prompt: 'hello', sessionId: 'sess-123', cwd: '/tmp/demo', folder: 'demo', backendId: 'mac-custom-cli' })).toEqual([
      '-p',
      'hello',
      '--output-format=stream-json',
      '-y',
      '--resume=sess-123',
    ]);
    expect(cfg.buildArgv({ prompt: 'hello', cwd: '/tmp/demo', folder: 'demo', backendId: 'mac-custom-cli' })).toEqual([
      '-p',
      'hello',
      '--output-format=stream-json',
      '-y',
    ]);
  });

  test('uses full native resume argv template when configured', async () => {
    const { buildDynamicBackend } = await import('../src/backends/dynamic.js');
    runHostCliMock.mockClear();
    runViaAgentLinkMock.mockClear();

    const backend = buildDynamicBackend({
      id: 'mac-codex',
      displayName: 'Mac Codex',
      binary: 'codex',
      argvTemplate: ['exec', '--skip-git-repo-check', '-m', '{model}', '{prompt}'],
      resumeArgvTemplate: ['exec', 'resume', '--skip-git-repo-check', '-m', '{model}', '{sessionId}', '{prompt}'],
      outputProtocol: 'plain-text',
      supportsHost: true,
      supportsContainer: false,
      usesProviderPool: false,
      supportsNativeSessions: true,
      runtime: 'local-device',
      deviceLinkId: 'cl_1234567890abcdef',
      model: 'gpt-5-codex',
    });

    expect(backend.supportsNativeSessions).toBe(true);

    await backend.run({
      group: { name: 'Demo', folder: 'demo', executionNode: 'cl_1234567890abcdef' } as any,
      input: { prompt: 'hello again', sessionId: 'sess-456' } as any,
      executionMode: 'host',
      onProcess: vi.fn(),
    });

    const cfg = runViaAgentLinkMock.mock.calls[0][1];
    expect(cfg.buildArgv({ prompt: 'hello again', sessionId: 'sess-456', cwd: '/tmp/demo', folder: 'demo', backendId: 'mac-codex' })).toEqual([
      'exec',
      'resume',
      '--skip-git-repo-check',
      '-m',
      'gpt-5-codex',
      'sess-456',
      'hello again',
    ]);
    expect(cfg.buildArgv({ prompt: 'hello', cwd: '/tmp/demo', folder: 'demo', backendId: 'mac-codex' })).toEqual([
      'exec',
      '--skip-git-repo-check',
      '-m',
      'gpt-5-codex',
      'hello',
    ]);
  });

  test('server-side runtime keeps model loop on the server even when a device is selected for RPC', async () => {
    const { buildDynamicBackend } = await import('../src/backends/dynamic.js');
    runHostCliMock.mockClear();
    runViaAgentLinkMock.mockClear();

    const backend = buildDynamicBackend({
      id: 'server-side-agent',
      displayName: 'Server Side Agent',
      binary: 'claude',
      argvTemplate: ['-p', '{prompt}'],
      outputProtocol: 'plain-text',
      supportsHost: true,
      supportsContainer: false,
      usesProviderPool: false,
      runtime: 'server-side',
      deviceLinkId: 'cl_1234567890abcdef',
    });

    await backend.run({
      group: { name: 'Demo', folder: 'demo', executionNode: 'cl_1234567890abcdef' } as any,
      input: { prompt: 'hello' } as any,
      executionMode: 'host',
      onProcess: vi.fn(),
    });

    expect(runHostCliMock).toHaveBeenCalledTimes(1);
    expect(runHostCliMock.mock.calls[0][0].group.executionNode).toBe('server-local');
    expect(runViaAgentLinkMock).not.toHaveBeenCalled();
  });
});
