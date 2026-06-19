export type IncidentKnowledgeStatus = 'none' | 'open' | 'mitigating' | 'resolved' | 'failed';
export type IncidentKnowledgeSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface IncidentKnowledgeEvent {
  id: string;
  eventType: string;
  title?: string | null;
  summary?: string | null;
  detail?: string | null;
  payload?: Record<string, unknown> | null;
  createdAt: string;
}

export interface IncidentKnowledgeEntry {
  id: string;
  issueId: string;
  runId: string;
  title: string;
  fingerprint: string;
  severity: IncidentKnowledgeSeverity;
  status: IncidentKnowledgeStatus;
  symptoms: string[];
  suspectedRootCauses: string[];
  remediationActions: Array<{
    action: string;
    summary: string;
    detail?: string | null;
    observedAt: string;
  }>;
  verificationSignals: Array<{
    eventType: string;
    summary: string;
    observedAt: string;
  }>;
  preventionChecklist: string[];
  relatedEvents: IncidentKnowledgeEvent[];
  createdAt: string;
  updatedAt: string;
}

export interface IncidentKnowledgePayload {
  entry: IncidentKnowledgeEntry | null;
  events: IncidentKnowledgeEvent[];
}

function eventTime(event: IncidentKnowledgeEvent): number {
  const parsed = Date.parse(event.createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function textOf(event: IncidentKnowledgeEvent): string {
  return event.summary || event.detail || event.title || event.eventType;
}

function normalizedText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8)
    .join('-') || 'incident';
}

function isIncidentEvent(event: IncidentKnowledgeEvent): boolean {
  if (event.eventType === 'production_incident_detected' || event.eventType === 'production_rollback_recommended' || event.eventType === 'remediation_failed') return true;
  if (event.eventType === 'production_health_signal_received') {
    return event.payload?.type === 'incident_detected' || event.payload?.type === 'rollback_recommended';
  }
  if (event.eventType === 'incident_knowledge_archived') return !!event.payload?.incidentKnowledge;
  return false;
}

function isResolutionEvent(event: IncidentKnowledgeEvent): boolean {
  return event.eventType === 'production_recovered' || event.eventType === 'production_healthy' || event.eventType === 'remediation_resolved';
}

function isRemediationActionEvent(event: IncidentKnowledgeEvent): boolean {
  return event.eventType === 'remediation_action_recorded' || event.eventType === 'remediation_running' || event.eventType === 'remediation_verifying';
}

function isStatusRelevantEvent(event: IncidentKnowledgeEvent): boolean {
  return isIncidentEvent(event) || isResolutionEvent(event) || isRemediationActionEvent(event) || event.eventType === 'remediation_failed';
}

function severityOf(events: IncidentKnowledgeEvent[]): IncidentKnowledgeSeverity {
  if (events.some((event) => event.eventType === 'production_rollback_recommended' || event.payload?.type === 'rollback_recommended')) return 'critical';
  if (events.some((event) => event.eventType === 'production_incident_detected' || event.payload?.type === 'incident_detected' || event.eventType === 'remediation_failed')) return 'high';
  if (events.some((event) => event.eventType === 'production_health_degraded')) return 'medium';
  return 'low';
}

function statusOf(events: IncidentKnowledgeEvent[]): IncidentKnowledgeStatus {
  const latest = [...events].reverse().find((event) => event.eventType !== 'incident_knowledge_archived' && isStatusRelevantEvent(event));
  if (!latest) return 'none';
  if (latest.eventType === 'remediation_failed') return 'failed';
  if (isResolutionEvent(latest)) return 'resolved';
  if (isRemediationActionEvent(latest)) return 'mitigating';
  return 'open';
}

function archivedEntry(events: IncidentKnowledgeEvent[]): IncidentKnowledgeEntry | null {
  const archived = [...events].reverse().find((event) => event.eventType === 'incident_knowledge_archived');
  const value = archived?.payload?.incidentKnowledge;
  return value && typeof value === 'object' ? value as IncidentKnowledgeEntry : null;
}

export function buildIncidentKnowledge(input: { issueId: string; runId: string; events: IncidentKnowledgeEvent[] }): IncidentKnowledgePayload {
  const events = [...input.events].sort((a, b) => eventTime(a) - eventTime(b));
  const archived = archivedEntry(events);
  const incidentEvents = events.filter((event) => isIncidentEvent(event) && event.eventType !== 'incident_knowledge_archived');
  if (!incidentEvents.length && !archived) return { entry: null, events };

  const anchor = incidentEvents[0] ?? events[0];
  const severity = severityOf(events);
  const title = textOf(anchor);
  const fingerprint = `ik_${severity}_${normalizedText(title)}`;
  const symptoms = Array.from(new Set(incidentEvents.map(textOf).filter(Boolean)));
  const remediationActions = events.filter(isRemediationActionEvent).map((event) => ({
    action: typeof event.payload?.action === 'string' ? event.payload.action : event.eventType.replace(/^remediation_/, ''),
    summary: textOf(event),
    detail: event.detail ?? null,
    observedAt: event.createdAt,
  }));
  const verificationSignals = events.filter(isResolutionEvent).map((event) => ({
    eventType: event.eventType,
    summary: textOf(event),
    observedAt: event.createdAt,
  }));
  const createdAt = archived?.createdAt ?? anchor.createdAt;
  const updatedAt = events[events.length - 1]?.createdAt ?? createdAt;

  const entry: IncidentKnowledgeEntry = {
    id: archived?.id ?? fingerprint,
    issueId: input.issueId,
    runId: input.runId,
    title: archived?.title ?? title,
    fingerprint: archived?.fingerprint ?? fingerprint,
    severity,
    status: statusOf(events),
    symptoms: symptoms.length ? symptoms : archived?.symptoms ?? [],
    suspectedRootCauses: archived?.suspectedRootCauses?.length ? archived.suspectedRootCauses : ['Review production signal payloads, release checks, and remediation run logs for root-cause evidence.'],
    remediationActions,
    verificationSignals,
    preventionChecklist: [
      'Verify production recovery with an explicit healthy or recovered signal.',
      'Preserve issue run events as audit evidence for future similar incidents.',
      'Add or refine production health signal coverage for this failure mode.',
    ],
    relatedEvents: events.filter((event) => isIncidentEvent(event) || isResolutionEvent(event) || isRemediationActionEvent(event)),
    createdAt,
    updatedAt,
  };
  return { entry, events };
}
