import {
  buildRuntimePoolSnapshot,
  resolveRuntimeSchedulingTarget,
  type RuntimePoolRuntime,
  type RuntimeSchedulingDecision,
} from './runtime-pool.js';

type RuntimePoolInput = Parameters<typeof buildRuntimePoolSnapshot>[0];

export type AgentRunRuntimeSchedulingReason =
  | 'target_resolved'
  | 'target_recovered'
  | 'target_blocked'
  | 'target_not_found';

export type AgentRunRuntimeTargetDecision = RuntimeSchedulingDecision & {
  ok: boolean;
  schedulingReason: AgentRunRuntimeSchedulingReason;
  recovery?: {
    strategy: 'failover_same_agent';
    originalRuntimeId: string;
    originalExecutionNode: string | null;
    originalBlockedReason: NonNullable<RuntimeSchedulingDecision['blockedReason']>;
  };
};

function runtimeTargetForCandidate(runtime: RuntimePoolRuntime): string | null {
  if (runtime.backendId) return `server:${runtime.backendId}`;
  if (runtime.deviceLinkId) return `runtime:${runtime.deviceLinkId}:${runtime.agentClientId}`;
  return null;
}

function exactRuntimeAgentClientId(executionTarget?: string | null): string | null {
  const target = executionTarget?.trim();
  if (!target) return null;
  const exact = /^runtime:(cl_[^:]+):([^:]+)$/.exec(target) ?? /^(cl_[^:]+):([^:]+)$/.exec(target);
  return exact?.[2] ?? null;
}

export function resolveAgentRunRuntimeTarget(input: {
  executionTarget?: string | null;
  preferredAgentClientId?: string | null;
  devices: RuntimePoolInput['devices'];
  serverBackends: RuntimePoolInput['serverBackends'];
  includeServerBackends?: boolean;
  quota?: RuntimePoolInput['quota'];
  allowFailover?: boolean;
  allowedDeviceLinkId?: string | null;
  nowMs?: number;
  staleHeartbeatMs?: number;
}): AgentRunRuntimeTargetDecision {
  const snapshot = buildRuntimePoolSnapshot({
    devices: input.devices,
    serverBackends: input.includeServerBackends ? input.serverBackends : [],
    quota: input.quota,
    assignment: {
      preferredAgentClientId: input.preferredAgentClientId ?? 'claude-code',
    },
    nowMs: input.nowMs,
    staleHeartbeatMs: input.staleHeartbeatMs,
  });
  const decision = resolveRuntimeSchedulingTarget(snapshot, input.executionTarget);
  const originalBlockedReason = decision.blockedReason;
  const exactAgentClientId = exactRuntimeAgentClientId(input.executionTarget);
  if (
    input.allowFailover &&
    !decision.eligible &&
    originalBlockedReason &&
    originalBlockedReason !== 'runtime_not_found' &&
    originalBlockedReason !== 'quota_exhausted' &&
    exactAgentClientId
  ) {
    const fallback = snapshot.runtimes
      .filter((runtime) => runtime.runtimeId !== decision.runtimeId)
      .filter((runtime) => runtime.agentClientId === exactAgentClientId)
      .filter((runtime) => !input.allowedDeviceLinkId || runtime.deviceLinkId === input.allowedDeviceLinkId)
      .filter((runtime) => runtime.scheduling.eligible)
      .sort((a, b) => {
        const slotDiff = (b.availableSlots ?? 0) - (a.availableSlots ?? 0);
        if (slotDiff !== 0) return slotDiff;
        const runDiff = a.runningRuns.length - b.runningRuns.length;
        if (runDiff !== 0) return runDiff;
        if (a.kind !== b.kind) return a.kind === 'device' ? -1 : 1;
        return a.runtimeId.localeCompare(b.runtimeId);
      })[0];
    const fallbackTarget = fallback ? runtimeTargetForCandidate(fallback) : null;
    const recovered = fallbackTarget ? resolveRuntimeSchedulingTarget(snapshot, fallbackTarget) : null;
    if (recovered?.eligible && recovered.executionNode) {
      return {
        ...recovered,
        ok: true,
        schedulingReason: 'target_recovered',
        recovery: {
          strategy: 'failover_same_agent',
          originalRuntimeId: decision.runtimeId ?? input.executionTarget?.trim() ?? 'unknown',
          originalExecutionNode: decision.executionNode,
          originalBlockedReason,
        },
      };
    }
  }
  const schedulingReason: AgentRunRuntimeSchedulingReason = decision.eligible
    ? 'target_resolved'
    : decision.blockedReason === 'runtime_not_found'
      ? 'target_not_found'
      : 'target_blocked';

  return {
    ...decision,
    ok: decision.eligible && Boolean(decision.executionNode),
    schedulingReason,
  };
}
