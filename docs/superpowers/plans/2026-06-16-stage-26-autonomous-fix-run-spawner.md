# Stage 26 Autonomous Fix Run Spawner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert safe runbook reuse recommendations into auditable, one-click child fix runs.

**Architecture:** Add a pure `src/fix-run-spawner.ts` draft builder that consumes Stage 25 runbook reuse payload plus issue/run metadata and returns a deterministic fix-run draft. Issue routes expose read-only draft generation and guarded spawning, Orchestration Control maps fix-run events, and Issue Detail adds a compact Fix Run Spawner panel after Runbook Reuse.

**Tech Stack:** TypeScript, Hono routes, Vitest, Zustand, React, existing issue run events, Incident Knowledge, Runbook Reuse, Orchestration Control.

---

## File Structure

- Create `src/fix-run-spawner.ts`: pure draft builder. No DB/network/time/randomness.
- Create `tests/fix-run-spawner.test.ts`: unit tests for draft status, blocking rules, and prompt content.
- Create `tests/fix-run-spawner-routes.test.ts`: route tests for GET read-only, POST spawn, unsafe rejection, and duplicate protection.
- Modify `src/routes/issues.ts`: import builder, create payload helper, expose `fix-run-draft` and `fix-run` routes, create child run and audit events.
- Modify `src/orchestration-control.ts`: add `fix_run_proposed`, `fix_run_spawned`, `fix_run_blocked` event types and summary bucket mappings.
- Modify `tests/orchestration-control.test.ts`: add fix-run timeline/summary assertions.
- Modify `web/src/stores/issues.ts`: add fix-run draft types, cache, actions, and issue deletion cleanup.
- Modify `web/src/pages/IssueDetailPage.tsx`: add `FixRunSpawnerPanel` under `RunbookReusePanel` in both run detail locations.
- Modify `web/src/stores/orchestration.ts`: add frontend fix-run event union members.
- Modify `web/src/pages/OrchestrationPage.tsx`: add fix-run tone/icon/label/filter mappings.
- Modify `tests/frontend-agents-module.test.ts`: static assertions for store symbols, panel symbols, and orchestration mappings.

---

### Task 1: Pure fix-run draft builder

**Files:**
- Create: `src/fix-run-spawner.ts`
- Test: `tests/fix-run-spawner.test.ts`

- [ ] **Step 1: Write failing unit tests**

Create `tests/fix-run-spawner.test.ts` with cases for:

```ts
import { describe, expect, test } from 'vitest';

import { buildFixRunDraft } from '../src/fix-run-spawner.js';
import type { IncidentKnowledgeEntry } from '../src/incident-knowledge.js';
import type { RunbookReusePayload } from '../src/runbook-reuse.js';

function incident(partial: Partial<IncidentKnowledgeEntry> = {}): IncidentKnowledgeEntry {
  return {
    id: partial.id ?? 'ik_current',
    issueId: partial.issueId ?? 'iss_fix',
    runId: partial.runId ?? 'run_current',
    title: partial.title ?? 'checkout 500s',
    fingerprint: partial.fingerprint ?? 'ik_high_checkout-500s',
    severity: partial.severity ?? 'high',
    status: partial.status ?? 'open',
    symptoms: partial.symptoms ?? ['checkout 500s', 'payment timeout'],
    suspectedRootCauses: partial.suspectedRootCauses ?? ['Null checkout guard'],
    remediationActions: partial.remediationActions ?? [],
    verificationSignals: partial.verificationSignals ?? [],
    preventionChecklist: partial.preventionChecklist ?? ['Verify checkout recovery'],
    relatedEvents: partial.relatedEvents ?? [],
    createdAt: partial.createdAt ?? '2026-06-16T00:00:00.000Z',
    updatedAt: partial.updatedAt ?? '2026-06-16T00:01:00.000Z',
  };
}

function reusableRunbook(overrides: Partial<RunbookReusePayload['recommendation']> = {}): RunbookReusePayload {
  return {
    recommendation: {
      status: 'reuse_recommended',
      action: 'reuse_remediation_actions',
      riskLevel: 'high',
      confidence: 'high',
      approvalRequired: false,
      summary: 'Matched historical runbook ik_high_checkout-500s',
      detail: 'fingerprint match · historical remediation actions available',
      sourceFingerprint: 'ik_high_checkout-500s',
      ...overrides,
    },
    matches: [
      {
        id: 'ik_archived',
        issueId: 'iss_fix',
        runId: 'run_archived',
        fingerprint: 'ik_high_checkout-500s',
        title: 'checkout 500s',
        status: 'resolved',
        severity: 'high',
        score: 100,
        confidence: 'high',
        reusable: true,
        rationale: ['fingerprint match'],
        remediationActions: [{ action: 'spawn_fix_run', summary: 'Patch checkout null guard', observedAt: '2026-06-16T00:02:00.000Z' }],
        verificationSignals: [{ eventType: 'production_recovered', summary: 'healthy again', observedAt: '2026-06-16T00:03:00.000Z' }],
      },
    ],
    reusableActions: [{ action: 'spawn_fix_run', summary: 'Patch checkout null guard', observedAt: '2026-06-16T00:02:00.000Z' }],
    checklist: [{ id: 'verification', label: 'Recovery verification', status: 'ready', detail: 'Verify production recovery after any reused action.' }],
  };
}

describe('fix run spawner', () => {
  test('builds a draft-ready fix run from a safe reusable runbook', () => {
    const result = buildFixRunDraft({
      issue: { id: 'iss_fix', title: 'Checkout is failing', description: 'checkout smoke failed' },
      sourceRun: { id: 'run_current', result: 'production incident detected' },
      currentIncident: incident(),
      runbookReuse: reusableRunbook(),
    });

    expect(result.fixRunDraft).toMatchObject({
      status: 'draft_ready',
      title: 'Fix checkout 500s using runbook ik_high_checkout-500s',
      riskLevel: 'high',
      approvalRequired: false,
      sourceRunId: 'run_current',
      sourceFingerprint: 'ik_high_checkout-500s',
    });
    expect(result.fixRunDraft.prompt).toContain('Checkout is failing');
    expect(result.fixRunDraft.prompt).toContain('Patch checkout null guard');
    expect(result.fixRunDraft.prompt).toContain('Verify checkout recovery');
  });

  test('blocks approval-required runbook reuse from direct spawning', () => {
    const result = buildFixRunDraft({
      issue: { id: 'iss_fix', title: 'Critical outage', description: 'rollback recommended' },
      sourceRun: { id: 'run_current' },
      currentIncident: incident({ severity: 'critical' }),
      runbookReuse: reusableRunbook({ status: 'approval_required', action: 'request_rollback', riskLevel: 'critical', approvalRequired: true }),
    });

    expect(result.fixRunDraft).toMatchObject({ status: 'approval_required', approvalRequired: true, blockedReason: 'human_approval_required' });
  });

  test('blocks candidate and not-reusable recommendations', () => {
    const candidate = buildFixRunDraft({
      issue: { id: 'iss_fix', title: 'Checkout maybe failing' },
      sourceRun: { id: 'run_current' },
      currentIncident: incident(),
      runbookReuse: reusableRunbook({ status: 'candidate_found', action: 'collect_more_signals' }),
    });
    const blocked = buildFixRunDraft({
      issue: { id: 'iss_fix', title: 'Checkout failed remediation' },
      sourceRun: { id: 'run_current' },
      currentIncident: incident(),
      runbookReuse: reusableRunbook({ status: 'not_reusable', action: 'collect_more_signals', approvalRequired: true }),
    });

    expect(candidate.fixRunDraft).toMatchObject({ status: 'blocked', blockedReason: 'runbook_not_directly_reusable' });
    expect(blocked.fixRunDraft).toMatchObject({ status: 'blocked', blockedReason: 'runbook_not_directly_reusable' });
  });
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -- tests/fix-run-spawner.test.ts`

Expected: FAIL because `src/fix-run-spawner.ts` does not exist.

- [ ] **Step 3: Implement minimal builder**

Create `src/fix-run-spawner.ts` exporting:

```ts
export type FixRunDraftStatus = 'none' | 'draft_ready' | 'approval_required' | 'blocked';
export interface FixRunDraftPayload { fixRunDraft: FixRunDraft; }
export function buildFixRunDraft(input: FixRunDraftInput): FixRunDraftPayload;
```

Rules:
- no recommendation/current incident/actions => `none` or `blocked`
- `approvalRequired === true || status === 'approval_required'` => `approval_required`
- only `status === 'reuse_recommended' && !approvalRequired && reusableActions.length > 0` => `draft_ready`
- generated prompt includes issue title/description, source run id, fingerprint, current symptoms, historical remediation actions, and verification checklist.

- [ ] **Step 4: Run GREEN**

Run: `npm test -- tests/fix-run-spawner.test.ts`

Expected: PASS.

---

### Task 2: Issue routes for draft and spawn

**Files:**
- Modify: `src/routes/issues.ts`
- Test: `tests/fix-run-spawner-routes.test.ts`

- [ ] **Step 1: Write failing route tests**

Create route tests with the same mock style as `tests/runbook-reuse-routes.test.ts`:
- GET `/:id/runs/:runId/fix-run-draft` returns `draft_ready` and does not create runs/events.
- POST `/:id/runs/:runId/fix-run` creates exactly one child run with `parent_run_id` equal to source run, records `fix_run_spawned`, queues the run, and returns `{ run, fixRunDraft }`.
- Second POST returns the same child run or avoids duplicates by detecting prior `fix_run_spawned` event.
- Unsafe draft returns `409` and records no child run.

- [ ] **Step 2: Run RED**

Run: `npm test -- tests/fix-run-spawner-routes.test.ts`

Expected: FAIL because routes do not exist.

- [ ] **Step 3: Implement route helper and GET**

In `src/routes/issues.ts`:
- import `buildFixRunDraft` and `FixRunDraftPayload`
- add `buildIssueRunFixRunDraftPayload(issue, run)` using `buildIssueRunRunbookReusePayload` and `buildIssueRunIncidentKnowledgePayload`
- add GET route directly after runbook reuse routes.

- [ ] **Step 4: Implement guarded POST**

In `src/routes/issues.ts` POST route:
- build draft
- reject `draft.status !== 'draft_ready' || draft.approvalRequired` with `409`
- check existing `fix_run_spawned` event on source run and return existing child run if present
- create child run using source run runtime fields and `parent_run_id: run.id`
- record source-run event `fix_run_spawned` with payload `{ fixRunDraft, fixRunId }`
- record child-run `run_queued` event with draft prompt
- create issue event `run_created`
- call `enqueueIssueRun(issue.id, fixRun.id)`

- [ ] **Step 5: Run GREEN**

Run: `npm test -- tests/fix-run-spawner-routes.test.ts`

Expected: PASS.

---

### Task 3: Orchestration Control fix-run events

**Files:**
- Modify: `src/orchestration-control.ts`
- Test: `tests/orchestration-control.test.ts`

- [ ] **Step 1: Add failing orchestration test**

Append a test that creates issue run events:
- `fix_run_proposed`
- `fix_run_spawned`
- `fix_run_blocked`

Assert timeline types are emitted in newest-first order and summary counts blocked/manualReview/autoExecuted as expected.

- [ ] **Step 2: Run RED**

Run: `npm test -- tests/orchestration-control.test.ts`

Expected: FAIL because event types are not mapped.

- [ ] **Step 3: Implement mapping**

In `src/orchestration-control.ts`:
- extend `OrchestrationControlEventType` union
- add `fixRunEventType(eventType)` helper
- include it in issue run event mapping next to runbook reuse
- summary: `fix_run_spawned` counts as `autoExecuted` and `manualReview`; `fix_run_blocked` counts as `blocked`; `fix_run_proposed` counts as `manualReview`.

- [ ] **Step 4: Run GREEN**

Run: `npm test -- tests/orchestration-control.test.ts`

Expected: PASS.

---

### Task 4: Frontend store and Issue Detail panel

**Files:**
- Modify: `web/src/stores/issues.ts`
- Modify: `web/src/pages/IssueDetailPage.tsx`
- Modify: `web/src/stores/orchestration.ts`
- Modify: `web/src/pages/OrchestrationPage.tsx`
- Test: `tests/frontend-agents-module.test.ts`

- [ ] **Step 1: Add failing static frontend test**

In `tests/frontend-agents-module.test.ts`, assert these source symbols exist:
- `IssueRunFixRunDraft`
- `fixRunDraftsByRun`
- `loadIssueRunFixRunDraft`
- `spawnIssueRunFixRun`
- `FixRunSpawnerPanel`
- `fix_run_spawned`
- `fix_run_blocked`

- [ ] **Step 2: Run RED**

Run: `npm test -- tests/frontend-agents-module.test.ts`

Expected: FAIL because symbols are missing.

- [ ] **Step 3: Implement store types/actions**

In `web/src/stores/issues.ts`:
- add `IssueRunFixRunDraftStatus`, `IssueRunFixRunDraft`, `fixRunDraftsByRun`
- add actions for GET/POST endpoints
- clear `fixRunDraftsByRun` during issue deletion.

- [ ] **Step 4: Implement Issue Detail panel**

Add `FixRunSpawnerPanel` under `RunbookReusePanel` in both run detail render locations. Button enabled only when `draft.status === 'draft_ready' && !draft.approvalRequired`.

- [ ] **Step 5: Implement orchestration frontend mappings**

Add fix-run event union members, labels, icons, tones, and filters in orchestration store/page.

- [ ] **Step 6: Run GREEN**

Run: `npm test -- tests/frontend-agents-module.test.ts`

Expected: PASS.

---

### Task 5: Final verification and review

**Files:**
- All Stage 26 files above.

- [ ] **Step 1: Run focused Stage 26 tests**

Run:

```bash
npm test -- tests/fix-run-spawner.test.ts tests/fix-run-spawner-routes.test.ts tests/orchestration-control.test.ts tests/frontend-agents-module.test.ts
```

Expected: all tests PASS.

- [ ] **Step 2: Run typecheck and builds**

Run:

```bash
npm run typecheck && npm run build && npm run build:web
```

Expected: all commands exit 0. Existing Vite chunk-size warnings are acceptable.

- [ ] **Step 3: Request code review**

Use code-review subagent with Stage 26 requirements and changed files.

- [ ] **Step 4: Fix Critical/Important findings**

If reviewer reports Critical or Important issues, add failing tests first, fix, and rerun focused tests and builds.

---

## Self-Review

- Spec coverage: pure builder, guarded routes, orchestration, frontend panel/store, and verification are covered.
- Placeholder scan: no TBD/TODO placeholders remain; all tasks include exact files and commands.
- Type consistency: `FixRunDraft`, `FixRunDraftPayload`, `IssueRunFixRunDraft`, and event names are consistent across tasks.
