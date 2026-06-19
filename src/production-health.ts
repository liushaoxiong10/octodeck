export type ProductionHealthStage =
  | 'not_observed'
  | 'observing'
  | 'healthy'
  | 'degraded'
  | 'incident_detected'
  | 'mitigation_running'
  | 'rollback_recommended'
  | 'recovered';

export type ProductionHealthNextAction =
  | 'wait_for_release'
  | 'collect_health_signal'
  | 'investigate_degradation'
  | 'mitigate_incident'
  | 'rollback_release'
  | 'none';

export type ProductionHealthSeverity = 'info' | 'warning' | 'critical';

export interface ProductionHealthSignal {
  type: 'healthy' | 'degraded' | 'incident' | 'mitigation_running' | 'rollback_recommended' | 'recovered';
  severity?: ProductionHealthSeverity;
  summary?: string | null;
  detail?: string | null;
  source?: string | null;
  observedAt?: string | null;
  payload?: Record<string, unknown> | null;
}

const productionHealthSignalTypes: ProductionHealthSignal['type'][] = [
  'healthy',
  'degraded',
  'incident',
  'mitigation_running',
  'rollback_recommended',
  'recovered',
];

const productionHealthSeverities: ProductionHealthSeverity[] = ['info', 'warning', 'critical'];

export function isProductionHealthSignalType(value: unknown): value is ProductionHealthSignal['type'] {
  return typeof value === 'string' && productionHealthSignalTypes.includes(value as ProductionHealthSignal['type']);
}

export function isProductionHealthSeverity(value: unknown): value is ProductionHealthSeverity {
  return typeof value === 'string' && productionHealthSeverities.includes(value as ProductionHealthSeverity);
}

export interface ProductionHealthState {
  stage: ProductionHealthStage;
  healthy: boolean;
  severity: ProductionHealthSeverity;
  nextAction: ProductionHealthNextAction;
  incident: {
    summary?: string | null;
    detail?: string | null;
    rollbackRecommended: boolean;
  } | null;
  signals: ProductionHealthSignal[];
  checklist: Array<{
    id: 'release' | 'signals' | 'incident' | 'rollback' | 'recovery';
    label: string;
    status: 'pending' | 'ready' | 'blocked';
    detail?: string;
  }>;
}

function signalTime(signal: ProductionHealthSignal): number {
  const value = signal.observedAt ? Date.parse(signal.observedAt) : NaN;
  return Number.isFinite(value) ? value : 0;
}

function isReleaseCompleted(stage: string | undefined): boolean {
  return stage === 'released' || stage === 'merged' || stage === 'rollback_required';
}

function severityForSignal(signal: ProductionHealthSignal | null): ProductionHealthSeverity {
  if (!signal) return 'info';
  if (signal.type === 'incident' || signal.type === 'rollback_recommended') return 'critical';
  if (signal.type === 'degraded' || signal.type === 'mitigation_running') return 'warning';
  return signal.severity ?? 'info';
}

export function buildProductionHealthState(input: {
  releaseState?: { stage?: string; releaseGate?: { allowed?: boolean } } | null;
  signals: ProductionHealthSignal[];
}): ProductionHealthState {
  const releaseCompleted = isReleaseCompleted(input.releaseState?.stage);
  const signals = [...input.signals].sort((a, b) => signalTime(a) - signalTime(b));
  const latest = signals[signals.length - 1] ?? null;

  let stage: ProductionHealthStage = 'not_observed';
  let healthy = false;
  let nextAction: ProductionHealthNextAction = 'wait_for_release';
  let incident: ProductionHealthState['incident'] = null;

  if (!releaseCompleted) {
    stage = 'not_observed';
    nextAction = 'wait_for_release';
  } else if (!latest) {
    stage = 'observing';
    nextAction = 'collect_health_signal';
  } else if (latest.type === 'healthy') {
    stage = 'healthy';
    healthy = true;
    nextAction = 'none';
  } else if (latest.type === 'degraded') {
    stage = 'degraded';
    nextAction = 'investigate_degradation';
  } else if (latest.type === 'incident') {
    stage = 'incident_detected';
    nextAction = 'mitigate_incident';
    incident = { summary: latest.summary, detail: latest.detail, rollbackRecommended: false };
  } else if (latest.type === 'mitigation_running') {
    stage = 'mitigation_running';
    nextAction = 'mitigate_incident';
    incident = { summary: latest.summary, detail: latest.detail, rollbackRecommended: false };
  } else if (latest.type === 'rollback_recommended') {
    stage = 'rollback_recommended';
    nextAction = 'rollback_release';
    incident = { summary: latest.summary, detail: latest.detail, rollbackRecommended: true };
  } else if (latest.type === 'recovered') {
    stage = 'recovered';
    healthy = true;
    nextAction = 'none';
    incident = { summary: latest.summary, detail: latest.detail, rollbackRecommended: false };
  }

  const severity = severityForSignal(latest);
  return {
    stage,
    healthy,
    severity,
    nextAction,
    incident,
    signals,
    checklist: [
      { id: 'release', label: 'Release completed', status: releaseCompleted ? 'ready' : 'pending', detail: input.releaseState?.stage ?? 'release not completed' },
      { id: 'signals', label: 'Health signals', status: signals.length > 0 ? 'ready' : releaseCompleted ? 'pending' : 'blocked', detail: `${signals.length} signal(s)` },
      { id: 'incident', label: 'Incident status', status: stage === 'incident_detected' || stage === 'rollback_recommended' ? 'blocked' : stage === 'degraded' || stage === 'mitigation_running' ? 'pending' : 'ready', detail: latest?.summary ?? 'No incident detected' },
      { id: 'rollback', label: 'Rollback decision', status: stage === 'rollback_recommended' ? 'blocked' : 'ready', detail: stage === 'rollback_recommended' ? 'Rollback recommended' : 'No rollback recommendation' },
      { id: 'recovery', label: 'Recovery', status: stage === 'recovered' || stage === 'healthy' ? 'ready' : stage === 'not_observed' || stage === 'observing' ? 'pending' : 'blocked', detail: healthy ? 'Production healthy' : 'Not recovered yet' },
    ],
  };
}
