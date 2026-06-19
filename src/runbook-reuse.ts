import type { IncidentKnowledgeEntry } from './incident-knowledge.js';

export type RunbookReuseStatus = 'none' | 'candidate_found' | 'reuse_recommended' | 'approval_required' | 'not_reusable';
export type RunbookReuseAction = 'reuse_remediation_actions' | 'request_rollback' | 'verify_recovery' | 'spawn_fix_run' | 'collect_more_signals' | 'none';
export type RunbookReuseRiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type RunbookReuseConfidence = 'low' | 'medium' | 'high';

export interface RunbookReuseInput {
  issueId: string;
  runId: string;
  currentIncident: IncidentKnowledgeEntry | null;
  archivedIncidents: IncidentKnowledgeEntry[];
}

export interface RunbookReuseMatch {
  id: string;
  issueId: string;
  runId: string;
  fingerprint: string;
  title: string;
  status: IncidentKnowledgeEntry['status'];
  severity: IncidentKnowledgeEntry['severity'];
  score: number;
  confidence: RunbookReuseConfidence;
  reusable: boolean;
  rationale: string[];
  remediationActions: IncidentKnowledgeEntry['remediationActions'];
  verificationSignals: IncidentKnowledgeEntry['verificationSignals'];
}

export interface RunbookReuseRecommendation {
  status: RunbookReuseStatus;
  action: RunbookReuseAction;
  riskLevel: RunbookReuseRiskLevel;
  confidence: RunbookReuseConfidence;
  approvalRequired: boolean;
  summary: string;
  detail: string;
  sourceFingerprint?: string;
}

export interface RunbookReuseChecklistItem {
  id: 'current_incident' | 'historical_match' | 'safety' | 'approval' | 'verification';
  label: string;
  status: 'pending' | 'ready' | 'blocked';
  detail?: string;
}

export interface RunbookReusePayload {
  recommendation: RunbookReuseRecommendation | null;
  matches: RunbookReuseMatch[];
  reusableActions: IncidentKnowledgeEntry['remediationActions'];
  checklist: RunbookReuseChecklistItem[];
}

function words(values: string[]): Set<string> {
  return new Set(
    values
      .join(' ')
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, ' ')
      .split(/\s+/)
      .filter((item) => item.length >= 3),
  );
}

function overlapCount(a: string[], b: string[]): number {
  const left = words(a);
  const right = words(b);
  let count = 0;
  for (const item of left) {
    if (right.has(item)) count += 1;
  }
  return count;
}

function confidence(score: number): RunbookReuseConfidence {
  if (score >= 80) return 'high';
  if (score >= 45) return 'medium';
  return 'low';
}

function scoreMatch(current: IncidentKnowledgeEntry, archived: IncidentKnowledgeEntry): RunbookReuseMatch {
  const rationale: string[] = [];
  let score = 0;
  if (current.fingerprint === archived.fingerprint) {
    score += 70;
    rationale.push('fingerprint match');
  }
  if (current.severity === archived.severity) {
    score += 10;
    rationale.push(`same severity: ${current.severity}`);
  }
  const symptomOverlap = overlapCount(current.symptoms, archived.symptoms);
  if (symptomOverlap > 0) {
    score += Math.min(40, symptomOverlap * 20);
    rationale.push(`symptom overlap: ${symptomOverlap}`);
  }
  if (archived.remediationActions.length > 0) {
    score += 10;
    rationale.push('historical remediation actions available');
  }
  const reusable = archived.status === 'resolved' && archived.remediationActions.length > 0;
  if (!reusable && archived.status === 'failed') rationale.push('historical remediation failed');
  const boundedScore = Math.min(100, score);
  return {
    id: archived.id,
    issueId: archived.issueId,
    runId: archived.runId,
    fingerprint: archived.fingerprint,
    title: archived.title,
    status: archived.status,
    severity: archived.severity,
    score: boundedScore,
    confidence: confidence(boundedScore),
    reusable,
    rationale,
    remediationActions: archived.remediationActions,
    verificationSignals: archived.verificationSignals,
  };
}

function primaryAction(match: RunbookReuseMatch | undefined): RunbookReuseAction {
  const actions = match?.remediationActions.map((item) => item.action) ?? [];
  if (actions.includes('request_rollback')) return 'request_rollback';
  if (actions.includes('spawn_fix_run')) return 'reuse_remediation_actions';
  if (actions.length > 0) return 'reuse_remediation_actions';
  return 'collect_more_signals';
}

function checklist(
  currentIncident: IncidentKnowledgeEntry | null,
  matches: RunbookReuseMatch[],
  recommendation: RunbookReuseRecommendation | null,
): RunbookReuseChecklistItem[] {
  const hasActionableRecommendation = Boolean(recommendation && recommendation.status !== 'none');
  return [
    {
      id: 'current_incident',
      label: 'Current incident detected',
      status: currentIncident ? 'ready' : 'blocked',
      detail: currentIncident?.fingerprint ?? 'No current incident knowledge available.',
    },
    {
      id: 'historical_match',
      label: 'Historical runbook match',
      status: matches.length ? 'ready' : 'pending',
      detail: matches[0]?.fingerprint ?? 'No archived incident matched yet.',
    },
    {
      id: 'safety',
      label: 'Reuse safety check',
      status: recommendation?.status === 'not_reusable' ? 'blocked' : hasActionableRecommendation ? 'ready' : 'pending',
      detail: recommendation?.detail,
    },
    {
      id: 'approval',
      label: 'Approval requirement',
      status: recommendation?.approvalRequired ? 'blocked' : hasActionableRecommendation ? 'ready' : 'pending',
      detail: recommendation?.approvalRequired ? 'Human approval required before applying this runbook.' : 'No extra approval required.',
    },
    {
      id: 'verification',
      label: 'Recovery verification',
      status: hasActionableRecommendation ? 'ready' : 'pending',
      detail: 'Verify production recovery after any reused action.',
    },
  ];
}

function noneRecommendation(currentIncident: IncidentKnowledgeEntry | null, detail: string): RunbookReuseRecommendation {
  return {
    status: 'none',
    action: 'none',
    riskLevel: currentIncident?.severity ?? 'low',
    confidence: 'low',
    approvalRequired: false,
    summary: 'No reusable runbook recommendation.',
    detail,
  };
}

export function buildRunbookReuse(input: RunbookReuseInput): RunbookReusePayload {
  if (!input.currentIncident) {
    const recommendation = noneRecommendation(null, 'No current incident knowledge available.');
    return { recommendation, matches: [], reusableActions: [], checklist: checklist(null, [], recommendation) };
  }

  const currentIncident = input.currentIncident;
  const matches = input.archivedIncidents
    .filter((incident) => incident.runId !== input.runId || incident.issueId !== input.issueId)
    .map((incident) => scoreMatch(currentIncident, incident))
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!matches.length) {
    const recommendation = noneRecommendation(currentIncident, 'No archived incident matched the current incident.');
    return { recommendation, matches: [], reusableActions: [], checklist: checklist(currentIncident, [], recommendation) };
  }

  const best = matches[0];
  const action = best.reusable ? primaryAction(best) : 'collect_more_signals';
  const riskLevel = currentIncident.severity;
  const failedBest = best.status === 'failed';
  const needsApproval = riskLevel === 'critical' || action === 'request_rollback' || failedBest;
  const status: RunbookReuseStatus = failedBest
    ? 'not_reusable'
    : needsApproval
      ? 'approval_required'
      : best.reusable && best.score >= 80
        ? 'reuse_recommended'
        : 'candidate_found';
  const recommendation: RunbookReuseRecommendation = {
    status,
    action: failedBest ? 'collect_more_signals' : action,
    riskLevel,
    confidence: best.confidence,
    approvalRequired: needsApproval,
    summary: failedBest ? 'Similar historical incident failed remediation; collect more signals before reuse.' : `Matched historical runbook ${best.fingerprint}`,
    detail: best.rationale.join(' · '),
    sourceFingerprint: best.fingerprint,
  };

  return {
    recommendation,
    matches,
    reusableActions: best.reusable ? best.remediationActions : [],
    checklist: checklist(currentIncident, matches, recommendation),
  };
}
