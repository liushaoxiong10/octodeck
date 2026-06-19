# Stage 28 Autonomous Resolution & Runbook Promotion Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn verified fix-run outcomes into an auditable resolution gate that can safely close issues and mark recovered knowledge as reusable.

**Architecture:** Add a deterministic `src/resolution-gate.ts` builder that consumes issue metadata, source/fix runs, and Stage 27 fix-run outcome payload. Issue routes expose read-only gate generation and guarded/idempotent apply; Orchestration Control maps resolution events; Issue Detail adds a panel after Fix Run Outcome.

**Tech Stack:** TypeScript, Hono routes, Vitest, Zustand, React, existing issue run events, Fix Run Outcome Verifier, Orchestration Control.

---

## File Structure

- Create `src/resolution-gate.ts`: pure gate builder.
- Create `tests/resolution-gate.test.ts`: unit tests for ready, approval_required, needs_review, and blocked states.
- Create `tests/resolution-gate-routes.test.ts`: route tests for GET read-only, POST apply, unsafe rejection, and idempotency.
- Modify `src/routes/issues.ts`: import builder, add payload helper, expose resolution gate routes, update issue status to `done` only for safe gate.
- Modify `src/orchestration-control.ts`: add resolution event types and summary mappings.
- Modify `tests/orchestration-control.test.ts`: add resolution timeline/summary assertions.
- Modify `web/src/stores/issues.ts`: add resolution gate types/cache/actions and deletion cleanup.
- Modify `web/src/pages/IssueDetailPage.tsx`: add `ResolutionGatePanel` after `FixRunOutcomePanel`.
- Modify `web/src/stores/orchestration.ts` and `web/src/pages/OrchestrationPage.tsx`: add frontend event union/mappings.
- Modify `tests/frontend-agents-module.test.ts`: static assertions for Stage 28 symbols.

---

### Task 1: Pure resolution gate builder

**Files:**
- Create: `src/resolution-gate.ts`
- Test: `tests/resolution-gate.test.ts`

- [ ] **Step 1: Write failing unit tests**

Create tests covering:
- resolved outcome with low/medium/high risk and no failed signals returns `ready`.
- critical risk returns `approval_required`.
- needs_review outcome returns `needs_review`.
- failed/blocked/missing outcome returns `blocked`.

- [ ] **Step 2: Run RED**

Run: `npm test -- tests/resolution-gate.test.ts`

Expected: FAIL because `src/resolution-gate.ts` does not exist.

- [ ] **Step 3: Implement builder**

Create `buildResolutionGate(input)` exporting `ResolutionGateStatus`, `ResolutionGate`, and `ResolutionGatePayload`. The builder must be pure and return recommended issue status, archive/promote booleans, rationale, checklist, and approvalRequired.

- [ ] **Step 4: Run GREEN**

Run: `npm test -- tests/resolution-gate.test.ts`

Expected: PASS.

---

### Task 2: Issue routes for resolution gate

**Files:**
- Modify: `src/routes/issues.ts`
- Test: `tests/resolution-gate-routes.test.ts`

- [ ] **Step 1: Write route tests**

Create tests covering:
- GET `/:id/runs/:runId/resolution-gate` returns ready gate and is read-only.
- POST `/:id/runs/:runId/resolution-gate/apply` updates issue status to `done`, records `resolution_gate_applied`, and is idempotent.
- critical/unsafe gate returns 409 and does not update issue.

- [ ] **Step 2: Implement GET helper**

Add `buildIssueRunResolutionGatePayload(issue, run)` using existing fix-run outcome payload helper and `buildResolutionGate`.

- [ ] **Step 3: Implement guarded POST**

POST apply must reject unless `gate.status === 'ready' && !gate.approvalRequired`. For safe gate, use `recordIssueRunDeliveryEventOnce`, call `updateIssue(issue.id, { status: 'done' })`, write an issue event, and return payload. Repeated apply should not duplicate run event.

- [ ] **Step 4: Run route tests**

Run: `npm test -- tests/resolution-gate-routes.test.ts`

Expected: PASS.

---

### Task 3: Orchestration Control integration

**Files:**
- Modify: `src/orchestration-control.ts`
- Modify: `tests/orchestration-control.test.ts`
- Modify: `web/src/stores/orchestration.ts`
- Modify: `web/src/pages/OrchestrationPage.tsx`

- [ ] **Step 1: Add event types**

Add `resolution_ready`, `resolution_applied`, `resolution_blocked`, `resolution_needs_review` backend/frontend event union members and mapping function.

- [ ] **Step 2: Update summary buckets**

Map `resolution_applied` to recovered, `resolution_blocked` to blocked, and `resolution_ready`/`resolution_needs_review` to manualReview.

- [ ] **Step 3: Add tests and frontend mappings**

Add orchestration unit test and frontend tone/icon/label/filter entries.

---

### Task 4: Issue Detail frontend panel

**Files:**
- Modify: `web/src/stores/issues.ts`
- Modify: `web/src/pages/IssueDetailPage.tsx`
- Modify: `tests/frontend-agents-module.test.ts`

- [ ] **Step 1: Add store state/actions**

Add `IssueRunResolutionGate`, `resolutionGatesByRun`, `loadIssueRunResolutionGate`, and `applyIssueRunResolutionGate`.

- [ ] **Step 2: Add panel**

Render `ResolutionGatePanel` after `FixRunOutcomePanel`, including status, recommended issue status, archive/promote flags, rationale, checklist, and Apply Resolution button.

- [ ] **Step 3: Add static assertions**

Extend frontend static test with new store symbols, panel label, actions, and orchestration strings.

---

### Task 5: Final verification and review

**Files:** all Stage 28 files.

- [ ] **Step 1: Run targeted tests**

Run:

```bash
npm test -- tests/resolution-gate.test.ts tests/resolution-gate-routes.test.ts tests/orchestration-control.test.ts tests/frontend-agents-module.test.ts tests/fix-run-outcome.test.ts tests/fix-run-outcome-routes.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run builds**

Run:

```bash
npm run typecheck && npm run build && npm run build:web
```

Expected: PASS.

- [ ] **Step 3: Request code review**

Use `superpowers:requesting-code-review` for focused Stage 28 review. Fix any Critical/Important issues and rerun Step 1/2.

---

## Self-Review Notes

- Coverage: pure builder, routes, orchestration, frontend, final verification are covered.
- Placeholder scan: no TBD/TODO placeholders remain.
- Type consistency: `resolutionGate`, `ResolutionGateStatus`, and resolution event names are consistent across plan tasks.
