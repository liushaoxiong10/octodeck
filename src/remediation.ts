export type RemediationStage =
  | 'not_needed'
  | 'proposed'
  | 'waiting_approval'
  | 'running'
  | 'verifying'
  | 'resolved'
  | 'failed';

export type RemediationRecommendedAction =
  | 'rerun_checks'
  | 'spawn_fix_run'
  | 'request_rollback'
  | 'verify_recovery'
  | 'none';

export type RemediationRiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface RemediationSignal {
  source: 'quality' | 'delivery' | 'release' | 'production' | 'remediation';
  stage: string;
  eventType?: string | null;
  summary?: string | null;
  detail?: string | null;
  observedAt?: string | null;
  payload?: Record<string, unknown> | null;
}

export interface RemediationState {
  stage: RemediationStage;
  recommendedAction: RemediationRecommendedAction;
  riskLevel: RemediationRiskLevel;
  approvalRequired: boolean;
  proposal: {
    reason: string;
    source: RemediationSignal['source'];
    signalStage: string;
  } | null;
  signals: RemediationSignal[];
  checklist: Array<{
    id: 'detection' | 'proposal' | 'approval' | 'execution' | 'resolution';
    label: string;
    status: 'pending' | 'ready' | 'blocked';
    detail?: string;
  }>;
}

function signalTime(signal: RemediationSignal): number {
  const value = signal.observedAt ? Date.parse(signal.observedAt) : NaN;
  return Number.isFinite(value) ? value : 0;
}

function signalReason(signal: RemediationSignal | null, fallback: string): string {
  return signal?.summary || signal?.detail || signal?.eventType || signal?.stage || fallback;
}

function matches(signal: RemediationSignal, source: RemediationSignal['source'], stage: string, eventType?: string): boolean {
  return signal.source === source && (signal.stage === stage || signal.eventType === eventType);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isRecommendedAction(value: unknown): value is RemediationRecommendedAction {
  return value === 'rerun_checks' || value === 'spawn_fix_run' || value === 'request_rollback' || value === 'verify_recovery' || value === 'none';
}

function isRiskLevel(value: unknown): value is RemediationRiskLevel {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'critical';
}

function classify(signal: RemediationSignal | null): Pick<RemediationState, 'stage' | 'recommendedAction' | 'riskLevel' | 'approvalRequired'> {
  if (!signal) {
    return { stage: 'not_needed', recommendedAction: 'none', riskLevel: 'low', approvalRequired: false };
  }
  if (matches(signal, 'production', 'recovered', 'production_recovered') || matches(signal, 'remediation', 'resolved', 'remediation_resolved')) {
    return { stage: 'resolved', recommendedAction: 'none', riskLevel: 'low', approvalRequired: false };
  }
  if (matches(signal, 'production', 'healthy', 'production_healthy') || matches(signal, 'release', 'completed', 'release_completed') || matches(signal, 'quality', 'passed', 'quality_passed')) {
    return { stage: 'resolved', recommendedAction: 'none', riskLevel: 'low', approvalRequired: false };
  }
  if (matches(signal, 'production', 'rollback_recommended', 'production_rollback_recommended')) {
    return { stage: 'waiting_approval', recommendedAction: 'request_rollback', riskLevel: 'critical', approvalRequired: true };
  }
  if (matches(signal, 'release', 'rollback_required', 'release_rollback_required')) {
    return { stage: 'waiting_approval', recommendedAction: 'request_rollback', riskLevel: 'high', approvalRequired: true };
  }
  if (matches(signal, 'production', 'incident_detected', 'production_incident_detected')) {
    return { stage: 'waiting_approval', recommendedAction: 'spawn_fix_run', riskLevel: 'high', approvalRequired: true };
  }
  if (matches(signal, 'remediation', 'running', 'remediation_running')) {
    return { stage: 'running', recommendedAction: 'verify_recovery', riskLevel: 'medium', approvalRequired: false };
  }
  if (matches(signal, 'remediation', 'verifying', 'remediation_verifying')) {
    return { stage: 'verifying', recommendedAction: 'verify_recovery', riskLevel: 'medium', approvalRequired: false };
  }
  if (matches(signal, 'remediation', 'failed', 'remediation_failed')) {
    return { stage: 'failed', recommendedAction: 'spawn_fix_run', riskLevel: 'high', approvalRequired: true };
  }
  if (matches(signal, 'production', 'degraded', 'production_health_degraded')) {
    return { stage: 'proposed', recommendedAction: 'verify_recovery', riskLevel: 'medium', approvalRequired: false };
  }
  if (matches(signal, 'quality', 'failed', 'quality_failed') || matches(signal, 'delivery', 'blocked_by_quality', 'delivery_quality_blocked')) {
    return { stage: 'proposed', recommendedAction: 'spawn_fix_run', riskLevel: 'medium', approvalRequired: false };
  }
  if (matches(signal, 'release', 'checks_failed', 'release_checks_failed')) {
    return { stage: 'proposed', recommendedAction: 'rerun_checks', riskLevel: 'medium', approvalRequired: false };
  }
  if (matches(signal, 'remediation', 'proposed', 'remediation_proposed')) {
    return { stage: 'proposed', recommendedAction: 'spawn_fix_run', riskLevel: 'medium', approvalRequired: false };
  }
  if (matches(signal, 'remediation', 'waiting_approval', 'remediation_waiting_approval')) {
    const remediation = isRecord(signal.payload?.remediation) ? signal.payload.remediation : null;
    return {
      stage: 'waiting_approval',
      recommendedAction: isRecommendedAction(remediation?.recommendedAction) ? remediation.recommendedAction : 'request_rollback',
      riskLevel: isRiskLevel(remediation?.riskLevel) ? remediation.riskLevel : 'high',
      approvalRequired: true,
    };
  }
  return { stage: 'not_needed', recommendedAction: 'none', riskLevel: 'low', approvalRequired: false };
}

export function buildRemediationState(input: { signals: RemediationSignal[] }): RemediationState {
  const signals = [...input.signals].sort((a, b) => signalTime(a) - signalTime(b));
  const latest = signals[signals.length - 1] ?? null;
  const classified = classify(latest);
  const proposal = latest && classified.stage !== 'not_needed'
    ? { reason: signalReason(latest, classified.stage), source: latest.source, signalStage: latest.stage }
    : null;

  return {
    ...classified,
    proposal,
    signals,
    checklist: [
      { id: 'detection', label: 'Problem detected', status: classified.stage === 'not_needed' ? 'ready' : 'blocked', detail: proposal?.reason ?? 'No upstream problem detected' },
      { id: 'proposal', label: 'Remediation proposal', status: classified.stage === 'not_needed' ? 'ready' : 'ready', detail: classified.recommendedAction },
      { id: 'approval', label: 'Approval gate', status: classified.approvalRequired ? 'pending' : 'ready', detail: classified.approvalRequired ? `${classified.riskLevel} risk requires approval` : 'No approval required' },
      { id: 'execution', label: 'Execution', status: classified.stage === 'running' || classified.stage === 'verifying' ? 'pending' : classified.stage === 'failed' ? 'blocked' : 'ready', detail: classified.stage },
      { id: 'resolution', label: 'Resolution', status: classified.stage === 'resolved' || classified.stage === 'not_needed' ? 'ready' : classified.stage === 'failed' ? 'blocked' : 'pending', detail: classified.stage === 'resolved' ? 'Remediation resolved' : 'Not resolved yet' },
    ],
  };
}
