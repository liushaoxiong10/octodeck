import fs from 'fs';
import path from 'path';
import type { PoolConfig } from 'pg';

import {
  DatabaseBackendConfig,
  redactDatabaseUrl,
} from './db-backend-config.js';
import { logger } from './logger.js';

const SNAPSHOT_ID = 'messages.db';
const MYSQL_TABLE = 'octodeck_sqlite_snapshots';
const MONGO_COLLECTION = 'octodeck_sqlite_snapshots';
const POSTGRES_TABLE = 'octodeck_sqlite_snapshots';
const DEFAULT_PERSIST_DEBOUNCE_MS = 250;

export interface RemoteSqliteStore {
  backend: 'mysql' | 'mongodb' | 'postgresql';
  prepareLocalDatabase(localPath: string): Promise<void>;
  persistLocalDatabase(localPath: string): Promise<void>;
  close(): Promise<void>;
}

export interface RemotePersistenceController {
  backend: 'sqlite' | 'mysql' | 'mongodb' | 'postgresql';
  schedulePersist(): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

interface SnapshotRecord {
  data: Buffer;
  updatedAt: Date;
}

export class NoopPersistenceController implements RemotePersistenceController {
  backend: 'sqlite' = 'sqlite';

  schedulePersist(): void {
    // SQLite persists directly to its local file.
  }

  async flush(): Promise<void> {
    // No remote backend to flush.
  }

  async close(): Promise<void> {
    // No remote backend to close.
  }
}

export class DebouncedRemotePersistenceController implements RemotePersistenceController {
  readonly backend: 'mysql' | 'mongodb' | 'postgresql';
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private dirty = false;

  constructor(
    private readonly store: RemoteSqliteStore,
    private readonly localPath: string,
    private readonly debounceMs = DEFAULT_PERSIST_DEBOUNCE_MS,
  ) {
    this.backend = store.backend;
  }

  schedulePersist(): void {
    this.dirty = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush().catch((err) => {
        logger.error(
          { err, backend: this.backend },
          'Failed to persist SQLite snapshot',
        );
      });
    }, this.debounceMs);
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) {
      if (this.inFlight) await this.inFlight;
      return;
    }
    this.dirty = false;
    this.inFlight = this.store
      .persistLocalDatabase(this.localPath)
      .finally(() => {
        this.inFlight = null;
      });
    await this.inFlight;
  }

  async close(): Promise<void> {
    await this.flush();
    await this.store.close();
  }
}

export async function createRemoteStoreFromConfig(
  config: DatabaseBackendConfig,
): Promise<RemoteSqliteStore | null> {
  if (config.backend === 'sqlite') return null;
  if (!config.databaseUrl) {
    throw new Error(
      `OCTODECK_DATABASE_URL is required when OCTODECK_DB_BACKEND=${config.backend}`,
    );
  }
  if (config.backend === 'mysql')
    return createMysqlRemoteStore(config.databaseUrl);
  if (config.backend === 'postgresql')
    return createPostgresqlRemoteStore(config.databaseUrl);
  return createMongoRemoteStore(config.databaseUrl);
}

export async function prepareSqlitePathForBackend(
  config: DatabaseBackendConfig,
  localPath: string,
): Promise<RemotePersistenceController> {
  if (config.backend === 'sqlite') return new NoopPersistenceController();

  let remoteStore: RemoteSqliteStore | null = null;
  try {
    remoteStore = await createRemoteStoreFromConfig(config);
    if (!remoteStore) return new NoopPersistenceController();
    await remoteStore.prepareLocalDatabase(localPath);
    logger.info(
      {
        backend: config.backend,
        databaseUrl: redactDatabaseUrl(config.databaseUrl),
      },
      'Using remote database backend for SQLite snapshot storage',
    );
    return new DebouncedRemotePersistenceController(remoteStore, localPath);
  } catch (err) {
    if (remoteStore) await remoteStore.close().catch(() => undefined);
    if (config.fallbackToSqlite) {
      logger.warn(
        { err, backend: config.backend },
        'Remote database unavailable; falling back to local SQLite',
      );
      return new NoopPersistenceController();
    }
    throw err;
  }
}

async function createPostgresqlRemoteStore(
  databaseUrl: string,
): Promise<RemoteSqliteStore> {
  const pg = await import('pg');
  const pool = new pg.Pool(createPostgresqlPoolConfig(databaseUrl));

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${POSTGRES_TABLE} (
      id VARCHAR(128) PRIMARY KEY,
      data BYTEA NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  return {
    backend: 'postgresql',
    async prepareLocalDatabase(localPath: string): Promise<void> {
      const result = await pool.query(
        `SELECT data, updated_at AS "updatedAt" FROM ${POSTGRES_TABLE} WHERE id = $1 LIMIT 1`,
        [SNAPSHOT_ID],
      );
      const record = firstPostgresqlSnapshot(result.rows);
      if (!record) return;
      writeSnapshot(localPath, record.data);
    },
    async persistLocalDatabase(localPath: string): Promise<void> {
      const data = readSnapshot(localPath);
      await pool.query(
        `INSERT INTO ${POSTGRES_TABLE} (id, data, updated_at)
         VALUES ($1, $2, CURRENT_TIMESTAMP)
         ON CONFLICT (id) DO UPDATE SET
           data = EXCLUDED.data,
           updated_at = CURRENT_TIMESTAMP`,
        [SNAPSHOT_ID, data],
      );
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}

export function createPostgresqlPoolConfig(databaseUrl: string): PoolConfig {
  const parsed = new URL(databaseUrl);
  const hostname = parsed.hostname;
  if (!hostname.startsWith('[') || !hostname.endsWith(']')) {
    return { connectionString: databaseUrl };
  }

  const config: PoolConfig = {
    host: hostname.slice(1, -1),
    port: parsed.port ? Number(parsed.port) : undefined,
    user: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    database: parsed.pathname
      ? decodeURIComponent(parsed.pathname.replace(/^\//, ''))
      : undefined,
  };
  const options = parsed.searchParams.get('options');
  if (options) config.options = options;
  return config;
}

async function createMysqlRemoteStore(
  databaseUrl: string,
): Promise<RemoteSqliteStore> {
  const mysql = await import('mysql2/promise');
  const pool = mysql.createPool(databaseUrl);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS ${MYSQL_TABLE} (
      id VARCHAR(128) PRIMARY KEY,
      data LONGBLOB NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  return {
    backend: 'mysql',
    async prepareLocalDatabase(localPath: string): Promise<void> {
      const [rows] = await pool.execute(
        `SELECT data, updated_at AS updatedAt FROM ${MYSQL_TABLE} WHERE id = ? LIMIT 1`,
        [SNAPSHOT_ID],
      );
      const record = firstMysqlSnapshot(rows);
      if (!record) return;
      writeSnapshot(localPath, record.data);
    },
    async persistLocalDatabase(localPath: string): Promise<void> {
      const data = readSnapshot(localPath);
      await pool.execute(
        `INSERT INTO ${MYSQL_TABLE} (id, data, updated_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON DUPLICATE KEY UPDATE data = VALUES(data), updated_at = CURRENT_TIMESTAMP`,
        [SNAPSHOT_ID, data],
      );
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}

async function createMongoRemoteStore(
  databaseUrl: string,
): Promise<RemoteSqliteStore> {
  const { MongoClient, Binary } = await import('mongodb');
  const client = new MongoClient(databaseUrl);
  await client.connect();
  const dbName = new URL(databaseUrl).pathname.replace(/^\//, '') || 'octodeck';
  const db = client.db(dbName);
  const collection = db.collection(MONGO_COLLECTION);
  await collection.createIndex({ id: 1 }, { unique: true });

  return {
    backend: 'mongodb',
    async prepareLocalDatabase(localPath: string): Promise<void> {
      const doc = await collection.findOne<{
        data?: Buffer | { buffer?: Buffer };
      }>({ id: SNAPSHOT_ID });
      const data = normalizeMongoBinary(doc?.data);
      if (!data) return;
      writeSnapshot(localPath, data);
    },
    async persistLocalDatabase(localPath: string): Promise<void> {
      const data = readSnapshot(localPath);
      await collection.updateOne(
        { id: SNAPSHOT_ID },
        {
          $set: {
            id: SNAPSHOT_ID,
            data: new Binary(data),
            updatedAt: new Date(),
          },
        },
        { upsert: true },
      );
    },
    async close(): Promise<void> {
      await client.close();
    },
  };
}

function firstMysqlSnapshot(rows: unknown): SnapshotRecord | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const row = rows[0] as { data?: Buffer | Uint8Array; updatedAt?: Date };
  if (!row.data) return null;
  return {
    data: Buffer.from(row.data),
    updatedAt: row.updatedAt || new Date(),
  };
}

function firstPostgresqlSnapshot(rows: unknown): SnapshotRecord | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const row = rows[0] as { data?: Buffer | Uint8Array; updatedAt?: Date };
  if (!row.data) return null;
  return {
    data: Buffer.from(row.data),
    updatedAt: row.updatedAt || new Date(),
  };
}

function normalizeMongoBinary(value: unknown): Buffer | null {
  if (!value) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  const maybeBinary = value as {
    buffer?: Buffer | Uint8Array;
    value?: () => Buffer;
  };
  if (maybeBinary.buffer) return Buffer.from(maybeBinary.buffer);
  if (typeof maybeBinary.value === 'function')
    return Buffer.from(maybeBinary.value());
  return null;
}

function readSnapshot(localPath: string): Buffer {
  return fs.readFileSync(localPath);
}

function writeSnapshot(localPath: string, data: Buffer): void {
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  fs.writeFileSync(localPath, data);
}
