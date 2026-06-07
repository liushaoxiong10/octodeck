import { getDatabaseBackendConfig } from './db-backend-config.js';
import { isRepoKnowledgeFtsAvailable } from './db.js';

export type RepoKnowledgeSearchBackendId = 'sqlite' | 'postgres' | 'mongo';

export interface RepoKnowledgeSearchBackendStatus {
  id: RepoKnowledgeSearchBackendId;
  displayName: string;
  available: boolean;
  selected: boolean;
  reason?: string;
  mode: 'embedded' | 'database' | 'fallback';
}

function desiredBackend(): string {
  return (process.env.REPO_KNOWLEDGE_SEARCH_BACKEND || 'auto').trim().toLowerCase();
}

export function resolveRepoKnowledgeSearchBackend(): RepoKnowledgeSearchBackendId {
  const desired = desiredBackend();
  if (desired === 'sqlite') return 'sqlite';
  try {
    const dbConfig = getDatabaseBackendConfig();
    if (desired === 'postgres') return dbConfig.backend === 'postgresql' && !!dbConfig.databaseUrl ? 'postgres' : 'sqlite';
    if (desired === 'mongo') return dbConfig.backend === 'mongodb' && !!dbConfig.databaseUrl ? 'mongo' : 'sqlite';
    if (dbConfig.backend === 'postgresql') return 'postgres';
    if (dbConfig.backend === 'mongodb') return 'mongo';
  } catch {
    // Keep SQLite as the safe default when DB config is unavailable in tests.
  }
  return 'sqlite';
}

export function listRepoKnowledgeSearchBackends(): RepoKnowledgeSearchBackendStatus[] {
  const selected = resolveRepoKnowledgeSearchBackend();
  let dbBackend = 'sqlite';
  let hasDatabaseUrl = false;
  try {
    const dbConfig = getDatabaseBackendConfig();
    dbBackend = dbConfig.backend;
    hasDatabaseUrl = !!dbConfig.databaseUrl;
  } catch {
    // ignore invalid optional backend config; SQLite remains available.
  }
  return [
    {
      id: 'sqlite',
      displayName: isRepoKnowledgeFtsAvailable() ? 'SQLite FTS5 full-text search' : 'SQLite LIKE fallback',
      available: true,
      selected: selected === 'sqlite',
      mode: selected === 'sqlite' ? 'embedded' : 'fallback',
      reason: isRepoKnowledgeFtsAvailable() ? undefined : '当前 SQLite 未启用 FTS5，使用 LIKE fallback',
    },
    {
      id: 'postgres',
      displayName: 'PostgreSQL full-text search',
      available: dbBackend === 'postgresql' && hasDatabaseUrl,
      selected: selected === 'postgres',
      mode: 'database',
      reason: dbBackend === 'postgresql' && hasDatabaseUrl ? undefined : '需要 OCTODECK_DB_BACKEND=postgresql 和 OCTODECK_DATABASE_URL；当前将 fallback SQLite',
    },
    {
      id: 'mongo',
      displayName: 'MongoDB text search',
      available: dbBackend === 'mongodb' && hasDatabaseUrl,
      selected: selected === 'mongo',
      mode: 'database',
      reason: dbBackend === 'mongodb' && hasDatabaseUrl ? undefined : '需要 OCTODECK_DB_BACKEND=mongodb 和 OCTODECK_DATABASE_URL；当前将 fallback SQLite',
    },
  ];
}
