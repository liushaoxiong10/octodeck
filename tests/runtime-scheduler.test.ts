import { describe, expect, test } from 'vitest';

import { resolveAgentRunRuntimeTarget } from '../src/runtime-scheduler.js';

describe('unified runtime scheduler', () => {
  test('normalizes provider targets to a concrete device runtime decision', () => {
    const decision = resolveAgentRunRuntimeTarget({
      executionTarget: 'provider:anthropic',
      preferredAgentClientId: 'claude-code',
      devices: [
        {
          id: 'cl_ready000000001',
          displayName: 'Ready Mac',
          online: true,
          runtimes: [
            {
              runtimeId: 'cl_ready000000001:claude-code',
              deviceLinkId: 'cl_ready000000001',
              agentClientId: 'claude-code',
              displayName: 'Claude Code',
              provider: 'anthropic',
              status: 'idle',
              availableSlots: 2,
              maxConcurrentRuns: 2,
              runningRuns: [],
            },
          ],
        },
      ],
      serverBackends: [],
    });

    expect(decision).toMatchObject({
      ok: true,
      runtimeId: 'cl_ready000000001:claude-code',
      executionNode: 'runtime:cl_ready000000001:claude-code',
      deviceLinkId: 'cl_ready000000001',
      agentClientId: 'claude-code',
      schedulingReason: 'target_resolved',
    });
  });

  test('can schedule server-side backends when server runtimes are included', () => {
    const decision = resolveAgentRunRuntimeTarget({
      executionTarget: 'server:server-codex',
      preferredAgentClientId: 'server-codex',
      devices: [],
      serverBackends: [
        { id: 'server-codex', displayName: 'Server Codex', runtime: 'server-side', providerId: 'openai' },
      ],
      includeServerBackends: true,
    });

    expect(decision).toMatchObject({
      ok: true,
      runtimeId: 'server:server-codex',
      executionNode: 'server:server-codex',
      backendId: 'server-codex',
      schedulingReason: 'target_resolved',
    });
  });

  test('blocks degraded runtimes with a stable blocked reason', () => {
    const decision = resolveAgentRunRuntimeTarget({
      executionTarget: 'runtime:cl_stale00000001:claude-code',
      preferredAgentClientId: 'claude-code',
      nowMs: Date.parse('2026-06-15T10:02:00.000Z'),
      staleHeartbeatMs: 60_000,
      devices: [
        {
          id: 'cl_stale00000001',
          displayName: 'Stale Mac',
          online: true,
          lastHeartbeatAt: '2026-06-15T10:00:00.000Z',
          agentClients: [{ id: 'claude-code', displayName: 'Claude Code' }],
        },
      ],
      serverBackends: [],
    });

    expect(decision).toMatchObject({
      ok: false,
      runtimeId: 'cl_stale00000001:claude-code',
      blockedReason: 'runtime_degraded',
      schedulingReason: 'target_blocked',
    });
  });

  test('self-heals an exact degraded runtime target by failing over to another eligible runtime for the same agent', () => {
    const decision = resolveAgentRunRuntimeTarget({
      executionTarget: 'runtime:cl_stale00000001:claude-code',
      preferredAgentClientId: 'claude-code',
      allowFailover: true,
      nowMs: Date.parse('2026-06-15T10:02:00.000Z'),
      staleHeartbeatMs: 60_000,
      devices: [
        {
          id: 'cl_stale00000001',
          displayName: 'Stale Mac',
          online: true,
          lastHeartbeatAt: '2026-06-15T10:00:00.000Z',
          agentClients: [{ id: 'claude-code', displayName: 'Claude Code' }],
        },
        {
          id: 'cl_ready00000001',
          displayName: 'Ready Mac',
          online: true,
          lastHeartbeatAt: '2026-06-15T10:01:59.000Z',
          runtimes: [
            {
              runtimeId: 'cl_ready00000001:claude-code',
              deviceLinkId: 'cl_ready00000001',
              agentClientId: 'claude-code',
              displayName: 'Claude Code',
              provider: 'anthropic',
              status: 'idle',
              availableSlots: 2,
              maxConcurrentRuns: 2,
              runningRuns: [],
            },
          ],
        },
      ],
      serverBackends: [],
    });

    expect(decision).toMatchObject({
      ok: true,
      runtimeId: 'cl_ready00000001:claude-code',
      executionNode: 'runtime:cl_ready00000001:claude-code',
      deviceLinkId: 'cl_ready00000001',
      agentClientId: 'claude-code',
      schedulingReason: 'target_recovered',
      recovery: {
        strategy: 'failover_same_agent',
        originalRuntimeId: 'cl_stale00000001:claude-code',
        originalExecutionNode: 'runtime:cl_stale00000001:claude-code',
        originalBlockedReason: 'runtime_degraded',
      },
    });
  });

  test.each([
    {
      name: 'offline',
      blockedReason: 'runtime_offline',
      devices: [
        {
          id: 'cl_blocked000001',
          displayName: 'Offline Mac',
          online: false,
          agentClients: [{ id: 'claude-code', displayName: 'Claude Code' }],
        },
      ],
    },
    {
      name: 'draining',
      blockedReason: 'runtime_draining',
      devices: [
        {
          id: 'cl_blocked000001',
          displayName: 'Drain Mac',
          online: true,
          runtimes: [
            {
              runtimeId: 'cl_blocked000001:claude-code',
              deviceLinkId: 'cl_blocked000001',
              agentClientId: 'claude-code',
              displayName: 'Claude Code',
              status: 'draining' as const,
              availableSlots: 1,
              runningRuns: [],
            },
          ],
        },
      ],
    },
    {
      name: 'full',
      blockedReason: 'runtime_full',
      devices: [
        {
          id: 'cl_blocked000001',
          displayName: 'Full Mac',
          online: true,
          runtimes: [
            {
              runtimeId: 'cl_blocked000001:claude-code',
              deviceLinkId: 'cl_blocked000001',
              agentClientId: 'claude-code',
              displayName: 'Claude Code',
              status: 'busy' as const,
              availableSlots: 0,
              runningRuns: [{ runId: 'busy' }],
            },
          ],
        },
      ],
    },
  ])('self-heals an exact $name runtime target by failing over to another eligible runtime', ({ blockedReason, devices }) => {
    const decision = resolveAgentRunRuntimeTarget({
      executionTarget: 'runtime:cl_blocked000001:claude-code',
      preferredAgentClientId: 'claude-code',
      allowFailover: true,
      devices: [
        ...devices,
        {
          id: 'cl_ready00000001',
          displayName: 'Ready Mac',
          online: true,
          runtimes: [
            {
              runtimeId: 'cl_ready00000001:claude-code',
              deviceLinkId: 'cl_ready00000001',
              agentClientId: 'claude-code',
              displayName: 'Claude Code',
              status: 'idle' as const,
              availableSlots: 1,
              runningRuns: [],
            },
          ],
        },
      ],
      serverBackends: [],
    });

    expect(decision).toMatchObject({
      ok: true,
      runtimeId: 'cl_ready00000001:claude-code',
      schedulingReason: 'target_recovered',
      recovery: {
        originalRuntimeId: 'cl_blocked000001:claude-code',
        originalBlockedReason: blockedReason,
      },
    });
  });

  test('does not fail over exact runtime targets outside an allowed device boundary', () => {
    const decision = resolveAgentRunRuntimeTarget({
      executionTarget: 'runtime:cl_stale00000001:claude-code',
      preferredAgentClientId: 'claude-code',
      allowFailover: true,
      allowedDeviceLinkId: 'cl_stale00000001',
      nowMs: Date.parse('2026-06-15T10:02:00.000Z'),
      staleHeartbeatMs: 60_000,
      devices: [
        {
          id: 'cl_stale00000001',
          displayName: 'Stale Mac',
          online: true,
          lastHeartbeatAt: '2026-06-15T10:00:00.000Z',
          agentClients: [{ id: 'claude-code', displayName: 'Claude Code' }],
        },
        {
          id: 'cl_ready00000001',
          displayName: 'Ready Mac',
          online: true,
          runtimes: [
            {
              runtimeId: 'cl_ready00000001:claude-code',
              deviceLinkId: 'cl_ready00000001',
              agentClientId: 'claude-code',
              displayName: 'Claude Code',
              status: 'idle',
              availableSlots: 2,
              runningRuns: [],
            },
          ],
        },
      ],
      serverBackends: [],
    });

    expect(decision).toMatchObject({
      ok: false,
      runtimeId: 'cl_stale00000001:claude-code',
      blockedReason: 'runtime_degraded',
      schedulingReason: 'target_blocked',
    });
  });
});
