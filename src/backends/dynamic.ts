/**
 * Dynamic backend builder — 把 admin 在 UI 配置的 CustomBackendDef 翻译成
 * 一个可以注册进 registry 的 AgentBackend 实例。
 *
 * 自定义 backend 一律走 host-cli-driver；Phase 4 不开 container 模式。
 */
import fs from 'fs';

import type { ExecutionMode } from '../types.js';
import { resolveProviderById } from '../runtime-config.js';
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
  /** Native CLI session resume support. When true, OctoDeck skips prompt history injection. */
  supportsNativeSessions?: boolean;
  /** Extra argv rendered and appended only when input.sessionId is present. */
  sessionArgvTemplate?: string[];
  /** Full argv rendered instead of argvTemplate when input.sessionId is present. */
  resumeArgvTemplate?: string[];
  workdirMode?: 'auto' | 'custom';
  workdir?: string;
  /** Server-side model endpoint selected for this Agent. */
  providerId?: string | null;
  /** Optional device id. When set, this backend runs on the selected octodeck-daemon device. */
  deviceLinkId?: string | null;
  /** Agent client discovered by octodeck-daemon on the selected device. */
  agentClientId?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

function providerEnv(providerId: string | null | undefined): Record<string, string> | undefined {
  if (!providerId) return undefined;
  const { config, customEnv } = resolveProviderById(providerId);
  const env: Record<string, string> = { ...customEnv };
  if (config.anthropicBaseUrl) env.ANTHROPIC_BASE_URL = config.anthropicBaseUrl;
  if (config.anthropicApiKey) env.ANTHROPIC_API_KEY = config.anthropicApiKey;
  if (config.claudeCodeOauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = config.claudeCodeOauthToken;
  if (config.anthropicAuthToken) {
    if (config.apiType && config.apiType !== 'claude') {
      env.ANTHROPIC_API_KEY = config.anthropicAuthToken;
      delete env.ANTHROPIC_AUTH_TOKEN;
    } else {
      env.ANTHROPIC_AUTH_TOKEN = config.anthropicAuthToken;
    }
  }
  return env;
}

function makeResolveBinary(binary: string): () => string | null {
  return () => {
    if (binary.startsWith('/')) {
      try {
        if (fs.existsSync(binary) && fs.statSync(binary).isFile()) {
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
  const env = { ...(providerEnv(def.providerId) ?? {}), ...(def.env ?? {}) };

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
        resolveRemoteBinary: () => def.binary,
        buildArgv: (ctx) => {
          if (
            def.supportsNativeSessions === true &&
            ctx.sessionId &&
            resumeArgvTemplate?.length
          ) {
            return renderArgv(resumeArgvTemplate, { ...ctx, model: def.model });
          }
          const rendered = renderArgv(argvTemplate, {
            ...ctx,
            model: def.model,
          });
          if (
            def.supportsNativeSessions === true &&
            ctx.sessionId &&
            sessionArgvTemplate?.length
          ) {
            rendered.push(
              ...renderArgv(sessionArgvTemplate, { ...ctx, model: def.model }),
            );
          }
          return rendered;
        },
        outputProtocol: def.outputProtocol,
        timeoutMs: def.timeoutMs,
        maxOutputBytes: def.maxOutputBytes,
        envOverrides: Object.keys(env).length > 0 ? env : undefined,
        runtime: def.runtime,
        model: def.model,
        workdirMode: def.workdirMode,
        workdir: def.workdir,
      };
      const configuredDeviceLinkId = def.deviceLinkId?.trim();
      const groupDeviceLinkId =
        args.group.executionNode && args.group.executionNode !== 'server-local'
          ? args.group.executionNode
          : undefined;
      const deviceLinkId = groupDeviceLinkId || configuredDeviceLinkId;
      const runtime =
        def.runtime ?? (deviceLinkId ? 'local-device' : 'server-side');
      const runArgs =
        def.workdirMode === 'custom' && def.workdir
          ? { ...args, group: { ...args.group, customCwd: def.workdir } }
          : args;
      if (runtime === 'local-device' && deviceLinkId)
        return runViaAgentLink(runArgs, cfg, deviceLinkId);
      const hostArgs =
        runtime === 'server-side'
          ? {
              ...runArgs,
              group: { ...runArgs.group, executionNode: 'server-local' },
            }
          : runArgs;
      return runHostCli(hostArgs, cfg);
    },
  };
}
