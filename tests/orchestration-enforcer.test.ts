import { describe, expect, test, vi } from 'vitest';

import type { OrchestrationDecision } from '../src/orchestration-policy.js';
import { enforceOrchestrationDecision } from '../src/orchestration-enforcer.js';

function decision(overrides: Partial<OrchestrationDecision>): OrchestrationDecision {
  return {
    eligible: true,
    mode: 'auto',
    targetAgentId: 'agent-a',
    targetRuntimeId: 'runtime-a',
    requiredSkillIds: [],
    permissionScopes: [],
    riskLevel: 'medium',
    reasons: ['matched'],
    blockers: [],
    approvalRequired: false,
    enforcementAction: 'execute',
    ...overrides,
  };
}

describe('orchestration enforcer', () => {
  test('executes auto decisions after writing a policy event', async () => {
    const createEvent = vi.fn();
    const execute = vi.fn(async () => ({ runId: 'run_1' }));

    const result = await enforceOrchestrationDecision({
      source: 'issue',
      sourceId: 'iss_1',
      title: 'Summarize repo',
      decision: decision({ mode: 'auto', enforcementAction: 'execute' }),
      now: '2026-06-15T00:00:00.000Z',
      createEvent,
      execute,
    });

    expect(result).toEqual({ action: 'executed', runId: 'run_1' });
    expect(createEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'orchestration_policy_auto',
      title: 'Orchestration policy: execute',
      source: 'issue',
      sourceId: 'iss_1',
      runId: 'run_1',
    }));
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test('creates an approval request for approval_required decisions without executing', async () => {
    const createEvent = vi.fn();
    const createApprovalRequest = vi.fn(async () => ({ requestId: 'req_1', runId: 'run_waiting' }));
    const execute = vi.fn();

    const result = await enforceOrchestrationDecision({
      source: 'issue',
      sourceId: 'iss_2',
      title: 'Deploy service',
      decision: decision({
        mode: 'approval_required',
        enforcementAction: 'request_approval',
        riskLevel: 'high',
        permissionScopes: ['repo_write', 'terminal'],
        approvalRequired: true,
      }),
      now: '2026-06-15T00:00:00.000Z',
      createEvent,
      createApprovalRequest,
      execute,
    });

    expect(result).toEqual({ action: 'approval_requested', requestId: 'req_1', runId: 'run_waiting' });
    expect(createApprovalRequest).toHaveBeenCalledWith(expect.objectContaining({
      source: 'issue',
      sourceId: 'iss_2',
      title: 'Deploy service',
      decision: expect.objectContaining({ mode: 'approval_required' }),
    }));
    expect(createEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'orchestration_policy_approval_required',
      title: 'Orchestration policy: request approval',
    }));
    expect(execute).not.toHaveBeenCalled();
  });

  test('blocks blocked decisions by logging policy state only', async () => {
    const createEvent = vi.fn();
    const execute = vi.fn();

    const result = await enforceOrchestrationDecision({
      source: 'task',
      sourceId: 'task_1',
      title: 'Run shell command',
      decision: decision({
        eligible: false,
        mode: 'blocked',
        enforcementAction: 'block',
        blockers: ['No compatible runtime'],
      }),
      now: '2026-06-15T00:00:00.000Z',
      createEvent,
      execute,
    });

    expect(result).toEqual({ action: 'blocked', reason: 'No compatible runtime' });
    expect(createEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'orchestration_policy_blocked',
      title: 'Orchestration policy: blocked',
      detail: 'No compatible runtime',
    }));
    expect(execute).not.toHaveBeenCalled();
  });

  test('keeps manual decisions non-executing and records manual review', async () => {
    const createEvent = vi.fn();
    const execute = vi.fn();

    const result = await enforceOrchestrationDecision({
      source: 'task',
      sourceId: 'task_2',
      title: 'Ambiguous task',
      decision: decision({ mode: 'manual', enforcementAction: 'manual_review' }),
      now: '2026-06-15T00:00:00.000Z',
      createEvent,
      execute,
    });

    expect(result).toEqual({ action: 'manual_review', reason: 'Manual orchestration review required' });
    expect(createEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'orchestration_policy_manual',
      title: 'Orchestration policy: manual review',
    }));
    expect(execute).not.toHaveBeenCalled();
  });
});
