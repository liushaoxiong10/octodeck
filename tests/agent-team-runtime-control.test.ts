import { describe, expect, test, vi } from 'vitest';

import {
  cancelAgentTeamRun,
  clearAgentTeamRuntimeControlsForTests,
  registerAgentTeamTaskCancellation,
  resolveAgentTeamRoleWorkspace,
  validateAgentTeamRoleRuntimeTargets,
} from '../src/agent-team-runtime-control.js';

describe('agent team runtime control', () => {
  test('cancels every registered task for a run exactly once', () => {
    clearAgentTeamRuntimeControlsForTests();
    const first = vi.fn();
    const second = vi.fn();

    const unregisterFirst = registerAgentTeamTaskCancellation({
      runId: 'run_1',
      taskId: 'task_1',
      cancel: first,
    });
    registerAgentTeamTaskCancellation({
      runId: 'run_1',
      taskId: 'task_2',
      cancel: second,
    });

    const result = cancelAgentTeamRun('run_1', 'user_cancel');
    const secondResult = cancelAgentTeamRun('run_1', 'user_cancel_again');

    expect(result.cancelledTaskIds).toEqual(['task_1', 'task_2']);
    expect(result.errors).toEqual([]);
    expect(secondResult.cancelledTaskIds).toEqual([]);
    expect(first).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledWith('user_cancel');
    expect(second).toHaveBeenCalledTimes(1);

    unregisterFirst();
  });

  test('keeps cancelling other tasks when one cancel handler throws', () => {
    clearAgentTeamRuntimeControlsForTests();
    const broken = vi.fn(() => {
      throw new Error('socket closed');
    });
    const healthy = vi.fn();

    registerAgentTeamTaskCancellation({
      runId: 'run_2',
      taskId: 'task_broken',
      cancel: broken,
    });
    registerAgentTeamTaskCancellation({
      runId: 'run_2',
      taskId: 'task_healthy',
      cancel: healthy,
    });

    const result = cancelAgentTeamRun('run_2', 'timeout');

    expect(result.cancelledTaskIds).toEqual(['task_healthy']);
    expect(result.errors).toEqual([
      { taskId: 'task_broken', error: 'socket closed' },
    ]);
    expect(healthy).toHaveBeenCalledWith('timeout');
  });

  test('resolves default per-role workspace without changing caller cwd', () => {
    const workspace = resolveAgentTeamRoleWorkspace({
      teamId: 'team_1',
      runId: 'run_1',
      roleId: 'planner',
      roleName: 'Planner',
      workspacePolicy: undefined,
      runtimeGroupFolder: undefined,
      runtimeRemoteToolCwd: '/repo',
    });

    expect(workspace.policy).toBe('none');
    expect(workspace.groupFolder).toBe('agent-team-team_1-planner');
    expect(workspace.remoteToolCwd).toBe('/repo');
    expect(workspace.cleanupScope).toBe('session');
  });

  test('resolves sandbox workspace under run and role scoped folder', () => {
    const workspace = resolveAgentTeamRoleWorkspace({
      teamId: 'team_1',
      runId: 'run_1',
      roleId: 'writer',
      roleName: 'Writer',
      workspacePolicy: 'sandbox',
      runtimeGroupFolder: 'custom-root',
      runtimeRemoteToolCwd: '/repo',
    });

    expect(workspace.policy).toBe('sandbox');
    expect(workspace.groupFolder).toBe('custom-root/run_1/writer');
    expect(workspace.remoteToolCwd).toBe(
      '/repo/.octodeck/agent-team-runs/run_1/writer',
    );
    expect(workspace.cleanupScope).toBe('run');
  });

  test('validates role runtime targets before execution starts', () => {
    const result = validateAgentTeamRoleRuntimeTargets({
      roles: [
        { id: 'planner', name: 'Planner', policy: {} },
        { id: 'device_worker', name: 'Device Worker', policy: { workspacePolicy: 'device' } },
      ],
      roleAssignments: {
        planner: { runnerAgentId: 'blocked_runner' },
        ghost: { runnerAgentId: 'runner_a' },
      },
      defaultRunnerAgentId: 'runner_a',
      allowedBackends: ['runner_a', 'runner_b'],
      resolveBackend: (backendId) =>
        backendId === 'runner_a'
          ? { supportsExecutionMode: () => true }
          : undefined,
      resolveDeviceLink: () => undefined,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
    expect(result.errors).toEqual(expect.arrayContaining([
      'role planner runner blocked_runner is not in allowedBackends',
      'role assignment ghost does not match any team role',
      'role device_worker requires a device link for workspacePolicy=device',
    ]));
    expect(result.errors).toHaveLength(3);
  });

  test('accepts assigned device roles with host backend and device link', () => {
    const result = validateAgentTeamRoleRuntimeTargets({
      roles: [
        { id: 'device_worker', name: 'Device Worker', policy: { workspacePolicy: 'device' } },
      ],
      roleAssignments: {
        device_worker: { runnerAgentId: 'runner_b', linkId: 'cl_device' },
      },
      defaultRunnerAgentId: 'runner_a',
      allowedBackends: ['runner_a', 'runner_b'],
      resolveBackend: (backendId) => ({
        supportsExecutionMode: (mode) => mode === 'host' && backendId.startsWith('runner_'),
      }),
      resolveDeviceLink: (_runnerAgentId, assignment) => assignment?.linkId,
    });

    expect(result).toEqual({ ok: true, errors: [] });
  });

  test('rejects role assignments whose resolved runtime is blocked', () => {
    const result = validateAgentTeamRoleRuntimeTargets({
      roles: [{ id: 'builder', name: 'Builder', policy: { workspacePolicy: 'device' } }],
      roleAssignments: {
        builder: { runnerAgentId: 'runner_a', linkId: 'cl_full0000000001', agentClientId: 'claude-code' },
      },
      defaultRunnerAgentId: 'runner_a',
      allowedBackends: ['runner_a'],
      resolveBackend: () => ({ supportsExecutionMode: () => true }),
      resolveDeviceLink: (_runnerAgentId, assignment) => assignment?.linkId,
      resolveRuntimeTarget: () => ({
        ok: false,
        runtimeId: 'cl_full0000000001:claude-code',
        executionNode: 'runtime:cl_full0000000001:claude-code',
        deviceLinkId: 'cl_full0000000001',
        agentClientId: 'claude-code',
        blockedReason: 'runtime_full',
        schedulingReason: 'target_blocked',
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(409);
    expect(result.errors).toContain('role builder runtime cl_full0000000001:claude-code is not schedulable: runtime_full');
  });
});
