type RuntimeStatus = 'idle' | 'busy' | 'draining' | 'offline';
type RuntimeKind = 'server' | 'device';

type RuntimeRun = {
  runId: string;
  backendId?: string;
  cwd?: string;
  status?: string;
  startedAt?: string;
  lastActivityAt?: string;
};

type DeviceRuntime = {
  runtimeId: string;
  deviceLinkId: string;
  agentClientId: string;
  displayName?: string;
  provider?: string;
  transport?: 'stdio' | 'acp' | 'a2a' | 'http';
  status: RuntimeStatus;
  maxConcurrentRuns?: number;
  availableSlots?: number;
  runningRuns?: RuntimeRun[];
  lastHeartbeatAt?: string | number;
};

type RuntimePoolDevice = {
  id: string;
  displayName: string;
  online: boolean;
  status?: RuntimeStatus;
  lastHeartbeatAt?: string | number | null;
  agentClients?: Array<{
    id: string;
    displayName: string;
    binary?: string;
    provider?: string;
    transport?: 'stdio' | 'acp' | 'a2a' | 'http';
  }>;
  runtimes?: DeviceRuntime[];
};

type RuntimePoolServerBackend = {
  id: string;
  displayName: string;
  runtime?: 'local-device' | 'server-side';
  providerId?: string | null;
};

type RuntimePoolQuotaInput = {
  userId?: string;
  maxConcurrentRuns: number;
  runningRuns?: number;
};

type RuntimePoolQuota = {
  userId?: string;
  maxConcurrentRuns: number;
  runningRuns: number;
  remainingRuns: number;
  saturated: boolean;
};

type RuntimePoolAssignmentInput = {
  preferredAgentClientId?: string;
};

type RuntimePoolAssignment = {
  recommendedRuntimeId: string | null;
  executionNode: string | null;
  deviceLinkId?: string;
  agentClientId?: string;
  backendId?: string;
  reason: 'matched_preferred_agent' | 'best_available' | 'no_eligible_runtime';
};

type SchedulingState = {
  eligible: boolean;
  blockedReason?: 'runtime_offline' | 'runtime_draining' | 'runtime_full' | 'runtime_degraded' | 'quota_exhausted';
};

export type RuntimeRecoveryAction =
  | 'none'
  | 'wait_for_reconnect'
  | 'respect_drain'
  | 'wait_for_heartbeat'
  | 'wait_for_capacity'
  | 'wait_for_quota';

export type RuntimeRecoveryState = {
  action: RuntimeRecoveryAction;
  retryable: boolean;
  failoverEligible: boolean;
  reason: string;
};

export type RuntimeSchedulingDecision = {
  eligible: boolean;
  runtimeId: string | null;
  executionNode: string | null;
  deviceLinkId?: string;
  agentClientId?: string;
  backendId?: string;
  blockedReason?: NonNullable<SchedulingState['blockedReason']> | 'runtime_not_found';
};

const DEFAULT_STALE_HEARTBEAT_MS = 90_000;

export type RuntimePoolRuntime = {
  runtimeId: string;
  kind: RuntimeKind;
  deviceLinkId?: string;
  deviceName?: string;
  backendId?: string;
  agentClientId: string;
  displayName: string;
  provider?: string;
  transport?: 'stdio' | 'acp' | 'a2a' | 'http';
  status: RuntimeStatus;
  health: 'available' | 'busy' | 'draining' | 'offline' | 'full' | 'degraded';
  scheduling: SchedulingState;
  recovery: RuntimeRecoveryState;
  maxConcurrentRuns?: number;
  availableSlots?: number;
  runningRuns: RuntimeRun[];
  lastHeartbeatAt?: string;
  heartbeatAgeMs?: number;
};

export type RuntimePoolSnapshot = {
  summary: {
    totalRuntimes: number;
    onlineRuntimes: number;
    busyRuntimes: number;
    degradedRuntimes: number;
    recoverableRuntimes: number;
    availableSlots: number;
    admissibleSlots: number;
    runningRuns: number;
  };
  quota?: RuntimePoolQuota;
  assignment?: RuntimePoolAssignment;
  runtimes: RuntimePoolRuntime[];
};

function parseTimestampMs(value: string | number | null | undefined): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function heartbeatInfo(input: {
  lastHeartbeatAt?: string | number | null;
  nowMs: number;
}): { lastHeartbeatAt?: string; heartbeatAgeMs?: number } {
  const heartbeatMs = parseTimestampMs(input.lastHeartbeatAt);
  if (heartbeatMs === undefined) return {};
  return {
    lastHeartbeatAt: new Date(heartbeatMs).toISOString(),
    heartbeatAgeMs: Math.max(0, input.nowMs - heartbeatMs),
  };
}

function healthFor(
  status: RuntimeStatus,
  availableSlots: number | undefined,
  heartbeatAgeMs: number | undefined,
  staleHeartbeatMs: number,
): RuntimePoolRuntime['health'] {
  if (status === 'offline') return 'offline';
  if (status === 'draining') return 'draining';
  if (heartbeatAgeMs !== undefined && heartbeatAgeMs > staleHeartbeatMs) return 'degraded';
  if (availableSlots !== undefined && availableSlots <= 0) return 'full';
  if (status === 'busy') return 'available';
  return 'available';
}

function schedulingFor(
  health: RuntimePoolRuntime['health'],
  quota: RuntimePoolQuota | undefined,
): SchedulingState {
  if (quota?.saturated) return { eligible: false, blockedReason: 'quota_exhausted' };
  if (health === 'offline') return { eligible: false, blockedReason: 'runtime_offline' };
  if (health === 'draining') return { eligible: false, blockedReason: 'runtime_draining' };
  if (health === 'degraded') return { eligible: false, blockedReason: 'runtime_degraded' };
  if (health === 'full') return { eligible: false, blockedReason: 'runtime_full' };
  return { eligible: true };
}

function recoveryFor(health: RuntimePoolRuntime['health'], scheduling: SchedulingState): RuntimeRecoveryState {
  if (scheduling.blockedReason === 'quota_exhausted') {
    return {
      action: 'wait_for_quota',
      retryable: true,
      failoverEligible: false,
      reason: 'User runtime quota is exhausted; retry after another run completes.',
    };
  }
  if (health === 'offline') {
    return {
      action: 'wait_for_reconnect',
      retryable: true,
      failoverEligible: true,
      reason: 'Runtime is offline; wait for daemon reconnect or fail over to another compatible runtime.',
    };
  }
  if (health === 'draining') {
    return {
      action: 'respect_drain',
      retryable: true,
      failoverEligible: true,
      reason: 'Runtime is draining; avoid new work and route to another compatible runtime.',
    };
  }
  if (health === 'degraded') {
    return {
      action: 'wait_for_heartbeat',
      retryable: true,
      failoverEligible: true,
      reason: 'Runtime heartbeat is stale; fail over now and retry this runtime after heartbeat recovers.',
    };
  }
  if (health === 'full') {
    return {
      action: 'wait_for_capacity',
      retryable: true,
      failoverEligible: true,
      reason: 'Runtime has no available slots; fail over or retry after capacity is released.',
    };
  }
  return {
    action: 'none',
    retryable: false,
    failoverEligible: false,
    reason: 'Runtime is schedulable.',
  };
}

function withScheduling(
  runtime: Omit<RuntimePoolRuntime, 'scheduling' | 'recovery'>,
  quota: RuntimePoolQuota | undefined,
): RuntimePoolRuntime {
  const scheduling = schedulingFor(runtime.health, quota);
  return {
    ...runtime,
    scheduling,
    recovery: recoveryFor(runtime.health, scheduling),
  };
}

function normalizeDeviceRuntimes(
  device: RuntimePoolDevice,
  quota: RuntimePoolQuota | undefined,
  opts: { nowMs: number; staleHeartbeatMs: number },
): RuntimePoolRuntime[] {
  const source = device.runtimes?.length
    ? device.runtimes
    : (device.agentClients ?? []).map((client): DeviceRuntime => ({
        runtimeId: `${device.id}:${client.id}`,
        deviceLinkId: device.id,
        agentClientId: client.id,
        displayName: client.displayName,
        provider: client.provider,
        transport: client.transport,
        status: device.online ? (device.status ?? 'idle') : 'offline',
        availableSlots: device.online ? 1 : 0,
        maxConcurrentRuns: 1,
        runningRuns: [],
        lastHeartbeatAt: device.lastHeartbeatAt ?? undefined,
      }));

  return source.map((runtime) => {
    const status: RuntimeStatus = device.online ? runtime.status : 'offline';
    const runningRuns = runtime.runningRuns ?? [];
    const heartbeat = heartbeatInfo({
      lastHeartbeatAt: runtime.lastHeartbeatAt ?? device.lastHeartbeatAt,
      nowMs: opts.nowMs,
    });
    const health = healthFor(status, runtime.availableSlots, heartbeat.heartbeatAgeMs, opts.staleHeartbeatMs);
    return withScheduling({
      runtimeId: runtime.runtimeId,
      kind: 'device',
      deviceLinkId: device.id,
      deviceName: device.displayName,
      agentClientId: runtime.agentClientId,
      displayName: runtime.displayName ?? runtime.agentClientId,
      provider: runtime.provider,
      transport: runtime.transport,
      status,
      health,
      maxConcurrentRuns: runtime.maxConcurrentRuns,
      availableSlots: runtime.availableSlots,
      runningRuns,
      ...heartbeat,
    }, quota);
  });
}

function buildQuota(
  quota: RuntimePoolQuotaInput | undefined,
  runningRuns: number,
): RuntimePoolQuota | undefined {
  if (!quota) return undefined;
  const maxConcurrentRuns = Math.max(0, quota.maxConcurrentRuns);
  const currentRunningRuns = Math.max(0, quota.runningRuns ?? runningRuns);
  const remainingRuns = Math.max(0, maxConcurrentRuns - currentRunningRuns);
  return {
    userId: quota.userId,
    maxConcurrentRuns,
    runningRuns: currentRunningRuns,
    remainingRuns,
    saturated: remainingRuns <= 0,
  };
}

function executionNodeFor(runtime: RuntimePoolRuntime): string | null {
  if (runtime.kind === 'device' && runtime.deviceLinkId) {
    return `runtime:${runtime.deviceLinkId}:${runtime.agentClientId}`;
  }
  if (runtime.kind === 'server' && runtime.backendId) {
    return `server:${runtime.backendId}`;
  }
  return null;
}

function buildAssignment(
  runtimes: RuntimePoolRuntime[],
  input: RuntimePoolAssignmentInput | undefined,
): RuntimePoolAssignment | undefined {
  if (!input) return undefined;
  const eligible = runtimes.filter((runtime) => runtime.scheduling.eligible);
  const preferred = input.preferredAgentClientId
    ? eligible.filter((runtime) => runtime.agentClientId === input.preferredAgentClientId)
    : [];
  const candidates = preferred.length > 0 ? preferred : eligible;
  const selected = [...candidates].sort((a, b) => {
    const slotDiff = (b.availableSlots ?? 0) - (a.availableSlots ?? 0);
    if (slotDiff !== 0) return slotDiff;
    const runDiff = a.runningRuns.length - b.runningRuns.length;
    if (runDiff !== 0) return runDiff;
    if (a.kind !== b.kind) return a.kind === 'device' ? -1 : 1;
    return a.runtimeId.localeCompare(b.runtimeId);
  })[0];
  if (!selected) {
    return { recommendedRuntimeId: null, executionNode: null, reason: 'no_eligible_runtime' };
  }
  return {
    recommendedRuntimeId: selected.runtimeId,
    executionNode: executionNodeFor(selected),
    deviceLinkId: selected.deviceLinkId,
    agentClientId: selected.agentClientId,
    backendId: selected.backendId,
    reason: preferred.length > 0 ? 'matched_preferred_agent' : 'best_available',
  };
}

function sortRuntimeCandidates(candidates: RuntimePoolRuntime[]): RuntimePoolRuntime[] {
  return [...candidates].sort((a, b) => {
    const slotDiff = (b.availableSlots ?? 0) - (a.availableSlots ?? 0);
    if (slotDiff !== 0) return slotDiff;
    const runDiff = a.runningRuns.length - b.runningRuns.length;
    if (runDiff !== 0) return runDiff;
    if (a.kind !== b.kind) return a.kind === 'device' ? -1 : 1;
    return a.runtimeId.localeCompare(b.runtimeId);
  });
}

function decisionForRuntime(runtime: RuntimePoolRuntime): RuntimeSchedulingDecision {
  return {
    eligible: runtime.scheduling.eligible,
    runtimeId: runtime.runtimeId,
    executionNode: executionNodeFor(runtime),
    deviceLinkId: runtime.deviceLinkId,
    agentClientId: runtime.agentClientId,
    backendId: runtime.backendId,
    blockedReason: runtime.scheduling.blockedReason,
  };
}

export function resolveRuntimeSchedulingTarget(
  snapshot: RuntimePoolSnapshot,
  executionTarget?: string | null,
): RuntimeSchedulingDecision {
  const target = executionTarget?.trim();
  if (!target) {
    const assignment = snapshot.assignment;
    if (!assignment?.recommendedRuntimeId) {
      return { eligible: false, runtimeId: null, executionNode: null, blockedReason: 'runtime_not_found' };
    }
    const runtime = snapshot.runtimes.find((item) => item.runtimeId === assignment.recommendedRuntimeId);
    return runtime
      ? decisionForRuntime(runtime)
      : { eligible: false, runtimeId: null, executionNode: null, blockedReason: 'runtime_not_found' };
  }

  const exactRuntime = /^runtime:(cl_[^:]+):([^:]+)$/.exec(target);
  if (exactRuntime) {
    const runtimeId = `${exactRuntime[1]}:${exactRuntime[2]}`;
    const runtime = snapshot.runtimes.find((item) => item.runtimeId === runtimeId);
    return runtime
      ? decisionForRuntime(runtime)
      : { eligible: false, runtimeId, executionNode: target, blockedReason: 'runtime_not_found' };
  }

  const legacyRuntime = /^(cl_[^:]+):([^:]+)$/.exec(target);
  if (legacyRuntime) {
    const runtimeId = `${legacyRuntime[1]}:${legacyRuntime[2]}`;
    const runtime = snapshot.runtimes.find((item) => item.runtimeId === runtimeId);
    return runtime
      ? decisionForRuntime(runtime)
      : { eligible: false, runtimeId, executionNode: `runtime:${runtimeId}`, blockedReason: 'runtime_not_found' };
  }

  const device = /^(cl_[^:]+)$/.exec(target);
  if (device) {
    const candidates = snapshot.runtimes.filter((runtime) => runtime.deviceLinkId === device[1]);
    const runtime = sortRuntimeCandidates(candidates.filter((item) => item.scheduling.eligible))[0] ?? sortRuntimeCandidates(candidates)[0];
    return runtime
      ? decisionForRuntime(runtime)
      : { eligible: false, runtimeId: null, executionNode: target, blockedReason: 'runtime_not_found' };
  }

  const provider = /^provider:([^:]+)$/.exec(target);
  if (provider) {
    const providerId = provider[1];
    const candidates = snapshot.runtimes.filter(
      (runtime) => runtime.provider === providerId || runtime.agentClientId === providerId || runtime.backendId === providerId,
    );
    const runtime = sortRuntimeCandidates(candidates.filter((item) => item.scheduling.eligible))[0] ?? sortRuntimeCandidates(candidates)[0];
    return runtime
      ? decisionForRuntime(runtime)
      : { eligible: false, runtimeId: null, executionNode: target, blockedReason: 'runtime_not_found' };
  }

  const server = /^server:([^:]+)$/.exec(target);
  if (server) {
    const runtimeId = `server:${server[1]}`;
    const runtime = snapshot.runtimes.find((item) => item.runtimeId === runtimeId);
    return runtime
      ? decisionForRuntime(runtime)
      : { eligible: false, runtimeId, executionNode: target, blockedReason: 'runtime_not_found' };
  }

  return { eligible: false, runtimeId: null, executionNode: target, blockedReason: 'runtime_not_found' };
}

export function buildRuntimePoolSnapshot(input: {
  devices: RuntimePoolDevice[];
  serverBackends: RuntimePoolServerBackend[];
  quota?: RuntimePoolQuotaInput;
  assignment?: RuntimePoolAssignmentInput;
  nowMs?: number;
  staleHeartbeatMs?: number;
}): RuntimePoolSnapshot {
  const nowMs = input.nowMs ?? Date.now();
  const staleHeartbeatMs = input.staleHeartbeatMs ?? DEFAULT_STALE_HEARTBEAT_MS;
  const serverRuntimeBases: Array<Omit<RuntimePoolRuntime, 'scheduling' | 'recovery'>> = input.serverBackends
    .filter((backend) => backend.runtime === 'server-side')
    .map((backend) => ({
      runtimeId: `server:${backend.id}`,
      kind: 'server',
      backendId: backend.id,
      agentClientId: backend.id,
      displayName: backend.displayName,
      provider: backend.providerId ?? undefined,
      transport: 'stdio' as const,
      status: 'idle' as const,
      health: 'available' as const,
      maxConcurrentRuns: 1,
      availableSlots: 1,
      runningRuns: [],
    }));

  const deviceRuntimeBases = input.devices.flatMap((device) =>
    normalizeDeviceRuntimes(device, undefined, { nowMs, staleHeartbeatMs }),
  );
  const quota = buildQuota(
    input.quota,
    [...serverRuntimeBases, ...deviceRuntimeBases].reduce(
      (sum, runtime) => sum + runtime.runningRuns.length,
      0,
    ),
  );
  const serverRuntimes = serverRuntimeBases.map((runtime) => withScheduling(runtime, quota));
  const deviceRuntimes = input.devices.flatMap((device) =>
    normalizeDeviceRuntimes(device, quota, { nowMs, staleHeartbeatMs }),
  );
  const runtimes = [...serverRuntimes, ...deviceRuntimes];
  const availableSlots = runtimes.reduce((sum, runtime) => sum + (runtime.availableSlots ?? 0), 0);
  const eligibleSlots = runtimes.reduce(
    (sum, runtime) => sum + (runtime.scheduling.eligible ? (runtime.availableSlots ?? 0) : 0),
    0,
  );
  const admissibleSlots = quota
    ? Math.min(eligibleSlots, quota.remainingRuns)
    : eligibleSlots;

  return {
    summary: {
      totalRuntimes: runtimes.length,
      onlineRuntimes: runtimes.filter((runtime) => runtime.status !== 'offline').length,
      busyRuntimes: runtimes.filter((runtime) => runtime.status === 'busy').length,
      degradedRuntimes: runtimes.filter((runtime) => runtime.health === 'degraded').length,
      recoverableRuntimes: runtimes.filter((runtime) => runtime.recovery.retryable).length,
      availableSlots,
      admissibleSlots,
      runningRuns: runtimes.reduce((sum, runtime) => sum + runtime.runningRuns.length, 0),
    },
    quota,
    assignment: buildAssignment(runtimes, input.assignment),
    runtimes,
  };
}
