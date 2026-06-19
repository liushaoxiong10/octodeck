import { describe, expect, test } from 'vitest';

import { buildResolutionGate } from '../src/resolution-gate.js';
import type { FixRunOutcomePayload } from '../src/fix-run-outcome.js';

function outcome(partial: Partial<FixRunOutcomePayload['fixRunOutcome']> = {}): FixRunOutcomePayload {
  return {
    fixRunOutcome: {
      status: partial.status ?? 'resolved',
      title: partial.title ?? 'Fix run resolved the incident',
      summary: partial.summary ?? 'Fix run produced verification evidence.',
      detail: partial.detail ?? 'tests passed; production healthy',
      sourceRunId: partial.sourceRunId ?? 'irun_source',
      fixRunId: partial.fixRunId ?? 'irun_fix',
      riskLevel: partial.riskLevel ?? 'high',
      resolvedSignals: partial.resolvedSignals ?? ['tests passed; production healthy'],
      failedSignals: partial.failedSignals ?? [],
      verificationChecklist: partial.verificationChecklist ?? ['Run checkout smoke', 'Verify production recovery'],
      nextAction: partial.nextAction ?? 'record_resolution',
      blockedReason: partial.blockedReason,
    },
  };
}

describe('resolution gate', () => {
  test('builds ready gate from resolved non-critical outcome without failed signals', () => {
    const result = buildResolutionGate({
      issue: { id: 'iss_1', title: 'Checkout failed', status: 'review' },
      fixRunOutcome: outcome(),
    });

    expect(result.resolutionGate).toMatchObject({
      status: 'ready',
      recommendedIssueStatus: 'done',
      archiveIncident: true,
      promoteRunbook: true,
      approvalRequired: false,
      sourceRunId: 'irun_source',
      fixRunId: 'irun_fix',
    });
    expect(result.resolutionGate.checklist).toContain('Run checkout smoke');
  });

  test('requires approval for critical resolved outcome', () => {
    const result = buildResolutionGate({
      issue: { id: 'iss_1', title: 'Critical outage', status: 'review' },
      fixRunOutcome: outcome({ riskLevel: 'critical' }),
    });

    expect(result.resolutionGate).toMatchObject({ status: 'approval_required', approvalRequired: true, recommendedIssueStatus: 'review' });
  });

  test('marks needs-review outcome as needs_review gate', () => {
    const result = buildResolutionGate({
      issue: { id: 'iss_1', title: 'Checkout failed', status: 'review' },
      fixRunOutcome: outcome({ status: 'needs_review', resolvedSignals: [], nextAction: 'review_fix_run_output' }),
    });

    expect(result.resolutionGate).toMatchObject({ status: 'needs_review', recommendedIssueStatus: 'review', archiveIncident: false, promoteRunbook: false });
  });

  test('blocks failed blocked and missing outcomes', () => {
    const failed = buildResolutionGate({ issue: { id: 'iss_1', title: 'Checkout failed', status: 'review' }, fixRunOutcome: outcome({ status: 'failed', failedSignals: ['tests failed'] }) });
    const blocked = buildResolutionGate({ issue: { id: 'iss_1', title: 'Checkout failed', status: 'review' }, fixRunOutcome: outcome({ status: 'blocked', blockedReason: 'missing_fix_run' }) });
    const missing = buildResolutionGate({ issue: { id: 'iss_1', title: 'Checkout failed', status: 'review' }, fixRunOutcome: null });

    expect(failed.resolutionGate).toMatchObject({ status: 'blocked', blockedReason: 'fix_run_not_resolved' });
    expect(blocked.resolutionGate).toMatchObject({ status: 'blocked', blockedReason: 'fix_run_not_resolved' });
    expect(missing.resolutionGate).toMatchObject({ status: 'blocked', blockedReason: 'missing_fix_run_outcome' });
  });
});
