import { describe, expect, test } from 'vitest';

import { evaluateRunQuality } from '../src/quality-evaluator.js';

describe('quality evaluator', () => {
  test('marks successful issue runs with verification evidence as passed', () => {
    const evaluation = evaluateRunQuality({
      source: 'issue',
      sourceId: 'iss_1',
      title: 'Implement feature',
      run: {
        id: 'run_1',
        issue_id: 'iss_1',
        workspace_jid: 'web:main',
        workspace_folder: 'main',
        status: 'success',
        result: 'Implemented feature. Verification: npm test -- tests/foo.test.ts passed.',
        agent_link_id: 'cl_ready',
        agent_client_id: 'claude-code',
        execution_node: 'runtime:cl_ready:claude-code',
        created_by: 'u1',
        created_at: '2026-06-15T01:00:00.000Z',
        run_completed_at: '2026-06-15T01:10:00.000Z',
      },
      events: [
        {
          id: 'ev_verify',
          issue_id: 'iss_1',
          run_id: 'run_1',
          event_type: 'verification_completed',
          title: 'Verification completed',
          summary: 'npm test -- tests/foo.test.ts',
          payload: { command: 'npm test -- tests/foo.test.ts', exitCode: 0 },
          created_at: '2026-06-15T01:09:00.000Z',
        },
      ],
      requests: [],
    });

    expect(evaluation).toMatchObject({
      source: 'issue',
      sourceId: 'iss_1',
      runId: 'run_1',
      outcome: 'passed',
      confidence: 'high',
      failureCategory: null,
      needsReview: false,
      runtimeId: 'runtime:cl_ready:claude-code',
      agentClientId: 'claude-code',
    });
    expect(evaluation.score).toBeGreaterThanOrEqual(90);
    expect(evaluation.evidence.map((item) => item.kind)).toContain('verification');
  });

  test('marks successful code-changing runs without verification as needs_review', () => {
    const evaluation = evaluateRunQuality({
      source: 'issue',
      sourceId: 'iss_2',
      run: {
        id: 'run_2',
        issue_id: 'iss_2',
        workspace_jid: 'web:main',
        workspace_folder: 'main',
        status: 'success',
        result: 'Modified src/app.ts and web/src/App.tsx.',
        selected_skills: ['repo-edit'],
        created_by: 'u1',
        created_at: '2026-06-15T02:00:00.000Z',
      },
      events: [
        {
          id: 'ev_files',
          issue_id: 'iss_2',
          run_id: 'run_2',
          event_type: 'files_changed',
          title: 'Files changed',
          summary: '2 files changed',
          payload: { changedFiles: ['src/app.ts', 'web/src/App.tsx'] },
          created_at: '2026-06-15T02:04:00.000Z',
        },
      ],
      requests: [],
    });

    expect(evaluation).toMatchObject({
      outcome: 'needs_review',
      confidence: 'medium',
      failureCategory: 'missing_verification',
      needsReview: true,
    });
    expect(evaluation.reasons).toContain('Code changes were detected without verification evidence');
  });

  test('classifies rejected approvals as user_rejected failures', () => {
    const evaluation = evaluateRunQuality({
      source: 'issue',
      sourceId: 'iss_3',
      run: {
        id: 'run_3',
        issue_id: 'iss_3',
        workspace_jid: 'web:main',
        workspace_folder: 'main',
        status: 'canceled',
        created_by: 'u1',
        created_at: '2026-06-15T03:00:00.000Z',
      },
      events: [],
      requests: [
        {
          id: 'req_3',
          issue_id: 'iss_3',
          run_id: 'run_3',
          kind: 'permission',
          status: 'answered',
          decision: 'reject',
          created_at: '2026-06-15T03:01:00.000Z',
        },
      ],
    });

    expect(evaluation).toMatchObject({
      outcome: 'failed',
      confidence: 'high',
      failureCategory: 'user_rejected',
      needsReview: false,
    });
  });

  test('keeps runtime recovery as positive evidence when the run eventually succeeds', () => {
    const evaluation = evaluateRunQuality({
      source: 'issue',
      sourceId: 'iss_4',
      run: {
        id: 'run_4',
        issue_id: 'iss_4',
        workspace_jid: 'web:main',
        workspace_folder: 'main',
        status: 'success',
        result: 'Completed after failover. npm run typecheck passed.',
        created_by: 'u1',
        created_at: '2026-06-15T04:00:00.000Z',
      },
      events: [
        {
          id: 'ev_recovery',
          issue_id: 'iss_4',
          run_id: 'run_4',
          event_type: 'runtime_self_healed',
          title: 'Runtime self-healed',
          payload: { originalBlockedReason: 'runtime_degraded', recoveredRuntimeId: 'cl_ready:claude-code' },
          created_at: '2026-06-15T04:01:00.000Z',
        },
      ],
      requests: [],
    });

    expect(evaluation).toMatchObject({ outcome: 'passed', failureCategory: null });
    expect(evaluation.evidence.map((item) => item.kind)).toEqual(expect.arrayContaining(['runtime_recovery', 'verification']));
    expect(evaluation.reasons).toContain('Runtime recovered before completion');
  });

  test('classifies failed test and build outputs', () => {
    const evaluation = evaluateRunQuality({
      source: 'task',
      sourceId: 'task_1',
      taskLog: {
        task_id: 'task_1',
        run_at: '2026-06-15T05:00:00.000Z',
        duration_ms: 1000,
        status: 'error',
        result: null,
        error: 'npm test failed: expected true to be false',
      },
    });

    expect(evaluation).toMatchObject({
      source: 'task',
      sourceId: 'task_1',
      outcome: 'failed',
      confidence: 'high',
      failureCategory: 'test_failure',
      needsReview: true,
    });
  });

  test('does not treat generic build wording as verification evidence', () => {
    const evaluation = evaluateRunQuality({
      source: 'issue',
      sourceId: 'iss_build_word',
      run: {
        id: 'run_build_word',
        issue_id: 'iss_build_word',
        workspace_jid: 'web:main',
        workspace_folder: 'main',
        status: 'success',
        result: 'Modified src/app.ts to build the UI state model.',
        created_by: 'u1',
        created_at: '2026-06-15T06:00:00.000Z',
      },
      events: [],
      requests: [],
    });

    expect(evaluation).toMatchObject({ outcome: 'needs_review', failureCategory: 'missing_verification' });
    expect(evaluation.evidence.map((item) => item.kind)).not.toContain('verification');
  });
});
