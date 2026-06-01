/**
 * Dynamic backend builder — 把 admin 在 UI 配置的 CustomBackendDef 翻译成
 * 一个可以注册进 registry 的 AgentBackend 实例。
 *
 * 自定义 backend 一律走 host-cli-driver；Phase 4 不开 container 模式。
 */
import fs from 'fs';

import type { ExecutionMode } from '../types.js';
import { runViaAgentLink } from './agent-link-driver.js';
import { runHostCli } from './host-cli-driver.js';
import type { HostCliDriverConfig } from './host-cli-driver.js';
import type { AgentBackend } from './types.js';
import { renderArgv } from './validation.js';

export interface CustomBackendDef {
  id: string;
  displayName: string;
  binary: string;
  argvTemplate: string[];
  outputProtocol: 'jsonline-stream-json' | 'plain-text';
  /** Phase 1 强制 true。 */
  supportsHost: boolean;
  /** Phase 1 强制 false。 */
  supportsContainer: boolean;
  usesProviderPool: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: Record<string, string>;
  runtime?: 'local-device' | 'server-side';
  model?: string;
  /** Native CLI session resume support. When true, HappyClaw skips prompt history injection. */
  supportsNativeSessions?: boolean;
  /** Extra argv rendered and appended only when input.sessionId is present. */
  sessionArgvTemplate?: string[];
  /** Full argv rendered instead of argvTemplate when input.sessionId is present. */
  resumeArgvTemplate?: string[];
  workdirMode?: 'auto' | 'custom';
  workdir?: string;
  /** Optional device id. When set, this backend runs on the selected hcagent device. */
  deviceLinkId?: string | null;
  /** Agent client discovered by hcagent on the selected device. */
  agentClientId?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

function makeResolveBinary(binary: string): () => string | null {
  return () => {
    if (binary.startsWith('/')) {
      try {
        if (
          fs.existsSync(binary) &&
          fs.statSync(binary).isFile()
        ) {
          return binary;
        }
      } catch {
        /* ignore */
      }
      // 绝对路径但文件不存在 → null，driver 会报 binary not found
      return null;
    }
    // 纯命令名 → PATH lookup 由 spawn 兜底
    return binary;
  };
}

export function buildDynamicBackend(def: CustomBackendDef): AgentBackend {
  const resolveBinary = makeResolveBinary(def.binary);
  const argvTemplate = def.argvTemplate.slice();
  const sessionArgvTemplate = def.sessionArgvTemplate?.slice();
  const resumeArgvTemplate = def.resumeArgvTemplate?.slice();
  const env = def.env ? { ...def.env } : undefined;

  return {
    id: def.id,
    displayName: def.displayName || def.id,
    usesProviderPool: !!def.usesProviderPool,
    supportsNativeSessions: def.supportsNativeSessions === true,

    supportsExecutionMode(mode: ExecutionMode): boolean {
      if (mode === 'host') return def.supportsHost !== false;
      if (mode === 'container') return def.supportsContainer === true;
      return false;
    },

    run: (args) => {
      const cfg: HostCliDriverConfig = {
        backendId: def.id,
        resolveBinary,
        buildArgv: (ctx) => {
          if (def.supportsNativeSessions === true && ctx.sessionId && resumeArgvTemplate?.length) {
            return renderArgv(resumeArgvTemplate, { ...ctx, model: def.model });
          }
          const rendered = renderArgv(argvTemplate, { ...ctx, model: def.model });
          if (def.supportsNativeSessions === true && ctx.sessionId && sessionArgvTemplate?.length) {
            rendered.push(
              ...renderArgv(sessionArgvTemplate, { ...ctx, model: def.model }),
            );
          }
          return rendered;
        },
        outputProtocol: def.outputProtocol,
        timeoutMs: def.timeoutMs,
        maxOutputBytes: def.maxOutputBytes,
        envOverrides: env,
      };
      const deviceLinkId = def.deviceLinkId?.trim();
      const runtime = def.runtime ?? (deviceLinkId ? 'local-device' : 'server-side');
      const runArgs =
        (def.workdirMode === 'custom' && def.workdir) || runtime === 'server-side'
          ? {
              ...args,
              group: {
                ...args.group,
                ...(def.workdirMode === 'custom' && def.workdir
                  ? { customCwd: def.workdir }
                  : {}),
                ...(runtime === 'server-side'
                  ? { executionNode: 'server-local' }
                  : {}),
              },
            }
          : args;
      if (deviceLinkId && runtime === 'local-device') return runViaAgentLink(runArgs, cfg, deviceLinkId);
      return runHostCli(runArgs, cfg);
    },
  };
}
