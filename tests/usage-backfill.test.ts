import { beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'octodeck-usage-'));
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

describe('usage record backfill', () => {
  beforeEach(async () => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.mkdirSync(tmpStoreDir, { recursive: true });
    fs.mkdirSync(tmpGroupsDir, { recursive: true });
    await db.initDatabase();
  });

  test('backfills daemon CLI message token_usage into usage daily stats', () => {
    const chatJid = 'web:device-usage';
    const timestamp = new Date().toISOString();

    db.setRegisteredGroup(chatJid, {
      name: 'Device Usage',
      folder: 'device-usage',
      added_at: timestamp,
      created_by: 'user-device',
      executionMode: 'host',
      executionNode: 'cl_1234567890abcdef',
      agentClientId: 'claude-code',
    });
    db.ensureChatExists(chatJid);
    db.storeMessageDirect(
      'msg-device-usage-1',
      chatJid,
      'octodeck-agent',
      'OctoDeck',
      'done',
      timestamp,
      true,
      {
        tokenUsage: JSON.stringify({
          inputTokens: 120,
          outputTokens: 30,
          cacheReadInputTokens: 7,
          cacheCreationInputTokens: 5,
          durationMs: 456,
          modelUsage: {
            'claude-device': {
              inputTokens: 120,
              outputTokens: 30,
              cacheReadInputTokens: 7,
              cacheCreationInputTokens: 5,
              costUSD: 0,
            },
          },
        }),
      },
    );

    expect(db.getUsageDailySummary(7, 'user-device').totalMessages).toBe(0);

    expect(db.backfillMissingUsageRecordsFromMessages()).toBe(1);
    expect(db.backfillMissingUsageRecordsFromMessages()).toBe(0);

    const summary = db.getUsageDailySummary(7, 'user-device');
    expect(summary).toMatchObject({
      totalInputTokens: 120,
      totalOutputTokens: 30,
      totalCacheReadTokens: 7,
      totalCacheCreationTokens: 5,
      totalMessages: 1,
    });

    expect(db.getUsageDailyStats(7, 'user-device')).toEqual([
      expect.objectContaining({
        model: 'claude-device',
        user_id: 'user-device',
        input_tokens: 120,
        output_tokens: 30,
        cache_read_tokens: 7,
        cache_creation_tokens: 5,
        request_count: 1,
      }),
    ]);

    expect(db.getUsageSourceStats(7, 'user-device')).toEqual([
      expect.objectContaining({
        source: 'claude-code',
        input_tokens: 120,
        output_tokens: 30,
        cache_read_tokens: 7,
        cache_creation_tokens: 5,
        request_count: 1,
      }),
    ]);
  });
});
