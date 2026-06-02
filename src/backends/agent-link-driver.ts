/**
 * Agent-link driver — Phase 5.2.
 *
 * Mirror of host-cli-driver, but instead of `child_process.spawn` we ship the
 * `run.request` frame to a remote octodeck-daemon via the AgentLink ws session and
 * route incoming `run.event` / `run.result` frames back through the same
 * parsing/finalizing pipeline that host-cli-driver uses.
 *
 * Reuses host-cli-driver's parser by feeding it the same stdout text byte-by-
 * byte; the only behavior diff vs local spawn:
 *   - cwd validation runs *server-side* (we still need an absolute, existing
 *     dir for run logs); the remote daemon may reject if its filesystem is
 *     different — surfaced via run.result(exitCode != 0)
 *   - onProcess receives a fake ChildProcess-like shim whose .kill() sends
 *     run.cancel
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';

import { GROUPS_DIR } from '../config.js';
import { logger } from '../logger.js';
import { LONG_RUNNING_LOCAL_CLI_TIMEOUT_MS, getSystemSettings } from '../runtime-config.js';
import type { ContainerOutput } from '../container-runner.js';
import { getSession } from '../agent-link/registry.js';
import {
  registerRun,
  unregisterRun,
  type RunController,
} from '../agent-link/run-rpc.js';
import type { BackendRunArgs } from './types.js';
import type { HostCliDriverConfig } from './host-cli-driver.js';
import { shouldDisableAgentTeamMcp, stripAgentTeamMcpConfigArgs } from './validation.js';

interface CocoEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  is_error?: boolean;
  delta?: { role?: string; content?: string };
  message?: { role?: string; content?: string | Array<{ type?: string; text?: string }> };
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

const REMOTE_CWD_PLACEHOLDER = '__OCTODECK_REMOTE_CWD__';

function newRunId(): string {
  return crypto.randomUUID();
}

function buildRunContext(args: BackendRunArgs, cfg: HostCliDriverConfig): Record<string, unknown> {
  const { group, input, executionMode } = args;
  return {
    backendId: cfg.backendId,
    executionMode,
    input,
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

function buildWorkspaceRepo(group: BackendRunArgs['group']):
  | { kind: 'git'; gitUrl: string; groupFolder: string }
  | { kind: 'device_path'; devicePath: string; groupFolder: string }
  | undefined {
  if (group.repoGitUrl) {
    return { kind: 'git', gitUrl: group.repoGitUrl, groupFolder: group.folder };
  }
  if (group.repoDevicePath) {
    return { kind: 'device_path', devicePath: group.repoDevicePath, groupFolder: group.folder };
  }
  return undefined;
}

/**
 * Run a host-mode CLI on a remote octodeck-daemon and return a ContainerOutput.
 * Returns a synthetic `not online` error result if the link isn't connected,
 * letting the caller decide whether to fall back to server-local.
 */
export async function runViaAgentLink(
  args: BackendRunArgs,
  cfg: HostCliDriverConfig,
  linkId: string,
): Promise<ContainerOutput> {
  const { group, input, onProcess, onOutput } = args;

  const session = getSession(linkId);
  if (!session || session.state !== 'open') {
    return {
      status: 'error',
      result: `Agent Link ${linkId} 离线`,
      error: `agent-link ${linkId} not online`,
    };
  }

  // 1. Server-side cwd: keep run logs locally; remote daemon will resolve its
  //    own cwd from this path. Only enforce absolute + existence on server.
  const defaultGroupDir = path.join(GROUPS_DIR, group.folder);
  fs.mkdirSync(defaultGroupDir, { recursive: true });
  const groupDir = group.customCwd || defaultGroupDir;
  if (!path.isAbsolute(groupDir)) {
    return {
      status: 'error',
      result: `${cfg.backendId} 后端启动失败：工作目录必须是绝对路径：${groupDir}`,
      error: `non-absolute cwd: ${groupDir}`,
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

  const workspaceRepo = buildWorkspaceRepo(group);

  // 3. argv
  let argv: string[];
  try {
    argv = cfg.buildArgv({
      prompt: input.prompt,
      sessionId: input.sessionId,
      cwd: workspaceRepo ? REMOTE_CWD_PLACEHOLDER : groupDir,
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
  const timeoutMs = configuredTimeoutMs || (input.isScheduledTask
    ? Math.max(settings.containerTimeout, LONG_RUNNING_LOCAL_CLI_TIMEOUT_MS)
    : settings.containerTimeout);
  const maxOutputBytes =
    (cfg.maxOutputBytes && cfg.maxOutputBytes > 0
      ? cfg.maxOutputBytes
      : 0) || settings.containerMaxOutputSize;

  const startTime = Date.now();
  const runId = newRunId();
  const processId = `${cfg.backendId}-${group.folder}-${linkId}-${startTime}`;

  return new Promise<ContainerOutput>((resolve) => {
    let settled = false;
    const resolveOnce = (out: ContainerOutput): void => {
      if (settled) return;
      settled = true;
      unregisterRun(runId);
      resolve(out);
    };

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
          `${cfg.backendId} onOutput callback failed (agent-link)`,
        );
      }
    };

    const fakeProc = new EventEmitter() as ChildProcess & EventEmitter;
    Object.assign(fakeProc, {
      pid: undefined,
      stdin: null,
      stdout: null,
      stderr: null,
      stdio: [null, null, null] as unknown as ChildProcess['stdio'],
      killed: false,
      kill: (_signal?: NodeJS.Signals | number): boolean => {
        const s = getSession(linkId);
        if (s && s.state === 'open') {
          s.send({ type: 'run.cancel', runId, reason: 'user_abort' });
        }
        return true;
      },
    });

    onProcess(fakeProc, processId, null);

    const handleStdoutChunk = (chunk: string): void => {
      if (stdoutAccum.length < maxOutputBytes) {
        stdoutAccum += chunk.slice(0, maxOutputBytes - stdoutAccum.length);
      }
      if (cfg.outputProtocol !== 'jsonline-stream-json') return;
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
    };

    const finalize = async (
      info:
        | { kind: 'result'; exitCode: number | null; signal: string | null; timedOut: boolean; durationMs: number }
        | { kind: 'fail'; reason: string },
    ): Promise<void> => {
      // Persist run log
      try {
        const ts = new Date(startTime).toISOString().replace(/[:.]/g, '-');
        const logFile = path.join(logsDir, `${cfg.backendId}-${ts}.log`);
        fs.writeFileSync(
          logFile,
          [
            `=== ${cfg.backendId} run ${processId} (via agent-link ${linkId}) ===`,
            `Group: ${group.name} (${group.folder})`,
            `Cwd: ${groupDir}`,
            `Args: ${argv.join(' ')}`,
            info.kind === 'result'
              ? `Exit: code=${info.exitCode} signal=${info.signal} duration=${info.durationMs}ms timedOut=${info.timedOut}`
              : `Failed: ${info.reason}`,
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
          `${cfg.backendId} failed to write run log (agent-link)`,
        );
      }

      if (info.kind === 'fail') {
        const out: ContainerOutput = {
          status: 'error',
          result: `Agent Link ${linkId} 失败：${info.reason}`,
          error: `agent-link run failed: ${info.reason}`,
          newSessionId: state.lastSessionId,
        };
        await emitWrapped(out);
        resolveOnce(out);
        return;
      }

      const { exitCode, signal, timedOut, durationMs } = info;

      if (timedOut) {
        const out: ContainerOutput = {
          status: 'error',
          result: `${cfg.backendId} 执行超时（${Math.round(durationMs / 1000)}s）`,
          error: `${cfg.backendId} timeout after ${durationMs}ms (agent-link)`,
          newSessionId: state.lastSessionId,
        };
        await emitWrapped(out);
        resolveOnce(out);
        return;
      }

      if (
        exitCode !== 0 &&
        state.finalResultText === null &&
        cfg.outputProtocol !== 'plain-text'
      ) {
        const tail = stderrAccum.slice(-400) || stdoutAccum.slice(-400);
        const out: ContainerOutput = {
          status: 'error',
          result: `${cfg.backendId} 进程退出 code=${exitCode}`,
          error: `${cfg.backendId} exit code=${exitCode} signal=${signal}: ${tail}`,
          newSessionId: state.lastSessionId,
        };
        await emitWrapped(out);
        resolveOnce(out);
        return;
      }

      let text: string;
      let isErr: boolean;
      if (cfg.outputProtocol === 'plain-text') {
        text = stdoutAccum.trimEnd();
        isErr = exitCode !== 0;
        if (isErr && !text) {
          text = `${cfg.backendId} 进程退出 code=${exitCode}`;
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
              `${cfg.backendId} reported failure (code=${exitCode})`,
            newSessionId: state.lastSessionId,
          }
        : {
            status: 'success',
            result: text,
            newSessionId: state.lastSessionId,
          };
      await emitWrapped(out);
      resolveOnce(out);
    };

    // Server-side timeout watchdog (in case remote never sends run.result).
    const timer = setTimeout(() => {
      logger.error(
        { group: group.name, runId, linkId },
        `${cfg.backendId} agent-link timeout, sending run.cancel`,
      );
      const s = getSession(linkId);
      if (s && s.state === 'open') {
        s.send({ type: 'run.cancel', runId, reason: 'timeout' });
      }
      // Still wait for result; if it doesn't come within 5s, fail manually.
      setTimeout(() => {
        if (!settled) {
          void finalize({ kind: 'fail', reason: 'server_timeout' });
        }
      }, 5_000);
    }, timeoutMs);

    const controller: RunController = {
      runId,
      linkId,
      onChunk(stream, data) {
        if (stream === 'stderr') {
          if (stderrAccum.length < 20000) {
            stderrAccum += data.slice(0, 20000 - stderrAccum.length);
          }
        } else {
          handleStdoutChunk(data);
        }
      },
      finish(result) {
        clearTimeout(timer);
        void finalize({ kind: 'result', ...result });
      },
      fail(reason) {
        clearTimeout(timer);
        void finalize({ kind: 'fail', reason });
      },
    };

    registerRun(controller);

    const ok = session.send({
      type: 'run.request',
      id: 0,
      runId,
      backendId: cfg.backendId,
      binary,
      argv,
      cwd: groupDir,
      env: cfg.envOverrides,
      outputProtocol: cfg.outputProtocol,
      timeoutMs,
      maxOutputBytes,
      context: buildRunContext(args, cfg),
      stdinJson: JSON.stringify(input),
      remoteCwdPlaceholder: workspaceRepo ? REMOTE_CWD_PLACEHOLDER : undefined,
      workspaceRepo,
    });
    if (!ok) {
      clearTimeout(timer);
      void finalize({ kind: 'fail', reason: 'send_failed' });
    }
  });
}
