import { describe, expect, test } from 'vitest';

import { buildFixRunDraft } from '../src/fix-run-spawner.js';
import type { IncidentKnowledgeEntry } from '../src/incident-knowledge.js';
import type { RunbookReusePayload } from '../src/runbook-reuse.js';

function incident(partial: Partial<IncidentKnowledgeEntry> = {}): IncidentKnowledgeEntry {
  return {
    id: partial.id ?? 'ik_current',
    issueId: partial.issueId ?? 'iss_fix',
    runId: partial.runId ?? 'run_current',
    title: partial.title ?? 'checkout 500s',
    fingerprint: partial.fingerprint ?? 'ik_high_checkout-500s',
    severity: partial.severity ?? 'high',
    status: partial.status ?? 'open',
    symptoms: partial.symptoms ?? ['checkout 500s', 'payment timeout'],
    suspectedRootCauses: partial.suspectedRootCauses ?? ['Null checkout guard'],
    remediationActions: partial.remediationActions ?? [],
    verificationSignals: partial.verificationSignals ?? [],
    preventionChecklist: partial.preventionChecklist ?? ['Verify checkout recovery'],
    relatedEvents: partial.relatedEvents ?? [],
    createdAt: partial.createdAt ?? '2026-06-16T00:00:00.000Z',
    updatedAt: partial.updatedAt ?? '2026-06-16T00:01:00.000Z',
  };
}

function reusableRunbook(overrides: Partial<NonNullable<RunbookReusePayload['recommendation']>> = {}): RunbookReusePayload {
  return {
    recommendation: {
      status: 'reuse_recommended',
      action: 'reuse_remediation_actions',
      riskLevel: 'high',
      confidence: 'high',
      approvalRequired: false,
      summary: 'Matched historical runbook ik_high_checkout-500s',
      detail: 'fingerprint match · historical remediation actions available',
      sourceFingerprint: 'ik_high_checkout-500s',
      ...overrides,
    },
    matches: [
      {
        id: 'ik_archived',
        issueId: 'iss_fix',
        runId: 'run_archived',
        fingerprint: 'ik_high_checkout-500s',
        title: 'checkout 500s',
        status: 'resolved',
        severity: 'high',
        score: 100,
        confidence: 'high',
        reusable: true,
        rationale: ['fingerprint match'],
        remediationActions: [{ action: 'spawn_fix_run', summary: 'Patch checkout null guard', observedAt: '2026-06-16T00:02:00.000Z' }],
        verificationSignals: [{ eventType: 'production_recovered', summary: 'healthy again', observedAt: '2026-06-16T00:03:00.000Z' }],
      },
    ],
    reusableActions: [{ action: 'spawn_fix_run', summary: 'Patch checkout null guard', observedAt: '2026-06-16T00:02:00.000Z' }],
    checklist: [{ id: 'verification', label: 'Recovery verification', status: 'ready', detail: 'Verify production recovery after any reused action.' }],
  };
}

describe('fix run spawner', () => {
  test('builds a draft-ready fix run from a safe reusable runbook', () => {
    const result = buildFixRunDraft({
      issue: { id: 'iss_fix', title: 'Checkout is failing', description: 'checkout smoke failed' },
      sourceRun: { id: 'run_current', result: 'production incident detected' },
      currentIncident: incident(),
      runbookReuse: reusableRunbook(),
    });

    expect(result.fixRunDraft).toMatchObject({
      status: 'draft_ready',
      title: 'Fix checkout 500s using runbook ik_high_checkout-500s',
      riskLevel: 'high',
      approvalRequired: false,
      sourceRunId: 'run_current',
      sourceFingerprint: 'ik_high_checkout-500s',
    });
    expect(result.fixRunDraft.prompt).toContain('Checkout is failing');
    expect(result.fixRunDraft.prompt).toContain('Patch checkout null guard');
    expect(result.fixRunDraft.prompt).toContain('Verify checkout recovery');
  });

  test('blocks approval-required runbook reuse from direct spawning', () => {
    const result = buildFixRunDraft({
      issue: { id: 'iss_fix', title: 'Critical outage', description: 'rollback recommended' },
      sourceRun: { id: 'run_current' },
      currentIncident: incident({ severity: 'critical' }),
      runbookReuse: reusableRunbook({ status: 'approval_required', action: 'request_rollback', riskLevel: 'critical', approvalRequired: true }),
    });

    expect(result.fixRunDraft).toMatchObject({ status: 'approval_required', approvalRequired: true, blockedReason: 'human_approval_required' });
  });

  test('blocks candidate and not-reusable recommendations', () => {
    const candidate = buildFixRunDraft({
      issue: { id: 'iss_fix', title: 'Checkout maybe failing' },
      sourceRun: { id: 'run_current' },
      currentIncident: incident(),
      runbookReuse: reusableRunbook({ status: 'candidate_found', action: 'collect_more_signals' }),
    });
    const blocked = buildFixRunDraft({
      issue: { id: 'iss_fix', title: 'Checkout failed remediation' },
      sourceRun: { id: 'run_current' },
      currentIncident: incident(),
      runbookReuse: reusableRunbook({ status: 'not_reusable', action: 'collect_more_signals', approvalRequired: true }),
    });

    expect(candidate.fixRunDraft).toMatchObject({ status: 'blocked', blockedReason: 'runbook_not_directly_reusable' });
    expect(blocked.fixRunDraft).toMatchObject({ status: 'blocked', blockedReason: 'runbook_not_directly_reusable' });
  });
});
