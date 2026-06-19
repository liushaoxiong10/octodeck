import { describe, expect, test } from 'vitest';

import { buildIncidentKnowledge, type IncidentKnowledgeEvent } from '../src/incident-knowledge.js';

function event(partial: Partial<IncidentKnowledgeEvent> & { eventType: string; createdAt: string }): IncidentKnowledgeEvent {
  return {
    id: partial.id ?? partial.eventType,
    eventType: partial.eventType,
    title: partial.title ?? partial.eventType,
    summary: partial.summary ?? null,
    detail: partial.detail ?? null,
    payload: partial.payload ?? null,
    createdAt: partial.createdAt,
  };
}

describe('incident knowledge builder', () => {
  test('returns null when no incident-like event exists', () => {
    const result = buildIncidentKnowledge({ issueId: 'iss_1', runId: 'run_1', events: [event({ eventType: 'quality_passed', createdAt: '2026-06-16T00:00:00.000Z' })] });

    expect(result.entry).toBeNull();
    expect(result.events).toHaveLength(1);
  });

  test('production incident creates an open entry', () => {
    const result = buildIncidentKnowledge({
      issueId: 'iss_1',
      runId: 'run_1',
      events: [event({ eventType: 'production_incident_detected', summary: 'checkout 500s', detail: 'smoke failed', createdAt: '2026-06-16T00:01:00.000Z' })],
    });

    expect(result.entry).toMatchObject({
      issueId: 'iss_1',
      runId: 'run_1',
      title: 'checkout 500s',
      status: 'open',
      severity: 'high',
      symptoms: ['checkout 500s'],
    });
    expect(result.entry?.fingerprint).toMatch(/^ik_/);
  });

  test('rollback recommendation is critical', () => {
    const result = buildIncidentKnowledge({
      issueId: 'iss_1',
      runId: 'run_1',
      events: [event({ eventType: 'production_rollback_recommended', summary: 'error budget exhausted', createdAt: '2026-06-16T00:01:00.000Z' })],
    });

    expect(result.entry).toMatchObject({ status: 'open', severity: 'critical' });
  });

  test('remediation action is captured as action history', () => {
    const result = buildIncidentKnowledge({
      issueId: 'iss_1',
      runId: 'run_1',
      events: [
        event({ eventType: 'production_incident_detected', summary: 'checkout 500s', createdAt: '2026-06-16T00:01:00.000Z' }),
        event({ eventType: 'remediation_action_recorded', summary: 'spawn fix run', payload: { action: 'spawn_fix_run' }, createdAt: '2026-06-16T00:02:00.000Z' }),
      ],
    });

    expect(result.entry?.remediationActions).toEqual([
      expect.objectContaining({ action: 'spawn_fix_run', summary: 'spawn fix run' }),
    ]);
  });

  test('recovery signals resolve the entry', () => {
    const result = buildIncidentKnowledge({
      issueId: 'iss_1',
      runId: 'run_1',
      events: [
        event({ eventType: 'production_incident_detected', summary: 'checkout 500s', createdAt: '2026-06-16T00:01:00.000Z' }),
        event({ eventType: 'production_recovered', summary: 'healthy again', createdAt: '2026-06-16T00:03:00.000Z' }),
      ],
    });

    expect(result.entry).toMatchObject({ status: 'resolved' });
    expect(result.entry?.verificationSignals).toEqual([
      expect.objectContaining({ eventType: 'production_recovered', summary: 'healthy again' }),
    ]);
  });

  test('unrelated events after recovery do not reopen the entry', () => {
    const result = buildIncidentKnowledge({
      issueId: 'iss_1',
      runId: 'run_1',
      events: [
        event({ eventType: 'production_incident_detected', summary: 'checkout 500s', createdAt: '2026-06-16T00:01:00.000Z' }),
        event({ eventType: 'production_recovered', summary: 'healthy again', createdAt: '2026-06-16T00:03:00.000Z' }),
        event({ eventType: 'git_commit_created', summary: 'commit evidence', createdAt: '2026-06-16T00:04:00.000Z' }),
      ],
    });

    expect(result.entry).toMatchObject({ status: 'resolved' });
  });

  test('failed remediation marks the entry failed', () => {
    const result = buildIncidentKnowledge({
      issueId: 'iss_1',
      runId: 'run_1',
      events: [
        event({ eventType: 'production_incident_detected', summary: 'checkout 500s', createdAt: '2026-06-16T00:01:00.000Z' }),
        event({ eventType: 'remediation_failed', summary: 'fix failed', createdAt: '2026-06-16T00:04:00.000Z' }),
      ],
    });

    expect(result.entry).toMatchObject({ status: 'failed', severity: 'high' });
  });

  test('same summary produces stable fingerprint', () => {
    const first = buildIncidentKnowledge({ issueId: 'iss_1', runId: 'run_1', events: [event({ eventType: 'production_incident_detected', summary: 'Checkout 500s!', createdAt: '2026-06-16T00:01:00.000Z' })] });
    const second = buildIncidentKnowledge({ issueId: 'iss_2', runId: 'run_2', events: [event({ eventType: 'production_incident_detected', summary: 'checkout 500s', createdAt: '2026-06-16T00:02:00.000Z' })] });

    expect(first.entry?.fingerprint).toBe(second.entry?.fingerprint);
  });
});
