import { describe, expect, test } from 'vitest';

import { buildFixRunOutcome } from '../src/fix-run-outcome.js';
import type { IssueAgentRun, IssueAgentRunEvent } from '../src/types.js';

function run(partial: Partial<IssueAgentRun>): IssueAgentRun {
  return {
    id: partial.id ?? 'irun_fix',
    issue_id: partial.issue_id ?? 'iss_fix',
    workspace_jid: partial.workspace_jid ?? 'web:main',
    workspace_folder: partial.workspace_folder ?? 'main',
    status: partial.status ?? 'queued',
    created_by: partial.created_by ?? 'user_1',
    created_at: partial.created_at ?? '2026-06-16T00:00:00.000Z',
    parent_run_id: partial.parent_run_id,
    result: partial.result,
    error: partial.error,
  } as IssueAgentRun;
}

function event(partial: Partial<IssueAgentRunEvent>): IssueAgentRunEvent {
  return {
    id: partial.id ?? 'ev_1',
    issue_id: partial.issue_id ?? 'iss_fix',
    run_id: partial.run_id ?? 'irun_fix',
    event_type: partial.event_type ?? 'run_queued',
    title: partial.title ?? 'event',
    summary: partial.summary ?? null,
    detail: partial.detail ?? null,
    payload: partial.payload ?? null,
    created_at: partial.created_at ?? '2026-06-16T00:00:00.000Z',
  };
}

const draft = {
  status: 'draft_ready',
  title: 'Fix checkout using runbook',
  riskLevel: 'high',
  sourceRunId: 'irun_source',
  verificationChecklist: ['Run checkout smoke', 'Verify production recovery'],
  remediationActions: [{ action: 'spawn_fix_run', summary: 'Patch checkout null guard' }],
};

describe('fix run outcome verifier', () => {
  test('keeps queued and running fix runs pending', () => {
    const outcome = buildFixRunOutcome({
      sourceRun: run({ id: 'irun_source', status: 'success' }),
      fixRun: run({ id: 'irun_fix', parent_run_id: 'irun_source', status: 'running' }),
      sourceEvents: [event({ run_id: 'irun_source', event_type: 'fix_run_spawned', payload: { fixRunId: 'irun_fix', fixRunDraft: draft } })],
      fixRunEvents: [event({ run_id: 'irun_fix', payload: { trigger: 'fix_run_spawner', fixRunDraft: draft } })],
    });

    expect(outcome.fixRunOutcome).toMatchObject({ status: 'pending', sourceRunId: 'irun_source', fixRunId: 'irun_fix', nextAction: 'wait_for_fix_run_completion' });
  });

  test('marks successful fix runs with verification signals as resolved', () => {
    const outcome = buildFixRunOutcome({
      sourceRun: run({ id: 'irun_source', status: 'success' }),
      fixRun: run({ id: 'irun_fix', parent_run_id: 'irun_source', status: 'success', result: 'patched checkout guard; tests passed; production recovered' }),
      sourceEvents: [event({ run_id: 'irun_source', event_type: 'fix_run_spawned', payload: { fixRunId: 'irun_fix', fixRunDraft: draft } })],
      fixRunEvents: [event({ run_id: 'irun_fix', payload: { trigger: 'fix_run_spawner', fixRunDraft: draft } })],
    });

    expect(outcome.fixRunOutcome.status).toBe('resolved');
    expect(outcome.fixRunOutcome.resolvedSignals.join(' ')).toContain('tests passed');
    expect(outcome.fixRunOutcome.verificationChecklist).toContain('Run checkout smoke');
  });

  test('treats successful verification text with no errors as resolved', () => {
    for (const result of [
      'tests passed with no errors; production healthy',
      'no tests failed; production healthy',
      '0 tests failed; tests passed; production healthy',
    ]) {
      const outcome = buildFixRunOutcome({
        sourceRun: run({ id: 'irun_source', status: 'success' }),
        fixRun: run({ id: 'irun_fix', parent_run_id: 'irun_source', status: 'success', result }),
        sourceEvents: [event({ run_id: 'irun_source', event_type: 'fix_run_spawned', payload: { fixRunId: 'irun_fix', fixRunDraft: draft } })],
        fixRunEvents: [event({ run_id: 'irun_fix', payload: { trigger: 'fix_run_spawner', fixRunDraft: draft } })],
      });

      expect(outcome.fixRunOutcome.status).toBe('resolved');
      expect(outcome.fixRunOutcome.failedSignals).toEqual([]);
    }
  });

  test('marks failed terminal fix runs as failed', () => {
    const outcome = buildFixRunOutcome({
      sourceRun: run({ id: 'irun_source', status: 'success' }),
      fixRun: run({ id: 'irun_fix', parent_run_id: 'irun_source', status: 'error', error: 'unit tests failed' }),
      sourceEvents: [event({ run_id: 'irun_source', event_type: 'fix_run_spawned', payload: { fixRunId: 'irun_fix', fixRunDraft: draft } })],
      fixRunEvents: [event({ run_id: 'irun_fix', payload: { trigger: 'fix_run_spawner', fixRunDraft: draft } })],
    });

    expect(outcome.fixRunOutcome).toMatchObject({ status: 'failed', nextAction: 'manual_review_failed_fix' });
    expect(outcome.fixRunOutcome.failedSignals.join(' ')).toContain('unit tests failed');
  });

  test('marks success without verification evidence as needs review', () => {
    const outcome = buildFixRunOutcome({
      sourceRun: run({ id: 'irun_source', status: 'success' }),
      fixRun: run({ id: 'irun_fix', parent_run_id: 'irun_source', status: 'success', result: 'changed files' }),
      sourceEvents: [event({ run_id: 'irun_source', event_type: 'fix_run_spawned', payload: { fixRunId: 'irun_fix', fixRunDraft: draft } })],
      fixRunEvents: [event({ run_id: 'irun_fix', payload: { trigger: 'fix_run_spawner', fixRunDraft: draft } })],
    });

    expect(outcome.fixRunOutcome).toMatchObject({ status: 'needs_review', nextAction: 'review_fix_run_output' });
  });

  test('blocks non fix-run-spawner child runs', () => {
    const outcome = buildFixRunOutcome({
      sourceRun: run({ id: 'irun_source', status: 'success' }),
      fixRun: run({ id: 'irun_review', parent_run_id: 'irun_source', status: 'success', result: 'reviewed' }),
      sourceEvents: [],
      fixRunEvents: [event({ run_id: 'irun_review', payload: { trigger: 'review_agent' } })],
    });

    expect(outcome.fixRunOutcome).toMatchObject({ status: 'blocked', blockedReason: 'not_fix_run_spawner_child' });
  });
});
