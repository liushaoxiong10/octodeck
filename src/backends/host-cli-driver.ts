/**
 * Generic host-mode CLI driver.
 *
 * 把所有「在 host 上 spawn 一个外部 CLI、按行读 stdout、写 run log、超时 kill」
 * 的样板代码抽到这里。built-in `coco` 与所有自定义 backend 都通过它落地，
 * 避免每个 backend 复制 80% 的代码。
 *
 * 安全要点：
 *   - 永远 `shell: false`，参数走 argv 数组（buildArgv 返回值）
 *   - 工作目录必须是绝对路径并在 host 上真实存在
 *   - timeout / maxOutputBytes 缺省时复用 SystemSettings 的全局值
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from '../config.js';
import { logger } from '../logger.js';
import {
  LONG_RUNNING_LOCAL_CLI_TIMEOUT_MS,
  getSystemSettings,
} from '../runtime-config.js';
import type { ContainerOutput } from '../container-runner.js';
import type { StreamEvent } from '../stream-event.types.js';
import { runViaAgentLink } from './agent-link-driver.js';
import type { BackendRunArgs } from './types.js';
import {
  shouldDisableAgentTeamMcp,
  stripAgentTeamMcpConfigArgs,
} from './validation.js';

export type OutputProtocol = 'jsonline-stream-json' | 'plain-text';

export interface HostCliPlaceholderCtx {
  prompt: string;
  sessionId?: string;
  cwd: string;
  folder: string;
  backendId: string;
}

export interface HostCliDriverConfig {
  /** 仅用于日志/processId。 */
  backendId: string;
  /** 解析二进制路径；返回 null/undefined 时 driver 直接报错退出。 */
  resolveBinary: () => string | null | undefined;
  /** 解析远端执行二进制路径；不做服务端文件存在性校验。 */
  resolveRemoteBinary?: () => string | null | undefined;
  /** 由 placeholder 上下文生成 argv。每项都不会再被 shell 解析。 */
  buildArgv: (ctx: HostCliPlaceholderCtx) => string[];
  /** stdout 解析协议。 */
  outputProtocol: OutputProtocol;
  /** 自定义超时（毫秒），<=0/未设走 SystemSettings.containerTimeout。 */
  timeoutMs?: number;
  /** stdout/stderr 累积上限（字节），<=0/未设走 SystemSettings.containerMaxOutputSize。 */
  maxOutputBytes?: number;
  /** 额外 env，键值会覆盖 process.env 的同名项。 */
  envOverrides?: Record<string, string>;
  runtime?: 'local-device' | 'server-side';
  model?: string;
  workdirMode?: 'auto' | 'custom';
  workdir?: string;
}

function safePathSegment(value: string | undefined, fallback: string): string {
  const cleaned = (value || '').replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 96);
  return cleaned || fallback;
}

function resolveServerSideInternalCwd(args: BackendRunArgs, cfg: HostCliDriverConfig): string {
  const { input, group } = args;
  const scope = input.isScheduledTask
    ? 'tasks'
    : input.sessionId
      ? 'sessions'
      : 'workspaces';
  const scopeId = input.taskRunId || input.messageTaskId || input.sessionId || group.folder;
  return path.join(
    DATA_DIR,
    'runtime',
    'server-side',
    safePathSegment(cfg.backendId, 'backend'),
    scope,
    safePathSegment(scopeId, 'run'),
  );
}

interface CocoEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  is_error?: boolean;
  name?: string;
  id?: string;
  tool_use_id?: string;
  input?: unknown;
  content?: unknown;
  delta?: {
    role?: string;
    content?: string;
  };
  message?: {
    role?: string;
    content?: string | Array<Record<string, unknown>>;
  };
}

function compactJson(value: unknown, max = 2000): string | null {
  if (value === undefined || value === null) return null;
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function summarizeToolInput(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return compactJson(input, 240) ?? undefined;
  const record = input as Record<string, unknown>;
  for (const key of ['description', 'command', 'file_path', 'path', 'pattern', 'query', 'url', 'prompt']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return `${key}: ${value.slice(0, 220)}`;
  }
  return compactJson(record, 240) ?? undefined;
}

function firstContentBlock(evt: CocoEvent, type: string): Record<string, unknown> | null {
  const content = evt.message?.content;
  if (!Array.isArray(content)) return null;
  return content.find((block) => block?.type === type) ?? null;
}

function streamEventFromCocoEvent(evt: CocoEvent): StreamEvent | null {
  const sessionId = evt.session_id;
  const toolUseBlock = firstContentBlock(evt, 'tool_use');
  const toolResultBlock = firstContentBlock(evt, 'tool_result');
  if (evt.type === 'tool_use' || evt.type === 'tool_call' || toolUseBlock) {
    const source = toolUseBlock ?? (evt as unknown as Record<string, unknown>);
    const input = source.input;
    const toolInput = input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : undefined;
    return {
      eventType: 'tool_use_start',
      sessionId,
      toolName: typeof source.name === 'string' ? source.name : 'unknown',
      toolUseId: typeof source.id === 'string' ? source.id : typeof source.tool_use_id === 'string' ? source.tool_use_id : undefined,
      toolInputSummary: summarizeToolInput(input),
      toolInput,
      detail: compactJson(input) ?? undefined,
      rawEvent: evt as unknown as Record<string, unknown>,
    };
  }
  if (evt.type === 'tool_result' || toolResultBlock) {
    const source = toolResultBlock ?? (evt as unknown as Record<string, unknown>);
    const content = source.content ?? source.result ?? source.text;
    const isError = Boolean(source.is_error ?? evt.is_error);
    return {
      eventType: 'tool_use_end',
      sessionId,
      toolUseId: typeof source.tool_use_id === 'string' ? source.tool_use_id : typeof source.id === 'string' ? source.id : undefined,
      statusText: isError ? 'error' : 'completed',
      summary: isError ? 'Tool returned error' : 'Tool response received',
      detail: compactJson(content) ?? undefined,
      rawEvent: evt as unknown as Record<string, unknown>,
    };
  }
  return null;
}

function extractAssistantText(evt: CocoEvent): string | null {
  if (
    evt.type === 'stream_event' &&
    evt.delta?.role === 'assistant' &&
    typeof evt.delta.content === 'string'
  ) {
    return evt.delta.content;
  }
  if (evt.type !== 'assistant') return null;
  const content = evt.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = content
      .filter(
        (block) => block?.type === 'text' && typeof block.text === 'string',
      )
      .map((block) => block.text)
      .join('');
    return text || null;
  }
  return null;
}

function parseEvent(line: string): CocoEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as CocoEvent;
  } catch {
    return null;
  }
}

interface ParseState {
  finalResultText: string | null;
  finalIsError: boolean;
  lastSessionId?: string;
  lastAssistantText: string | null;
}

function buildRunContext(
  args: BackendRunArgs,
  cfg: HostCliDriverConfig,
  cwd: string,
): Record<string, unknown> {
  const { group, input, executionMode } = args;
  const repo = buildRepoContext(group, cwd);
  return {
    backendId: cfg.backendId,
    executionMode,
    input,
    cwd,
    ...(repo ? { repo } : {}),
    group: {
      name: group.name,
      folder: group.folder,
      backend: group.backend,
      executionMode: group.executionMode,
      executionNode: group.executionNode,
      customCwd: group.customCwd,
      repoId: group.repoId,
      repoGitUrl: group.repoGitUrl,
      repoDevicePath: group.repoDevicePath,
      created_by: group.created_by,
      is_home: group.is_home,
    },
  };
}

function buildRepoContext(
  group: BackendRunArgs['group'],
  cwd: string,
): Record<string, unknown> | null {
  if (!group.repoId && !group.repoGitUrl && !group.repoDevicePath) {
    return null;
  }
  return {
    id: group.repoId,
    gitUrl: group.repoGitUrl,
    devicePath: group.repoDevicePath,
    kind: group.repoGitUrl
      ? 'git'
      : group.repoDevicePath
        ? 'device_path'
        : undefined,
    cwd,
  };
}

function buildAgentEnv(
  baseEnv: NodeJS.ProcessEnv,
  overrides: Record<string, string> | undefined,
  runContext: Record<string, unknown>,
): NodeJS.ProcessEnv {
  const repo = runContext.repo;
  return {
    ...baseEnv,
    ...(overrides || {}),
    OCTODECK_RUN_CONTEXT_JSON: JSON.stringify(runContext),
    ...(repo ? { OCTODECK_REPO_CONTEXT_JSON: JSON.stringify(repo) } : {}),
  };
}

export async function runHostCli(
  args: BackendRunArgs,
  cfg: HostCliDriverConfig,
): Promise<ContainerOutput> {
  const { group, input, onProcess, onOutput } = args;

  // Phase 5.2 dispatch: if the group is pinned to a remote agent link, run
  // the same host-CLI logic on the daemon instead of spawning locally.
  const execNode = group.executionNode;
  if (
    execNode &&
    execNode !== 'server-local' &&
    (/^cl_[0-9a-f]{16}$/.test(execNode) ||
      /^runtime:cl_[0-9a-f]{16}:[^:]+$/.test(execNode) ||
      /^cl_[0-9a-f]{16}:[^:]+$/.test(execNode) ||
      /^provider:[^:]+$/.test(execNode))
  ) {
    return runViaAgentLink(args, cfg, execNode);
  }

  // 1. 工作目录。纯 server-side backend 不暴露业务 Workdir；这里只使用
  // data/runtime/server-side 下的内部运行目录承载 CLI cwd / 临时文件。
  const defaultGroupDir = path.join(GROUPS_DIR, group.folder);
  fs.mkdirSync(defaultGroupDir, { recursive: true });
  let groupDir =
    cfg.runtime === 'server-side' && !group.customCwd
      ? resolveServerSideInternalCwd(args, cfg)
      : group.customCwd || defaultGroupDir;
  fs.mkdirSync(groupDir, { recursive: true });
  if (!path.isAbsolute(groupDir)) {
    return {
      status: 'error',
      result: `${cfg.backendId} 后端启动失败：工作目录必须是绝对路径：${groupDir}`,
      error: `non-absolute cwd: ${groupDir}`,
    };
  }
  try {
    groupDir = fs.realpathSync(groupDir);
  } catch {
    return {
      status: 'error',
      result: `${cfg.backendId} 后端启动失败：工作目录不存在：${groupDir}`,
      error: `cwd not found: ${groupDir}`,
    };
  }

  const logsDir = path.join(defaultGroupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  // 2. binary
  const binary = cfg.resolveBinary();
  if (!binary) {
    return {
      status: 'error',
      result: `${cfg.backendId} 后端启动失败：未找到可执行文件`,
      error: `${cfg.backendId} binary not found`,
    };
  }

  // 3. argv
  let argv: string[];
  const runContext = buildRunContext(args, cfg, groupDir);
  try {
    argv = cfg.buildArgv({
      prompt: input.prompt,
      sessionId: input.sessionId,
      cwd: groupDir,
      folder: group.folder,
      backendId: cfg.backendId,
    });
    if (shouldDisableAgentTeamMcp(input, group.folder)) {
      argv = stripAgentTeamMcpConfigArgs(argv);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: 'error',
      result: `${cfg.backendId} 后端启动失败：构建参数出错：${msg}`,
      error: `${cfg.backendId} buildArgv error: ${msg}`,
    };
  }

  const settings = getSystemSettings();
  const configuredTimeoutMs =
    group.containerConfig?.timeout && group.containerConfig.timeout > 0
      ? group.containerConfig.timeout
      : cfg.timeoutMs && cfg.timeoutMs > 0
        ? cfg.timeoutMs
        : undefined;
  const timeoutMs =
    configuredTimeoutMs ||
    (input.isScheduledTask
      ? Math.max(settings.containerTimeout, LONG_RUNNING_LOCAL_CLI_TIMEOUT_MS)
      : settings.containerTimeout);
  const maxOutputBytes =
    (cfg.maxOutputBytes && cfg.maxOutputBytes > 0 ? cfg.maxOutputBytes : 0) ||
    settings.containerMaxOutputSize;

  const startTime = Date.now();

  return new Promise<ContainerOutput>((resolve) => {
    let settled = false;
    const resolveOnce = (out: ContainerOutput): void => {
      if (settled) return;
      settled = true;
      resolve(out);
    };

    const proc = spawn(binary, argv, {
      cwd: groupDir,
      env: buildAgentEnv(process.env, cfg.envOverrides, runContext),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });

    const processId = `${cfg.backendId}-${group.folder}-${Date.now()}`;
    onProcess(proc, processId, null);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      logger.error(
        { group: group.name, processId },
        `${cfg.backendId} timeout, killing`,
      );
      try {
        proc.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }, timeoutMs);

    let buf = '';
    let stdoutAccum = '';
    let stderrAccum = '';
    const state: ParseState = {
      finalResultText: null,
      finalIsError: false,
      lastSessionId: undefined,
      lastAssistantText: null,
    };

    const emitWrapped = async (output: ContainerOutput): Promise<void> => {
      if (!onOutput) return;
      try {
        await onOutput(output);
      } catch (err) {
        logger.error(
          { group: group.name, err },
          `${cfg.backendId} onOutput callback failed`,
        );
      }
    };

    proc.stdout.on('data', (data: Buffer) => {
      const chunk = data.toString();
      if (stdoutAccum.length < maxOutputBytes) {
        stdoutAccum += chunk.slice(0, maxOutputBytes - stdoutAccum.length);
      }

      if (cfg.outputProtocol === 'jsonline-stream-json') {
        buf += chunk;
        let nl = buf.indexOf('\n');
        while (nl !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          const evt = parseEvent(line);
          if (evt) {
            if (evt.session_id) state.lastSessionId = evt.session_id;
            const structuredEvent = streamEventFromCocoEvent(evt);
            if (structuredEvent) {
              void emitWrapped({
                status: 'stream',
                result: null,
                newSessionId: state.lastSessionId,
                streamEvent: structuredEvent,
              });
            }
            const assistantText = extractAssistantText(evt);
            if (assistantText) {
              state.lastAssistantText = `${state.lastAssistantText ?? ''}${assistantText}`;
              void emitWrapped({
                status: 'stream',
                result: null,
                newSessionId: state.lastSessionId,
                streamEvent: {
                  eventType: 'text_delta',
                  text: assistantText,
                  sessionId: state.lastSessionId,
                },
              });
            }
            if (evt.type === 'result') {
              if (typeof evt.result === 'string') {
                state.finalResultText = evt.result;
              }
              state.finalIsError = !!evt.is_error;
            }
          }
          nl = buf.indexOf('\n');
        }
      }
      // plain-text: 全部 stdout 当 result，最后再 finalize
    });

    proc.stderr.on('data', (data: Buffer) => {
      const s = data.toString();
      if (stderrAccum.length < 20000) {
        stderrAccum += s.slice(0, 20000 - stderrAccum.length);
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      logger.error(
        { group: group.name, processId, err },
        `${cfg.backendId} spawn error`,
      );
      resolveOnce({
        status: 'error',
        result: null,
        error: `${cfg.backendId} spawn error: ${err.message}`,
      });
    });

    proc.on('close', async (code, signal) => {
      clearTimeout(timer);
      const duration = Date.now() - startTime;

      // Persist run log
      try {
        const ts = new Date(startTime).toISOString().replace(/[:.]/g, '-');
        const logFile = path.join(logsDir, `${cfg.backendId}-${ts}.log`);
        fs.writeFileSync(
          logFile,
          [
            `=== ${cfg.backendId} run ${processId} ===`,
            `Group: ${group.name} (${group.folder})`,
            `Cwd: ${groupDir}`,
            `Args: ${argv.join(' ')}`,
            `Exit: code=${code} signal=${signal} duration=${duration}ms timedOut=${timedOut}`,
            ``,
            `=== STDOUT ===`,
            stdoutAccum,
            ``,
            `=== STDERR ===`,
            stderrAccum,
          ].join('\n'),
          { mode: 0o600 },
        );
      } catch (err) {
        logger.warn(
          { group: group.name, err },
          `${cfg.backendId} failed to write run log`,
        );
      }

      if (timedOut) {
        const out: ContainerOutput = {
          status: 'error',
          result: `${cfg.backendId} 执行超时（${Math.round(timeoutMs / 1000)}s）`,
          error: `${cfg.backendId} timeout after ${timeoutMs}ms`,
          newSessionId: state.lastSessionId,
        };
        await emitWrapped(out);
        resolveOnce(out);
        return;
      }

      if (
        code !== 0 &&
        state.finalResultText === null &&
        cfg.outputProtocol !== 'plain-text'
      ) {
        const tail = stderrAccum.slice(-400) || stdoutAccum.slice(-400);
        const out: ContainerOutput = {
          status: 'error',
          result: `${cfg.backendId} 进程退出 code=${code}`,
          error: `${cfg.backendId} exit code=${code} signal=${signal}: ${tail}`,
          newSessionId: state.lastSessionId,
        };
        await emitWrapped(out);
        resolveOnce(out);
        return;
      }

      // Finalize text
      let text: string;
      let isErr: boolean;
      if (cfg.outputProtocol === 'plain-text') {
        text = stdoutAccum.trimEnd();
        isErr = code !== 0;
        if (isErr && !text) {
          text = `${cfg.backendId} 进程退出 code=${code}`;
        }
      } else {
        text = state.finalResultText ?? state.lastAssistantText ?? '';
        isErr = state.finalIsError;
      }

      const out: ContainerOutput = isErr
        ? {
            status: 'error',
            result: text || `${cfg.backendId} 返回错误`,
            error: text || `${cfg.backendId} reported failure (code=${code})`,
            newSessionId: state.lastSessionId,
          }
        : {
            status: 'success',
            result: text,
            newSessionId: state.lastSessionId,
          };
      await emitWrapped(out);
      resolveOnce(out);
    });
  });
}
