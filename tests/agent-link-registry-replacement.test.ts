import { describe, expect, test, vi } from 'vitest';

vi.mock('../src/db.js', () => ({
  recordAgentLinkResources: vi.fn(),
  recordAgentLinkConnect: vi.fn(),
  touchAgentLinkSeen: vi.fn(),
}));

const failRunsForLink = vi.fn();
const failToolRequestsForLink = vi.fn();
const failModelRequestsForLink = vi.fn();
const failSkillsRequestsForLink = vi.fn();

vi.mock('../src/agent-link/run-rpc.js', () => ({
  deliverEvent: vi.fn(),
  deliverResult: vi.fn(),
  failRunsForLink,
}));

vi.mock('../src/agent-link/tool-rpc.js', () => ({
  deliverToolEvent: vi.fn(),
  deliverToolResult: vi.fn(),
  failToolRequestsForLink,
}));

vi.mock('../src/agent-link/model-rpc.js', () => ({
  deliverModelResult: vi.fn(),
  failModelRequestsForLink,
}));

vi.mock('../src/agent-link/skills-rpc.js', () => ({
  deliverSkillsResult: vi.fn(),
  failSkillsRequestsForLink,
}));

vi.mock('../src/memory-store.js', () => ({
  syncClientAgentMemory: vi.fn(),
}));

function fakeSession(linkId: string) {
  return {
    linkId,
    userId: 'user_1',
    remoteIp: '127.0.0.1',
    connectedAt: Date.now(),
    state: 'open',
    sendError: vi.fn(),
    close: vi.fn(),
    send: vi.fn(),
  } as any;
}

describe('agent-link registry replacement handling', () => {
  test('does not fail pending work when an old replaced session closes after a newer session is online', async () => {
    vi.clearAllMocks();
    const { isOnline, onIncomingSession, unregisterSession } = await import('../src/agent-link/registry.js');

    const oldSession = fakeSession('cl_replaced');
    const newSession = fakeSession('cl_replaced');

    onIncomingSession(oldSession);
    onIncomingSession(newSession);
    unregisterSession(oldSession);

    expect(isOnline('cl_replaced')).toBe(true);
    expect(failRunsForLink).not.toHaveBeenCalled();
    expect(failToolRequestsForLink).not.toHaveBeenCalled();
    expect(failModelRequestsForLink).not.toHaveBeenCalled();
    expect(failSkillsRequestsForLink).not.toHaveBeenCalled();
  });

  test('sends daemon update request after hello when client version is outdated', async () => {
    vi.clearAllMocks();
    const { handleHello, LATEST_DAEMON_VERSION } = await import('../src/agent-link/registry.js');

    const session = fakeSession('cl_outdated');
    session.send.mockReturnValue(true);

    handleHello(
      session,
      {
        type: 'hello',
        id: 1,
        version: 'octodeck-daemon/1.0.3',
        capabilities: ['run.host-cli'],
      },
      'Outdated Daemon',
    );

    expect(session.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'hello_ack' }),
    );
    expect(session.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'daemon.update.request',
        latestVersion: LATEST_DAEMON_VERSION,
        currentVersion: 'octodeck-daemon/1.0.3',
      }),
    );
  });
});
