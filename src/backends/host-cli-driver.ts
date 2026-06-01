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

import { GROUPS_DIR } from '../config.js';
import { logger } from '../logger.js';
import { getSystemSettings } from '../runtime-config.js';
import type { ContainerOutput } from '../container-runner.js';
import { runViaAgentLink } from './agent-link-driver.js';
import type { BackendRunArgs } from './types.js';

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
}

interface CocoEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  is_error?: boolean;
  delta?: {
    role?: string;
    content?: string;
  };
  message?: {
    role?: string;
    content?: string | Array<{ type?: string; text?: string }>;
  };
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
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
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

export async function runHostCli(
  args: BackendRunArgs,
  cfg: HostCliDriverConfig,
): Promise<ContainerOutput> {
  const { group, input, onProcess, onOutput } = args;

  // Phase 5.2 dispatch: if the group is pinned to a remote agent link, run
  // the same host-CLI logic on the daemon instead of spawning locally.
  const execNode = group.executionNode;
  if (execNode && execNode !== 'server-local' && /^cl_[0-9a-f]{16}$/.test(execNode)) {
    return runViaAgentLink(args, cfg, execNode);
  }

  // 1. 工作目录
  const defaultGroupDir = path.join(GROUPS_DIR, group.folder);
  fs.mkdirSync(defaultGroupDir, { recursive: true });
  let groupDir = group.customCwd || defaultGroupDir;
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
  try {
    argv = cfg.buildArgv({
      prompt: input.prompt,
      sessionId: input.sessionId,
      cwd: groupDir,
      folder: group.folder,
      backendId: cfg.backendId,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: 'error',
      result: `${cfg.backendId} 后端启动失败：构建参数出错：${msg}`,
      error: `${cfg.backendId} buildArgv error: ${msg}`,
    };
  }

  const settings = getSystemSettings();
  const timeoutMs =
    (cfg.timeoutMs && cfg.timeoutMs > 0
      ? cfg.timeoutMs
      : group.containerConfig?.timeout) || settings.containerTimeout;
  const maxOutputBytes =
    (cfg.maxOutputBytes && cfg.maxOutputBytes > 0
      ? cfg.maxOutputBytes
      : 0) || settings.containerMaxOutputSize;

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
      env: { ...process.env, ...(cfg.envOverrides || {}) },
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
            error:
              text ||
              `${cfg.backendId} reported failure (code=${code})`,
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
