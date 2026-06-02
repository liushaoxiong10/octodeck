import { describe, expect, test, vi } from 'vitest';

const syncClientAgentMemory = vi.fn();

vi.mock('../src/db.js', () => ({
  recordAgentLinkConnect: vi.fn(),
  recordAgentLinkResources: vi.fn(),
  touchAgentLinkSeen: vi.fn(),
}));

vi.mock('../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../src/memory-store.js', () => ({
  syncClientAgentMemory,
}));

const { handleFrame } = await import('../src/agent-link/registry.js');

describe('agent-link memory sync', () => {
  test('persists memory.sync frames as client-authoritative agent memory mirrors', () => {
    const session = {
      linkId: 'cl_1234567890abcdef',
      userId: 'alice',
      remoteIp: '127.0.0.1',
      connectedAt: Date.now(),
      state: 'open',
      close: vi.fn(),
    } as any;

    handleFrame(session, {
      type: 'memory.sync',
      deviceLinkId: 'cl_1234567890abcdef',
      agentId: 'claude-code',
      path: 'CLAUDE.md',
      content: '# Local Agent Memory',
      mtime: '2026-06-02T00:00:00Z',
      contentHash: 'sha256:abc123',
    } as any);

    expect(syncClientAgentMemory).toHaveBeenCalledWith({
      userId: 'alice',
      deviceLinkId: 'cl_1234567890abcdef',
      agentId: 'claude-code',
      path: 'CLAUDE.md',
      content: '# Local Agent Memory',
      source: 'client_sync',
      updatedBy: 'cl_1234567890abcdef',
    });
  });
});
