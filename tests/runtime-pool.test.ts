import { describe, expect, test } from 'vitest';

import {
  buildRuntimePoolSnapshot,
  resolveRuntimeSchedulingTarget,
} from '../src/runtime-pool.js';

describe('runtime pool snapshot', () => {
  test('aggregates device runtimes and server backends into capacity summary', () => {
    const snapshot = buildRuntimePoolSnapshot({
      devices: [
        {
          id: 'cl_1234567890abcdef',
          displayName: 'Mac Studio',
          online: true,
          runtimes: [
            {
              runtimeId: 'cl_1234567890abcdef:claude-code',
              deviceLinkId: 'cl_1234567890abcdef',
              agentClientId: 'claude-code',
              displayName: 'Claude Code',
              provider: 'anthropic',
              transport: 'stdio',
              status: 'busy',
              maxConcurrentRuns: 2,
              availableSlots: 1,
              runningRuns: [{ runId: 'run_1', backendId: 'claude-code' }],
            },
          ],
        },
        {
          id: 'cl_offline0000000',
          displayName: 'Offline Mini',
          online: false,
          agentClients: [{ id: 'codex', displayName: 'Codex', binary: 'codex' }],
        },
      ],
      serverBackends: [
        { id: 'server-codex', displayName: 'Server Codex', runtime: 'server-side', providerId: 'openai' },
      ],
    });

    expect(snapshot.summary.totalRuntimes).toBe(3);
    expect(snapshot.summary.onlineRuntimes).toBe(2);
    expect(snapshot.summary.availableSlots).toBe(2);
    expect(snapshot.summary.runningRuns).toBe(1);
    expect(snapshot.runtimes.map((runtime) => runtime.runtimeId)).toEqual([
      'server:server-codex',
      'cl_1234567890abcdef:claude-code',
      'cl_offline0000000:codex',
    ]);
    expect(snapshot.runtimes[0]).toMatchObject({ kind: 'server', status: 'idle', provider: 'openai' });
    expect(snapshot.runtimes[1]).toMatchObject({ kind: 'device', health: 'available' });
    expect(snapshot.runtimes[2]).toMatchObject({ status: 'offline', health: 'offline' });
  });

  test('applies per-user quota to scheduling capacity', () => {
    const snapshot = buildRuntimePoolSnapshot({
      devices: [
        {
          id: 'cl_device00000001',
          displayName: 'Mac Studio',
          online: true,
          runtimes: [
            {
              runtimeId: 'cl_device00000001:claude-code',
              deviceLinkId: 'cl_device00000001',
              agentClientId: 'claude-code',
              displayName: 'Claude Code',
              status: 'idle',
              maxConcurrentRuns: 2,
              availableSlots: 2,
              runningRuns: [],
            },
          ],
        },
      ],
      serverBackends: [
        { id: 'server-codex', displayName: 'Server Codex', runtime: 'server-side' },
      ],
      quota: {
        userId: 'user_1',
        maxConcurrentRuns: 1,
        runningRuns: 1,
      },
    });

    expect(snapshot.summary.availableSlots).toBe(3);
    expect(snapshot.summary.admissibleSlots).toBe(0);
    expect(snapshot.quota).toMatchObject({
      userId: 'user_1',
      maxConcurrentRuns: 1,
      runningRuns: 1,
      remainingRuns: 0,
      saturated: true,
    });
    expect(snapshot.runtimes.every((runtime) => runtime.scheduling.eligible === false)).toBe(true);
    expect(snapshot.runtimes.map((runtime) => runtime.scheduling.blockedReason)).toEqual([
      'quota_exhausted',
      'quota_exhausted',
    ]);
  });

  test('marks online runtimes degraded when heartbeat is stale', () => {
    const snapshot = buildRuntimePoolSnapshot({
      nowMs: Date.parse('2026-06-12T10:02:00.000Z'),
      staleHeartbeatMs: 60_000,
      devices: [
        {
          id: 'cl_stale000000001',
          displayName: 'Stale Mac',
          online: true,
          lastHeartbeatAt: '2026-06-12T10:00:00.000Z',
          agentClients: [{ id: 'codex', displayName: 'Codex', binary: 'codex' }],
        },
      ],
      serverBackends: [],
    });

    expect(snapshot.summary.degradedRuntimes).toBe(1);
    expect(snapshot.runtimes[0]).toMatchObject({
      health: 'degraded',
      lastHeartbeatAt: '2026-06-12T10:00:00.000Z',
      heartbeatAgeMs: 120_000,
      scheduling: { eligible: false, blockedReason: 'runtime_degraded' },
    });
  });

  test('annotates recovery guidance for degraded, full, draining, and offline runtimes', () => {
    const snapshot = buildRuntimePoolSnapshot({
      nowMs: Date.parse('2026-06-15T12:03:00.000Z'),
      staleHeartbeatMs: 60_000,
      devices: [
        {
          id: 'cl_stale00000001',
          displayName: 'Stale Mac',
          online: true,
          lastHeartbeatAt: '2026-06-15T12:00:00.000Z',
          agentClients: [{ id: 'claude-code', displayName: 'Claude Code' }],
        },
        {
          id: 'cl_full000000001',
          displayName: 'Full Mac',
          online: true,
          runtimes: [
            {
              runtimeId: 'cl_full000000001:claude-code',
              deviceLinkId: 'cl_full000000001',
              agentClientId: 'claude-code',
              displayName: 'Claude Code',
              status: 'busy',
              availableSlots: 0,
              runningRuns: [{ runId: 'run_busy' }],
            },
          ],
        },
        {
          id: 'cl_drain00000001',
          displayName: 'Drain Mac',
          online: true,
          runtimes: [
            {
              runtimeId: 'cl_drain00000001:claude-code',
              deviceLinkId: 'cl_drain00000001',
              agentClientId: 'claude-code',
              displayName: 'Claude Code',
              status: 'draining',
              availableSlots: 1,
              runningRuns: [],
            },
          ],
        },
        {
          id: 'cl_offline000001',
          displayName: 'Offline Mac',
          online: false,
          agentClients: [{ id: 'claude-code', displayName: 'Claude Code' }],
        },
      ],
      serverBackends: [],
    });

    expect(snapshot.summary.recoverableRuntimes).toBe(4);
    expect(snapshot.runtimes.map((runtime) => runtime.recovery.action)).toEqual([
      'wait_for_heartbeat',
      'wait_for_capacity',
      'respect_drain',
      'wait_for_reconnect',
    ]);
    expect(snapshot.runtimes.every((runtime) => runtime.recovery.retryable)).toBe(true);
    expect(snapshot.runtimes.every((runtime) => runtime.recovery.failoverEligible)).toBe(true);
  });

  test('recommends an eligible runtime for the next issue run', () => {
    const snapshot = buildRuntimePoolSnapshot({
      nowMs: Date.parse('2026-06-12T10:02:00.000Z'),
      staleHeartbeatMs: 60_000,
      assignment: { preferredAgentClientId: 'claude-code' },
      devices: [
        {
          id: 'cl_full0000000001',
          displayName: 'Full Mac',
          online: true,
          lastHeartbeatAt: '2026-06-12T10:01:50.000Z',
          runtimes: [
            {
              runtimeId: 'cl_full0000000001:claude-code',
              deviceLinkId: 'cl_full0000000001',
              agentClientId: 'claude-code',
              displayName: 'Claude Code',
              status: 'busy',
              availableSlots: 0,
              maxConcurrentRuns: 1,
              runningRuns: [{ runId: 'run_busy', backendId: 'claude-code' }],
            },
          ],
        },
        {
          id: 'cl_ready000000001',
          displayName: 'Ready Mac',
          online: true,
          lastHeartbeatAt: '2026-06-12T10:01:55.000Z',
          runtimes: [
            {
              runtimeId: 'cl_ready000000001:claude-code',
              deviceLinkId: 'cl_ready000000001',
              agentClientId: 'claude-code',
              displayName: 'Claude Code',
              status: 'idle',
              availableSlots: 2,
              maxConcurrentRuns: 2,
              runningRuns: [],
            },
            {
              runtimeId: 'cl_ready000000001:codex',
              deviceLinkId: 'cl_ready000000001',
              agentClientId: 'codex',
              displayName: 'Codex',
              status: 'idle',
              availableSlots: 5,
              maxConcurrentRuns: 5,
              runningRuns: [],
            },
          ],
        },
      ],
      serverBackends: [
        { id: 'server-claude', displayName: 'Server Claude', runtime: 'server-side' },
      ],
    });

    expect(snapshot.assignment).toMatchObject({
      recommendedRuntimeId: 'cl_ready000000001:claude-code',
      executionNode: 'runtime:cl_ready000000001:claude-code',
      deviceLinkId: 'cl_ready000000001',
      agentClientId: 'claude-code',
      reason: 'matched_preferred_agent',
    });
  });

  test('returns a concrete server runtime execution target for server-side backends', () => {
    const snapshot = buildRuntimePoolSnapshot({
      devices: [],
      serverBackends: [
        { id: 'server-codex', displayName: 'Server Codex', runtime: 'server-side', providerId: 'openai' },
      ],
      assignment: { preferredAgentClientId: 'server-codex' },
    });

    expect(snapshot.assignment).toMatchObject({
      recommendedRuntimeId: 'server:server-codex',
      executionNode: 'server:server-codex',
      backendId: 'server-codex',
      reason: 'matched_preferred_agent',
    });
    expect(resolveRuntimeSchedulingTarget(snapshot, 'server:server-codex')).toMatchObject({
      eligible: true,
      runtimeId: 'server:server-codex',
      executionNode: 'server:server-codex',
      backendId: 'server-codex',
    });
  });

  test('blocks a selected exact runtime when it is full', () => {
    const snapshot = buildRuntimePoolSnapshot({
      devices: [
        {
          id: 'cl_full0000000001',
          displayName: 'Full Mac',
          online: true,
          runtimes: [
            {
              runtimeId: 'cl_full0000000001:claude-code',
              deviceLinkId: 'cl_full0000000001',
              agentClientId: 'claude-code',
              displayName: 'Claude Code',
              status: 'busy',
              availableSlots: 0,
              maxConcurrentRuns: 1,
              runningRuns: [{ runId: 'run_busy' }],
            },
          ],
        },
      ],
      serverBackends: [],
    });

    const decision = resolveRuntimeSchedulingTarget(
      snapshot,
      'runtime:cl_full0000000001:claude-code',
    );

    expect(decision).toMatchObject({
      eligible: false,
      runtimeId: 'cl_full0000000001:claude-code',
      executionNode: 'runtime:cl_full0000000001:claude-code',
      blockedReason: 'runtime_full',
    });
  });

  test('resolves provider targets to the best eligible runtime in that provider pool', () => {
    const snapshot = buildRuntimePoolSnapshot({
      devices: [
        {
          id: 'cl_full0000000001',
          displayName: 'Full Mac',
          online: true,
          runtimes: [
            {
              runtimeId: 'cl_full0000000001:claude-code',
              deviceLinkId: 'cl_full0000000001',
              agentClientId: 'claude-code',
              displayName: 'Claude Code',
              provider: 'anthropic',
              status: 'busy',
              availableSlots: 0,
              runningRuns: [{ runId: 'run_busy' }],
            },
          ],
        },
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
              availableSlots: 3,
              runningRuns: [],
            },
          ],
        },
      ],
      serverBackends: [],
    });

    const decision = resolveRuntimeSchedulingTarget(snapshot, 'provider:anthropic');

    expect(decision).toMatchObject({
      eligible: true,
      runtimeId: 'cl_ready000000001:claude-code',
      executionNode: 'runtime:cl_ready000000001:claude-code',
    });
  });

  test('resolves a device target to a concrete eligible runtime for run audit fields', () => {
    const snapshot = buildRuntimePoolSnapshot({
      devices: [
        {
          id: 'cl_ready000000001',
          displayName: 'Ready Mac',
          online: true,
          runtimes: [
            {
              runtimeId: 'cl_ready000000001:codex',
              deviceLinkId: 'cl_ready000000001',
              agentClientId: 'codex',
              displayName: 'Codex',
              status: 'idle',
              availableSlots: 1,
              runningRuns: [],
            },
            {
              runtimeId: 'cl_ready000000001:claude-code',
              deviceLinkId: 'cl_ready000000001',
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

    const decision = resolveRuntimeSchedulingTarget(snapshot, 'cl_ready000000001');

    expect(decision).toMatchObject({
      eligible: true,
      runtimeId: 'cl_ready000000001:claude-code',
      executionNode: 'runtime:cl_ready000000001:claude-code',
    });
  });
});
