import { describe, expect, test, vi } from 'vitest';

const runViaAgentLinkMock = vi.hoisted(() =>
  vi.fn(async () => ({ status: 'success', result: 'device-out' })),
);

vi.mock('../src/backends/agent-link-driver.js', () => ({
  runViaAgentLink: runViaAgentLinkMock,
}));

describe('script runner device execution', () => {
  test('routes script commands through the selected remote Device', async () => {
    const { runScript } = await import('../src/script-runner.js');

    const result = await (runScript as any)(
      'printf device-out',
      'demo-folder',
      'cl_1234567890abcdef',
    );

    expect(runViaAgentLinkMock).toHaveBeenCalledTimes(1);
    expect(runViaAgentLinkMock.mock.calls[0][2]).toBe('cl_1234567890abcdef');
    const cfg = runViaAgentLinkMock.mock.calls[0][1];
    expect(cfg.backendId).toBe('script');
    expect(cfg.resolveBinary()).toBe('/bin/sh');
    expect(
      cfg.buildArgv({
        prompt: '',
        cwd: '/remote/workdir',
        folder: 'demo-folder',
        backendId: 'script',
      }),
    ).toEqual(['-c', 'printf device-out']);
    expect(result).toMatchObject({
      stdout: 'device-out',
      stderr: '',
      exitCode: 0,
      timedOut: false,
    });
  });
});
