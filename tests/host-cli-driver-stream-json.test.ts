import { describe, expect, test, vi } from 'vitest';

import { runHostCli } from '../src/backends/host-cli-driver.js';

describe('host CLI stream-json protocol', () => {
  test('passes repo context to server-side agent environment', async () => {
    const cwd = process.cwd();
    const script = [
      `const run = JSON.parse(process.env.OCTODECK_RUN_CONTEXT_JSON || '{}');`,
      `const repo = JSON.parse(process.env.OCTODECK_REPO_CONTEXT_JSON || '{}');`,
      `console.log(JSON.stringify({ runRepo: run.repo, repo }));`,
    ].join('');

    const result = await runHostCli(
      {
        group: {
          name: 'Repo Env',
          folder: 'host-cli-repo-env-test',
          executionNode: 'server-local',
          customCwd: cwd,
          repoId: 'repo-1',
          repoGitUrl: 'https://github.com/acme/project.git',
        } as any,
        input: {
          prompt: 'hello',
          groupFolder: 'host-cli-repo-env-test',
          chatJid: 'web:test',
          isMain: true,
        } as any,
        executionMode: 'host',
        onProcess: vi.fn(),
      },
      {
        backendId: 'fake-env-cli',
        resolveBinary: () => process.execPath,
        buildArgv: () => ['-e', script],
        outputProtocol: 'plain-text',
        timeoutMs: 5_000,
        maxOutputBytes: 100_000,
      },
    );

    const parsed = JSON.parse(result.result);
    expect(parsed.runRepo).toMatchObject({
      id: 'repo-1',
      gitUrl: 'https://github.com/acme/project.git',
      kind: 'git',
      cwd,
    });
    expect(parsed.repo).toEqual(parsed.runRepo);
  });

  test('emits stream_event deltas as OctoDeck text_delta events', async () => {
    const outputs: any[] = [];
    const script = [
      `console.log(JSON.stringify({type:'system',subtype:'init',session_id:'sess-1'}));`,
      `console.log(JSON.stringify({type:'stream_event',delta:{role:'assistant',content:'你'}}));`,
      `console.log(JSON.stringify({type:'stream_event',delta:{role:'assistant',content:'好'}}));`,
      `console.log(JSON.stringify({type:'result',subtype:'success',session_id:'sess-1',result:'你好',is_error:false}));`,
    ].join('');

    const result = await runHostCli(
      {
        group: {
          name: 'Demo',
          folder: 'host-cli-stream-json-test',
          executionNode: 'server-local',
        } as any,
        input: {
          prompt: 'hello',
          groupFolder: 'host-cli-stream-json-test',
          chatJid: 'web:test',
          isMain: true,
        } as any,
        executionMode: 'host',
        onProcess: vi.fn(),
        onOutput: async (output) => {
          outputs.push(output);
        },
      },
      {
        backendId: 'fake-stream-json-cli',
        resolveBinary: () => process.execPath,
        buildArgv: () => ['-e', script],
        outputProtocol: 'jsonline-stream-json',
        timeoutMs: 5_000,
        maxOutputBytes: 100_000,
      },
    );

    expect(
      outputs
        .filter((o) => o.status === 'stream')
        .map((o) => o.streamEvent?.text),
    ).toEqual(['你', '好']);
    expect(outputs.at(-1)).toMatchObject({
      status: 'success',
      result: '你好',
      newSessionId: 'sess-1',
    });
    expect(result).toMatchObject({
      status: 'success',
      result: '你好',
      newSessionId: 'sess-1',
    });
  });

  test('lets a group-specific timeout override backend default timeout', async () => {
    const result = await runHostCli(
      {
        group: {
          name: 'Timeout Override',
          folder: 'host-cli-timeout-override-test',
          executionNode: 'server-local',
          containerConfig: { timeout: 1_000 },
        } as any,
        input: {
          prompt: 'hello',
          groupFolder: 'host-cli-timeout-override-test',
          chatJid: 'web:test',
          isMain: true,
        } as any,
        executionMode: 'host',
        onProcess: vi.fn(),
      },
      {
        backendId: 'fake-timeout-cli',
        resolveBinary: () => process.execPath,
        buildArgv: () => ['-e', `setTimeout(() => console.log('done'), 100);`],
        outputProtocol: 'plain-text',
        timeoutMs: 1,
        maxOutputBytes: 100_000,
      },
    );

    expect(result.status).toBe('success');
    expect(result.result).toContain('done');
  });
});
