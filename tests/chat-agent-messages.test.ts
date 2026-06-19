import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Message } from '../web/src/stores/chat';

const {
  apiGetMock,
  apiPostMock,
  apiPatchMock,
  apiDeleteMock,
  wsSendMock,
  invalidateWorkspaceGroupCachesMock,
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
  invalidateWorkspaceGroupCachesMock: vi.fn(),
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
  invalidateGroupsListCache: vi.fn(),
  invalidateWorkspaceGroupCaches: invalidateWorkspaceGroupCachesMock,
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
    clearEpoch: {},
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

describe('clearHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    apiGetMock.mockReset();
    apiPostMock.mockReset();
    invalidateWorkspaceGroupCachesMock.mockResolvedValue(undefined);
    deleteGroupMessageSnapshotsMock.mockResolvedValue(undefined);
    resetChatStore();
  });

  it('purges main and sibling chat state returned by workspace rebuild', async () => {
    const jid = 'web:main';
    const siblingJid = 'feishu:chat-1';
    const agentId = 'agent-1';
    const oldMain = mainMessage('old-main', '2026-01-02T10:00:00.000Z');
    const oldSibling = mainMessage('old-sibling', '2026-01-02T10:01:00.000Z', {
      chat_jid: siblingJid,
    });

    useChatStore.setState({
      messages: { [jid]: [oldMain], [siblingJid]: [oldSibling] },
      waiting: { [jid]: true, [siblingJid]: true },
      hasMore: { [jid]: true, [siblingJid]: true },
      streaming: { [jid]: { text: 'stale main' }, [siblingJid]: { text: 'stale sibling' } },
      pendingThinking: { [jid]: 'main thinking', [siblingJid]: 'sibling thinking' },
      pendingThinkingDuration: { [jid]: 100, [siblingJid]: 200 },
      agents: { [jid]: [{ id: agentId, name: 'Agent', prompt: '', status: 'idle', kind: 'conversation', created_at: '2026-01-02T09:00:00.000Z' }] },
      agentMessages: { [agentId]: [message('agent-old', '2026-01-02T10:02:00.000Z')] },
      agentStreaming: { [agentId]: { text: 'stale agent' } },
      agentWaiting: { [agentId]: true },
      agentHasMore: { [agentId]: true },
      drafts: { [jid]: 'draft', [siblingJid]: 'sibling draft' },
      activeAgentTab: { [jid]: agentId, [siblingJid]: null },
      unreadReplies: { [jid]: 1, [siblingJid]: 2 },
      sdkTasks: { task1: { chatJid: siblingJid, description: 'task', status: 'running' } },
      sdkTaskAliases: { alias1: 'task1' },
    });
    apiPostMock.mockResolvedValueOnce({
      success: true,
      workspace_id: 'home-new',
      old_workspace_id: 'home-old',
      affected_jids: [jid, siblingJid],
    });
    apiGetMock.mockImplementation((url: string) => {
      if (url === '/api/groups') return Promise.resolve({ groups: {} });
      if (url === `/api/groups/${encodeURIComponent(jid)}/agents`) return Promise.resolve({ agents: [] });
      return Promise.resolve({ messages: [], hasMore: false });
    });

    await expect(useChatStore.getState().clearHistory(jid)).resolves.toEqual({
      jid,
      folder: 'home-new',
    });

    const state = useChatStore.getState();
    expect(state.messages[jid]).toBeUndefined();
    expect(state.messages[siblingJid]).toBeUndefined();
    expect(state.waiting[jid]).toBeUndefined();
    expect(state.waiting[siblingJid]).toBeUndefined();
    expect(state.streaming[jid]).toBeUndefined();
    expect(state.streaming[siblingJid]).toBeUndefined();
    expect(state.agentMessages[agentId]).toBeUndefined();
    expect(state.agentWaiting[agentId]).toBeUndefined();
    expect(state.agentHasMore[agentId]).toBeUndefined();
    expect(state.drafts[jid]).toBeUndefined();
    expect(state.drafts[siblingJid]).toBeUndefined();
    expect(state.sdkTasks.task1).toBeUndefined();
    expect(state.sdkTaskAliases.alias1).toBeUndefined();
    expect(state.clearing[jid]).toBeUndefined();
    expect(state.clearing[siblingJid]).toBeUndefined();
    expect(invalidateWorkspaceGroupCachesMock).toHaveBeenCalledWith([jid, siblingJid]);
    expect(deleteGroupMessageSnapshotsMock).toHaveBeenCalledWith(jid);
    expect(deleteGroupMessageSnapshotsMock).toHaveBeenCalledWith(siblingJid);
  });

  it('drops an in-flight message load that started before workspace rebuild', async () => {
    const jid = 'web:main';
    let resolveLoad!: (value: { messages: Message[]; hasMore: boolean }) => void;
    const loadPromise = new Promise<{ messages: Message[]; hasMore: boolean }>((resolve) => {
      resolveLoad = resolve;
    });
    apiGetMock.mockReturnValueOnce(loadPromise);

    const loading = useChatStore.getState().loadMessages(jid);
    await Promise.resolve();
    useChatStore.setState((s) => ({
      clearing: { ...s.clearing, [jid]: true },
      clearEpoch: { ...s.clearEpoch, [jid]: (s.clearEpoch[jid] || 0) + 1 },
    }));
    resolveLoad({
      messages: [mainMessage('stale-after-clear', '2026-01-02T10:00:00.000Z')],
      hasMore: false,
    });
    await loading;

    expect(useChatStore.getState().messages[jid]).toBeUndefined();
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

describe('sendMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    apiPostMock.mockReset();
    resetChatStore();
  });

  it('clears stale streaming and pending thinking when starting a new user turn', async () => {
    const jid = 'web:main';
    const oldUser = mainMessage('old-user', '2026-01-02T10:00:00.000Z');

    useChatStore.setState({
      messages: { [jid]: [oldUser] },
      waiting: { [jid]: true },
      streaming: {
        [jid]: {
          ...initialState.streaming[jid],
          thinkingText: 'stale thinking',
          isThinking: true,
        } as any,
      },
      pendingThinking: { [jid]: 'stale pending thinking' },
      pendingThinkingDuration: { [jid]: 1234 },
    });
    apiPostMock.mockResolvedValueOnce({
      success: true,
      messageId: 'new-user',
      timestamp: '2026-01-02T10:05:00.000Z',
    });

    await expect(
      useChatStore.getState().sendMessage(jid, 'next message'),
    ).resolves.toBe(true);

    const state = useChatStore.getState();
    expect(state.waiting[jid]).toBe(true);
    expect(state.streaming[jid]).toBeUndefined();
    expect(state.pendingThinking[jid]).toBeUndefined();
    expect(state.pendingThinkingDuration[jid]).toBeUndefined();
    expect(state.messages[jid].map((msg) => msg.id)).toEqual([
      'old-user',
      'new-user',
    ]);
  });
});

describe('handleWsError', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    resetChatStore();
  });

  it('clears stale agent waiting state after a rejected WebSocket send', () => {
    const jid = 'web:main';
    const agentId = 'agent-1';

    useChatStore.setState({
      agentWaiting: { [agentId]: true },
      agentStreaming: { [agentId]: { partialText: 'thinking' } as any },
      waiting: { [jid]: true },
      streaming: { [jid]: { partialText: 'main thinking' } as any },
    });

    useChatStore.getState().handleWsError(jid, agentId);

    const state = useChatStore.getState();
    expect(state.agentWaiting[agentId]).toBeUndefined();
    expect(state.agentStreaming[agentId]).toBeUndefined();
    expect(state.waiting[jid]).toBe(true);
    expect(state.streaming[jid]).toBeDefined();
  });

  it('clears main waiting state after a rejected WebSocket send without agentId', () => {
    const jid = 'web:main';

    useChatStore.setState({
      waiting: { [jid]: true },
      streaming: { [jid]: { partialText: 'main thinking' } as any },
    });

    useChatStore.getState().handleWsError(jid);

    const state = useChatStore.getState();
    expect(state.waiting[jid]).toBeUndefined();
    expect(state.streaming[jid]).toBeUndefined();
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
      `/api/groups/${encodeURIComponent(jid)}/messages?limit=50&after=${encodeURIComponent(userMessage.timestamp)}&afterId=${userMessage.id}`,
    );
    expect(useChatStore.getState().messages[jid]).toEqual([
      userMessage,
      assistantMessage,
    ]);
    expect(useChatStore.getState().waiting[jid]).toBe(false);
    expect(useChatStore.getState().streaming[jid]).toBeUndefined();
  });
});
