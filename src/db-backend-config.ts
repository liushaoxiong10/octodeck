export type DatabaseBackend = 'sqlite' | 'mysql' | 'mongodb' | 'postgresql';

export interface DatabaseBackendConfig {
  backend: DatabaseBackend;
  databaseUrl?: string;
  fallbackToSqlite: boolean;
}

const VALID_BACKENDS = new Set<DatabaseBackend>([
  'sqlite',
  'mysql',
  'mongodb',
  'postgresql',
]);

function normalizeBackend(value: string | undefined): DatabaseBackend {
  const normalized = (value || 'sqlite').trim().toLowerCase();
  if (!VALID_BACKENDS.has(normalized as DatabaseBackend)) {
    throw new Error(
      `Unsupported OCTODECK_DB_BACKEND "${value}". Expected one of: sqlite, mysql, mongodb, postgresql`,
    );
  }
  return normalized as DatabaseBackend;
}

function normalizeUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export function getDatabaseBackendConfig(
  env: NodeJS.ProcessEnv = process.env,
): DatabaseBackendConfig {
  const backend = normalizeBackend(env.OCTODECK_DB_BACKEND);
  const databaseUrl = normalizeUrl(env.OCTODECK_DATABASE_URL);
  const fallbackToSqlite = env.OCTODECK_DB_FALLBACK_TO_SQLITE === 'true';

  if (backend !== 'sqlite' && !databaseUrl) {
    throw new Error(
      `OCTODECK_DATABASE_URL is required when OCTODECK_DB_BACKEND=${backend}`,
    );
  }

  return {
    backend,
    databaseUrl,
    fallbackToSqlite,
  };
}

export function redactDatabaseUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    if (parsed.username) parsed.username = parsed.username ? '***' : '';
    return parsed.toString();
  } catch {
    return '<invalid-url-redacted>';
  }
}
