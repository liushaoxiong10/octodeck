import { describe, expect, test, vi } from 'vitest';

const getSessionMock = vi.hoisted(() => vi.fn());
const registerRunMock = vi.hoisted(() => vi.fn());
const unregisterRunMock = vi.hoisted(() => vi.fn());
const getSystemSettingsMock = vi.hoisted(() => vi.fn(() => ({ containerTimeout: 1000, containerMaxOutputSize: 4096 })));

vi.mock('../src/agent-link/registry.js', () => ({ getSession: getSessionMock }));
vi.mock('../src/agent-link/run-rpc.js', () => ({
  registerRun: registerRunMock,
  unregisterRun: unregisterRunMock,
}));
vi.mock('../src/runtime-config.js', () => ({ getSystemSettings: getSystemSettingsMock }));
vi.mock('../src/config.js', () => ({ GROUPS_DIR: '/tmp/happyclaw-test/groups' }));

describe('agent-link run context forwarding', () => {
  test('runViaAgentLink includes full container input context and stdinJson', async () => {
    const sent: any[] = [];
    getSessionMock.mockReturnValue({
      state: 'open',
      send(frame: any) {
        sent.push(frame);
        return true;
      },
    });

    const { runViaAgentLink } = await import('../src/backends/agent-link-driver.js');
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
        group: { folder: 'demo', backend: 'coco', executionNode: 'cl_1234567890abcdef' },
      },
    });
    expect(sent[0].stdinJson).toContain('"prompt":"hello"');

    registerRunMock.mock.calls[0][0].finish({ exitCode: 0, signal: null, timedOut: false, durationMs: 1 });
    await promise;
  });
});
