/**
 * Agent backend abstraction.
 *
 * 一个 backend 知道如何 spawn 一个外部 agent 进程（Claude Agent SDK / coco / ...），
 * 并把它的输出按 octodeck 的 stdout marker 协议（OUTPUT_START_MARKER /
 * OUTPUT_END_MARKER 包裹的 ContainerOutput JSON）暴露给上层。
 *
 * Phase 1：仅定义接口 + claude-sdk 实现（直接代理给现有的 runContainerAgent /
 * runHostAgent）。后续 phase 会再把共用的 driver（工作目录、IPC 目录、provider
 * pool 上报、stdout/stderr/timeout 处理等）从 container-runner 抽到这里来。
 */
import type { ChildProcess } from 'child_process';

import type {
  ContainerInput,
  ContainerOutput,
} from '../container-runner.js';
import type { ExecutionMode, RegisteredGroup } from '../types.js';

/** 上层（index.ts / task-scheduler.ts）传入的进程注册回调。 */
export type BackendOnProcess = (
  proc: ChildProcess,
  identifier: string,
  selectedProviderId: string | null,
) => void;

/** 上层流式回调 —— backend 必须按现有 ContainerOutput 形状输出。 */
export type BackendOnOutput = (
  output: ContainerOutput,
) => Promise<void>;

export interface BackendRunArgs {
  group: RegisteredGroup;
  input: ContainerInput;
  executionMode: ExecutionMode;
  onProcess: BackendOnProcess;
  onOutput?: BackendOnOutput;
  ownerHomeFolder?: string;
}

export interface AgentBackend {
  /** 唯一 ID（与 SystemSettings.defaultBackend / RegisteredGroup.backend 对齐）。 */
  readonly id: string;
  /** 给 admin UI 展示用的人类可读名称。 */
  readonly displayName: string;
  /** 是否走 octodeck provider pool（Claude shape API key 池）。 */
  readonly usesProviderPool: boolean;
  /**
   * Backend 是否能用自身 CLI/session 机制恢复多轮上下文。
   * true 时 orchestration 层不再把 OctoDeck 历史包装成 <system_context> 注入 prompt，
   * 而是把 sessionId 交给 backend，由 backend 的 argv/env 协议原生 resume。
   */
  readonly supportsNativeSessions?: boolean;
  /** 该 backend 支持的执行模式集合。 */
  supportsExecutionMode(mode: ExecutionMode): boolean;
  /** 实际执行入口：返回最终 ContainerOutput。 */
  run(args: BackendRunArgs): Promise<ContainerOutput>;
}
