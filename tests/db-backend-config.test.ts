import { describe, expect, test } from 'vitest';

import { getDatabaseBackendConfig, redactDatabaseUrl } from '../src/db-backend-config.js';

describe('database backend config', () => {
  test('defaults to sqlite when no backend is configured', () => {
    expect(getDatabaseBackendConfig({})).toEqual({
      backend: 'sqlite',
      databaseUrl: undefined,
      fallbackToSqlite: false,
    });
  });

  test('accepts mysql and mongodb with database urls', () => {
    expect(getDatabaseBackendConfig({
      OCTODECK_DB_BACKEND: 'mysql',
      OCTODECK_DATABASE_URL: 'mysql://root:secret@localhost:3306/octodeck',
      OCTODECK_DB_FALLBACK_TO_SQLITE: 'true',
    })).toEqual({
      backend: 'mysql',
      databaseUrl: 'mysql://root:secret@localhost:3306/octodeck',
      fallbackToSqlite: true,
    });

    expect(getDatabaseBackendConfig({
      OCTODECK_DB_BACKEND: 'mongodb',
      OCTODECK_DATABASE_URL: 'mongodb://localhost:27017/octodeck',
    }).backend).toBe('mongodb');
  });

  test('requires url for remote backends', () => {
    expect(() => getDatabaseBackendConfig({ OCTODECK_DB_BACKEND: 'mysql' }))
      .toThrow('OCTODECK_DATABASE_URL is required');
    expect(() => getDatabaseBackendConfig({ OCTODECK_DB_BACKEND: 'mongodb' }))
      .toThrow('OCTODECK_DATABASE_URL is required');
  });

  test('rejects unsupported backends', () => {
    expect(() => getDatabaseBackendConfig({ OCTODECK_DB_BACKEND: 'postgres' }))
      .toThrow('Unsupported OCTODECK_DB_BACKEND');
  });

  test('redacts database url credentials for logs', () => {
    expect(redactDatabaseUrl('mysql://root:secret@localhost:3306/octodeck'))
      .toBe('mysql://***:***@localhost:3306/octodeck');
    expect(redactDatabaseUrl('not a url')).toBe('<invalid-url-redacted>');
    expect(redactDatabaseUrl(undefined)).toBeUndefined();
  });
});
