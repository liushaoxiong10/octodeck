import fs from 'fs';
import os from 'os';
import path from 'path';

import { beforeEach, describe, expect, test, vi } from 'vitest';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'octodeck-tool-role-'));
const tmpStoreDir = path.join(tmpRoot, 'db');
const tmpGroupsDir = path.join(tmpRoot, 'groups');

vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return {
    ...actual,
    DATA_DIR: tmpRoot,
    STORE_DIR: tmpStoreDir,
    GROUPS_DIR: tmpGroupsDir,
  };
});

const db = await import('../src/db.js');

describe('tool role messages', () => {
  beforeEach(async () => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.mkdirSync(tmpRoot, { recursive: true });
    await db.initDatabase();
  });

  test('persists tool role and exposes it to chat and history queries', () => {
    db.ensureChatExists('web:main');
    db.storeMessageDirect(
      'tool-1-start',
      'web:main',
      'octodeck-tool',
      'Bash',
      '工具调用: Bash\nid: tool-1',
      '2026-06-04T10:00:00.000Z',
      true,
      {
        meta: {
          role: 'tool',
          sourceKind: 'tool_call',
          turnId: 'turn-1',
          sessionId: 'session-1',
        },
      },
    );

    const [message] = db.getMessagesPage('web:main', undefined, 10);
    expect(message.role).toBe('tool');
    expect(message.source_kind).toBe('tool_call');

    const history = db.listSystemHistoryFlows({ type: 'message', limit: 10 });
    const stage = history[0]?.stages[0];
    expect(stage?.status).toBe('tool');
    expect(stage?.type).toBe('tool_message');
    expect(stage?.payload).toMatchObject({ role: 'tool', sourceKind: 'tool_call' });
  });

  test('reopening an archived chat clears archived flag for new history flows', () => {
    db.ensureChatExists('web:main');
    db.storeMessageDirect(
      'old-msg',
      'web:main',
      'user-1',
      'User',
      'old conversation',
      '2026-06-04T10:00:00.000Z',
      false,
      { meta: { role: 'user', sessionId: 'old-session' } },
    );
    db.deleteChatHistory('web:main');

    // 主工作区清空/重置后会复用同一个 JID 发起新会话。
    // ensureChatExists 必须解除 chats.archived_at，否则历史页会把新会话误标记为已归档。
    db.ensureChatExists('web:main');
    db.storeMessageDirect(
      'new-msg',
      'web:main',
      'user-1',
      'User',
      'new conversation',
      '2026-06-04T11:00:00.000Z',
      false,
      { meta: { role: 'user', sessionId: 'new-session' } },
    );

    const [flow] = db.listSystemHistoryFlows({ type: 'message', limit: 10 });
    expect(flow?.summary).toBe('new conversation');
    expect(flow?.archivedAt).toBeNull();
    expect(flow?.stages[0]?.payload).toMatchObject({ archivedAt: null });
  });
});
