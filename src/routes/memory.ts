// Memory management routes — fully cloud-backed (cloud_memories table).
//
// 所有记忆操作(list/get/put/search)统一走 cloud_memories 数据库;
// 仅保留 importLegacyCloudMemories 一次性把本地 data/groups/**/CLAUDE.md、
// data/memory/{folder}/*.md、data/groups/{folder}/conversations/* 迁入云端。
// 前端 path 形式: cloud://{memoryType}/{scopeKey}/{path}

import { Hono } from 'hono';
import { getWebDeps, type Variables } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  MemoryFileSchema,
  MemoryGlobalSchema,
  type MemorySource,
  type MemoryFilePayload,
  type MemorySearchHit,
} from '../schemas.js';
import { getAllRegisteredGroups, getUserById } from '../db.js';
import { logger } from '../logger.js';
import type { AuthUser } from '../types.js';
import {
  getCloudMemory,
  importLegacyCloudMemories,
  listCloudMemories,
  putCloudMemory,
  searchCloudMemory,
  syncClientAgentMemory,
  type CloudMemoryRecord,
  type CloudMemoryType,
} from '../memory-store.js';
import { createOctoDeckEvent } from '../octodeck-events.js';

const memoryRoutes = new Hono<{ Variables: Variables }>();

// --- Constants ---
const MAX_GLOBAL_MEMORY_LENGTH = 200_000;
const MAX_MEMORY_FILE_LENGTH = 500_000;
const MEMORY_LIST_LIMIT = 500;
const MEMORY_SEARCH_LIMIT = 120;

function ownedFoldersForUser(user: AuthUser): string[] {
  const groups = getAllRegisteredGroups();
  const folders = new Set<string>();
  for (const group of Object.values(groups)) {
    if (user.role === 'admin' || group.created_by === user.id)
      folders.add(group.folder);
  }
  return Array.from(folders);
}

function ensureLegacyImported(user: AuthUser): void {
  importLegacyCloudMemories({
    userId: user.id,
    groupFolders: ownedFoldersForUser(user),
  });
}

function classifyCloudType(record: CloudMemoryRecord): MemorySource['type'] {
  if (record.memoryType === 'global') return 'global';
  if (record.memoryType === 'agent') return 'agent';
  if (record.path.startsWith('memory/')) return 'date';
  if (record.path.startsWith('conversations/')) return 'conversation';
  return 'session';
}

function cloudRecordToSource(record: CloudMemoryRecord): MemorySource {
  const owner = getUserById(record.userId);
  const ownerLabel = owner
    ? owner.display_name || owner.username
    : record.userId;
  const type = classifyCloudType(record);
  const labelPrefix =
    record.memoryType === 'global'
      ? `${ownerLabel} / 云端全局记忆`
      : record.memoryType === 'agent'
        ? `${record.deviceLinkId || 'client'} / client agent 记忆镜像`
        : type === 'date'
          ? `${record.groupFolder || record.scopeKey} / 日期记忆`
          : type === 'conversation'
            ? `${record.groupFolder || record.scopeKey} / 对话归档`
            : `${record.groupFolder || record.scopeKey} / 云端会话记忆`;
  return {
    path: `cloud://${record.memoryType}/${record.scopeKey}/${record.path}`,
    label: `${labelPrefix} / ${record.path}`,
    type,
    // agent 镜像只读;conversation 归档只读
    writable: record.authority === 'cloud' && type !== 'conversation',
    exists: true,
    updatedAt: record.updatedAt,
    size: Buffer.byteLength(record.content, 'utf-8'),
    ownerName: ownerLabel,
    folder: record.groupFolder,
  };
}

interface ParsedCloudPath {
  memoryType: CloudMemoryType;
  scopeKey: string;
  path: string;
  groupFolder?: string;
  deviceLinkId?: string;
  agentId?: string;
}

function parseCloudPath(cloudPath: string): ParsedCloudPath | null {
  if (!cloudPath.startsWith('cloud://')) return null;
  const rest = cloudPath.slice('cloud://'.length);
  const [memoryType, ...parts] = rest.split('/');
  if (
    memoryType !== 'global' &&
    memoryType !== 'session' &&
    memoryType !== 'agent'
  )
    return null;
  const scopeKey = parts.shift();
  if (!scopeKey) return null;
  const memoryPath = parts.join('/');
  if (!memoryPath) return null;
  if (memoryType === 'session' && scopeKey.startsWith('session:')) {
    return {
      memoryType,
      scopeKey,
      groupFolder: scopeKey.slice('session:'.length),
      path: memoryPath,
    };
  }
  if (memoryType === 'agent' && scopeKey.startsWith('agent:')) {
    const [, deviceLinkId, agentId] = scopeKey.split(':');
    return { memoryType, scopeKey, deviceLinkId, agentId, path: memoryPath };
  }
  return { memoryType, scopeKey, path: memoryPath };
}

/**
 * 兼容旧 path: data/groups/user-global/{userId}/CLAUDE.md、
 * data/groups/{folder}/CLAUDE.md、data/memory/{folder}/{name}.md、
 * data/groups/{folder}/conversations/{name} 等映射到 cloud://...。
 *
 * 历史前端缓存或外部链接可能仍在使用这些路径,做一次重定向解析。
 */
function parseLegacyPath(
  legacyPath: string,
  user: AuthUser,
): ParsedCloudPath | null {
  const normalized = legacyPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = normalized.split('/');
  if (parts.length < 3) return null;
  if (parts[0] !== 'data') return null;

  if (parts[1] === 'groups' && parts[2] === 'user-global') {
    // data/groups/user-global/{userId}/CLAUDE.md
    const ownerUserId = parts[3];
    if (!ownerUserId) return null;
    if (user.role !== 'admin' && ownerUserId !== user.id) return null;
    const memoryPath = parts.slice(4).join('/') || 'CLAUDE.md';
    return {
      memoryType: 'global',
      scopeKey: `global:${ownerUserId}`,
      path: memoryPath,
    };
  }

  if (parts[1] === 'groups') {
    // data/groups/{folder}/CLAUDE.md 或 data/groups/{folder}/conversations/...
    const folder = parts[2];
    if (!folder) return null;
    const memoryPath = parts.slice(3).join('/');
    if (!memoryPath) return null;
    return {
      memoryType: 'session',
      scopeKey: `session:${folder}`,
      groupFolder: folder,
      path: memoryPath,
    };
  }

  if (parts[1] === 'memory') {
    // data/memory/{folder}/{name}.md → memory/{name}.md
    const folder = parts[2];
    const fileName = parts.slice(3).join('/');
    if (!folder || !fileName) return null;
    return {
      memoryType: 'session',
      scopeKey: `session:${folder}`,
      groupFolder: folder,
      path: `memory/${fileName}`,
    };
  }

  return null;
}

function resolveAccessibleCloudRef(
  inputPath: string,
  user: AuthUser,
): ParsedCloudPath {
  const ref = parseCloudPath(inputPath) ?? parseLegacyPath(inputPath, user);
  if (!ref) throw new Error('Invalid memory path');

  // 权限校验
  if (user.role !== 'admin') {
    if (ref.memoryType === 'global') {
      const ownerId = ref.scopeKey.startsWith('global:')
        ? ref.scopeKey.slice('global:'.length)
        : '';
      if (ownerId && ownerId !== user.id)
        throw new Error('Memory path out of allowed scope');
    } else if (ref.memoryType === 'session') {
      const folder = ref.groupFolder;
      if (!folder || !ownedFoldersForUser(user).includes(folder)) {
        throw new Error('Memory path out of allowed scope');
      }
    } else if (ref.memoryType === 'agent') {
      // agent 记忆只读,仅本人 device 可见(由列表已过滤;读时简单兜底)
      // listCloudMemories 已按 user_id 过滤,此处不再阻止
    }
  }

  return ref;
}

function readMemoryFile(
  inputPath: string,
  user: AuthUser,
): MemoryFilePayload {
  ensureLegacyImported(user);
  const ref = resolveAccessibleCloudRef(inputPath, user);
  const record = getCloudMemory({
    userId: user.id,
    memoryType: ref.memoryType,
    groupFolder: ref.groupFolder,
    deviceLinkId: ref.deviceLinkId,
    agentId: ref.agentId,
    path: ref.path,
  });
  if (!record) {
    if (ref.memoryType === 'session') {
      // 还未创建,返回空白可写记录
      return {
        path: `cloud://${ref.memoryType}/${ref.scopeKey}/${ref.path}`,
        content: '',
        updatedAt: null,
        size: 0,
        writable: true,
      };
    }
    throw new Error('Memory file not found');
  }
  return {
    path: `cloud://${record.memoryType}/${record.scopeKey}/${record.path}`,
    content: record.content,
    updatedAt: record.updatedAt,
    size: Buffer.byteLength(record.content, 'utf-8'),
    writable:
      record.authority === 'cloud' && classifyCloudType(record) !== 'conversation',
  };
}

function writeMemoryFile(
  inputPath: string,
  content: string,
  user: AuthUser,
): MemoryFilePayload {
  ensureLegacyImported(user);
  const ref = resolveAccessibleCloudRef(inputPath, user);
  if (ref.memoryType === 'agent') {
    throw new Error('client agent memory is read-only cloud mirror');
  }
  if (ref.memoryType === 'session' && ref.path.startsWith('conversations/')) {
    throw new Error('conversation archive is read-only');
  }
  if (Buffer.byteLength(content, 'utf-8') > MAX_MEMORY_FILE_LENGTH) {
    throw new Error('Memory file is too large');
  }
  const record = putCloudMemory({
    userId: user.id,
    memoryType: ref.memoryType,
    groupFolder: ref.groupFolder,
    path: ref.path,
    content,
    source: 'web',
    updatedBy: user.id,
  });
  return {
    path: `cloud://${record.memoryType}/${record.scopeKey}/${record.path}`,
    content: record.content,
    updatedAt: record.updatedAt,
    size: Buffer.byteLength(record.content, 'utf-8'),
    writable: true,
  };
}

function broadcastMemoryUpdate(
  userId: string,
  input: {
    memoryType: CloudMemoryType;
    path: string;
    action: 'created' | 'updated' | 'deleted' | 'synced';
    scopeKey?: string;
    deviceLinkId?: string;
    correlationId?: string;
    source?: string;
  },
): void {
  const type = input.memoryType === 'agent' && input.action === 'synced'
    ? 'memory.agent.synced'
    : input.memoryType === 'global' && input.action === 'updated'
      ? 'memory.global.updated'
      : `memory.${input.memoryType}.${input.action}`;
  getWebDeps()?.broadcastOctoDeckEvent?.(
    createOctoDeckEvent({
      type,
      domain: 'memory',
      action: input.action,
      userId,
      deviceLinkId: input.deviceLinkId,
      correlationId: input.correlationId,
      payload: { userId, ...input },
    }),
    new Set([userId]),
  );
}

const TYPE_RANK: Record<MemorySource['type'], number> = {
  global: 0,
  session: 1,
  agent: 2,
  date: 3,
  conversation: 4,
};

function listMemorySources(user: AuthUser): MemorySource[] {
  ensureLegacyImported(user);
  const records = listCloudMemories(user.id);
  const sources = records.map(cloudRecordToSource);
  sources.sort((a, b) => {
    if (TYPE_RANK[a.type] !== TYPE_RANK[b.type])
      return TYPE_RANK[a.type] - TYPE_RANK[b.type];
    if (a.folder !== b.folder)
      return (a.folder || '').localeCompare(b.folder || '', 'zh-CN');
    return a.path.localeCompare(b.path, 'zh-CN');
  });
  return sources.slice(0, MEMORY_LIST_LIMIT);
}

function buildSearchSnippet(
  content: string,
  index: number,
  keywordLength: number,
): string {
  const start = Math.max(0, index - 36);
  const end = Math.min(content.length, index + keywordLength + 36);
  return content.slice(start, end).replace(/\s+/g, ' ').trim();
}

function searchMemorySources(
  keyword: string,
  user: AuthUser,
  limit = MEMORY_SEARCH_LIMIT,
): MemorySearchHit[] {
  ensureLegacyImported(user);
  const normalizedKeyword = keyword.trim().toLowerCase();
  if (!normalizedKeyword) return [];

  const maxResults = Number.isFinite(limit)
    ? Math.max(1, Math.min(MEMORY_SEARCH_LIMIT, Math.trunc(limit)))
    : MEMORY_SEARCH_LIMIT;

  const records = searchCloudMemory({
    userId: user.id,
    query: keyword,
    limit: maxResults,
  });

  return records.map((record) => {
    const lower = record.content.toLowerCase();
    const firstIndex = lower.indexOf(normalizedKeyword);
    let count = 0;
    let from = 0;
    while (from < lower.length) {
      const idx = lower.indexOf(normalizedKeyword, from);
      if (idx === -1) break;
      count += 1;
      from = idx + normalizedKeyword.length;
    }
    return {
      ...cloudRecordToSource(record),
      hits: count,
      snippet:
        firstIndex >= 0
          ? buildSearchSnippet(record.content, firstIndex, normalizedKeyword.length)
          : '',
    };
  });
}

// --- Routes ---
// All memory routes require authentication (member + admin).

memoryRoutes.get('/sources', authMiddleware, (c) => {
  try {
    const user = c.get('user') as AuthUser;
    return c.json({ sources: listMemorySources(user) });
  } catch (err) {
    logger.error({ err }, 'Failed to list memory sources');
    return c.json({ error: 'Failed to list memory sources' }, 500);
  }
});

memoryRoutes.get('/search', authMiddleware, (c) => {
  const query = c.req.query('q');
  if (!query || !query.trim()) {
    return c.json({ error: 'Missing q' }, 400);
  }
  const limitRaw = Number(c.req.query('limit'));
  const limit = Number.isFinite(limitRaw) ? limitRaw : MEMORY_SEARCH_LIMIT;
  try {
    const user = c.get('user') as AuthUser;
    return c.json({ hits: searchMemorySources(query, user, limit) });
  } catch (err) {
    logger.error({ err }, 'Failed to search memory sources');
    return c.json({ error: 'Failed to search memory sources' }, 500);
  }
});

memoryRoutes.get('/file', authMiddleware, (c) => {
  const filePath = c.req.query('path');
  if (!filePath) return c.json({ error: 'Missing path' }, 400);
  try {
    const user = c.get('user') as AuthUser;
    return c.json(readMemoryFile(filePath, user));
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to read memory file';
    const status = message.includes('not found') ? 404 : 400;
    return c.json({ error: message }, status);
  }
});

memoryRoutes.put('/file', authMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const validation = MemoryFileSchema.safeParse(body);
  if (!validation.success) {
    return c.json(
      { error: 'Invalid request body', details: validation.error.format() },
      400,
    );
  }
  try {
    const user = c.get('user') as AuthUser;
    const ref = resolveAccessibleCloudRef(validation.data.path, user);
    const file = writeMemoryFile(validation.data.path, validation.data.content, user);
    broadcastMemoryUpdate(user.id, {
      memoryType: ref.memoryType,
      scopeKey: ref.scopeKey,
      path: ref.path,
      action: 'updated',
      source: 'web',
    });
    return c.json(file);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to write memory file';
    return c.json({ error: message }, 400);
  }
});

// Legacy /global API — operates on the current user's user-global memory (cloud-backed).
memoryRoutes.get('/global', authMiddleware, (c) => {
  try {
    const user = c.get('user') as AuthUser;
    ensureLegacyImported(user);
    const record = getCloudMemory({
      userId: user.id,
      memoryType: 'global',
      path: 'CLAUDE.md',
    });
    return c.json({
      path: 'cloud://global/global:' + user.id + '/CLAUDE.md',
      content: record?.content ?? '',
      updatedAt: record?.updatedAt ?? null,
      size: record ? Buffer.byteLength(record.content, 'utf-8') : 0,
      writable: true,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to read user global memory');
    return c.json({ error: 'Failed to read global memory' }, 500);
  }
});

memoryRoutes.put('/global', authMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const validation = MemoryGlobalSchema.safeParse(body);
  if (!validation.success) {
    return c.json(
      { error: 'Invalid request body', details: validation.error.format() },
      400,
    );
  }
  if (
    Buffer.byteLength(validation.data.content, 'utf-8') >
    MAX_GLOBAL_MEMORY_LENGTH
  ) {
    return c.json({ error: 'Global memory is too large' }, 400);
  }

  try {
    const user = c.get('user') as AuthUser;
    const record = putCloudMemory({
      userId: user.id,
      memoryType: 'global',
      path: 'CLAUDE.md',
      content: validation.data.content,
      source: 'web',
      updatedBy: user.id,
    });
    broadcastMemoryUpdate(user.id, {
      memoryType: 'global',
      scopeKey: `global:${user.id}`,
      path: 'CLAUDE.md',
      action: 'updated',
      source: 'web',
    });
    return c.json({
      path: 'cloud://global/global:' + user.id + '/CLAUDE.md',
      content: record.content,
      updatedAt: record.updatedAt,
      size: Buffer.byteLength(record.content, 'utf-8'),
      writable: true,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to write global memory';
    logger.error({ err }, 'Failed to write user global memory');
    return c.json({ error: message }, 400);
  }
});

memoryRoutes.post('/client-agent-sync', authMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const {
    deviceLinkId,
    agentId,
    path: memoryPath,
    content,
  } = body as Record<string, unknown>;
  if (
    typeof deviceLinkId !== 'string' ||
    typeof agentId !== 'string' ||
    typeof memoryPath !== 'string' ||
    typeof content !== 'string'
  ) {
    return c.json(
      { error: 'deviceLinkId, agentId, path and content are required' },
      400,
    );
  }
  try {
    const user = c.get('user') as AuthUser;
    const record = syncClientAgentMemory({
      userId: user.id,
      deviceLinkId,
      agentId,
      path: memoryPath,
      content,
      source: 'client_sync',
      updatedBy: deviceLinkId,
    });
    broadcastMemoryUpdate(user.id, {
      memoryType: 'agent',
      scopeKey: `agent:${deviceLinkId}:${agentId}`,
      path: memoryPath,
      action: 'synced',
      deviceLinkId,
      correlationId: agentId,
      source: 'client_sync',
    });
    return c.json({ memory: record });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to sync client agent memory';
    return c.json({ error: message }, 400);
  }
});

export default memoryRoutes;
