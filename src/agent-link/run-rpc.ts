/**
 * Run-RPC controller registry — Phase 5.2.
 *
 * 把 server 发出的一次 run.request 与一组从 hcagent 回流的 run.event/run.result
 * 关联起来。生命周期：
 *   start(linkId, cfg) → controller 入注册表
 *   ┌── 服务端 session.send(run.request)
 *   │
 *   ├── on run.event (stdout/stderr chunks) → controller.onChunk()
 *   ├── on run.result → controller.finish()
 *   ├── on session close / link offline → controller.fail('link_lost')
 *   └── 调用方主动 cancel() → server.send(run.cancel) + controller.fail('cancelled')
 *
 * 设计要点：
 *   - 每个 controller 持有一个 timer 兜底（远端如果不发 result 也会被 server 端超时）
 *   - 同 runId 重复 deliver 是 no-op
 *   - 注册表按 runId 索引；同 linkId 多 run 并发可行
 */
import { logger } from '../logger.js';
import type { RunEventFrame, RunResultFrame } from './protocol.js';

export interface RunController {
  /** 服务端生成的 runId（uuid v4）。 */
  readonly runId: string;
  readonly linkId: string;
  /** 远端 stdout/stderr 增量片段。 */
  onChunk(stream: 'stdout' | 'stderr', data: string): void;
  /** 远端进程结束（exit / signal / timeout）。 */
  finish(result: {
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
    durationMs: number;
  }): void;
  /** 因 session 断连、cancel、上层超时等异常终止。 */
  fail(reason: string): void;
}

const controllers = new Map<string, RunController>();

export function registerRun(controller: RunController): void {
  if (controllers.has(controller.runId)) {
    logger.warn(
      { runId: controller.runId },
      'run-rpc: duplicate registration, replacing',
    );
  }
  controllers.set(controller.runId, controller);
}

export function unregisterRun(runId: string): void {
  controllers.delete(runId);
}

export function getRun(runId: string): RunController | undefined {
  return controllers.get(runId);
}

/** Called from agent-link/registry.ts handleFrame for run.event. */
export function deliverEvent(frame: RunEventFrame): void {
  const ctrl = controllers.get(frame.runId);
  if (!ctrl) {
    logger.debug(
      { runId: frame.runId, stream: frame.stream },
      'run-rpc: drop event for unknown runId',
    );
    return;
  }
  try {
    ctrl.onChunk(frame.stream, frame.data);
  } catch (err) {
    logger.error(
      { runId: frame.runId, err: (err as Error).message },
      'run-rpc: onChunk threw',
    );
  }
}

/** Called from agent-link/registry.ts handleFrame for run.result. */
export function deliverResult(frame: RunResultFrame): void {
  const ctrl = controllers.get(frame.runId);
  if (!ctrl) {
    logger.debug(
      { runId: frame.runId },
      'run-rpc: drop result for unknown runId',
    );
    return;
  }
  controllers.delete(frame.runId);
  try {
    ctrl.finish({
      exitCode: frame.exitCode,
      signal: frame.signal,
      timedOut: frame.timedOut,
      durationMs: frame.durationMs,
    });
  } catch (err) {
    logger.error(
      { runId: frame.runId, err: (err as Error).message },
      'run-rpc: finish threw',
    );
  }
}

/** Called when a session closes — fail every run waiting on that link. */
export function failRunsForLink(linkId: string, reason: string): void {
  const dead: string[] = [];
  for (const [runId, ctrl] of controllers) {
    if (ctrl.linkId === linkId) {
      dead.push(runId);
    }
  }
  for (const runId of dead) {
    const ctrl = controllers.get(runId);
    controllers.delete(runId);
    if (!ctrl) continue;
    try {
      ctrl.fail(reason);
    } catch (err) {
      logger.error(
        { runId, err: (err as Error).message },
        'run-rpc: fail handler threw',
      );
    }
  }
}
