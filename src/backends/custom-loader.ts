/**
 * Disk persistence + registry sync for custom CLI backends.
 *
 * 文件位置：data/config/custom-backends.json
 * 格式：{ version: 1, backends: CustomBackendDef[], updatedAt: string }
 *
 * - 启动时调一次 `loadCustomBackendsFromDisk()` 把磁盘上的自定义 backend 注册进 registry
 * - admin 每次 CRUD 后调 `reloadCustomBackends()` 让新条目立即对下一条消息生效
 * - 内置 backend (claude-sdk) 永远不会被这里动
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { getMetadataValue, setMetadataValue } from '../db.js';
import { logger } from '../logger.js';
import { normalizeAgentClientBackendDef } from './agent-client-adapter.js';
import { buildDynamicBackend, type CustomBackendDef } from './dynamic.js';
import {
  BUILTIN_BACKEND_IDS,
  listCustomBackendIds,
  registerBackend,
  unregisterBackend,
} from './registry.js';
import {
  validateArgvTemplate,
  validateBackendEnv,
  validateBinaryPath,
  validateResumeArgvTemplate,
  validateSessionArgvTemplate,
} from './validation.js';

const CUSTOM_BACKENDS_FILE = path.join(
  DATA_DIR,
  'config',
  'custom-backends.json',
);
const CUSTOM_BACKENDS_AUDIT_FILE = path.join(
  DATA_DIR,
  'config',
  'custom-backends.audit.log',
);
const CUSTOM_BACKENDS_METADATA_KEY = 'custom_backends';

interface StoredCustomBackendsFile {
  version: 1;
  backends: CustomBackendDef[];
  updatedAt: string;
}

let cache: Map<string, CustomBackendDef> = new Map();

function ensureConfigDir(): void {
  fs.mkdirSync(path.dirname(CUSTOM_BACKENDS_FILE), { recursive: true });
}

function readFromDisk(): CustomBackendDef[] {
  const stored = getMetadataValue(CUSTOM_BACKENDS_METADATA_KEY);
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as Record<string, unknown>;
      if (parsed.version === 1 && Array.isArray(parsed.backends)) {
        return (parsed.backends as CustomBackendDef[]).filter((b) => {
          if (!b || typeof b.id !== 'string') return false;
          return true;
        });
      }
    } catch (err) {
      logger.warn(
        { err },
        'Failed to parse custom backend metadata store value',
      );
    }
  }
  if (!fs.existsSync(CUSTOM_BACKENDS_FILE)) return [];
  try {
    const raw = fs.readFileSync(CUSTOM_BACKENDS_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.version !== 1 || !Array.isArray(parsed.backends)) {
      logger.warn(
        { file: CUSTOM_BACKENDS_FILE },
        'custom-backends.json malformed, ignoring',
      );
      return [];
    }
    const backends = (parsed.backends as CustomBackendDef[]).filter((b) => {
      if (!b || typeof b.id !== 'string') return false;
      return true;
    });
    setMetadataValue(
      CUSTOM_BACKENDS_METADATA_KEY,
      JSON.stringify({
        version: 1,
        backends,
        updatedAt:
          typeof parsed.updatedAt === 'string'
            ? parsed.updatedAt
            : new Date().toISOString(),
      }),
    );
    return backends;
  } catch (err) {
    logger.error(
      { err, file: CUSTOM_BACKENDS_FILE },
      'Failed to read custom-backends.json',
    );
    return [];
  }
}

function writeToDisk(defs: CustomBackendDef[]): void {
  ensureConfigDir();
  const payload: StoredCustomBackendsFile = {
    version: 1,
    backends: defs,
    updatedAt: new Date().toISOString(),
  };
  setMetadataValue(CUSTOM_BACKENDS_METADATA_KEY, JSON.stringify(payload));
  const tmp = `${CUSTOM_BACKENDS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', {
    mode: 0o600,
  });
  fs.renameSync(tmp, CUSTOM_BACKENDS_FILE);
}

function validateDef(def: CustomBackendDef): string | null {
  if (BUILTIN_BACKEND_IDS.has(def.id)) {
    return `id ${def.id} 与内置 backend 冲突`;
  }
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(def.id)) {
    return `id 非法：${def.id}`;
  }
  if (!def.displayName || def.displayName.length > 64) {
    return 'displayName 必须在 1..64 字符';
  }
  const binCheck = validateBinaryPath(def.binary);
  if (!binCheck.ok) return binCheck.error || 'binary invalid';
  const argvCheck = validateArgvTemplate(def.argvTemplate);
  if (!argvCheck.ok) return argvCheck.error || 'argvTemplate invalid';
  const sessionArgvCheck = validateSessionArgvTemplate(def.sessionArgvTemplate);
  if (!sessionArgvCheck.ok)
    return sessionArgvCheck.error || 'sessionArgvTemplate invalid';
  const resumeArgvCheck = validateResumeArgvTemplate(def.resumeArgvTemplate);
  if (!resumeArgvCheck.ok)
    return resumeArgvCheck.error || 'resumeArgvTemplate invalid';
  const envCheck = validateBackendEnv(def.env);
  if (!envCheck.ok) return envCheck.error || 'env invalid';
  if (
    def.outputProtocol !== 'jsonline-stream-json' &&
    def.outputProtocol !== 'plain-text'
  ) {
    return `outputProtocol 必须是 jsonline-stream-json / plain-text`;
  }
  if (def.supportsContainer) {
    return 'Phase 1 不支持 container 模式';
  }
  if (def.supportsHost === false) {
    return '必须支持 host 模式';
  }
  if (def.deviceLinkId && !/^cl_[0-9a-f]{16}$/.test(def.deviceLinkId)) {
    return `deviceLinkId 非法：${def.deviceLinkId}`;
  }
  if (
    def.runtime &&
    def.runtime !== 'local-device' &&
    def.runtime !== 'server-side'
  ) {
    return `runtime 必须是 local-device / server-side`;
  }
  if (def.runtime === 'local-device') {
    if (!def.deviceLinkId) return 'LocalRuntime 必须选择设备';
    if (!def.agentClientId) return 'LocalRuntime 必须选择 Agent client';
  }
  if (def.runtime === 'server-side' && !def.model) {
    return 'Server Side 必须选择模型端点/模型名称';
  }
  if (def.runtime === 'server-side' && !def.providerId) {
    return 'Server Side 必须选择模型端点';
  }
  if (
    def.workdirMode &&
    def.workdirMode !== 'auto' &&
    def.workdirMode !== 'custom'
  ) {
    return `workdirMode 必须是 auto / custom`;
  }
  if (def.workdirMode === 'custom') {
    if (!def.workdir) return '自定义 Workdir 必填';
    if (!path.isAbsolute(def.workdir)) return 'Workdir 必须是绝对路径';
  }
  return null;
}

function syncRegistry(defs: CustomBackendDef[]): void {
  // 1. 把当前 registry 里所有 custom 的卸了
  for (const id of listCustomBackendIds()) {
    unregisterBackend(id);
  }
  // 2. 把当前 cache 里所有合法 def 注册回去
  for (const def of defs) {
    const err = validateDef(def);
    if (err) {
      logger.warn(
        { id: def.id, err },
        'Skipping invalid custom backend during sync',
      );
      continue;
    }
    try {
      registerBackend(buildDynamicBackend(def));
    } catch (err) {
      logger.error({ err, id: def.id }, 'Failed to register custom backend');
    }
  }
}

export function loadCustomBackendsFromDisk(): void {
  const rawDefs = readFromDisk();
  const defs = rawDefs.map(normalizeAgentClientBackendDef);
  if (JSON.stringify(defs) !== JSON.stringify(rawDefs)) {
    writeToDisk(defs);
  }
  cache = new Map(defs.map((d) => [d.id, d]));
  syncRegistry(defs);
  logger.info({ count: defs.length }, 'Custom backends loaded from disk');
}

export function reloadCustomBackends(): void {
  loadCustomBackendsFromDisk();
}

export function listCustomBackends(): CustomBackendDef[] {
  return Array.from(cache.values()).map((d) => ({ ...d }));
}

export function getCustomBackend(id: string): CustomBackendDef | undefined {
  const def = cache.get(id);
  return def ? { ...def } : undefined;
}

export function upsertCustomBackend(
  def: CustomBackendDef,
  actor: string,
): CustomBackendDef {
  def = normalizeAgentClientBackendDef(def);
  const err = validateDef(def);
  if (err) {
    throw new Error(err);
  }
  const now = new Date().toISOString();
  const existing = cache.get(def.id);
  const stored: CustomBackendDef = {
    ...def,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  cache.set(def.id, stored);
  writeToDisk(Array.from(cache.values()));
  syncRegistry(Array.from(cache.values()));
  appendAudit(actor, existing ? 'update' : 'create', def.id, {
    binary: def.binary,
    runtime: def.runtime ?? null,
    model: def.model ?? null,
    providerId: def.providerId ?? null,
    workdirMode: def.workdirMode ?? null,
    workdir: def.workdir ?? null,
    deviceLinkId: def.deviceLinkId ?? null,
    agentClientId: def.agentClientId ?? null,
    agentMdId: def.agentMdId ?? null,
  });
  return { ...stored };
}

export function deleteCustomBackend(id: string, actor: string): boolean {
  if (BUILTIN_BACKEND_IDS.has(id)) {
    throw new Error('不能删除内置 backend');
  }
  if (!cache.has(id)) return false;
  cache.delete(id);
  writeToDisk(Array.from(cache.values()));
  syncRegistry(Array.from(cache.values()));
  appendAudit(actor, 'delete', id, {});
  return true;
}

function appendAudit(
  actor: string,
  action: 'create' | 'update' | 'delete',
  id: string,
  metadata: Record<string, unknown>,
): void {
  try {
    ensureConfigDir();
    const line =
      JSON.stringify({
        timestamp: new Date().toISOString(),
        actor,
        action,
        id,
        metadata,
      }) + '\n';
    fs.appendFileSync(CUSTOM_BACKENDS_AUDIT_FILE, line, { mode: 0o600 });
  } catch (err) {
    logger.warn({ err }, 'Failed to write custom-backends audit log');
  }
}
