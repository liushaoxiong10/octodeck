import type { FixRunOutcomePayload } from './fix-run-outcome.js';

export type ResolutionGateStatus = 'ready' | 'approval_required' | 'blocked' | 'needs_review';
export type ResolutionGateBlockedReason = 'missing_fix_run_outcome' | 'fix_run_not_resolved' | 'failed_signals_present';

export interface ResolutionGateInput {
  issue: {
    id: string;
    title?: string | null;
    status?: string | null;
  };
  fixRunOutcome: FixRunOutcomePayload | null;
}

export interface ResolutionGate {
  status: ResolutionGateStatus;
  title: string;
  summary: string;
  recommendedIssueStatus: 'done' | 'review' | 'in_progress';
  archiveIncident: boolean;
  promoteRunbook: boolean;
  approvalRequired: boolean;
  sourceRunId?: string;
  fixRunId?: string;
  riskLevel: string;
  rationale: string[];
  checklist: string[];
  blockedReason?: ResolutionGateBlockedReason;
}

export interface ResolutionGatePayload {
  resolutionGate: ResolutionGate;
}

function blocked(input: ResolutionGateInput, reason: ResolutionGateBlockedReason): ResolutionGatePayload {
  const outcome = input.fixRunOutcome?.fixRunOutcome;
  return {
    resolutionGate: {
      status: 'blocked',
      title: 'Resolution gate blocked',
      summary: `Issue ${input.issue.title ?? input.issue.id} cannot be resolved automatically.`,
      recommendedIssueStatus: 'review',
      archiveIncident: false,
      promoteRunbook: false,
      approvalRequired: false,
      sourceRunId: outcome?.sourceRunId,
      fixRunId: outcome?.fixRunId,
      riskLevel: outcome?.riskLevel ?? 'medium',
      rationale: [reason, outcome?.summary].filter((item): item is string => Boolean(item)),
      checklist: outcome?.verificationChecklist ?? [],
      blockedReason: reason,
    },
  };
}

export function buildResolutionGate(input: ResolutionGateInput): ResolutionGatePayload {
  const outcome = input.fixRunOutcome?.fixRunOutcome;
  if (!outcome) return blocked(input, 'missing_fix_run_outcome');
  if (outcome.status === 'needs_review') {
    return {
      resolutionGate: {
        status: 'needs_review',
        title: 'Resolution needs review',
        summary: `Fix run ${outcome.fixRunId} completed without enough resolution evidence.`,
        recommendedIssueStatus: 'review',
        archiveIncident: false,
        promoteRunbook: false,
        approvalRequired: false,
        sourceRunId: outcome.sourceRunId,
        fixRunId: outcome.fixRunId,
        riskLevel: outcome.riskLevel,
        rationale: [outcome.summary, 'Manual review is required before closing the issue.'],
        checklist: outcome.verificationChecklist,
      },
    };
  }
  if (outcome.status !== 'resolved') return blocked(input, 'fix_run_not_resolved');
  if (outcome.failedSignals.length > 0) return blocked(input, 'failed_signals_present');
  if (outcome.riskLevel === 'critical') {
    return {
      resolutionGate: {
        status: 'approval_required',
        title: 'Resolution requires approval',
        summary: `Critical fix run ${outcome.fixRunId} is resolved but requires human approval before closure.`,
        recommendedIssueStatus: 'review',
        archiveIncident: true,
        promoteRunbook: true,
        approvalRequired: true,
        sourceRunId: outcome.sourceRunId,
        fixRunId: outcome.fixRunId,
        riskLevel: outcome.riskLevel,
        rationale: [outcome.summary, 'Critical-risk resolution must be approved before applying.'],
        checklist: outcome.verificationChecklist,
      },
    };
  }
  return {
    resolutionGate: {
      status: 'ready',
      title: 'Resolution ready to apply',
      summary: `Fix run ${outcome.fixRunId} resolved ${input.issue.title ?? input.issue.id}.`,
      recommendedIssueStatus: 'done',
      archiveIncident: true,
      promoteRunbook: true,
      approvalRequired: false,
      sourceRunId: outcome.sourceRunId,
      fixRunId: outcome.fixRunId,
      riskLevel: outcome.riskLevel,
      rationale: [outcome.summary, ...outcome.resolvedSignals],
      checklist: outcome.verificationChecklist,
    },
  };
}
