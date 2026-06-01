import { describe, expect, test, vi } from 'vitest';

import { runHostCli } from '../src/backends/host-cli-driver.js';

describe('host CLI stream-json protocol', () => {
  test('emits TraeCLI stream_event deltas as HappyClaw text_delta events', async () => {
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
        backendId: 'fake-traecli',
        resolveBinary: () => process.execPath,
        buildArgv: () => ['-e', script],
        outputProtocol: 'jsonline-stream-json',
        timeoutMs: 5_000,
        maxOutputBytes: 100_000,
      },
    );

    expect(outputs.filter((o) => o.status === 'stream').map((o) => o.streamEvent?.text)).toEqual([
      '你',
      '好',
    ]);
    expect(outputs.at(-1)).toMatchObject({ status: 'success', result: '你好', newSessionId: 'sess-1' });
    expect(result).toMatchObject({ status: 'success', result: '你好', newSessionId: 'sess-1' });
  });
});
