import type { QualityEvaluation, QualityOutcome } from './quality-evaluator.js';

export interface QualitySummaryScorecard {
  total: number;
  passed: number;
  failed: number;
  needsReview: number;
  inconclusive: number;
  partial: number;
  averageScore: number;
  passRate: number;
}

export interface ReliabilityScorecardRow {
  id: string;
  total: number;
  passed: number;
  failed: number;
  needsReview: number;
  averageScore: number;
  reliability: number;
  failureCategories: Record<string, number>;
}

export interface QualityScorecards {
  summary: QualitySummaryScorecard;
  runtimes: ReliabilityScorecardRow[];
  agents: ReliabilityScorecardRow[];
  policies: ReliabilityScorecardRow[];
  insights: string[];
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function countOutcome(evaluations: QualityEvaluation[], outcome: QualityOutcome): number {
  return evaluations.filter((evaluation) => evaluation.outcome === outcome).length;
}

function buildSummary(evaluations: QualityEvaluation[]): QualitySummaryScorecard {
  const total = evaluations.length;
  const passed = countOutcome(evaluations, 'passed');
  const failed = countOutcome(evaluations, 'failed');
  const needsReview = countOutcome(evaluations, 'needs_review');
  const inconclusive = countOutcome(evaluations, 'inconclusive');
  const partial = countOutcome(evaluations, 'partial');
  const averageScore = total > 0
    ? Math.round(evaluations.reduce((sum, evaluation) => sum + evaluation.score, 0) / total)
    : 0;
  return {
    total,
    passed,
    failed,
    needsReview,
    inconclusive,
    partial,
    averageScore,
    passRate: total > 0 ? round2(passed / total) : 0,
  };
}

function buildRows(
  evaluations: QualityEvaluation[],
  keyFor: (evaluation: QualityEvaluation) => string | null | undefined,
): ReliabilityScorecardRow[] {
  const buckets = new Map<string, QualityEvaluation[]>();
  for (const evaluation of evaluations) {
    const key = keyFor(evaluation)?.trim();
    if (!key) continue;
    const bucket = buckets.get(key) ?? [];
    bucket.push(evaluation);
    buckets.set(key, bucket);
  }
  return [...buckets.entries()].map(([id, items]) => {
    const total = items.length;
    const passed = countOutcome(items, 'passed');
    const failed = countOutcome(items, 'failed');
    const needsReview = countOutcome(items, 'needs_review');
    const averageScore = total > 0 ? Math.round(items.reduce((sum, item) => sum + item.score, 0) / total) : 0;
    const failureCategories = items.reduce<Record<string, number>>((acc, item) => {
      if (item.failureCategory) acc[item.failureCategory] = (acc[item.failureCategory] ?? 0) + 1;
      return acc;
    }, {});
    return {
      id,
      total,
      passed,
      failed,
      needsReview,
      averageScore,
      reliability: total > 0 ? round2(passed / total) : 0,
      failureCategories,
    };
  }).sort((a, b) => {
    if (a.reliability !== b.reliability) return a.reliability - b.reliability;
    if (a.total !== b.total) return b.total - a.total;
    return a.id.localeCompare(b.id);
  });
}

function buildInsights(input: Pick<QualityScorecards, 'summary' | 'runtimes' | 'agents' | 'policies'>): string[] {
  const insights: string[] = [];
  const lowestRuntime = input.runtimes.find((row) => row.total > 0);
  if (lowestRuntime) {
    insights.push(`Lowest reliability runtime: ${lowestRuntime.id} (${Math.round(lowestRuntime.reliability * 100)}%)`);
  }
  const lowestAgent = input.agents.find((row) => row.total > 0);
  if (lowestAgent) {
    insights.push(`Lowest reliability agent: ${lowestAgent.id} (${Math.round(lowestAgent.reliability * 100)}%)`);
  }
  if (input.summary.needsReview > 0) {
    insights.push(`${input.summary.needsReview} run(s) need human quality review`);
  }
  if (input.summary.failed > 0) {
    insights.push(`${input.summary.failed} run(s) failed quality gates`);
  }
  return insights;
}

export function buildQualityScorecards(evaluations: QualityEvaluation[]): QualityScorecards {
  const summary = buildSummary(evaluations);
  const runtimes = buildRows(evaluations, (evaluation) => evaluation.runtimeId);
  const agents = buildRows(evaluations, (evaluation) => evaluation.agentClientId);
  const policies = buildRows(evaluations, (evaluation) => evaluation.policyMode);
  return {
    summary,
    runtimes,
    agents,
    policies,
    insights: buildInsights({ summary, runtimes, agents, policies }),
  };
}
