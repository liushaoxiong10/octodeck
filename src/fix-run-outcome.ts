import type { IssueAgentRun, IssueAgentRunEvent } from './types.js';

export type FixRunOutcomeStatus = 'pending' | 'verifying' | 'resolved' | 'failed' | 'needs_review' | 'blocked';
export type FixRunOutcomeBlockedReason = 'not_fix_run_spawner_child' | 'missing_source_run' | 'missing_fix_run';
export type FixRunOutcomeNextAction =
  | 'wait_for_fix_run_completion'
  | 'record_resolution'
  | 'manual_review_failed_fix'
  | 'review_fix_run_output'
  | 'inspect_fix_run_relationship';

export interface FixRunOutcome {
  status: FixRunOutcomeStatus;
  title: string;
  summary: string;
  detail: string;
  sourceRunId: string;
  fixRunId: string;
  riskLevel: string;
  resolvedSignals: string[];
  failedSignals: string[];
  verificationChecklist: string[];
  nextAction: FixRunOutcomeNextAction;
  blockedReason?: FixRunOutcomeBlockedReason;
}

export interface FixRunOutcomePayload {
  fixRunOutcome: FixRunOutcome;
}

export interface FixRunOutcomeInput {
  sourceRun: IssueAgentRun | null;
  fixRun: IssueAgentRun | null;
  sourceEvents: IssueAgentRunEvent[];
  fixRunEvents: IssueAgentRunEvent[];
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
}

function fixRunDraftFromEvent(event: IssueAgentRunEvent | undefined): Record<string, unknown> | null {
  const payload = asObject(event?.payload);
  return asObject(payload?.fixRunDraft) ?? asObject(asObject(payload?.fixRunDraftPayload)?.fixRunDraft);
}

function queuedFixRunDraft(events: IssueAgentRunEvent[]): Record<string, unknown> | null {
  const queued = events.find((event) => event.event_type === 'run_queued' && asObject(event.payload)?.trigger === 'fix_run_spawner');
  return fixRunDraftFromEvent(queued);
}

function sourceSpawnedDraft(events: IssueAgentRunEvent[], fixRunId: string): Record<string, unknown> | null {
  const spawned = events.find((event) => {
    if (event.event_type !== 'fix_run_spawned') return false;
    const payload = asObject(event.payload);
    return stringValue(payload?.fixRunId) === fixRunId;
  });
  return fixRunDraftFromEvent(spawned);
}

function isFixRunSpawnerChild(events: IssueAgentRunEvent[]): boolean {
  return events.some((event) => event.event_type === 'run_queued' && asObject(event.payload)?.trigger === 'fix_run_spawner');
}

function textSignals(text: string | null | undefined, patterns: RegExp[]): string[] {
  const value = text?.trim();
  if (!value) return [];
  return patterns.some((pattern) => pattern.test(value)) ? [value] : [];
}

function verificationChecklist(draft: Record<string, unknown> | null): string[] {
  return stringArray(draft?.verificationChecklist);
}

function riskLevel(draft: Record<string, unknown> | null): string {
  return stringValue(draft?.riskLevel) ?? 'medium';
}

function titleFor(status: FixRunOutcomeStatus, fixRunId: string): string {
  if (status === 'pending') return 'Fix run is still running';
  if (status === 'resolved') return 'Fix run resolved the incident';
  if (status === 'failed') return 'Fix run failed';
  if (status === 'needs_review') return 'Fix run needs review';
  if (status === 'verifying') return 'Fix run verification in progress';
  return `Fix run outcome blocked for ${fixRunId}`;
}

function blocked(sourceRunId: string, fixRunId: string, reason: FixRunOutcomeBlockedReason): FixRunOutcomePayload {
  return {
    fixRunOutcome: {
      status: 'blocked',
      title: titleFor('blocked', fixRunId),
      summary: 'Fix run outcome cannot be verified automatically.',
      detail: reason,
      sourceRunId,
      fixRunId,
      riskLevel: 'medium',
      resolvedSignals: [],
      failedSignals: [],
      verificationChecklist: [],
      nextAction: 'inspect_fix_run_relationship',
      blockedReason: reason,
    },
  };
}

export function buildFixRunOutcome(input: FixRunOutcomeInput): FixRunOutcomePayload {
  if (!input.sourceRun) return blocked('unknown', input.fixRun?.id ?? 'unknown', 'missing_source_run');
  if (!input.fixRun) return blocked(input.sourceRun.id, 'unknown', 'missing_fix_run');
  if (!isFixRunSpawnerChild(input.fixRunEvents)) return blocked(input.sourceRun.id, input.fixRun.id, 'not_fix_run_spawner_child');

  const draft = queuedFixRunDraft(input.fixRunEvents) ?? sourceSpawnedDraft(input.sourceEvents, input.fixRun.id);
  const checklist = verificationChecklist(draft);
  const risk = riskLevel(draft);
  const result = input.fixRun.result ?? '';
  const error = input.fixRun.error ?? '';
  const failureResultText = result.replace(/\b(?:no|zero|0)\s+tests?\s+failed\b/gi, '');
  const resolvedSignals = textSignals(result, [/test(s)? passed/i, /verified/i, /recovered/i, /resolved/i, /healthy/i]);
  const failedSignals = [
    ...textSignals(error, [/.+/]),
    ...textSignals(failureResultText, [/tests?\s+failed/i, /verification\s+failed/i, /regression\s+detected/i]),
  ];

  let status: FixRunOutcomeStatus;
  let nextAction: FixRunOutcomeNextAction;
  if (input.fixRun.status === 'queued' || input.fixRun.status === 'running' || input.fixRun.status === 'awaiting_input' || input.fixRun.status === 'paused') {
    status = 'pending';
    nextAction = 'wait_for_fix_run_completion';
  } else if (input.fixRun.status === 'error' || input.fixRun.status === 'lost' || input.fixRun.status === 'canceled') {
    status = 'failed';
    nextAction = 'manual_review_failed_fix';
  } else if (input.fixRun.status === 'success' && resolvedSignals.length > 0 && failedSignals.length === 0) {
    status = 'resolved';
    nextAction = 'record_resolution';
  } else if (input.fixRun.status === 'success') {
    status = 'needs_review';
    nextAction = 'review_fix_run_output';
  } else {
    status = 'verifying';
    nextAction = 'wait_for_fix_run_completion';
  }

  return {
    fixRunOutcome: {
      status,
      title: titleFor(status, input.fixRun.id),
      summary: status === 'resolved'
        ? `Fix run ${input.fixRun.id} produced verification evidence.`
        : status === 'failed'
          ? `Fix run ${input.fixRun.id} ended with failure evidence.`
          : status === 'needs_review'
            ? `Fix run ${input.fixRun.id} completed without enough verification evidence.`
            : `Fix run ${input.fixRun.id} is not ready for final outcome recording.`,
      detail: result || error || 'No terminal output recorded yet.',
      sourceRunId: input.sourceRun.id,
      fixRunId: input.fixRun.id,
      riskLevel: risk,
      resolvedSignals,
      failedSignals,
      verificationChecklist: checklist,
      nextAction,
    },
  };
}
