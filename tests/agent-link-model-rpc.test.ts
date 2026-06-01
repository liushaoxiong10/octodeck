import { describe, expect, test, vi } from 'vitest';

import { deliverModelResult, requestProviderModels } from '../src/agent-link/model-rpc.js';

describe('agent-link model rpc', () => {
  test('sends models.request and resolves from matching models.result', async () => {
    const sent: unknown[] = [];
    const session = {
      state: 'open',
      send(frame: unknown) {
        sent.push(frame);
        return true;
      },
    } as any;

    const promise = requestProviderModels(session, {
      linkId: 'cl_1234567890abcdef',
      providerId: 'codex',
      timeoutMs: 1000,
    });

    expect(sent[0]).toMatchObject({
      type: 'models.request',
      providerId: 'codex',
    });

    const requestId = (sent[0] as any).requestId;
    deliverModelResult({
      type: 'models.result',
      requestId,
      ok: true,
      models: [{ id: 'gpt-5', displayName: 'GPT-5' }],
      error: null,
      durationMs: 10,
    });

    await expect(promise).resolves.toEqual({
      ok: true,
      models: [{ id: 'gpt-5', displayName: 'GPT-5' }],
      error: null,
      durationMs: 10,
    });
  });

  test('rejects when session send fails', async () => {
    const session = {
      state: 'open',
      send: vi.fn(() => false),
    } as any;

    await expect(
      requestProviderModels(session, {
        linkId: 'cl_1234567890abcdef',
        providerId: 'codex',
        timeoutMs: 1000,
      }),
    ).rejects.toThrow('send_failed');
  });
});
