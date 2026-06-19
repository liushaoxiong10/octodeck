# Stage One Agent Task Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the B-scope phase-one foundation: keep existing Issue/Task/Agent Team execution paths, but add a unified AgentTask ledger and fix the obvious Issue run lifecycle gaps.

**Architecture:** Add an append/upsert `agent_tasks` ledger table as a compatibility layer over existing `issue_agent_runs`, scheduled task run UUIDs, and agent team runs/tasks. Existing execution code remains the source of truth for actual execution; it mirrors lifecycle transitions into the ledger so Web/API can later converge on one run model without risky rewrites.

**Tech Stack:** TypeScript, Hono, better-sqlite3, Vitest, React/Zustand frontend type alignment.

---

### Task 1: DB ledger and tests

**Files:**
- Modify: `src/types.ts`
- Modify: `src/db.ts`
- Create: `tests/agent-task-ledger.test.ts`

- [ ] **Step 1: Write failing DB tests**

Create `tests/agent-task-ledger.test.ts` with isolated DB setup. Test that `upsertAgentTask()` creates an issue-run ledger row, updates status/timestamps on subsequent calls, lists by source reference, and stores context JSON.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agent-task-ledger.test.ts`

Expected: FAIL because `upsertAgentTask` / `listAgentTasks` do not exist.

- [ ] **Step 3: Implement minimal ledger**

Add `AgentTaskStatus`, `AgentTaskSourceType`, `AgentTask` to `src/types.ts`. Add `agent_tasks` table, indexes, mapper, `upsertAgentTask()`, `getAgentTaskById()`, `listAgentTasks()` to `src/db.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/agent-task-ledger.test.ts`

Expected: PASS.

### Task 2: Mirror Issue run lifecycle into AgentTask

**Files:**
- Modify: `src/routes/issues.ts`
- Modify: `src/issue-runner.ts`
- Modify: `src/issue-auto-driver.ts`
- Modify: `src/issue-run-reconciler.ts`
- Test: `tests/agent-task-ledger.test.ts`

- [ ] **Step 1: Write failing issue mirror test**

Extend `tests/agent-task-ledger.test.ts` to create an issue run, mirror queued/running/success updates, and assert the ledger row has source type `issue_run`, source ref `issueId`, run ref `runId`, status changes, and runtime metadata.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agent-task-ledger.test.ts`

Expected: FAIL until mirror helper is wired.

- [ ] **Step 3: Implement issue mirror helper**

Add a small helper in `src/routes/issues.ts` or `src/issue-runner.ts` that upserts an `agent_tasks` row when an issue run is created and whenever status changes. Use id `agtask_${run.id}` for deterministic lookup.

- [ ] **Step 4: Fix issue run gaps**

Unify auto-driver queue key to `${issue.workspace_jid}#issue:${run.id}`. Add `agent_request_created` and `run_lost` notifications. Align frontend event/status types.

- [ ] **Step 5: Run targeted tests**

Run: `npx vitest run tests/agent-task-ledger.test.ts`

Expected: PASS.

### Task 3: Mirror scheduled Task runs into AgentTask

**Files:**
- Modify: `src/task-scheduler.ts`
- Test: `tests/agent-task-ledger.test.ts`

- [ ] **Step 1: Write failing task mirror test**

Add a direct DB-level test asserting an AgentTask row can represent scheduled task run UUIDs with source type `scheduled_task`, source ref `task.id`, run ref `taskRunId`, and status `running` -> `success` / `error`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agent-task-ledger.test.ts`

Expected: FAIL before task scheduler mirrors status.

- [ ] **Step 3: Wire task scheduler mirrors**

In `runTask()`, create ledger row after `taskRunId` is known, mark running before backend execution, and mark success/error in `finalizeRunLog()`.

- [ ] **Step 4: Run targeted task tests**

Run: `npx vitest run tests/task-backfill-grace.test.ts tests/agent-task-ledger.test.ts`

Expected: PASS.

### Task 4: Mirror Agent Team run/task records into AgentTask

**Files:**
- Modify: `src/db.ts`
- Test: `tests/agent-task-ledger.test.ts`

- [ ] **Step 1: Write failing team mirror test**

Add tests that `recordAgentTeamRun()` mirrors a top-level `agent_team_run` row and `recordAgentTeamTask()` mirrors a `agent_team_task` row.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agent-task-ledger.test.ts`

Expected: FAIL before DB record functions mirror to ledger.

- [ ] **Step 3: Implement DB-level mirror**

Inside `recordAgentTeamRun()` and `recordAgentTeamTask()`, call `upsertAgentTask()` with deterministic ids and status mapping.

- [ ] **Step 4: Run targeted tests**

Run: `npx vitest run tests/agent-team-metrics.test.ts tests/agent-task-ledger.test.ts`

Expected: PASS.

### Task 5: API and frontend type exposure

**Files:**
- Modify: `src/routes/tasks.ts`
- Modify: `src/web.ts` if a new route is needed
- Modify: `web/src/stores/issues.ts`
- Modify: `web/src/pages/IssuesPage.tsx`

- [ ] **Step 1: Add a minimal list API if needed**

Expose `GET /api/tasks/agent-runs?source_type=&source_ref=` returning ledger rows. Keep this read-only.

- [ ] **Step 2: Align frontend issue types**

Add missing issue events `run_lost`, `agent_request_created`, `agent_request_answered`, `agent_request_expired`; add `backend` to `CreateIssueInput`; add `waiting_for_human` to issue page status options.

- [ ] **Step 3: Run typecheck and targeted frontend tests**

Run: `npm run typecheck` and `npx vitest run tests/frontend-agents-module.test.ts tests/frontend-devices-nav.test.ts`

Expected: PASS.

### Task 6: Full verification

**Files:**
- No new files.

- [ ] **Step 1: Run targeted backend tests**

Run: `npx vitest run tests/agent-task-ledger.test.ts tests/task-backfill-grace.test.ts tests/agent-team-metrics.test.ts`

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 3: Inspect git diff**

Run: `git diff --stat && git diff -- docs/superpowers/plans/2026-06-11-stage-one-agent-task-ledger.md src/types.ts src/db.ts src/routes/issues.ts src/issue-runner.ts src/issue-auto-driver.ts src/issue-notifier.ts src/task-scheduler.ts web/src/stores/issues.ts web/src/pages/IssuesPage.tsx tests/agent-task-ledger.test.ts`

Expected: Diff is scoped to phase-one ledger and Issue lifecycle alignment.
