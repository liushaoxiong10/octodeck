import { describe, expect, test } from 'vitest';

import { buildProductionHealthState, type ProductionHealthSignal } from '../src/production-health.js';

describe('production health state machine', () => {
  const released = { stage: 'released' as const, releaseGate: { allowed: true } };

  function signal(type: ProductionHealthSignal['type'], overrides: Partial<ProductionHealthSignal> = {}): ProductionHealthSignal {
    return {
      type,
      severity: type === 'incident' ? 'critical' : type === 'degraded' ? 'warning' : 'info',
      summary: `${type} signal`,
      observedAt: '2026-06-15T10:00:00.000Z',
      ...overrides,
    };
  }

  test('does not observe production before release completes', () => {
    const state = buildProductionHealthState({ releaseState: { stage: 'merge_ready', releaseGate: { allowed: true } }, signals: [] });

    expect(state).toMatchObject({
      stage: 'not_observed',
      healthy: false,
      nextAction: 'wait_for_release',
      severity: 'info',
    });
  });

  test('observes released changes while waiting for health signals', () => {
    const state = buildProductionHealthState({ releaseState: released, signals: [] });

    expect(state).toMatchObject({
      stage: 'observing',
      healthy: false,
      nextAction: 'collect_health_signal',
      checklist: expect.arrayContaining([
        expect.objectContaining({ id: 'release', status: 'ready' }),
        expect.objectContaining({ id: 'signals', status: 'pending' }),
      ]),
    });
  });

  test('marks production healthy from healthy signal', () => {
    const state = buildProductionHealthState({ releaseState: released, signals: [signal('healthy')] });

    expect(state).toMatchObject({
      stage: 'healthy',
      healthy: true,
      nextAction: 'none',
      severity: 'info',
    });
  });

  test('marks degraded from warning signal', () => {
    const state = buildProductionHealthState({ releaseState: released, signals: [signal('degraded')] });

    expect(state).toMatchObject({
      stage: 'degraded',
      healthy: false,
      nextAction: 'investigate_degradation',
      severity: 'warning',
    });
  });

  test('detects incident from critical signal', () => {
    const state = buildProductionHealthState({ releaseState: released, signals: [signal('incident', { summary: 'checkout 500s' })] });

    expect(state).toMatchObject({
      stage: 'incident_detected',
      healthy: false,
      nextAction: 'mitigate_incident',
      severity: 'critical',
      incident: { summary: 'checkout 500s' },
    });
  });

  test('recommends rollback from rollback signal', () => {
    const state = buildProductionHealthState({ releaseState: released, signals: [signal('rollback_recommended', { summary: 'error budget exhausted' })] });

    expect(state).toMatchObject({
      stage: 'rollback_recommended',
      healthy: false,
      nextAction: 'rollback_release',
      severity: 'critical',
      incident: { rollbackRecommended: true },
    });
  });

  test('marks recovered from recovery signal even after incident', () => {
    const state = buildProductionHealthState({
      releaseState: released,
      signals: [
        signal('incident', { observedAt: '2026-06-15T10:00:00.000Z' }),
        signal('recovered', { observedAt: '2026-06-15T10:10:00.000Z', summary: 'smoke recovered' }),
      ],
    });

    expect(state).toMatchObject({
      stage: 'recovered',
      healthy: true,
      nextAction: 'none',
      severity: 'info',
      incident: { summary: 'smoke recovered' },
    });
  });
});
