import { describe, expect, test } from 'vitest';

import { evaluateOrchestrationPolicy } from '../src/orchestration-policy.js';

const baseRuntime = {
  id: 'runtime:device-1:codex',
  kind: 'runtime' as const,
  source: 'device' as const,
  sourceId: 'device-1:codex',
  displayName: 'Codex Runtime',
  description: 'runtime',
  version: null,
  capabilities: ['repo', 'terminal'],
  permissionScopes: [],
  riskLevel: 'low' as const,
  compatibleRuntimeIds: [],
  runtimeCompatibility: { compatible: 1, total: 1, blockedRuntimeIds: [] },
  updatedAt: '2026-06-15T00:00:00.000Z',
};

describe('orchestration policy engine', () => {
  test('auto-dispatches low-risk issue when agent and runtime are compatible', () => {
    const decision = evaluateOrchestrationPolicy({
      source: 'issue',
      item: {
        id: 'iss_1',
        title: 'Summarize repository status',
        description: 'Read files and summarize current state',
        priority: 'medium',
        selectedSkillIds: [],
      },
      registry: {
        summary: { dependencyConflicts: 0 },
        capabilityCatalog: [
          {
            id: 'agent:reader',
            kind: 'agent',
            source: 'local',
            sourceId: 'reader',
            displayName: 'Reader Agent',
            description: 'Reads repository state',
            version: '1.0.0',
            capabilities: ['repo'],
            permissionScopes: ['repo_read'],
            riskLevel: 'medium',
            compatibleRuntimeIds: ['device-1:codex'],
            runtimeCompatibility: { compatible: 1, total: 1, blockedRuntimeIds: [] },
            updatedAt: '2026-06-15T00:00:00.000Z',
          },
          baseRuntime,
        ],
      },
    });

    expect(decision).toMatchObject({
      eligible: true,
      mode: 'auto',
      targetAgentId: 'reader',
      targetRuntimeId: 'device-1:codex',
      riskLevel: 'medium',
      approvalRequired: false,
      blockers: [],
    });
    expect(decision.reasons).toContain('Matched agent capability: repo');
    expect(decision.reasons).toContain('Runtime has compatible available capacity');
  });

  test('requires approval for high-risk terminal and repo-write work', () => {
    const decision = evaluateOrchestrationPolicy({
      source: 'task',
      item: {
        id: 'task_1',
        title: 'Deploy service',
        description: 'Run deploy command and write release files',
        priority: 'urgent',
        selectedSkillIds: ['deploy-helper'],
      },
      registry: {
        summary: { dependencyConflicts: 0 },
        capabilityCatalog: [
          {
            id: 'agent:shipper',
            kind: 'agent',
            source: 'local',
            sourceId: 'shipper',
            displayName: 'Shipping Agent',
            description: 'Deploys services',
            version: '1.0.0',
            capabilities: ['repo', 'terminal'],
            permissionScopes: ['repo_write', 'terminal'],
            riskLevel: 'high',
            compatibleRuntimeIds: ['device-1:codex'],
            runtimeCompatibility: { compatible: 1, total: 1, blockedRuntimeIds: [] },
            updatedAt: '2026-06-15T00:00:00.000Z',
          },
          baseRuntime,
        ],
      },
    });

    expect(decision).toMatchObject({
      eligible: true,
      mode: 'approval_required',
      targetAgentId: 'shipper',
      targetRuntimeId: 'device-1:codex',
      riskLevel: 'high',
      approvalRequired: true,
      permissionScopes: ['repo_write', 'terminal'],
    });
    expect(decision.reasons).toContain('High-risk permission requires approval');
  });

  test('blocks dispatch when dependency conflicts or compatible runtime are missing', () => {
    const decision = evaluateOrchestrationPolicy({
      source: 'issue',
      item: {
        id: 'iss_2',
        title: 'Fix failing deployment',
        description: 'Needs terminal access',
        priority: 'high',
        selectedSkillIds: [],
      },
      registry: {
        summary: { dependencyConflicts: 1 },
        capabilityCatalog: [
          {
            id: 'agent:ops',
            kind: 'agent',
            source: 'local',
            sourceId: 'ops',
            displayName: 'Ops Agent',
            description: 'Runs operations',
            version: '1.0.0',
            capabilities: ['terminal'],
            permissionScopes: ['terminal'],
            riskLevel: 'high',
            compatibleRuntimeIds: [],
            runtimeCompatibility: { compatible: 0, total: 1, blockedRuntimeIds: ['device-1:codex'] },
            updatedAt: '2026-06-15T00:00:00.000Z',
          },
          baseRuntime,
        ],
      },
    });

    expect(decision).toMatchObject({
      eligible: false,
      mode: 'blocked',
      targetAgentId: 'ops',
      targetRuntimeId: undefined,
      approvalRequired: false,
    });
    expect(decision.blockers).toEqual(
      expect.arrayContaining([
        'Registry dependency conflicts must be resolved before auto-dispatch',
        'No compatible runtime is currently available for the selected agent',
      ]),
    );
  });
});
