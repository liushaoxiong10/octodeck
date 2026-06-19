import type { IncidentKnowledgeEntry } from './incident-knowledge.js';
import type { RunbookReusePayload, RunbookReuseRiskLevel } from './runbook-reuse.js';

export type FixRunDraftStatus = 'none' | 'draft_ready' | 'approval_required' | 'blocked';
export type FixRunBlockedReason = 'no_current_incident' | 'no_runbook_recommendation' | 'human_approval_required' | 'runbook_not_directly_reusable' | 'no_reusable_actions';

export interface FixRunDraftInput {
  issue: {
    id: string;
    title?: string | null;
    description?: string | null;
  };
  sourceRun: {
    id: string;
    result?: string | null;
  };
  currentIncident: IncidentKnowledgeEntry | null;
  runbookReuse: RunbookReusePayload;
}

export interface FixRunDraft {
  status: FixRunDraftStatus;
  title: string;
  prompt: string;
  rationale: string[];
  sourceRunId: string;
  sourceFingerprint?: string;
  remediationActions: IncidentKnowledgeEntry['remediationActions'];
  verificationChecklist: string[];
  riskLevel: RunbookReuseRiskLevel;
  approvalRequired: boolean;
  blockedReason?: FixRunBlockedReason;
}

export interface FixRunDraftPayload {
  fixRunDraft: FixRunDraft;
}

function bulletList(items: string[]): string {
  return items.length ? items.map((item) => `- ${item}`).join('\n') : '- none recorded';
}

function actionList(actions: IncidentKnowledgeEntry['remediationActions']): string {
  return actions.length
    ? actions.map((action) => `- ${action.action}: ${action.summary}${action.detail ? ` — ${action.detail}` : ''}`).join('\n')
    : '- none recorded';
}

function buildPrompt(input: FixRunDraftInput): string {
  const incident = input.currentIncident;
  const recommendation = input.runbookReuse.recommendation;
  const match = input.runbookReuse.matches[0];
  const checklist = [
    ...(incident?.preventionChecklist ?? []),
    ...input.runbookReuse.checklist.flatMap((item) => item.detail ? [item.detail] : []),
    ...(match?.verificationSignals ?? []).map((signal) => `${signal.eventType}: ${signal.summary}`),
  ];
  return [
    'You are spawning a controlled fix run from a reusable incident runbook.',
    '',
    `Issue: ${input.issue.title ?? input.issue.id}`,
    input.issue.description ? `Issue description: ${input.issue.description}` : null,
    `Source run: ${input.sourceRun.id}`,
    input.sourceRun.result ? `Source run result: ${input.sourceRun.result}` : null,
    `Current incident: ${incident?.title ?? 'unknown incident'}`,
    `Fingerprint: ${recommendation?.sourceFingerprint ?? incident?.fingerprint ?? 'unknown'}`,
    `Risk level: ${recommendation?.riskLevel ?? incident?.severity ?? 'low'}`,
    '',
    'Current symptoms:',
    bulletList(incident?.symptoms ?? []),
    '',
    'Suspected root causes:',
    bulletList(incident?.suspectedRootCauses ?? []),
    '',
    'Historical remediation actions to reuse carefully:',
    actionList(input.runbookReuse.reusableActions),
    '',
    'Verification checklist:',
    bulletList(Array.from(new Set(checklist))),
    '',
    'Instructions:',
    '- Inspect the current code before editing.',
    '- Reuse the historical remediation only when it still matches the current code path.',
    '- Keep changes minimal and focused on the incident.',
    '- Run relevant tests or explain why they cannot run.',
    '- Do not merge, deploy, or roll back production from this fix run.',
  ].filter((line): line is string => line !== null).join('\n');
}

function blockedDraft(input: FixRunDraftInput, status: FixRunDraftStatus, reason: FixRunBlockedReason): FixRunDraftPayload {
  const recommendation = input.runbookReuse.recommendation;
  const fingerprint = recommendation?.sourceFingerprint ?? input.currentIncident?.fingerprint;
  return {
    fixRunDraft: {
      status,
      title: 'Fix run is not ready',
      prompt: buildPrompt(input),
      rationale: recommendation?.detail ? [recommendation.detail] : [],
      sourceRunId: input.sourceRun.id,
      sourceFingerprint: fingerprint,
      remediationActions: [],
      verificationChecklist: input.currentIncident?.preventionChecklist ?? [],
      riskLevel: recommendation?.riskLevel ?? input.currentIncident?.severity ?? 'low',
      approvalRequired: status === 'approval_required' || recommendation?.approvalRequired === true,
      blockedReason: reason,
    },
  };
}

export function buildFixRunDraft(input: FixRunDraftInput): FixRunDraftPayload {
  if (!input.currentIncident) return blockedDraft(input, 'none', 'no_current_incident');
  const recommendation = input.runbookReuse.recommendation;
  if (!recommendation || recommendation.status === 'none') return blockedDraft(input, 'none', 'no_runbook_recommendation');
  if (recommendation.status === 'not_reusable' || recommendation.status === 'candidate_found') {
    return blockedDraft(input, 'blocked', 'runbook_not_directly_reusable');
  }
  if (recommendation.approvalRequired || recommendation.status === 'approval_required') {
    return blockedDraft(input, 'approval_required', 'human_approval_required');
  }
  if (recommendation.status !== 'reuse_recommended') {
    return blockedDraft(input, 'blocked', 'runbook_not_directly_reusable');
  }
  if (!input.runbookReuse.reusableActions.length) return blockedDraft(input, 'blocked', 'no_reusable_actions');

  const fingerprint = recommendation.sourceFingerprint ?? input.currentIncident.fingerprint;
  const verificationChecklist = Array.from(new Set([
    ...input.currentIncident.preventionChecklist,
    ...input.runbookReuse.checklist.flatMap((item) => item.detail ? [item.detail] : []),
  ]));
  return {
    fixRunDraft: {
      status: 'draft_ready',
      title: `Fix ${input.currentIncident.title} using runbook ${fingerprint}`,
      prompt: buildPrompt(input),
      rationale: [recommendation.summary, recommendation.detail].filter(Boolean),
      sourceRunId: input.sourceRun.id,
      sourceFingerprint: fingerprint,
      remediationActions: input.runbookReuse.reusableActions,
      verificationChecklist,
      riskLevel: recommendation.riskLevel,
      approvalRequired: false,
    },
  };
}
