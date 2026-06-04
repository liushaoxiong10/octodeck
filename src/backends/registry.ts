/**
 * Backend registry & resolver.
 *
 * 解析顺序（resolveBackend）：
 *   1. group.backend（若已设置且在 allowedBackends 内）
 *   2. SystemSettings.defaultBackend（若已注册且在 allowedBackends 内）
 *   3. 兜底 'claude-sdk'
 *
 * 不在 allowedBackends 白名单内的 backend 会降级到 defaultBackend，并打 warn 日志，
 * 永远不抛错 —— 后端选择是 admin 配置失误时的软失败点，不应让消息流崩溃。
 */
import { logger } from '../logger.js';
import { getSystemSettings } from '../runtime-config.js';
import type { RegisteredGroup } from '../types.js';
import { claudeSdkBackend } from './claude-sdk.js';
import type { AgentBackend } from './types.js';

const FALLBACK_BACKEND_ID = 'claude-sdk';

/** 内置 backend ID — unregisterBackend 永远不会动这些。 */
export const BUILTIN_BACKEND_IDS: ReadonlySet<string> = new Set(['claude-sdk']);

const registry = new Map<string, AgentBackend>();

export function registerBackend(backend: AgentBackend): void {
  if (registry.has(backend.id)) {
    logger.warn(
      { backendId: backend.id },
      'Overriding already-registered agent backend',
    );
  }
  registry.set(backend.id, backend);
}

/** 卸载非内置 backend。返回 true 表示真的删除了。 */
export function unregisterBackend(id: string): boolean {
  if (BUILTIN_BACKEND_IDS.has(id)) {
    logger.warn({ backendId: id }, 'Refusing to unregister builtin backend');
    return false;
  }
  return registry.delete(id);
}

/** 列出当前已注册的所有非内置 backend ID。 */
export function listCustomBackendIds(): string[] {
  const ids: string[] = [];
  for (const id of registry.keys()) {
    if (!BUILTIN_BACKEND_IDS.has(id)) ids.push(id);
  }
  return ids;
}

export function isBuiltinBackend(id: string): boolean {
  return BUILTIN_BACKEND_IDS.has(id);
}

export function getBackend(id: string): AgentBackend | undefined {
  return registry.get(id);
}

export function listBackends(): AgentBackend[] {
  return Array.from(registry.values());
}

// 内置注册：claude-sdk 永远可用，作为兜底
registerBackend(claudeSdkBackend);

/**
 * 选择当前 group 应该使用的 backend 实例。失败时降级，不抛错。
 */
export function resolveBackend(group: RegisteredGroup): AgentBackend {
  const settings = getSystemSettings();
  const allowedSet = new Set(settings.allowedBackends);
  const cloudSdkBackend = registry.get(FALLBACK_BACKEND_ID) ?? claudeSdkBackend;

  // Product runtime profiles are authoritative:
  // - server-agent: cloud SDK loop on server, no local tools
  // - server-agent-device-tools: cloud SDK loop on server, tools routed to Device
  // These profiles must not inherit SystemSettings.defaultBackend; otherwise a
  // default Device CLI/custom backend would move the model loop off the cloud.
  if (
    group.runtimeProfile === 'server-agent' ||
    group.runtimeProfile === 'server-agent-device-tools'
  ) {
    return cloudSdkBackend;
  }

  const fallback =
    registry.get(settings.defaultBackend) ??
    cloudSdkBackend;

  const requestedId = group.backend?.trim();
  if (!requestedId) return fallback;

  if (!allowedSet.has(requestedId)) {
    logger.warn(
      {
        groupFolder: group.folder,
        requested: requestedId,
        fallback: fallback.id,
      },
      'Group backend not in allowedBackends whitelist, falling back',
    );
    return fallback;
  }

  const backend = registry.get(requestedId);
  if (!backend) {
    logger.warn(
      {
        groupFolder: group.folder,
        requested: requestedId,
        fallback: fallback.id,
      },
      'Group backend not registered, falling back',
    );
    return fallback;
  }

  return backend;
}
