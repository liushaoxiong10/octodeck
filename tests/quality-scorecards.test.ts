import { describe, expect, test } from 'vitest';

import { buildQualityScorecards } from '../src/quality-scorecards.js';
import type { QualityEvaluation } from '../src/quality-evaluator.js';

function evaluation(input: Partial<QualityEvaluation> & Pick<QualityEvaluation, 'id' | 'source' | 'sourceId' | 'outcome' | 'score'>): QualityEvaluation {
  return {
    runId: input.runId ?? input.id,
    title: input.title ?? input.id,
    confidence: input.confidence ?? 'medium',
    failureCategory: input.failureCategory ?? null,
    needsReview: input.needsReview ?? false,
    evidence: input.evidence ?? [],
    reasons: input.reasons ?? [],
    runtimeId: input.runtimeId ?? null,
    agentClientId: input.agentClientId ?? null,
    policyMode: input.policyMode ?? null,
    createdAt: input.createdAt ?? '2026-06-15T00:00:00.000Z',
    ...input,
  };
}

describe('quality scorecards', () => {
  test('aggregates quality summary and reliability by runtime, agent, and policy mode', () => {
    const scorecards = buildQualityScorecards([
      evaluation({
        id: 'q1',
        source: 'issue',
        sourceId: 'iss_1',
        outcome: 'passed',
        score: 94,
        runtimeId: 'runtime:cl_ready:claude-code',
        agentClientId: 'claude-code',
        policyMode: 'auto',
      }),
      evaluation({
        id: 'q2',
        source: 'issue',
        sourceId: 'iss_2',
        outcome: 'failed',
        score: 20,
        failureCategory: 'runtime_failure',
        runtimeId: 'runtime:cl_bad:claude-code',
        agentClientId: 'claude-code',
        policyMode: 'auto',
      }),
      evaluation({
        id: 'q3',
        source: 'task',
        sourceId: 'task_1',
        outcome: 'needs_review',
        score: 62,
        needsReview: true,
        runtimeId: 'runtime:cl_ready:codex',
        agentClientId: 'codex',
        policyMode: 'approval_required',
      }),
      evaluation({
        id: 'q4',
        source: 'agent_team',
        sourceId: 'team_1',
        outcome: 'inconclusive',
        score: 50,
        agentClientId: 'planner',
      }),
    ]);

    expect(scorecards.summary).toMatchObject({
      total: 4,
      passed: 1,
      failed: 1,
      needsReview: 1,
      inconclusive: 1,
      averageScore: 57,
      passRate: 0.25,
    });
    expect(scorecards.runtimes.find((row) => row.id === 'runtime:cl_ready:claude-code')).toMatchObject({ total: 1, passed: 1, reliability: 1 });
    expect(scorecards.agents.find((row) => row.id === 'claude-code')).toMatchObject({ total: 2, passed: 1, failed: 1, reliability: 0.5 });
    expect(scorecards.policies.find((row) => row.id === 'auto')).toMatchObject({ total: 2, passed: 1, failed: 1, reliability: 0.5 });
    expect(scorecards.insights[0]).toContain('Lowest reliability runtime');
  });
});
