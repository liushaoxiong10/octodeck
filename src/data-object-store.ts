import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import {
  deleteDataObject,
  getDataObject,
  listDataObjects,
  putDataObject,
} from './db.js';

function relativeDataPath(absOrRelativePath: string): string {
  const relative = path.isAbsolute(absOrRelativePath)
    ? path.relative(DATA_DIR, absOrRelativePath)
    : absOrRelativePath;
  const normalized = relative.replace(/\\/g, '/').replace(/^\.\/?/, '');
  if (!normalized || normalized.startsWith('../') || path.isAbsolute(normalized)) {
    throw new Error(`Path is outside data directory: ${absOrRelativePath}`);
  }
  if (normalized === 'db' || normalized.startsWith('db/')) {
    throw new Error('data/db is reserved for database files');
  }
  return normalized;
}

async function statIfExists(absPath: string): Promise<{ mode?: number; mtimeMs?: number }> {
  try {
    const stat = await fs.stat(absPath);
    return { mode: stat.mode, mtimeMs: stat.mtimeMs };
  } catch {
    return {};
  }
}

function statIfExistsSync(absPath: string): { mode?: number; mtimeMs?: number } {
  try {
    const stat = fsSync.statSync(absPath);
    return { mode: stat.mode, mtimeMs: stat.mtimeMs };
  } catch {
    return {};
  }
}

export function readDataObjectText(absOrRelativePath: string): string | null {
  let record: ReturnType<typeof getDataObject>;
  try {
    record = getDataObject(relativeDataPath(absOrRelativePath));
  } catch {
    return null;
  }
  if (!record || record.entryType !== 'file') return null;
  return (record.data || Buffer.alloc(0)).toString('utf-8');
}

export function readDataObjectJson<T>(absOrRelativePath: string, fallback: T): T {
  const text = readDataObjectText(absOrRelativePath);
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export async function writeDataObjectText(
  absOrRelativePath: string,
  text: string,
  contentType = 'text/plain; charset=utf-8',
): Promise<void> {
  const relativePath = relativeDataPath(absOrRelativePath);
  const meta = await statIfExists(path.join(DATA_DIR, relativePath));
  try {
    putDataObject({ relativePath, data: text, contentType, ...meta });
  } catch {
    // Some unit tests exercise filesystem helpers before initDatabase(). In that
    // case keep the legacy file path as the source of truth.
  }
}

export function writeDataObjectTextSync(
  absOrRelativePath: string,
  text: string,
  contentType = 'text/plain; charset=utf-8',
): void {
  const relativePath = relativeDataPath(absOrRelativePath);
  const meta = statIfExistsSync(path.join(DATA_DIR, relativePath));
  try {
    putDataObject({ relativePath, data: text, contentType, ...meta });
  } catch {
    // Some unit tests exercise filesystem helpers before initDatabase(). In that
    // case keep the legacy file path as the source of truth.
  }
}

export async function writeDataObjectJson(
  absOrRelativePath: string,
  data: unknown,
): Promise<void> {
  await writeDataObjectText(
    absOrRelativePath,
    JSON.stringify(data, null, 2),
    'application/json; charset=utf-8',
  );
}

export function writeDataObjectJsonSync(
  absOrRelativePath: string,
  data: unknown,
): void {
  writeDataObjectTextSync(
    absOrRelativePath,
    JSON.stringify(data, null, 2),
    'application/json; charset=utf-8',
  );
}

export function readDataObjectBuffer(absOrRelativePath: string): Buffer | null {
  let record: ReturnType<typeof getDataObject>;
  try {
    record = getDataObject(relativeDataPath(absOrRelativePath));
  } catch {
    return null;
  }
  if (!record || record.entryType !== 'file') return null;
  return record.data ? Buffer.from(record.data) : Buffer.alloc(0);
}

export async function writeDataObjectBuffer(
  absOrRelativePath: string,
  data: Buffer | Uint8Array,
  contentType?: string,
): Promise<void> {
  const relativePath = relativeDataPath(absOrRelativePath);
  const meta = await statIfExists(path.join(DATA_DIR, relativePath));
  try {
    putDataObject({ relativePath, data, contentType, ...meta });
  } catch {
    // See writeDataObjectTextSync fallback note.
  }
}

export function writeDataObjectBufferSync(
  absOrRelativePath: string,
  data: Buffer | Uint8Array,
  contentType?: string,
): void {
  const relativePath = relativeDataPath(absOrRelativePath);
  const meta = statIfExistsSync(path.join(DATA_DIR, relativePath));
  try {
    putDataObject({ relativePath, data, contentType, ...meta });
  } catch {
    // See writeDataObjectTextSync fallback note.
  }
}

export function deleteDataObjectPath(absOrRelativePath: string): void {
  try {
    deleteDataObject(relativeDataPath(absOrRelativePath));
  } catch {
    // Database may be intentionally unavailable in isolated filesystem tests.
  }
}

export function listDataObjectPaths(prefix: string): string[] {
  try {
    return listDataObjects(relativeDataPath(prefix)).map((record) => record.relativePath);
  } catch {
    return [];
  }
}
