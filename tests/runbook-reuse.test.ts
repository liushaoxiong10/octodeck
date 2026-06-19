import { describe, expect, test } from 'vitest';

import { buildRunbookReuse, type RunbookReuseInput } from '../src/runbook-reuse.js';
import type { IncidentKnowledgeEntry } from '../src/incident-knowledge.js';

function incident(partial: Partial<IncidentKnowledgeEntry> & { fingerprint: string; title?: string }): IncidentKnowledgeEntry {
  return {
    id: partial.id ?? partial.fingerprint,
    issueId: partial.issueId ?? 'iss_1',
    runId: partial.runId ?? 'run_1',
    title: partial.title ?? 'checkout 500s',
    fingerprint: partial.fingerprint,
    severity: partial.severity ?? 'high',
    status: partial.status ?? 'open',
    symptoms: partial.symptoms ?? ['checkout 500s'],
    suspectedRootCauses: partial.suspectedRootCauses ?? [],
    remediationActions: partial.remediationActions ?? [],
    verificationSignals: partial.verificationSignals ?? [],
    preventionChecklist: partial.preventionChecklist ?? ['Verify recovery'],
    relatedEvents: partial.relatedEvents ?? [],
    createdAt: partial.createdAt ?? '2026-06-16T00:00:00.000Z',
    updatedAt: partial.updatedAt ?? '2026-06-16T00:01:00.000Z',
  };
}

function build(input: Partial<RunbookReuseInput>) {
  return buildRunbookReuse({
    issueId: 'iss_current',
    runId: 'run_current',
    currentIncident: input.currentIncident ?? null,
    archivedIncidents: input.archivedIncidents ?? [],
  });
}

describe('runbook reuse builder', () => {
  test('returns no recommendation without a current incident', () => {
    const result = build({ currentIncident: null, archivedIncidents: [incident({ fingerprint: 'ik_high_checkout-500s' })] });

    expect(result.recommendation).toMatchObject({ status: 'none', action: 'none' });
    expect(result.matches).toEqual([]);
    expect(result.checklist[0]).toMatchObject({ id: 'current_incident', status: 'blocked' });
  });

  test('returns no recommendation when no archived incidents exist', () => {
    const result = build({ currentIncident: incident({ fingerprint: 'ik_high_checkout-500s' }), archivedIncidents: [] });

    expect(result.recommendation).toMatchObject({ status: 'none', action: 'none' });
    expect(result.matches).toEqual([]);
  });

  test('same fingerprint recommends reusing remediation actions', () => {
    const historical = incident({
      fingerprint: 'ik_high_checkout-500s',
      status: 'resolved',
      remediationActions: [{ action: 'spawn_fix_run', summary: 'Patch checkout null guard', observedAt: '2026-06-16T00:02:00.000Z' }],
      verificationSignals: [{ eventType: 'production_recovered', summary: 'healthy again', observedAt: '2026-06-16T00:03:00.000Z' }],
    });

    const result = build({ currentIncident: incident({ fingerprint: 'ik_high_checkout-500s' }), archivedIncidents: [historical] });

    expect(result.recommendation).toMatchObject({
      status: 'reuse_recommended',
      action: 'reuse_remediation_actions',
      confidence: 'high',
      approvalRequired: false,
    });
    expect(result.matches[0]).toMatchObject({ fingerprint: 'ik_high_checkout-500s', score: 100 });
    expect(result.reusableActions).toEqual([expect.objectContaining({ action: 'spawn_fix_run' })]);
  });

  test('critical rollback incidents require approval', () => {
    const result = build({
      currentIncident: incident({ fingerprint: 'ik_critical_error-budget', severity: 'critical', symptoms: ['error budget exhausted'] }),
      archivedIncidents: [incident({
        fingerprint: 'ik_critical_error-budget',
        severity: 'critical',
        status: 'resolved',
        symptoms: ['error budget exhausted'],
        remediationActions: [{ action: 'request_rollback', summary: 'Rollback release', observedAt: '2026-06-16T00:02:00.000Z' }],
      })],
    });

    expect(result.recommendation).toMatchObject({
      status: 'approval_required',
      action: 'request_rollback',
      riskLevel: 'critical',
      approvalRequired: true,
    });
  });

  test('failed historical incidents are blocked from reuse', () => {
    const result = build({
      currentIncident: incident({ fingerprint: 'ik_high_checkout-500s' }),
      archivedIncidents: [incident({ fingerprint: 'ik_high_checkout-500s', status: 'failed' })],
    });

    expect(result.recommendation).toMatchObject({
      status: 'not_reusable',
      action: 'collect_more_signals',
      riskLevel: 'high',
      approvalRequired: true,
    });
    expect(result.matches[0]).toMatchObject({ reusable: false });
  });

  test('unresolved historical incidents with actions are not reusable', () => {
    const result = build({
      currentIncident: incident({ fingerprint: 'ik_high_checkout-500s' }),
      archivedIncidents: [incident({
        fingerprint: 'ik_high_checkout-500s',
        status: 'mitigating',
        remediationActions: [{ action: 'spawn_fix_run', summary: 'Patch still in progress', observedAt: '2026-06-16T00:02:00.000Z' }],
      })],
    });

    expect(result.recommendation).toMatchObject({
      status: 'candidate_found',
      action: 'collect_more_signals',
    });
    expect(result.reusableActions).toEqual([]);
  });

  test('symptom overlap returns candidate found with medium confidence', () => {
    const result = build({
      currentIncident: incident({ fingerprint: 'ik_high_checkout-500s-new', symptoms: ['checkout 500s', 'payment timeout'] }),
      archivedIncidents: [incident({ fingerprint: 'ik_high_checkout-500s-old', status: 'resolved', symptoms: ['checkout 500s', 'cart failed'] })],
    });

    expect(result.recommendation).toMatchObject({
      status: 'candidate_found',
      confidence: 'medium',
      action: 'collect_more_signals',
    });
    expect(result.matches[0].rationale.join(' ')).toContain('symptom overlap');
  });
});
