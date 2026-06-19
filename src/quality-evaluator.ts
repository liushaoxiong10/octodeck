import type { AgentTask, IssueAgentRequest, IssueAgentRun, IssueAgentRunEvent, TaskRunLog } from './types.js';

export type QualityOutcome = 'passed' | 'failed' | 'partial' | 'needs_review' | 'inconclusive';
export type QualityConfidence = 'low' | 'medium' | 'high';
export type QualityFailureCategory =
  | 'test_failure'
  | 'build_failure'
  | 'runtime_failure'
  | 'permission_denied'
  | 'policy_blocked'
  | 'missing_context'
  | 'missing_verification'
  | 'user_rejected'
  | 'unknown';

export interface QualityEvidence {
  kind: 'verification' | 'runtime_recovery' | 'approval' | 'status' | 'code_change' | 'error' | 'policy';
  label: string;
  detail?: string | null;
}

export interface QualityEvaluation {
  id: string;
  source: 'issue' | 'task' | 'agent_team';
  sourceId: string;
  runId?: string | null;
  title?: string | null;
  outcome: QualityOutcome;
  confidence: QualityConfidence;
  score: number;
  failureCategory: QualityFailureCategory | null;
  needsReview: boolean;
  evidence: QualityEvidence[];
  reasons: string[];
  runtimeId?: string | null;
  agentClientId?: string | null;
  policyMode?: string | null;
  createdAt: string;
}

export interface EvaluateRunQualityInput {
  source: QualityEvaluation['source'];
  sourceId: string;
  title?: string | null;
  run?: Partial<IssueAgentRun> | null;
  events?: Partial<IssueAgentRunEvent>[];
  requests?: Partial<IssueAgentRequest>[];
  taskLog?: Partial<TaskRunLog> | null;
  agentTask?: Partial<AgentTask> | null;
  createdAt?: string;
}

function textIncludesVerification(text: string): boolean {
  return /\b(npm|pnpm|yarn|bun)\s+(test|build|lint|typecheck|run\s+(test|typecheck|build|lint))\b|\b(vitest|pytest|go\s+test|cargo\s+test|tsc|eslint|typecheck)\b/i.test(text);
}

function textIncludesCodeChange(text: string): boolean {
  return /\b(modified|changed|created|updated|edited|files? changed|diff|patch)\b|\b(src|web|tests)\//i.test(text);
}

function failureCategoryFromText(text: string): QualityFailureCategory {
  if (/test|vitest|pytest|assert|expect/i.test(text)) return 'test_failure';
  if (/build|tsc|typecheck|compile/i.test(text)) return 'build_failure';
  if (/runtime|heartbeat|offline|degraded|lost|daemon|failover/i.test(text)) return 'runtime_failure';
  if (/permission|denied|unauthorized|forbidden/i.test(text)) return 'permission_denied';
  if (/blocked|policy/i.test(text)) return 'policy_blocked';
  if (/context|not found|missing/i.test(text)) return 'missing_context';
  return 'unknown';
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

function qualityId(source: QualityEvaluation['source'], sourceId: string, runId: string | null | undefined, suffix: string): string {
  return `quality:${source}:${sourceId}:${runId ?? suffix}`;
}

export function evaluateRunQuality(input: EvaluateRunQualityInput): QualityEvaluation {
  const events = input.events ?? [];
  const requests = input.requests ?? [];
  const run = input.run ?? null;
  const taskLog = input.taskLog ?? null;
  const agentTask = input.agentTask ?? null;
  const status = String(run?.status ?? taskLog?.status ?? agentTask?.status ?? 'unknown');
  const resultText = [run?.result, run?.error, taskLog?.result, taskLog?.error, agentTask?.result, agentTask?.error]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join('\n');
  const evidence: QualityEvidence[] = [];
  const reasons: string[] = [];

  const rejected = requests.some((request) => request.kind === 'permission' && request.status === 'answered' && request.decision === 'reject');
  const runtimeRecovered = events.some((event) => event.event_type === 'runtime_self_healed');
  const verificationEvent = events.find((event) => /verification|test|typecheck|build|lint/i.test(event.event_type ?? '') || textIncludesVerification(`${event.title ?? ''} ${event.summary ?? ''} ${event.detail ?? ''}`));
  const hasVerification = Boolean(verificationEvent) || textIncludesVerification(resultText);
  const codeChangeEvent = events.find((event) => /file|diff|patch|change/i.test(event.event_type ?? '') || textIncludesCodeChange(`${event.title ?? ''} ${event.summary ?? ''} ${event.detail ?? ''}`));
  const hasCodeChanges = Boolean(codeChangeEvent) || Boolean(run?.selected_skills?.length) || textIncludesCodeChange(resultText);

  evidence.push({ kind: 'status', label: `Run status: ${status}` });
  if (hasVerification) evidence.push({ kind: 'verification', label: 'Verification evidence detected', detail: verificationEvent?.summary ?? resultText.slice(0, 180) });
  if (hasCodeChanges) evidence.push({ kind: 'code_change', label: 'Code change evidence detected', detail: codeChangeEvent?.summary ?? null });
  if (runtimeRecovered) evidence.push({ kind: 'runtime_recovery', label: 'Runtime self-healing occurred' });
  if (rejected) evidence.push({ kind: 'approval', label: 'Approval rejected by user' });
  if (resultText && /error|failed|exception/i.test(resultText)) evidence.push({ kind: 'error', label: 'Error output detected', detail: resultText.slice(0, 220) });

  let outcome: QualityOutcome = 'inconclusive';
  let confidence: QualityConfidence = 'medium';
  let failureCategory: QualityFailureCategory | null = null;
  let score = 50;
  let needsReview = false;

  if (rejected) {
    outcome = 'failed';
    confidence = 'high';
    failureCategory = 'user_rejected';
    score = 15;
    reasons.push('User rejected the required approval');
  } else if (status === 'error' || status === 'lost' || status === 'canceled' || status === 'skipped') {
    outcome = 'failed';
    confidence = resultText ? 'high' : 'medium';
    failureCategory = failureCategoryFromText(resultText || status);
    needsReview = true;
    score = failureCategory === 'policy_blocked' ? 35 : 20;
    reasons.push(`Terminal status indicates failure: ${status}`);
  } else if (status === 'success') {
    if (hasCodeChanges && !hasVerification) {
      outcome = 'needs_review';
      confidence = 'medium';
      failureCategory = 'missing_verification';
      needsReview = true;
      score = 62;
      reasons.push('Code changes were detected without verification evidence');
    } else {
      outcome = 'passed';
      confidence = hasVerification ? 'high' : 'medium';
      score = hasVerification ? 94 : 82;
      reasons.push(hasVerification ? 'Run completed with verification evidence' : 'Run completed successfully');
    }
  } else if (status === 'awaiting_input' || status === 'paused' || status === 'waiting_approval') {
    outcome = 'needs_review';
    confidence = 'medium';
    needsReview = true;
    failureCategory = status === 'waiting_approval' ? 'policy_blocked' : 'missing_context';
    score = 45;
    reasons.push(`Run is waiting for human input: ${status}`);
  }

  if (runtimeRecovered) {
    reasons.push('Runtime recovered before completion');
    score += outcome === 'passed' ? 0 : -5;
  }

  const policyPayload = events.map((event) => event.payload).find((payload) => payload?.decision || payload?.mode);
  const decision = policyPayload?.decision && typeof policyPayload.decision === 'object'
    ? policyPayload.decision as Record<string, unknown>
    : policyPayload as Record<string, unknown> | undefined;
  const policyMode = typeof decision?.mode === 'string' ? decision.mode : null;
  const runId = run?.id ?? agentTask?.run_ref ?? agentTask?.id ?? null;
  const createdAt = input.createdAt ?? run?.run_completed_at ?? run?.created_at ?? taskLog?.run_at ?? agentTask?.updated_at ?? agentTask?.created_at ?? new Date(0).toISOString();

  return {
    id: qualityId(input.source, input.sourceId, runId, taskLog?.run_at ?? 'snapshot'),
    source: input.source,
    sourceId: input.sourceId,
    runId,
    title: input.title ?? null,
    outcome,
    confidence,
    score: clampScore(score),
    failureCategory,
    needsReview,
    evidence,
    reasons,
    runtimeId: run?.execution_node ?? agentTask?.execution_node ?? null,
    agentClientId: run?.agent_client_id ?? agentTask?.agent_client_id ?? null,
    policyMode,
    createdAt,
  };
}

function reviewResolutionEligible(outcome: QualityOutcome): boolean {
  return outcome === 'needs_review' || outcome === 'partial' || outcome === 'inconclusive';
}

function payloadObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function resolveIssueRunQualityWithReviewChild(
  evaluation: QualityEvaluation,
  input: {
    parentRunId: string;
    runs: Partial<IssueAgentRun>[];
    parentEvents: Partial<IssueAgentRunEvent>[];
    eventsByRun?: Record<string, Partial<IssueAgentRunEvent>[]>;
  },
): QualityEvaluation {
  if (!reviewResolutionEligible(evaluation.outcome)) return evaluation;
  const successfulReviewRun = input.runs.find((candidate) => {
    if (candidate.parent_run_id !== input.parentRunId || candidate.status !== 'success' || !candidate.id) return false;
    return input.parentEvents.some((event) => {
      if (event.event_type !== 'review_agent_run_created') return false;
      return payloadObject(event.payload)?.reviewRunId === candidate.id;
    });
  });
  if (!successfulReviewRun?.id) return evaluation;
  return {
    ...evaluation,
    outcome: 'passed',
    confidence: 'medium',
    score: Math.max(evaluation.score, 82),
    failureCategory: null,
    needsReview: false,
    evidence: [
      ...evaluation.evidence,
      {
        kind: 'verification',
        label: 'Review Agent completed successfully',
        detail: successfulReviewRun.id,
      },
    ],
    reasons: [
      `Review Agent ${successfulReviewRun.id} completed successfully for this run`,
      ...evaluation.reasons,
    ],
  };
}
