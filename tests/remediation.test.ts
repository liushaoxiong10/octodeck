import { describe, expect, test } from 'vitest';

import { buildRemediationState, type RemediationSignal } from '../src/remediation.js';

describe('remediation state machine', () => {
  function signal(overrides: Partial<RemediationSignal>): RemediationSignal {
    return {
      source: 'delivery',
      stage: 'diff_ready',
      eventType: 'delivery_commit_ready',
      summary: 'delivery ready',
      observedAt: '2026-06-16T08:00:00.000Z',
      ...overrides,
    };
  }

  test('does not require remediation when no upstream problem exists', () => {
    const state = buildRemediationState({ signals: [] });

    expect(state).toMatchObject({
      stage: 'not_needed',
      recommendedAction: 'none',
      riskLevel: 'low',
      approvalRequired: false,
    });
    expect(state.checklist).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'detection', status: 'ready' }),
      expect.objectContaining({ id: 'resolution', status: 'ready' }),
    ]));
  });

  test('proposes fix run when quality failed', () => {
    const state = buildRemediationState({
      signals: [signal({ source: 'quality', stage: 'failed', eventType: 'quality_failed', summary: 'tests failed' })],
    });

    expect(state).toMatchObject({
      stage: 'proposed',
      recommendedAction: 'spawn_fix_run',
      riskLevel: 'medium',
      approvalRequired: false,
      proposal: { reason: 'tests failed' },
    });
  });

  test('requires approval for release rollback requirement', () => {
    const state = buildRemediationState({
      signals: [signal({ source: 'release', stage: 'rollback_required', eventType: 'release_rollback_required', summary: 'post merge smoke failed' })],
    });

    expect(state).toMatchObject({
      stage: 'waiting_approval',
      recommendedAction: 'request_rollback',
      riskLevel: 'high',
      approvalRequired: true,
      proposal: { reason: 'post merge smoke failed' },
    });
  });

  test('requires critical approval for production rollback recommendation', () => {
    const state = buildRemediationState({
      signals: [signal({ source: 'production', stage: 'rollback_recommended', eventType: 'production_rollback_recommended', summary: 'error budget exhausted' })],
    });

    expect(state).toMatchObject({
      stage: 'waiting_approval',
      recommendedAction: 'request_rollback',
      riskLevel: 'critical',
      approvalRequired: true,
      proposal: { reason: 'error budget exhausted' },
    });
  });

  test('resolves remediation when production recovered after proposal', () => {
    const state = buildRemediationState({
      signals: [
        signal({ source: 'production', stage: 'incident_detected', eventType: 'production_incident_detected', summary: 'checkout 500s', observedAt: '2026-06-16T08:00:00.000Z' }),
        signal({ source: 'remediation', stage: 'proposed', eventType: 'remediation_proposed', summary: 'fix proposed', observedAt: '2026-06-16T08:05:00.000Z' }),
        signal({ source: 'production', stage: 'recovered', eventType: 'production_recovered', summary: 'healthy again', observedAt: '2026-06-16T08:10:00.000Z' }),
      ],
    });

    expect(state).toMatchObject({
      stage: 'resolved',
      recommendedAction: 'none',
      riskLevel: 'low',
      approvalRequired: false,
      proposal: { reason: 'healthy again' },
    });
  });

  test('resolves stale release remediation when release later completes', () => {
    const state = buildRemediationState({
      signals: [
        signal({ source: 'release', stage: 'checks_failed', eventType: 'release_checks_failed', summary: 'checks failed', observedAt: '2026-06-16T08:00:00.000Z' }),
        signal({ source: 'release', stage: 'completed', eventType: 'release_completed', summary: 'release completed', observedAt: '2026-06-16T08:10:00.000Z' }),
      ],
    });

    expect(state).toMatchObject({
      stage: 'resolved',
      recommendedAction: 'none',
      proposal: { reason: 'release completed' },
    });
  });

  test('resolves stale production remediation when production later becomes healthy', () => {
    const state = buildRemediationState({
      signals: [
        signal({ source: 'production', stage: 'degraded', eventType: 'production_health_degraded', summary: 'latency elevated', observedAt: '2026-06-16T08:00:00.000Z' }),
        signal({ source: 'production', stage: 'healthy', eventType: 'production_healthy', summary: 'manual healthy signal', observedAt: '2026-06-16T08:10:00.000Z' }),
      ],
    });

    expect(state).toMatchObject({
      stage: 'resolved',
      recommendedAction: 'none',
      proposal: { reason: 'manual healthy signal' },
    });
  });
});
