import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { getDatabaseForInternalUse } from './db.js';
import { DATA_DIR, GROUPS_DIR } from './config.js';

export type CloudMemoryType = 'global' | 'session' | 'agent';
export type CloudMemoryAuthority = 'cloud' | 'client';
export type CloudMemorySource = 'cloud_sdk' | 'web' | 'api' | 'client_sync' | 'migration';

export interface CloudMemoryRecord {
  id: string;
  userId: string;
  memoryType: CloudMemoryType;
  scopeKey: string;
  groupFolder?: string;
  agentId?: string;
  deviceLinkId?: string;
  path: string;
  content: string;
  revision: number;
  authority: CloudMemoryAuthority;
  source: CloudMemorySource;
  contentHash: string;
  updatedAt: string;
  updatedBy?: string;
}

interface PutCloudMemoryArgs {
  userId: string;
  memoryType: CloudMemoryType;
  groupFolder?: string;
  agentId?: string;
  deviceLinkId?: string;
  path: string;
  content: string;
  expectedRevision?: number;
  source: CloudMemorySource;
  updatedBy?: string;
}

interface SyncClientAgentMemoryArgs {
  userId: string;
  deviceLinkId: string;
  agentId: string;
  path: string;
  content: string;
  source: 'client_sync';
  updatedBy?: string;
}

interface SearchCloudMemoryArgs {
  userId: string;
  query: string;
  memoryType?: CloudMemoryType;
  limit?: number;
}

function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function normalizePath(input: string): string {
  const normalized = input.replace(/\\/g, '/').trim().replace(/^\/+/, '');
  if (!normalized || normalized.includes('\0')) throw new Error('Invalid memory path');
  const parts = normalized.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Invalid memory path');
  }
  return normalized;
}

function buildScopeKey(args: {
  memoryType: CloudMemoryType;
  userId: string;
  groupFolder?: string;
  deviceLinkId?: string;
  agentId?: string;
}): string {
  if (args.memoryType === 'global') return `global:${args.userId}`;
  if (args.memoryType === 'session') {
    if (!args.groupFolder) throw new Error('groupFolder is required for session memory');
    return `session:${args.groupFolder}`;
  }
  if (!args.deviceLinkId || !args.agentId) {
    throw new Error('deviceLinkId and agentId are required for agent memory');
  }
  return `agent:${args.deviceLinkId}:${args.agentId}`;
}

function toRecord(row: any): CloudMemoryRecord {
  return {
    id: row.id,
    userId: row.user_id,
    memoryType: row.memory_type,
    scopeKey: row.scope_key,
    groupFolder: row.group_folder ?? undefined,
    agentId: row.agent_id ?? undefined,
    deviceLinkId: row.device_link_id ?? undefined,
    path: row.path,
    content: row.content,
    revision: row.revision,
    authority: row.authority,
    source: row.source,
    contentHash: row.content_hash,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by ?? undefined,
  };
}

function getExisting(userId: string, memoryType: CloudMemoryType, scopeKey: string, memoryPath: string): CloudMemoryRecord | undefined {
  const row = getDatabaseForInternalUse()
    .prepare(
      `SELECT * FROM cloud_memories
       WHERE user_id = ? AND memory_type = ? AND scope_key = ? AND path = ?`,
    )
    .get(userId, memoryType, scopeKey, memoryPath);
  return row ? toRecord(row) : undefined;
}

export function putCloudMemory(args: PutCloudMemoryArgs): CloudMemoryRecord {
  if (args.memoryType === 'agent') {
    throw new Error('agent memory is client authoritative; use syncClientAgentMemory');
  }
  const memoryPath = normalizePath(args.path);
  const scopeKey = buildScopeKey(args);
  const existing = getExisting(args.userId, args.memoryType, scopeKey, memoryPath);
  if (existing && args.expectedRevision !== undefined && existing.revision !== args.expectedRevision) {
    throw new Error(`revision conflict: expected ${args.expectedRevision}, got ${existing.revision}`);
  }
  const now = new Date().toISOString();
  const id = existing?.id ?? crypto.randomUUID();
  const revision = existing ? existing.revision + 1 : 1;
  const contentHash = hashContent(args.content);
  getDatabaseForInternalUse()
    .prepare(
      `INSERT INTO cloud_memories (
        id, user_id, memory_type, scope_key, group_folder, agent_id, device_link_id,
        path, content, revision, authority, source, content_hash, updated_at, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'cloud', ?, ?, ?, ?)
      ON CONFLICT(user_id, memory_type, scope_key, path) DO UPDATE SET
        content = excluded.content,
        revision = excluded.revision,
        authority = excluded.authority,
        source = excluded.source,
        content_hash = excluded.content_hash,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by`,
    )
    .run(
      id,
      args.userId,
      args.memoryType,
      scopeKey,
      args.groupFolder ?? null,
      args.agentId ?? null,
      args.deviceLinkId ?? null,
      memoryPath,
      args.content,
      revision,
      args.source,
      contentHash,
      now,
      args.updatedBy ?? null,
    );
  return getExisting(args.userId, args.memoryType, scopeKey, memoryPath)!;
}

export function appendCloudMemory(args: PutCloudMemoryArgs): CloudMemoryRecord {
  const memoryPath = normalizePath(args.path);
  const scopeKey = buildScopeKey(args);
  const existing = getExisting(args.userId, args.memoryType, scopeKey, memoryPath);
  const normalizedContent = args.content.replace(/\r\n?/g, '\n').trim();
  const entry = `### ${new Date().toISOString()}\n${normalizedContent}\n`;
  const nextContent = existing?.content
    ? `${existing.content.replace(/\s*$/, '')}\n---\n\n${entry}`
    : entry;
  return putCloudMemory({ ...args, path: memoryPath, content: nextContent, expectedRevision: existing?.revision });
}

export function syncClientAgentMemory(args: SyncClientAgentMemoryArgs): CloudMemoryRecord {
  const memoryPath = normalizePath(args.path);
  const scopeKey = buildScopeKey({
    memoryType: 'agent',
    userId: args.userId,
    deviceLinkId: args.deviceLinkId,
    agentId: args.agentId,
  });
  const existing = getExisting(args.userId, 'agent', scopeKey, memoryPath);
  const now = new Date().toISOString();
  const id = existing?.id ?? crypto.randomUUID();
  const revision = existing ? existing.revision + 1 : 1;
  getDatabaseForInternalUse()
    .prepare(
      `INSERT INTO cloud_memories (
        id, user_id, memory_type, scope_key, group_folder, agent_id, device_link_id,
        path, content, revision, authority, source, content_hash, updated_at, updated_by
      ) VALUES (?, ?, 'agent', ?, NULL, ?, ?, ?, ?, ?, 'client', ?, ?, ?, ?)
      ON CONFLICT(user_id, memory_type, scope_key, path) DO UPDATE SET
        content = excluded.content,
        revision = excluded.revision,
        authority = excluded.authority,
        source = excluded.source,
        content_hash = excluded.content_hash,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by`,
    )
    .run(
      id,
      args.userId,
      scopeKey,
      args.agentId,
      args.deviceLinkId,
      memoryPath,
      args.content,
      revision,
      args.source,
      hashContent(args.content),
      now,
      args.updatedBy ?? null,
    );
  return getExisting(args.userId, 'agent', scopeKey, memoryPath)!;
}

export function getCloudMemory(args: {
  userId: string;
  memoryType: CloudMemoryType;
  groupFolder?: string;
  deviceLinkId?: string;
  agentId?: string;
  path: string;
}): CloudMemoryRecord | undefined {
  const memoryPath = normalizePath(args.path);
  const scopeKey = buildScopeKey(args);
  return getExisting(args.userId, args.memoryType, scopeKey, memoryPath);
}

export function searchCloudMemory(args: SearchCloudMemoryArgs): CloudMemoryRecord[] {
  const query = args.query.trim().toLowerCase();
  if (!query) return [];
  const limit = Math.max(1, Math.min(args.limit ?? 20, 100));
  const rows = args.memoryType
    ? getDatabaseForInternalUse()
        .prepare(
          `SELECT * FROM cloud_memories WHERE user_id = ? AND memory_type = ? ORDER BY updated_at DESC`,
        )
        .all(args.userId, args.memoryType)
    : getDatabaseForInternalUse()
        .prepare(`SELECT * FROM cloud_memories WHERE user_id = ? ORDER BY updated_at DESC`)
        .all(args.userId);
  return (rows as any[])
    .map(toRecord)
    .filter((record) => record.content.toLowerCase().includes(query))
    .slice(0, limit);
}

export function listCloudMemories(userId: string): CloudMemoryRecord[] {
  return getDatabaseForInternalUse()
    .prepare(`SELECT * FROM cloud_memories WHERE user_id = ? ORDER BY memory_type ASC, scope_key ASC, path ASC`)
    .all(userId)
    .map(toRecord);
}

export function importLegacyCloudMemories(args: {
  userId: string;
  groupFolders: string[];
}): number {
  let imported = 0;

  const importIfMissing = (params: {
    memoryType: 'global' | 'session';
    groupFolder?: string;
    memoryPath: string;
    filePath: string;
  }) => {
    if (!fs.existsSync(params.filePath)) return;
    const existing = getCloudMemory({
      userId: args.userId,
      memoryType: params.memoryType,
      groupFolder: params.groupFolder,
      path: params.memoryPath,
    });
    if (existing) return;
    putCloudMemory({
      userId: args.userId,
      memoryType: params.memoryType,
      groupFolder: params.groupFolder,
      path: params.memoryPath,
      content: fs.readFileSync(params.filePath, 'utf-8'),
      source: 'migration',
      updatedBy: 'migration',
    });
    imported += 1;
  };

  importIfMissing({
    memoryType: 'global',
    memoryPath: 'CLAUDE.md',
    filePath: path.join(GROUPS_DIR, 'user-global', args.userId, 'CLAUDE.md'),
  });

  for (const groupFolder of args.groupFolders) {
    importIfMissing({
      memoryType: 'session',
      groupFolder,
      memoryPath: 'CLAUDE.md',
      filePath: path.join(GROUPS_DIR, groupFolder, 'CLAUDE.md'),
    });

    const legacyDateDir = path.join(DATA_DIR, 'memory', groupFolder);
    if (!fs.existsSync(legacyDateDir)) continue;
    for (const entry of fs.readdirSync(legacyDateDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      importIfMissing({
        memoryType: 'session',
        groupFolder,
        memoryPath: `memory/${entry.name}`,
        filePath: path.join(legacyDateDir, entry.name),
      });
    }
  }

  return imported;
}
