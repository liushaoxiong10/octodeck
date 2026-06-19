import type { OrchestrationDecision, OrchestrationSource } from './orchestration-policy.js';

export type OrchestrationEnforcementAction =
  | 'executed'
  | 'approval_requested'
  | 'manual_review'
  | 'blocked';

export interface OrchestrationPolicyEventInput {
  source: OrchestrationSource;
  sourceId: string;
  runId?: string | null;
  eventType: string;
  title: string;
  summary: string;
  detail?: string | null;
  decision: OrchestrationDecision;
  createdAt: string;
}

export interface OrchestrationApprovalRequestInput {
  source: OrchestrationSource;
  sourceId: string;
  title: string;
  decision: OrchestrationDecision;
  createdAt: string;
}

export type OrchestrationEnforcementResult =
  | { action: 'executed'; runId?: string | null }
  | { action: 'approval_requested'; requestId?: string | null; runId?: string | null }
  | { action: 'manual_review'; reason: string }
  | { action: 'blocked'; reason: string };

export interface EnforceOrchestrationDecisionInput {
  source: OrchestrationSource;
  sourceId: string;
  title: string;
  decision: OrchestrationDecision;
  now?: string;
  createEvent: (event: OrchestrationPolicyEventInput) => void | Promise<void>;
  execute?: () => Promise<{ runId?: string | null } | void> | { runId?: string | null } | void;
  createApprovalRequest?: (
    request: OrchestrationApprovalRequestInput,
  ) => Promise<{ requestId?: string | null; runId?: string | null } | void> | { requestId?: string | null; runId?: string | null } | void;
}

function eventType(decision: OrchestrationDecision): string {
  return `orchestration_policy_${decision.mode}`;
}

function actionTitle(decision: OrchestrationDecision): string {
  switch (decision.enforcementAction) {
    case 'execute':
      return 'Orchestration policy: execute';
    case 'request_approval':
      return 'Orchestration policy: request approval';
    case 'manual_review':
      return 'Orchestration policy: manual review';
    case 'block':
      return 'Orchestration policy: blocked';
  }
}

function decisionDetail(decision: OrchestrationDecision): string | null {
  if (decision.blockers.length) return decision.blockers.join(' · ');
  if (decision.reasons.length) return decision.reasons.join(' · ');
  return null;
}

export async function enforceOrchestrationDecision(
  input: EnforceOrchestrationDecisionInput,
): Promise<OrchestrationEnforcementResult> {
  const createdAt = input.now ?? new Date().toISOString();
  let runId: string | null = null;

  if (input.decision.mode === 'auto' && input.decision.enforcementAction === 'execute') {
    const executed = await input.execute?.();
    runId = executed?.runId ?? null;
    await input.createEvent({
      source: input.source,
      sourceId: input.sourceId,
      runId,
      eventType: eventType(input.decision),
      title: actionTitle(input.decision),
      summary: input.title,
      detail: decisionDetail(input.decision),
      decision: input.decision,
      createdAt,
    });
    return { action: 'executed', runId };
  }

  if (input.decision.mode === 'approval_required' && input.decision.enforcementAction === 'request_approval') {
    const request = await input.createApprovalRequest?.({
      source: input.source,
      sourceId: input.sourceId,
      title: input.title,
      decision: input.decision,
      createdAt,
    });
    runId = request?.runId ?? null;
    await input.createEvent({
      source: input.source,
      sourceId: input.sourceId,
      runId,
      eventType: eventType(input.decision),
      title: actionTitle(input.decision),
      summary: input.title,
      detail: decisionDetail(input.decision),
      decision: input.decision,
      createdAt,
    });
    return {
      action: 'approval_requested',
      requestId: request?.requestId ?? null,
      runId,
    };
  }

  await input.createEvent({
    source: input.source,
    sourceId: input.sourceId,
    runId: null,
    eventType: eventType(input.decision),
    title: actionTitle(input.decision),
    summary: input.title,
    detail: decisionDetail(input.decision),
    decision: input.decision,
    createdAt,
  });

  if (input.decision.mode === 'blocked' || input.decision.enforcementAction === 'block') {
    return {
      action: 'blocked',
      reason: input.decision.blockers[0] ?? 'Orchestration policy blocked execution',
    };
  }

  return { action: 'manual_review', reason: 'Manual orchestration review required' };
}
