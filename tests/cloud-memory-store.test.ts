import fs from 'fs';
import os from 'os';
import path from 'path';

import { beforeEach, describe, expect, test, vi } from 'vitest';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'octodeck-cloud-memory-'));
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
const memoryStore = await import('../src/memory-store.js');

describe('cloud/client memory store', () => {
  beforeEach(async () => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.mkdirSync(tmpRoot, { recursive: true });
    await db.initDatabase();
  });

  test('全局和会话记忆以云端数据库为权威并使用 revision 防止覆盖', () => {
    const global = memoryStore.putCloudMemory({
      userId: 'alice',
      memoryType: 'global',
      path: 'CLAUDE.md',
      content: '# Alice Memory',
      source: 'cloud_sdk',
      updatedBy: 'alice',
    });

    expect(global.authority).toBe('cloud');
    expect(global.revision).toBe(1);
    expect(global.content).toBe('# Alice Memory');

    expect(() => memoryStore.putCloudMemory({
      userId: 'alice',
      memoryType: 'global',
      path: 'CLAUDE.md',
      content: '# stale write',
      expectedRevision: 0,
      source: 'cloud_sdk',
      updatedBy: 'alice',
    })).toThrow(/revision conflict/);

    const session = memoryStore.appendCloudMemory({
      userId: 'alice',
      memoryType: 'session',
      groupFolder: 'project-a',
      path: 'CLAUDE.md',
      content: '会话偏好：先跑测试。',
      source: 'cloud_sdk',
      updatedBy: 'alice',
    });

    expect(session.authority).toBe('cloud');
    expect(session.scopeKey).toBe('session:project-a');
    expect(session.content).toContain('会话偏好：先跑测试。');
  });

  test('client agent 记忆只能由 client 同步写入，云端只读镜像', () => {
    const synced = memoryStore.syncClientAgentMemory({
      userId: 'alice',
      deviceLinkId: 'cl_1234567890abcdef',
      agentId: 'claude-code',
      path: 'CLAUDE.md',
      content: '# Local Agent Memory',
      source: 'client_sync',
      updatedBy: 'cl_1234567890abcdef',
    });

    expect(synced.memoryType).toBe('agent');
    expect(synced.authority).toBe('client');
    expect(synced.scopeKey).toBe('agent:cl_1234567890abcdef:claude-code');

    expect(() => memoryStore.putCloudMemory({
      userId: 'alice',
      memoryType: 'agent',
      deviceLinkId: 'cl_1234567890abcdef',
      agentId: 'claude-code',
      path: 'CLAUDE.md',
      content: '# forbidden cloud write',
      source: 'cloud_sdk',
      updatedBy: 'alice',
    })).toThrow(/client authoritative/);

    const hits = memoryStore.searchCloudMemory({ userId: 'alice', query: 'Local Agent' });
    expect(hits.map((hit) => hit.memoryType)).toEqual(['agent']);
  });

  test('从旧文件迁移全局、会话和日期记忆到云端数据库', () => {
    fs.mkdirSync(path.join(tmpGroupsDir, 'user-global', 'alice'), { recursive: true });
    fs.writeFileSync(path.join(tmpGroupsDir, 'user-global', 'alice', 'CLAUDE.md'), '# Global File');
    fs.mkdirSync(path.join(tmpGroupsDir, 'project-a'), { recursive: true });
    fs.writeFileSync(path.join(tmpGroupsDir, 'project-a', 'CLAUDE.md'), '# Session File');
    fs.mkdirSync(path.join(tmpRoot, 'memory', 'project-a'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'memory', 'project-a', '2026-06-02.md'), '# Date File');

    const imported = memoryStore.importLegacyCloudMemories({
      userId: 'alice',
      groupFolders: ['project-a'],
    });

    expect(imported).toBe(3);
    expect(memoryStore.getCloudMemory({
      userId: 'alice',
      memoryType: 'global',
      path: 'CLAUDE.md',
    })?.content).toBe('# Global File');
    expect(memoryStore.getCloudMemory({
      userId: 'alice',
      memoryType: 'session',
      groupFolder: 'project-a',
      path: 'CLAUDE.md',
    })?.content).toBe('# Session File');
    expect(memoryStore.getCloudMemory({
      userId: 'alice',
      memoryType: 'session',
      groupFolder: 'project-a',
      path: 'memory/2026-06-02.md',
    })?.content).toBe('# Date File');
  });
});
