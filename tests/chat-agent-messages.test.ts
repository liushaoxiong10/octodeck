import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Message } from '../web/src/stores/chat';

const {
  apiGetMock,
  apiPostMock,
  apiPatchMock,
  apiDeleteMock,
  wsSendMock,
  deleteAgentMessageSnapshotMock,
  deleteGroupMessageSnapshotsMock,
  loadAgentMessageSnapshotMock,
  saveAgentMessageSnapshotMock,
} = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
  apiPostMock: vi.fn(),
  apiPatchMock: vi.fn(),
  apiDeleteMock: vi.fn(),
  wsSendMock: vi.fn(() => true),
  deleteAgentMessageSnapshotMock: vi.fn(),
  deleteGroupMessageSnapshotsMock: vi.fn(),
  loadAgentMessageSnapshotMock: vi.fn(),
  saveAgentMessageSnapshotMock: vi.fn(),
}));

vi.mock('../web/src/api/client', () => ({
  api: {
    get: apiGetMock,
    post: apiPostMock,
    patch: apiPatchMock,
    delete: apiDeleteMock,
  },
}));

vi.mock('../web/src/api/ws', () => ({
  wsManager: {
    send: wsSendMock,
    on: vi.fn(() => vi.fn()),
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn(() => true),
  },
}));

vi.mock('../web/src/stores/files', () => ({
  useFileStore: {
    getState: () => ({
      loadFiles: vi.fn(),
    }),
  },
}));

vi.mock('../web/src/stores/auth', () => ({
  useAuthStore: {
    getState: () => ({
      user: null,
    }),
  },
}));

vi.mock('../web/src/utils/toast', () => ({
  showToast: vi.fn(),
  notifyIfHidden: vi.fn(),
  shouldEmitBackgroundTaskNotice: vi.fn(() => false),
  showNotificationPromptToast: vi.fn(),
}));

vi.mock('../web/src/utils/pwaCache', () => ({
  invalidateGroupCache: vi.fn(),
}));

vi.mock('../web/src/utils/messageSnapshotCache', () => ({
  deleteAgentMessageSnapshot: deleteAgentMessageSnapshotMock,
  deleteGroupMessageSnapshots: deleteGroupMessageSnapshotsMock,
  loadAgentMessageSnapshot: loadAgentMessageSnapshotMock,
  saveAgentMessageSnapshot: saveAgentMessageSnapshotMock,
}));

const { useChatStore } = await import('../web/src/stores/chat');
const initialState = useChatStore.getState();

function message(id: string, timestamp: string): Message {
  return {
    id,
    chat_jid: 'web:main#agent:agent-1',
    sender: 'user',
    sender_name: 'User',
    content: id,
    timestamp,
    is_from_me: false,
  };
}

function mainMessage(
  id: string,
  timestamp: string,
  overrides: Partial<Message> = {},
): Message {
  return {
    id,
    chat_jid: 'web:main',
    sender: 'user',
    sender_name: 'User',
    content: id,
    timestamp,
    is_from_me: false,
    ...overrides,
  };
}

function resetChatStore(): void {
  useChatStore.setState({
    ...initialState,
    groups: {},
    currentGroup: null,
    messages: {},
    waiting: {},
    hasMore: {},
    loading: false,
    error: null,
    streaming: {},
    thinkingCache: {},
    thinkingDurationCache: {},
    pendingThinking: {},
    pendingThinkingDuration: {},
    clearing: {},
    agents: {},
    agentStreaming: {},
    activeAgentTab: {},
    sdkTasks: {},
    sdkTaskAliases: {},
    agentMessages: {},
    agentWaiting: {},
    agentHasMore: {},
    drafts: {},
    unreadReplies: {},
  }, true);
}

describe('loadAgentMessages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    apiGetMock.mockReset();
    wsSendMock.mockReturnValue(true);
    saveAgentMessageSnapshotMock.mockResolvedValue(undefined);
    deleteAgentMessageSnapshotMock.mockResolvedValue(undefined);
    loadAgentMessageSnapshotMock.mockResolvedValue(null);
    resetChatStore();
  });

  it('replaces hydrated agent messages with the server latest page on first-page calibration', async () => {
    const jid = 'web:main';
    const agentId = 'agent-1';
    const staleHydrated = message('stale-snapshot', '2026-01-02T09:30:00.000Z');
    const serverOlder = message('server-older', '2026-01-02T10:00:00.000Z');
    const serverLatest = message('server-latest', '2026-01-02T11:00:00.000Z');

    useChatStore.setState({
      agentMessages: { [agentId]: [staleHydrated] },
      agentHasMore: { [agentId]: true },
    });
    apiGetMock.mockResolvedValueOnce({
      messages: [serverLatest, serverOlder],
      hasMore: false,
    });

    await useChatStore.getState().loadAgentMessages(jid, agentId);

    expect(useChatStore.getState().agentMessages[agentId]).toEqual([
      serverOlder,
      serverLatest,
    ]);
    expect(saveAgentMessageSnapshotMock).toHaveBeenCalledWith(
      jid,
      agentId,
      [serverOlder, serverLatest],
      false,
    );
    expect(deleteAgentMessageSnapshotMock).not.toHaveBeenCalled();
  });

  it('merges older pages only when loading more', async () => {
    const jid = 'web:main';
    const agentId = 'agent-1';
    const currentOlder = message('current-older', '2026-01-02T10:00:00.000Z');
    const currentLatest = message('current-latest', '2026-01-02T11:00:00.000Z');
    const oldOldest = message('old-oldest', '2026-01-02T08:00:00.000Z');
    const oldNewest = message('old-newest', '2026-01-02T09:00:00.000Z');

    useChatStore.setState({
      agentMessages: { [agentId]: [currentOlder, currentLatest] },
      agentHasMore: { [agentId]: true },
    });
    apiGetMock.mockResolvedValueOnce({
      messages: [oldNewest, oldOldest],
      hasMore: false,
    });

    await useChatStore.getState().loadAgentMessages(jid, agentId, true);

    expect(useChatStore.getState().agentMessages[agentId]).toEqual([
      oldOldest,
      oldNewest,
      currentOlder,
      currentLatest,
    ]);
    const calledPath = apiGetMock.mock.calls[0]?.[0] as string;
    const calledUrl = new URL(calledPath, 'http://localhost');
    expect(calledUrl.searchParams.get('before')).toBe(currentOlder.timestamp);
    expect(calledUrl.searchParams.get('agentId')).toBe(agentId);
    expect(saveAgentMessageSnapshotMock).toHaveBeenCalledWith(
      jid,
      agentId,
      [oldOldest, oldNewest, currentOlder, currentLatest],
      false,
    );
  });

  it('clears hydrated messages and deletes the snapshot when the server latest page is empty', async () => {
    const jid = 'web:main';
    const agentId = 'agent-1';
    const staleHydrated = message('deleted-stale-snapshot', '2026-01-02T09:30:00.000Z');

    useChatStore.setState({
      agentMessages: { [agentId]: [staleHydrated] },
      agentHasMore: { [agentId]: true },
    });
    apiGetMock.mockResolvedValueOnce({
      messages: [],
      hasMore: false,
    });

    await useChatStore.getState().loadAgentMessages(jid, agentId);

    expect(useChatStore.getState().agentMessages[agentId]).toEqual([]);
    expect(useChatStore.getState().agentHasMore[agentId]).toBe(false);
    expect(saveAgentMessageSnapshotMock).not.toHaveBeenCalled();
    expect(deleteAgentMessageSnapshotMock).toHaveBeenCalledWith(jid, agentId);
  });
});

describe('sendAgentMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    apiGetMock.mockReset();
    wsSendMock.mockReturnValue(true);
    saveAgentMessageSnapshotMock.mockResolvedValue(undefined);
    deleteAgentMessageSnapshotMock.mockResolvedValue(undefined);
    loadAgentMessageSnapshotMock.mockResolvedValue(null);
    resetChatStore();
  });

  it('refreshes agent messages after a WebSocket send so missed broadcasts do not make the message disappear', async () => {
    vi.useFakeTimers();
    const jid = 'web:main';
    const agentId = 'agent-1';
    const persistedUserMessage = message('persisted-user-message', '2026-01-02T10:00:00.000Z');
    apiGetMock.mockResolvedValueOnce({ messages: [persistedUserMessage] });

    const ok = useChatStore.getState().sendAgentMessage(jid, agentId, 'hello');

    expect(ok).toBe(true);
    expect(apiGetMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);

    expect(apiGetMock).toHaveBeenCalledWith(
      `/api/groups/${encodeURIComponent(jid)}/messages?limit=50&agentId=${agentId}`,
    );
    expect(useChatStore.getState().agentMessages[agentId]).toEqual([
      persistedUserMessage,
    ]);

    vi.useRealTimers();
  });
});

describe('handleAgentStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    apiGetMock.mockReset();
    saveAgentMessageSnapshotMock.mockResolvedValue(undefined);
    deleteAgentMessageSnapshotMock.mockResolvedValue(undefined);
    loadAgentMessageSnapshotMock.mockResolvedValue(null);
    resetChatStore();
  });

  it('refreshes conversation agent messages when the run ends so a missed final broadcast still appears', async () => {
    const jid = 'web:main';
    const agentId = 'agent-1';
    const userMessage = message('user-message', '2026-01-02T10:00:00.000Z');
    const assistantMessage: Message = {
      ...message('assistant-message', '2026-01-02T10:01:00.000Z'),
      sender: 'octodeck-agent',
      sender_name: 'OctoDeck',
      content: 'done',
      is_from_me: true,
      source_kind: 'sdk_final',
    };

    useChatStore.setState({
      agents: {
        [jid]: [{
          id: agentId,
          name: 'Agent',
          prompt: 'prompt',
          status: 'running',
          kind: 'conversation',
          created_at: '2026-01-02T09:59:00.000Z',
        }],
      },
      agentMessages: { [agentId]: [userMessage] },
      agentWaiting: { [agentId]: true },
      agentStreaming: { [agentId]: { text: 'streamed but broadcast missed' } },
    });
    apiGetMock.mockResolvedValueOnce({ messages: [assistantMessage] });

    useChatStore.getState().handleAgentStatus(
      jid,
      agentId,
      'idle',
      'Agent',
      'prompt',
      undefined,
      'conversation',
    );

    await Promise.resolve();

    expect(apiGetMock).toHaveBeenCalledWith(
      `/api/groups/${encodeURIComponent(jid)}/messages?limit=50&agentId=${agentId}&after=${encodeURIComponent(userMessage.timestamp)}`,
    );
    expect(useChatStore.getState().agentMessages[agentId]).toEqual([
      userMessage,
      assistantMessage,
    ]);
    expect(useChatStore.getState().agentWaiting[agentId]).toBe(false);
    expect(useChatStore.getState().agentStreaming[agentId]).toBeUndefined();
  });
});

describe('handleRunnerState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    apiGetMock.mockReset();
    saveAgentMessageSnapshotMock.mockResolvedValue(undefined);
    deleteAgentMessageSnapshotMock.mockResolvedValue(undefined);
    loadAgentMessageSnapshotMock.mockResolvedValue(null);
    resetChatStore();
  });

  it('refreshes main chat messages when the runner becomes idle so a missed final broadcast still appears', async () => {
    const jid = 'web:main';
    const userMessage = mainMessage('user-message', '2026-01-02T10:00:00.000Z');
    const assistantMessage = mainMessage('assistant-message', '2026-01-02T10:04:00.000Z', {
      sender: 'octodeck-agent',
      sender_name: 'OctoDeck',
      content: 'done',
      is_from_me: true,
      source_kind: 'sdk_final',
    });

    useChatStore.setState({
      messages: { [jid]: [userMessage] },
      waiting: { [jid]: true },
      streaming: { [jid]: { text: 'streamed but final broadcast missed' } },
    });
    apiGetMock.mockResolvedValueOnce({ messages: [assistantMessage] });

    useChatStore.getState().handleRunnerState(jid, 'idle');

    await Promise.resolve();

    expect(apiGetMock).toHaveBeenCalledWith(
      `/api/groups/${encodeURIComponent(jid)}/messages?limit=50&after=${encodeURIComponent(userMessage.timestamp)}`,
    );
    expect(useChatStore.getState().messages[jid]).toEqual([
      userMessage,
      assistantMessage,
    ]);
    expect(useChatStore.getState().waiting[jid]).toBe(false);
    expect(useChatStore.getState().streaming[jid]).toBeUndefined();
  });
});
