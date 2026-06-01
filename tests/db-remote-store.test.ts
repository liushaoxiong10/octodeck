import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import Database from '../src/sqlite-compat.js';
import {
  DebouncedRemotePersistenceController,
  NoopPersistenceController,
  prepareSqlitePathForBackend,
  RemoteSqliteStore,
} from '../src/db-remote-store.js';

describe('database remote store persistence controllers', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.useRealTimers();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTempFile(contents = 'sqlite-data'): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octodeck-db-test-'));
    tempDirs.push(dir);
    const filePath = path.join(dir, 'messages.db');
    fs.writeFileSync(filePath, contents);
    return filePath;
  }

  test('noop controller keeps sqlite backend local only', async () => {
    const controller = new NoopPersistenceController();
    expect(controller.backend).toBe('sqlite');
    controller.schedulePersist();
    await expect(controller.flush()).resolves.toBeUndefined();
    await expect(controller.close()).resolves.toBeUndefined();
  });

  test('debounced controller persists dirty local database and closes remote store', async () => {
    vi.useFakeTimers();
    const localPath = makeTempFile('snapshot');
    const persistLocalDatabase = vi.fn(async (pathArg: string) => {
      expect(pathArg).toBe(localPath);
    });
    const close = vi.fn(async () => undefined);
    const store: RemoteSqliteStore = {
      backend: 'mysql',
      prepareLocalDatabase: vi.fn(async () => undefined),
      persistLocalDatabase,
      close,
    };
    const controller = new DebouncedRemotePersistenceController(store, localPath, 100);

    controller.schedulePersist();
    controller.schedulePersist();
    expect(persistLocalDatabase).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    expect(persistLocalDatabase).toHaveBeenCalledTimes(1);

    await controller.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  test('remote snapshot preserves every table written into the sqlite database file', async () => {
    const localPath = makeTempFile('');
    fs.rmSync(localPath, { force: true });

    const db = new Database(localPath);
    db.exec(`
      CREATE TABLE messages (id TEXT PRIMARY KEY, content TEXT NOT NULL);
      CREATE TABLE router_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO messages (id, content) VALUES ('m1', 'hello from sqlite');
      INSERT INTO router_state (key, value) VALUES ('schema_version', '38');
    `);
    db.close();

    let remoteSnapshot: Buffer | null = null;
    const store: RemoteSqliteStore = {
      backend: 'mongodb',
      prepareLocalDatabase: vi.fn(async () => undefined),
      persistLocalDatabase: vi.fn(async (pathArg: string) => {
        remoteSnapshot = fs.readFileSync(pathArg);
      }),
      close: vi.fn(async () => undefined),
    };
    const controller = new DebouncedRemotePersistenceController(store, localPath, 1);

    controller.schedulePersist();
    await controller.flush();

    expect(remoteSnapshot).toBeInstanceOf(Buffer);
    const restoredPath = makeTempFile('');
    fs.writeFileSync(restoredPath, remoteSnapshot as Buffer);
    const restored = new Database(restoredPath);
    expect(restored.prepare('SELECT content FROM messages WHERE id = ?').get('m1'))
      .toEqual({ content: 'hello from sqlite' });
    expect(restored.prepare('SELECT value FROM router_state WHERE key = ?').get('schema_version'))
      .toEqual({ value: '38' });
    restored.close();
  });

  test('remote failure falls back to sqlite only when explicitly enabled', async () => {
    await expect(prepareSqlitePathForBackend({
      backend: 'mysql',
      databaseUrl: 'mysql://127.0.0.1:1/octodeck',
      fallbackToSqlite: false,
    }, makeTempFile())).rejects.toThrow();

    const controller = await prepareSqlitePathForBackend({
      backend: 'mysql',
      databaseUrl: 'mysql://127.0.0.1:1/octodeck',
      fallbackToSqlite: true,
    }, makeTempFile());
    expect(controller.backend).toBe('sqlite');
  });
});
