// Memory management routes and utilities

import { Hono } from 'hono';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Variables } from '../web-context.js';
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
import { GROUPS_DIR, DATA_DIR } from '../config.js';
import type { AuthUser } from '../types.js';
import {
  appendCloudMemory,
  getCloudMemory,
  importLegacyCloudMemories,
  listCloudMemories,
  putCloudMemory,
  searchCloudMemory,
  syncClientAgentMemory,
  type CloudMemoryRecord,
  type CloudMemoryType,
} from '../memory-store.js';

const memoryRoutes = new Hono<{ Variables: Variables }>();

// --- Constants ---

const USER_GLOBAL_DIR = path.join(GROUPS_DIR, 'user-global');
const MAIN_MEMORY_DIR = path.join(GROUPS_DIR, 'main');
const MAIN_MEMORY_FILE = path.join(MAIN_MEMORY_DIR, 'CLAUDE.md');
const MEMORY_DATA_DIR = path.join(DATA_DIR, 'memory');
const MAX_GLOBAL_MEMORY_LENGTH = 200_000;
const MAX_MEMORY_FILE_LENGTH = 500_000;
const MEMORY_LIST_LIMIT = 500;
const MEMORY_SEARCH_LIMIT = 120;
const MEMORY_SOURCE_EXTENSIONS = new Set([
  '.md',
  '.txt',
  '.json',
  '.jsonl',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
]);

function ownedFoldersForUser(user: AuthUser): string[] {
  const groups = getAllRegisteredGroups();
  const folders = new Set<string>();
  for (const group of Object.values(groups)) {
    if (user.role === 'admin' || group.created_by === user.id) folders.add(group.folder);
  }
  return Array.from(folders);
}

function ensureLegacyImported(user: AuthUser): void {
  importLegacyCloudMemories({ userId: user.id, groupFolders: ownedFoldersForUser(user) });
}

function cloudRecordToSource(record: CloudMemoryRecord): MemorySource {
  const owner = getUserById(record.userId);
  const ownerLabel = owner ? owner.display_name || owner.username : record.userId;
  const type = record.memoryType === 'agent'
    ? 'agent'
    : record.memoryType === 'global'
      ? 'global'
      : record.path.startsWith('memory/')
        ? 'date'
        : 'session';
  const labelPrefix = record.memoryType === 'global'
    ? `${ownerLabel} / 云端全局记忆`
    : record.memoryType === 'agent'
      ? `${record.deviceLinkId || 'client'} / client agent 记忆镜像`
      : `${record.groupFolder || record.scopeKey} / 云端会话记忆`;
  return {
    path: `cloud://${record.memoryType}/${record.scopeKey}/${record.path}`,
    label: `${labelPrefix} / ${record.path}`,
    type,
    writable: record.authority === 'cloud',
    exists: true,
    updatedAt: record.updatedAt,
    size: Buffer.byteLength(record.content, 'utf-8'),
    ownerName: ownerLabel,
    folder: record.groupFolder,
  };
}

function parseCloudPath(cloudPath: string): {
  memoryType: CloudMemoryType;
  scopeKey: string;
  path: string;
  groupFolder?: string;
  deviceLinkId?: string;
  agentId?: string;
} | null {
  if (!cloudPath.startsWith('cloud://')) return null;
  const rest = cloudPath.slice('cloud://'.length);
  const [memoryType, ...parts] = rest.split('/');
  if (memoryType !== 'global' && memoryType !== 'session' && memoryType !== 'agent') return null;
  const scopeKey = parts.shift();
  if (!scopeKey) return null;
  const memoryPath = parts.join('/');
  if (!memoryPath) return null;
  if (memoryType === 'session' && scopeKey.startsWith('session:')) {
    return { memoryType, scopeKey, groupFolder: scopeKey.slice('session:'.length), path: memoryPath };
  }
  if (memoryType === 'agent' && scopeKey.startsWith('agent:')) {
    const [, deviceLinkId, agentId] = scopeKey.split(':');
    return { memoryType, scopeKey, deviceLinkId, agentId, path: memoryPath };
  }
  return { memoryType, scopeKey, path: memoryPath };
}

// --- Utility Functions ---

function isWithinRoot(targetPath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function normalizeRelativePath(input: unknown): string {
  if (typeof input !== 'string') {
    throw new Error('path must be a string');
  }
  const normalized = input.replace(/\\/g, '/').trim().replace(/^\/+/, '');
  if (!normalized || normalized.includes('\0')) {
    throw new Error('Invalid memory path');
  }
  const parts = normalized.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..')) {
    throw new Error('Invalid memory path');
  }
  return normalized;
}

function resolveMemoryPath(
  relativePath: string,
  user: AuthUser,
): {
  absolutePath: string;
  writable: boolean;
} {
  const absolute = path.resolve(process.cwd(), relativePath);
  const inGroups = isWithinRoot(absolute, GROUPS_DIR);
  const inMemoryData = isWithinRoot(absolute, MEMORY_DATA_DIR);
  const writable = inGroups || inMemoryData;

  if (!writable) {
    throw new Error('Memory path out of allowed scope');
  }

  // User ownership check for non-admin
  if (user.role !== 'admin') {
    // user-global/{userId}/... — member can only access their own
    if (isWithinRoot(absolute, USER_GLOBAL_DIR)) {
      const relToUserGlobal = path.relative(USER_GLOBAL_DIR, absolute);
      const ownerUserId = relToUserGlobal.split(path.sep)[0];
      if (ownerUserId !== user.id) {
        throw new Error('Memory path out of allowed scope');
      }
    }
    // data/groups/{folder}/... — check group ownership
    else if (inGroups) {
      const relToGroups = path.relative(GROUPS_DIR, absolute);
      const folder = relToGroups.split(path.sep)[0];
      if (!isUserOwnedFolder(user, folder)) {
        throw new Error('Memory path out of allowed scope');
      }
    }
    // data/memory/{folder}/... — check group ownership
    else if (inMemoryData) {
      const relToMemory = path.relative(MEMORY_DATA_DIR, absolute);
      const folder = relToMemory.split(path.sep)[0];
      if (!isUserOwnedFolder(user, folder)) {
        throw new Error('Memory path out of allowed scope');
      }
    }
  }

  return { absolutePath: absolute, writable };
}

/** Check if a folder belongs to the user (via registered_groups). */
function isUserOwnedFolder(
  user: { id: string; role: string },
  folder: string,
): boolean {
  if (user.role === 'admin') return true;
  if (!folder) return false;
  const groups = getAllRegisteredGroups();
  for (const group of Object.values(groups)) {
    if (group.folder === folder && group.created_by === user.id) {
      return true;
    }
  }
  return false;
}

function classifyMemorySource(
  relativePath: string,
): Pick<MemorySource, 'type' | 'label' | 'ownerName' | 'folder'> {
  const parts = relativePath.split('/');

  // data/groups/user-global/{userId}/...
  if (
    parts[0] === 'data' &&
    parts[1] === 'groups' &&
    parts[2] === 'user-global'
  ) {
    const userId = parts[3] || 'unknown';
    const name = parts.slice(4).join('/') || 'CLAUDE.md';
    const owner = getUserById(userId);
    const ownerLabel = owner ? owner.display_name || owner.username : userId;

    return {
      type: 'global',
      label: `${ownerLabel} / 全局记忆 / ${name}`,
      ownerName: ownerLabel,
    };
  }

  // data/memory/{folder}/...
  if (parts[0] === 'data' && parts[1] === 'memory') {
    const folder = parts[2] || 'unknown';
    const name = parts.slice(3).join('/') || 'memory';
    return {
      type: 'date',
      label: `${folder} / 日期记忆 / ${name}`,
      folder,
    };
  }

  // data/groups/{folder}/conversations/...
  if (
    parts[0] === 'data' &&
    parts[1] === 'groups' &&
    parts.length >= 4 &&
    parts[3] === 'conversations'
  ) {
    const folder = parts[2] || 'unknown';
    const name = parts.slice(4).join('/');
    return {
      type: 'conversation',
      label: `${folder} / 对话归档 / ${name}`,
      folder,
    };
  }

  // data/groups/{folder}/... (session memory)
  if (parts[0] === 'data' && parts[1] === 'groups') {
    const folder = parts[2] || 'unknown';
    const name = parts.slice(3).join('/');
    return {
      type: 'session',
      label: `${folder} / ${name}`,
      folder,
    };
  }

  // Fallback
  return {
    type: 'session',
    label: parts.slice(2).join('/'),
    folder: parts[2] || undefined,
  };
}

function readMemoryFile(
  relativePath: string,
  user: AuthUser,
): MemoryFilePayload {
  const cloudRef = parseCloudPath(relativePath);
  if (cloudRef) {
    ensureLegacyImported(user);
    const record = getCloudMemory({
      userId: user.id,
      memoryType: cloudRef.memoryType,
      groupFolder: cloudRef.groupFolder,
      deviceLinkId: cloudRef.deviceLinkId,
      agentId: cloudRef.agentId,
      path: cloudRef.path,
    });
    if (!record) throw new Error('Memory file not found');
    return {
      path: relativePath,
      content: record.content,
      updatedAt: record.updatedAt,
      size: Buffer.byteLength(record.content, 'utf-8'),
      writable: record.authority === 'cloud',
    };
  }
  const normalized = normalizeRelativePath(relativePath);
  const { absolutePath, writable } = resolveMemoryPath(normalized, user);
  if (!fs.existsSync(absolutePath)) {
    if (!writable) {
      throw new Error('Memory file not found');
    }
    return {
      path: normalized,
      content: '',
      updatedAt: null,
      size: 0,
      writable,
    };
  }
  const content = fs.readFileSync(absolutePath, 'utf-8');
  const stat = fs.statSync(absolutePath);
  return {
    path: normalized,
    content,
    updatedAt: stat.mtime.toISOString(),
    size: Buffer.byteLength(content, 'utf-8'),
    writable,
  };
}

// 记忆路径中禁止写入的系统子目录（CLAUDE.md 除外，它是记忆文件）
const MEMORY_BLOCKED_DIRS = ['logs', '.claude', 'conversations'];

function isBlockedMemoryPath(normalizedPath: string): boolean {
  const parts = normalizedPath.split('/');
  // 路径格式: data/groups/{folder}/{subpath...} 或 data/memory/{folder}/{subpath...}
  // 检查 data/groups/{folder}/ 下的系统子目录
  if (parts[0] === 'data' && parts[1] === 'groups' && parts.length >= 4) {
    const subPath = parts[3];
    if (MEMORY_BLOCKED_DIRS.includes(subPath)) return true;
  }
  return false;
}

function writeMemoryFile(
  relativePath: string,
  content: string,
  user: AuthUser,
): MemoryFilePayload {
  const cloudRef = parseCloudPath(relativePath);
  if (cloudRef) {
    if (cloudRef.memoryType === 'agent') throw new Error('client agent memory is read-only cloud mirror');
    const record = putCloudMemory({
      userId: user.id,
      memoryType: cloudRef.memoryType,
      groupFolder: cloudRef.groupFolder,
      path: cloudRef.path,
      content,
      source: 'web',
      updatedBy: user.id,
    });
    return {
      path: relativePath,
      content: record.content,
      updatedAt: record.updatedAt,
      size: Buffer.byteLength(record.content, 'utf-8'),
      writable: true,
    };
  }
  const normalized = normalizeRelativePath(relativePath);
  const { absolutePath, writable } = resolveMemoryPath(normalized, user);
  if (!writable) {
    throw new Error('Memory file is read-only');
  }
  if (isBlockedMemoryPath(normalized)) {
    throw new Error('Cannot write to system path');
  }
  if (Buffer.byteLength(content, 'utf-8') > MAX_MEMORY_FILE_LENGTH) {
    throw new Error('Memory file is too large');
  }

  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  const tempPath = `${absolutePath}.tmp`;
  fs.writeFileSync(tempPath, content, 'utf-8');
  fs.renameSync(tempPath, absolutePath);

  const stat = fs.statSync(absolutePath);
  return {
    path: normalized,
    content,
    updatedAt: stat.mtime.toISOString(),
    size: Buffer.byteLength(content, 'utf-8'),
    writable,
  };
}

// Directories to skip when scanning group workspaces for memory files
const WALK_SKIP_DIRS = new Set(['logs', '.claude', 'conversations', 'downloads', 'node_modules']);

function walkFiles(
  baseDir: string,
  maxDepth: number,
  limit: number,
  out: string[],
  currentDepth = 0,
): void {
  if (out.length >= limit || currentDepth > maxDepth || !fs.existsSync(baseDir))
    return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= limit) break;
    const fullPath = path.join(baseDir, entry.name);
    if (entry.isDirectory()) {
      if (WALK_SKIP_DIRS.has(entry.name)) continue;
      walkFiles(fullPath, maxDepth, limit, out, currentDepth + 1);
      continue;
    }
    out.push(fullPath);
  }
}

function isMemoryCandidateFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return MEMORY_SOURCE_EXTENSIONS.has(ext);
}

function listMemorySources(user: AuthUser): MemorySource[] {
  ensureLegacyImported(user);
  return listCloudMemories(user.id).map(cloudRecordToSource).slice(0, MEMORY_LIST_LIMIT);

  const files = new Set<string>();
  const isAdmin = user.role === 'admin';
  const groups = getAllRegisteredGroups();
  const accessibleFolders = new Set<string>();

  if (isAdmin) {
    for (const group of Object.values(groups)) {
      accessibleFolders.add(group.folder);
    }
  } else {
    for (const group of Object.values(groups)) {
      if (group.created_by === user.id) {
        accessibleFolders.add(group.folder);
      }
    }
  }

  // 1. User-global memory
  files.add(path.join(USER_GLOBAL_DIR, user.id, 'CLAUDE.md'));

  // 2. Group CLAUDE.md files
  for (const folder of accessibleFolders) {
    files.add(path.join(GROUPS_DIR, folder, 'CLAUDE.md'));
  }

  // 3. Scan group workspace directories (skips system dirs via WALK_SKIP_DIRS)
  for (const folder of accessibleFolders) {
    const folderDir = path.join(GROUPS_DIR, folder);
    const scanned: string[] = [];
    walkFiles(folderDir, 4, MEMORY_LIST_LIMIT, scanned);
    for (const f of scanned) {
      if (isMemoryCandidateFile(f)) files.add(f);
    }
  }

  // 4. Scan data/memory/ (date memory files)
  if (fs.existsSync(MEMORY_DATA_DIR)) {
    const memFolders = fs.readdirSync(MEMORY_DATA_DIR, { withFileTypes: true });
    for (const d of memFolders) {
      if (d.isDirectory() && (isAdmin || accessibleFolders.has(d.name))) {
        const scanned: string[] = [];
        walkFiles(
          path.join(MEMORY_DATA_DIR, d.name),
          4,
          MEMORY_LIST_LIMIT,
          scanned,
        );
        for (const f of scanned) {
          if (isMemoryCandidateFile(f)) files.add(f);
        }
      }
    }
  }

  // 5. Scan conversations/ directories (read-only archives)
  for (const folder of accessibleFolders) {
    const convDir = path.join(GROUPS_DIR, folder, 'conversations');
    if (!fs.existsSync(convDir)) continue;
    try {
      const entries = fs.readdirSync(convDir, { withFileTypes: true });
      for (const entry of entries) {
        if (files.size >= MEMORY_LIST_LIMIT) break;
        if (!entry.isFile()) continue;
        const fullPath = path.join(convDir, entry.name);
        if (isMemoryCandidateFile(fullPath)) files.add(fullPath);
      }
    } catch { /* skip unreadable */ }
  }

  const sources: MemorySource[] = [];
  for (const absolutePath of files) {
    const inGroups = isWithinRoot(absolutePath, GROUPS_DIR);
    const inMemoryData = isWithinRoot(absolutePath, MEMORY_DATA_DIR);
    if (!inGroups && !inMemoryData) continue;

    const relativePath = path
      .relative(process.cwd(), absolutePath)
      .replace(/\\/g, '/');
    const exists = fs.existsSync(absolutePath);
    let updatedAt: string | null = null;
    let size = 0;
    if (exists) {
      const stat = fs.statSync(absolutePath);
      updatedAt = stat.mtime.toISOString();
      size = stat.size;
    }

    const classified = classifyMemorySource(relativePath);
    const writable = classified.type !== 'conversation';
    sources.push({
      path: relativePath,
      writable,
      exists,
      updatedAt,
      size,
      ...classified,
    });
  }

  const typeRank: Record<MemorySource['type'], number> = {
    global: 0,
    session: 1,
    agent: 2,
    date: 3,
    conversation: 4,
  };

  sources.sort((a, b) => {
    if (typeRank[a.type] !== typeRank[b.type])
      return typeRank[a.type] - typeRank[b.type];
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
  return searchCloudMemory({ userId: user.id, query: keyword, limit }).map((record) => {
    const lower = record.content.toLowerCase();
    const normalizedKeyword = keyword.trim().toLowerCase();
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
      snippet: firstIndex >= 0
        ? buildSearchSnippet(record.content, firstIndex, normalizedKeyword.length)
        : '',
    };
  });

  const normalizedKeyword = keyword.trim().toLowerCase();
  if (!normalizedKeyword) return [];

  const maxResults = Number.isFinite(limit)
    ? Math.max(1, Math.min(MEMORY_SEARCH_LIMIT, Math.trunc(limit)))
    : MEMORY_SEARCH_LIMIT;

  const hits: MemorySearchHit[] = [];
  const sources = listMemorySources(user);

  for (const source of sources) {
    if (hits.length >= maxResults) break;
    if (!source.exists || source.size === 0) continue;
    if (source.size > MAX_MEMORY_FILE_LENGTH) continue;

    try {
      const payload = readMemoryFile(source.path, user);
      const lower = payload.content.toLowerCase();
      const firstIndex = lower.indexOf(normalizedKeyword);
      if (firstIndex === -1) continue;

      let count = 0;
      let from = 0;
      while (from < lower.length) {
        const idx = lower.indexOf(normalizedKeyword, from);
        if (idx === -1) break;
        count += 1;
        from = idx + normalizedKeyword.length;
      }

      hits.push({
        ...source,
        hits: count,
        snippet: buildSearchSnippet(
          payload.content,
          firstIndex,
          normalizedKeyword.length,
        ),
      });
    } catch {
      continue;
    }
  }

  return hits;
}

// --- Routes ---
// All memory routes require authentication (member + admin).
// User-level filtering is handled inside each function.

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
    return c.json(
      writeMemoryFile(validation.data.path, validation.data.content, user),
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to write memory file';
    return c.json({ error: message }, 400);
  }
});

// Legacy /global API — now operates on the current user's user-global memory.
memoryRoutes.get('/global', authMiddleware, (c) => {
  try {
    const user = c.get('user') as AuthUser;
    ensureLegacyImported(user);
    const record = getCloudMemory({ userId: user.id, memoryType: 'global', path: 'CLAUDE.md' });
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
  const { deviceLinkId, agentId, path: memoryPath, content } = body as Record<string, unknown>;
  if (typeof deviceLinkId !== 'string' || typeof agentId !== 'string' || typeof memoryPath !== 'string' || typeof content !== 'string') {
    return c.json({ error: 'deviceLinkId, agentId, path and content are required' }, 400);
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
    return c.json({ memory: record });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to sync client agent memory';
    return c.json({ error: message }, 400);
  }
});

export default memoryRoutes;
