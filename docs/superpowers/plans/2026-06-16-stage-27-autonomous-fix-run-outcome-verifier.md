# Stage 27 Autonomous Fix Run Outcome Verifier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify spawned fix-run child runs and record auditable resolved/failed/needs-review outcomes.

**Architecture:** Add a deterministic `src/fix-run-outcome.ts` builder that reads a source run, spawned fix run, and their events to produce a fix-run outcome. Issue routes expose read-only outcome generation and idempotent verification recording, Orchestration Control maps outcome events into timeline/summary buckets, and Issue Detail adds a compact outcome panel after Fix Run Spawner.

**Tech Stack:** TypeScript, Hono routes, Vitest, Zustand, React, existing issue run events, Fix Run Spawner, Orchestration Control.

---

## File Structure

- Create `src/fix-run-outcome.ts`: pure outcome builder with no DB/network/time/randomness.
- Create `tests/fix-run-outcome.test.ts`: unit tests for pending/resolved/failed/needs-review/blocked outcomes.
- Create `tests/fix-run-outcome-routes.test.ts`: route tests for GET read-only, POST idempotent recording, and parent/child resolution.
- Modify `src/routes/issues.ts`: import outcome builder, add source/fix-run relationship helpers, expose `fix-run-outcome` routes, and record outcome events once.
- Modify `src/orchestration-control.ts`: add `fix_run_verifying`, `fix_run_resolved`, `fix_run_failed`, `fix_run_needs_review` event types and summary mappings.
- Modify `tests/orchestration-control.test.ts`: add outcome timeline/summary assertions.
- Modify `web/src/stores/issues.ts`: add fix-run outcome types/cache/actions and deletion cleanup.
- Modify `web/src/pages/IssueDetailPage.tsx`: add `FixRunOutcomePanel` after `FixRunSpawnerPanel` in both selected-run render locations.
- Modify `web/src/stores/orchestration.ts`: add frontend outcome event union members.
- Modify `web/src/pages/OrchestrationPage.tsx`: add outcome tone/icon/label/filter mappings.
- Modify `tests/frontend-agents-module.test.ts`: static assertions for store symbols, panel symbols, and orchestration mappings.

---

### Task 1: Pure fix-run outcome builder

**Files:**
- Create: `src/fix-run-outcome.ts`
- Test: `tests/fix-run-outcome.test.ts`

- [ ] **Step 1: Write failing unit tests**

Create `tests/fix-run-outcome.test.ts` with these cases:

```ts
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
```

- [ ] **Step 2: Run RED**

Run: `npm test -- tests/fix-run-outcome.test.ts`

Expected: FAIL because `src/fix-run-outcome.ts` does not exist.

- [ ] **Step 3: Implement builder**

Create `src/fix-run-outcome.ts` with exported `FixRunOutcomeStatus`, `FixRunOutcome`, `FixRunOutcomePayload`, and `buildFixRunOutcome(input)`. The builder must derive draft metadata from `fixRunEvents` first and source `fix_run_spawned` payload second, block non-`fix_run_spawner` children, classify terminal run statuses, and keep output deterministic.

- [ ] **Step 4: Run GREEN**

Run: `npm test -- tests/fix-run-outcome.test.ts`

Expected: PASS.

---

### Task 2: Issue routes for outcome draft and verification

**Files:**
- Modify: `src/routes/issues.ts`
- Test: `tests/fix-run-outcome-routes.test.ts`

- [ ] **Step 1: Write route tests**

Create `tests/fix-run-outcome-routes.test.ts` covering:
- GET `/:id/runs/:runId/fix-run-outcome` returns a read-only resolved outcome and does not record outcome events.
- POST `/:id/runs/:runId/fix-run-outcome/verify` records exactly one mapped outcome event and is idempotent.
- GET works when `runId` is the source run by resolving the spawned child from `fix_run_spawned`.
- Review-agent child runs return blocked outcome.

- [ ] **Step 2: Implement helpers and GET**

In `src/routes/issues.ts`, add helpers:
- `fixRunDraftFromQueuedEvent(runId)`
- `sourceRunForFixRun(issueId, run)`
- `fixRunForOutcomeRequest(issueId, run)`
- `buildIssueRunFixRunOutcomePayload(issue, run)`

Add GET route after POST `/fix-run`.

- [ ] **Step 3: Implement idempotent POST**

Add POST route after GET. Map status to event type:
- `pending` or `verifying` → `fix_run_verifying`
- `resolved` → `fix_run_resolved`
- `failed` → `fix_run_failed`
- `needs_review` → `fix_run_needs_review`
- `blocked` → `fix_run_failed`

Use `recordIssueRunDeliveryEventOnce` on the fix run id with payload `{ fixRunOutcome }`.

- [ ] **Step 4: Run route tests**

Run: `npm test -- tests/fix-run-outcome-routes.test.ts`

Expected: PASS.

---

### Task 3: Orchestration Control integration

**Files:**
- Modify: `src/orchestration-control.ts`
- Modify: `tests/orchestration-control.test.ts`
- Modify: `web/src/stores/orchestration.ts`
- Modify: `web/src/pages/OrchestrationPage.tsx`

- [ ] **Step 1: Extend event types and backend mapping**

Add `fix_run_verifying`, `fix_run_resolved`, `fix_run_failed`, and `fix_run_needs_review` to backend and frontend event unions. Extend `fixRunEventType()` and summary buckets.

- [ ] **Step 2: Add orchestration test**

Append a test asserting fix-run outcome events appear in timeline and summary: resolved increments recovered; failed increments failed/blocked; needs-review increments manualReview.

- [ ] **Step 3: Update frontend mappings**

Add tone/icon/label entries and include `fix_run_needs_review` in waiting/manual review filters and `fix_run_failed` in blocked filters.

- [ ] **Step 4: Run orchestration tests**

Run: `npm test -- tests/orchestration-control.test.ts tests/frontend-agents-module.test.ts`

Expected: PASS after frontend static assertions are updated in Task 4.

---

### Task 4: Issue Detail frontend outcome panel

**Files:**
- Modify: `web/src/stores/issues.ts`
- Modify: `web/src/pages/IssueDetailPage.tsx`
- Modify: `tests/frontend-agents-module.test.ts`

- [ ] **Step 1: Add store types/actions**

Add `IssueRunFixRunOutcomeStatus`, `IssueRunFixRunOutcome`, `fixRunOutcomesByRun`, `loadIssueRunFixRunOutcome`, and `verifyIssueRunFixRunOutcome`. Ensure issue deletion cleans the cache for removed runs.

- [ ] **Step 2: Add `FixRunOutcomePanel`**

Render status, linked fix run id, next action, verification checklist, resolved signals, failed signals, and a “Verify Outcome” button after `FixRunSpawnerPanel` in both selected-run locations.

- [ ] **Step 3: Add static frontend assertions**

Extend `tests/frontend-agents-module.test.ts` to assert the new store symbols, panel label, actions, and orchestration event strings.

- [ ] **Step 4: Run frontend static test**

Run: `npm test -- tests/frontend-agents-module.test.ts`

Expected: PASS.

---

### Task 5: Final verification and review

**Files:**
- All Stage 27 files above.

- [ ] **Step 1: Run targeted test suite**

Run:

```bash
npm test -- tests/fix-run-outcome.test.ts tests/fix-run-outcome-routes.test.ts tests/orchestration-control.test.ts tests/frontend-agents-module.test.ts tests/issue-runner-scoped-token.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run typecheck and builds**

Run:

```bash
npm run typecheck && npm run build && npm run build:web
```

Expected: PASS.

- [ ] **Step 3: Request code review**

Use `superpowers:requesting-code-review` and ask for a focused Stage 27 review.

- [ ] **Step 4: Fix Critical/Important issues and re-verify**

If review finds Critical or Important issues, fix them and rerun Step 1 and Step 2.

---

## Self-Review Notes

- Spec coverage: pure builder, routes, orchestration, frontend, and final review are covered by Tasks 1-5.
- Placeholder scan: no TBD/TODO/fill-in-later requirements remain; each task names exact files and commands.
- Type consistency: `fixRunOutcome`, `FixRunOutcomeStatus`, and event names are consistent across backend, routes, frontend store, and orchestration.
