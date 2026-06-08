import { describe, expect, test } from 'vitest';

import { evaluateAgentTeamApprovalPolicy } from '../src/agent-team-engine.js';

describe('agent team approval policy evaluator', () => {
  test('requires all approvers for all-of policy', () => {
    const result = evaluateAgentTeamApprovalPolicy(
      { mode: 'all_of', approverRoleIds: ['owner', 'security'] },
      [
        { approverRoleId: 'owner', decision: 'approved' },
        { approverRoleId: 'security', decision: 'approved' },
      ],
    );

    expect(result.status).toBe('approved');
  });

  test('rejects quorum policy when any approver rejects', () => {
    const result = evaluateAgentTeamApprovalPolicy(
      { mode: 'quorum', approverRoleIds: ['a', 'b', 'c'], quorum: 2 },
      [
        { approverRoleId: 'a', decision: 'approved' },
        { approverRoleId: 'b', decision: 'rejected' },
      ],
    );

    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('b rejected');
  });
});
