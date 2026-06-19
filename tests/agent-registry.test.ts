import { describe, expect, test } from 'vitest';

import { buildTeamAgentRegistrySnapshot } from '../src/agent-registry.js';

describe('team agent registry snapshot', () => {
  test('links versioned agent definitions to installed skill packages and install records', () => {
    const snapshot = buildTeamAgentRegistrySnapshot({
      agents: [
        {
          id: 'reviewer',
          name: 'Review Agent',
          description: 'Reviews diffs',
          tools: ['Read'],
          version: '1.4.0',
          visibility: 'team',
          defaultModel: 'claude-sonnet-4',
          requiredSkills: [
            { id: 'bits-code-guard', version: '^1.2.0', raw: 'bits-code-guard@^1.2.0' },
            { id: 'graphify', version: null, raw: 'graphify' },
          ],
          updatedAt: '2026-06-12T00:00:00.000Z',
        },
      ],
      skills: [
        {
          skillId: 'bits-code-guard',
          name: 'Code Guard',
          description: 'Review code changes',
          content: '---\nversion: 1.2.3\nauthor: devinfra\n---\n# Code Guard\n',
          packageName: '@octodeck/code-guard',
          packageSource: 'https://skills.example/code-guard',
          sourceProvider: 'claude',
          installedAt: '2026-06-12T00:01:00.000Z',
          updatedAt: '2026-06-12T00:02:00.000Z',
          files: [{ name: 'SKILL.md', type: 'file', size: 55 }],
        },
      ],
    });

    expect(snapshot.summary).toMatchObject({
      totalAgents: 1,
      totalSkillPackages: 1,
      unresolvedSkillDependencies: 1,
    });
    expect(snapshot.agents[0]).toMatchObject({
      id: 'reviewer',
      version: '1.4.0',
      visibility: 'team',
      defaultModel: 'claude-sonnet-4',
      requiredSkills: [
        {
          id: 'bits-code-guard',
          requestedVersion: '^1.2.0',
          installed: true,
          installedVersion: '1.2.3',
          packageId: '@octodeck/code-guard',
        },
        {
          id: 'graphify',
          requestedVersion: null,
          installed: false,
          packageId: null,
        },
      ],
    });
    expect(snapshot.skillPackages[0]).toMatchObject({
      id: '@octodeck/code-guard',
      skillIds: ['bits-code-guard'],
      version: '1.2.3',
      author: 'devinfra',
      fileCount: 1,
      totalBytes: 55,
      fileManifest: [
        {
          skillId: 'bits-code-guard',
          name: 'SKILL.md',
          type: 'file',
          size: 55,
        },
      ],
      providerTargets: ['claude'],
      installRecords: [
        {
          skillId: 'bits-code-guard',
          target: 'cloud',
          provider: 'claude',
          installedAt: '2026-06-12T00:01:00.000Z',
        },
      ],
    });
    expect(snapshot.skillPackages[0].checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test('flags installed skill dependencies whose versions do not satisfy agent requirements', () => {
    const snapshot = buildTeamAgentRegistrySnapshot({
      agents: [
        {
          id: 'reviewer',
          name: 'Review Agent',
          description: 'Reviews diffs',
          tools: ['Read'],
          version: '1.4.0',
          visibility: 'team',
          defaultModel: 'claude-sonnet-4',
          requiredSkills: [
            { id: 'bits-code-guard', version: '^1.2.0', raw: 'bits-code-guard@^1.2.0' },
            { id: 'graphify', version: '2.0.0', raw: 'graphify@2.0.0' },
          ],
          updatedAt: '2026-06-12T00:00:00.000Z',
        },
      ],
      skills: [
        {
          skillId: 'bits-code-guard',
          name: 'Code Guard',
          description: 'Review code changes',
          content: '---\nversion: 2.0.0\nauthor: devinfra\n---\n# Code Guard\n',
          packageName: '@octodeck/code-guard',
          packageSource: 'https://skills.example/code-guard',
          sourceProvider: 'claude',
          installedAt: '2026-06-12T00:01:00.000Z',
          updatedAt: '2026-06-12T00:02:00.000Z',
          files: [{ name: 'SKILL.md', type: 'file', size: 55 }],
        },
        {
          skillId: 'graphify',
          name: 'Graphify',
          description: 'Builds a code graph',
          content: '---\nversion: 2.0.0\nauthor: platform\n---\n# Graphify\n',
          packageName: '@octodeck/graphify',
          packageSource: 'https://skills.example/graphify',
          sourceProvider: 'codex',
          installedAt: '2026-06-12T00:01:00.000Z',
          updatedAt: '2026-06-12T00:02:00.000Z',
          files: [{ name: 'SKILL.md', type: 'file', size: 55 }],
        },
      ],
    });

    expect(snapshot.summary.dependencyConflicts).toBe(1);
    expect(snapshot.dependencyConflicts).toEqual([
      {
        agentId: 'reviewer',
        skillId: 'bits-code-guard',
        requestedVersion: '^1.2.0',
        installedVersion: '2.0.0',
        packageId: '@octodeck/code-guard',
      },
    ]);
    expect(snapshot.agents[0].requiredSkills).toEqual([
      expect.objectContaining({
        id: 'bits-code-guard',
        installed: true,
        versionSatisfied: false,
      }),
      expect.objectContaining({
        id: 'graphify',
        installed: true,
        versionSatisfied: true,
      }),
    ]);
  });

  test('builds a unified governance catalog with permission risk and runtime compatibility', () => {
    const snapshot = buildTeamAgentRegistrySnapshot({
      agents: [
        {
          id: 'shipper',
          name: 'Shipping Agent',
          description: 'Updates repositories and runs deploy commands',
          tools: ['Read', 'Bash', 'Write'],
          version: '2.1.0',
          visibility: 'team',
          defaultModel: 'claude-sonnet-4',
          requiredSkills: [{ id: 'deploy-helper', version: '^1.0.0', raw: 'deploy-helper@^1.0.0' }],
          updatedAt: '2026-06-15T00:00:00.000Z',
        },
      ],
      skills: [
        {
          skillId: 'deploy-helper',
          name: 'Deploy Helper',
          description: 'Deploys services from an approved repo',
          content: '---\nversion: 1.1.0\ncapabilities: deploy, repo\npermissions: repo_write, terminal, network\nrisk-level: high\nminimum-octodeck-version: 0.14.0\n---\n# Deploy Helper\n',
          packageName: '@octodeck/deploy-helper',
          packageSource: 'https://skills.example/deploy-helper',
          sourceProvider: 'codex',
          installedAt: '2026-06-15T00:01:00.000Z',
          updatedAt: '2026-06-15T00:02:00.000Z',
          files: [{ name: 'SKILL.md', type: 'file', size: 155 }],
        },
      ],
      runtimes: [
        {
          runtimeId: 'device-1:codex',
          kind: 'device',
          displayName: 'Mac Studio Codex',
          agentClientId: 'codex',
          provider: 'codex',
          transport: 'stdio',
          status: 'idle',
          health: 'available',
          capabilities: ['repo', 'terminal', 'network'],
          availableSlots: 1,
          updatedAt: '2026-06-15T00:03:00.000Z',
        },
      ],
    });

    expect(snapshot.summary.totalRegistryItems).toBe(3);
    expect(snapshot.summary.highRiskItems).toBe(2);
    expect(snapshot.summary.compatibleRuntimeLinks).toBe(2);

    expect(snapshot.capabilityCatalog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'agent:shipper',
          kind: 'agent',
          source: 'local',
          version: '2.1.0',
          riskLevel: 'high',
          permissionScopes: expect.arrayContaining(['repo_read', 'repo_write', 'terminal']),
          compatibleRuntimeIds: ['device-1:codex'],
        }),
        expect.objectContaining({
          id: 'skill:deploy-helper',
          kind: 'skill',
          source: 'cloud',
          version: '1.1.0',
          minimumOctodeckVersion: '0.14.0',
          riskLevel: 'high',
          permissionScopes: ['network', 'repo_write', 'terminal'],
          compatibleRuntimeIds: ['device-1:codex'],
        }),
        expect.objectContaining({
          id: 'runtime:device-1:codex',
          kind: 'runtime',
          source: 'device',
          capabilities: ['network', 'repo', 'terminal'],
          riskLevel: 'low',
        }),
      ]),
    );
  });
});
