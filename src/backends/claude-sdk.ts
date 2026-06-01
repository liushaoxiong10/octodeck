/**
 * Claude Agent SDK backend.
 *
 * Phase 1：直接代理给现有的 runContainerAgent / runHostAgent，行为与改造前完全一致。
 * 后续 phase 可以把共享逻辑（IPC 目录准备、provider pool 上报、stdout/stderr/timeout
 * 处理等）从 container-runner 移到通用 driver 里，让本文件只负责 spawn。
 */
import { runContainerAgent, runHostAgent } from '../container-runner.js';
import { sdkQuery } from '../sdk-query.js';
import type { ExecutionMode } from '../types.js';
import type { AgentBackend, BackendRunArgs } from './types.js';

export const claudeSdkBackend: AgentBackend = {
  id: 'claude-sdk',
  displayName: 'Claude Agent SDK',
  usesProviderPool: true,

  supportsExecutionMode(mode: ExecutionMode): boolean {
    return mode === 'host' || mode === 'container';
  },

  async run(args: BackendRunArgs) {
    const { group, input, executionMode, onProcess, onOutput, ownerHomeFolder } =
      args;
    if (input.executionProfile === 'single-turn-json') {
      const result = await sdkQuery(input.prompt, {
        timeout: group.containerConfig?.timeout,
      });
      if (!result) {
        return {
          status: 'error',
          result: null,
          error: 'Claude Agent SDK single-turn query returned no output',
        };
      }
      return { status: 'success', result };
    }
    if (executionMode === 'host') {
      return runHostAgent(group, input, onProcess, onOutput, ownerHomeFolder);
    }
    return runContainerAgent(group, input, onProcess, onOutput, ownerHomeFolder);
  },
};
