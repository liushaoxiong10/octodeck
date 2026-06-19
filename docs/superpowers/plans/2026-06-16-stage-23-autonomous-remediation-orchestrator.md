# Stage 23 Autonomous Remediation Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把质量失败、交付阻断、发布阻断和生产事故转化为可审计、可批准、可执行的 remediation 闭环。

**Architecture:** 新增 `src/remediation.ts` 纯函数状态机，读取 issue run events 中的 quality / delivery / release / production 信号并输出 remediation stage、推荐动作、风险等级、checklist 和 proposal。`src/routes/issues.ts` 暴露只读 GET、派生事件 refresh、手动 action 记录 API；Orchestration Control 将 remediation 事件纳入 timeline 和 summary；Issue Detail 复用现有 run panel + Zustand cache 模式展示 remediation 状态和动作按钮。

**Tech Stack:** TypeScript, Hono routes, Vitest, Zustand, React, existing issue run events and orchestration timeline.

---

### Task 1: Remediation state machine

**Files:**
- Create: `src/remediation.ts`
- Test: `tests/remediation.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/remediation.test.ts` covering:
- no upstream problem -> `not_needed`, action `none`
- quality failed -> `proposed`, action `spawn_fix_run`, risk `medium`
- release rollback required -> `waiting_approval`, action `request_rollback`, risk `high`
- production rollback recommended -> `waiting_approval`, action `request_rollback`, risk `critical`
- production recovered after an existing remediation proposal -> `resolved`, action `none`

- [ ] **Step 2: Run RED**

Run: `npm test -- tests/remediation.test.ts`
Expected: FAIL because `src/remediation.ts` does not exist.

- [ ] **Step 3: Implement minimal state machine**

Export:
- `RemediationStage`
- `RemediationRecommendedAction`
- `RemediationRiskLevel`
- `RemediationSignal`
- `RemediationState`
- `buildRemediationState(input)`

Rules:
- `production_rollback_recommended` or signal `{ source: 'production', stage: 'rollback_recommended' }` -> `waiting_approval`, `request_rollback`, `critical`
- `release_rollback_required` or signal `{ source: 'release', stage: 'rollback_required' }` -> `waiting_approval`, `request_rollback`, `high`
- `production_incident_detected` or signal `{ source: 'production', stage: 'incident_detected' }` -> `waiting_approval`, `spawn_fix_run`, `high`
- `production_health_degraded` or signal `{ source: 'production', stage: 'degraded' }` -> `proposed`, `verify_recovery`, `medium`
- `delivery_quality_blocked`, `quality_failed`, or signal `{ source: 'quality', stage: 'failed' }` -> `proposed`, `spawn_fix_run`, `medium`
- `release_checks_failed` or signal `{ source: 'release', stage: 'checks_failed' }` -> `proposed`, `rerun_checks`, `medium`
- `production_recovered` or signal `{ source: 'production', stage: 'recovered' }` -> `resolved`, `none`, `low`
- if no problem signal exists -> `not_needed`, `none`, `low`

- [ ] **Step 4: Run GREEN**

Run: `npm test -- tests/remediation.test.ts`
Expected: PASS.

### Task 2: Remediation API routes

**Files:**
- Modify: `src/routes/issues.ts`
- Test: `tests/remediation-routes.test.ts`

- [ ] **Step 1: Write failing route tests**

Create `tests/remediation-routes.test.ts` covering:
- `GET /:id/runs/:runId/remediation` is read-only
- `POST /:id/runs/:runId/remediation/refresh` records one derived remediation event
- `POST /:id/runs/:runId/remediation/actions` records `remediation_action_recorded`
- high-risk rollback action returns `approvalRequired: true` and does not execute rollback

- [ ] **Step 2: Run RED**

Run: `npm test -- tests/remediation-routes.test.ts`
Expected: FAIL because remediation routes do not exist.

- [ ] **Step 3: Implement route helpers and routes**

Add helpers in `src/routes/issues.ts`:
- `remediationSignalsFromEvents(runId)` maps issue run events to `RemediationSignal[]`
- `remediationEventTypeForStage(stage)` maps state to derived event type
- `remediationEventTitleForStage(stage)` maps state to title
- `buildIssueRunRemediationPayload(run)` returns `{ remediation, signals }`

Add routes:
- `GET /:id/runs/:runId/remediation`
- `POST /:id/runs/:runId/remediation/refresh`
- `POST /:id/runs/:runId/remediation/actions`

Action body accepts `{ action, summary?, detail? }`. Allowed actions are `acknowledge`, `mark_verifying`, `mark_resolved`, `spawn_fix_run`, `request_rollback`. Invalid action returns 400. `request_rollback` only records an approval-required event and returns `{ approvalRequired: true }`.

- [ ] **Step 4: Run GREEN**

Run: `npm test -- tests/remediation-routes.test.ts`
Expected: PASS.

### Task 3: Orchestration Control remediation timeline

**Files:**
- Modify: `src/orchestration-control.ts`
- Test: `tests/orchestration-control.test.ts`

- [ ] **Step 1: Write failing tests**

Extend `tests/orchestration-control.test.ts` with remediation events:
- `remediation_proposed`
- `remediation_waiting_approval`
- `remediation_running`
- `remediation_verifying`
- `remediation_resolved`
- `remediation_failed`

Assert waiting approval increments `waitingApproval`, resolved increments `recovered`, failed increments `failed`, and unresolved waiting/failed states appear in timeline.

- [ ] **Step 2: Run RED**

Run: `npm test -- tests/orchestration-control.test.ts`
Expected: FAIL until remediation mappings are added.

- [ ] **Step 3: Implement mapping**

Add `remediation_*` values to `OrchestrationControlEventType`, `EVENT_TONE` compatibility via frontend Task 4, and a `remediationEventType()` mapper. Include remediation waiting approval in summary `waitingApproval`, remediation failed in `failed`, remediation resolved in `recovered`, and remediation waiting/failed in `blocked` where appropriate.

- [ ] **Step 4: Run GREEN**

Run: `npm test -- tests/orchestration-control.test.ts`
Expected: PASS.

### Task 4: Frontend Remediation panel

**Files:**
- Modify: `web/src/stores/issues.ts`
- Modify: `web/src/pages/IssueDetailPage.tsx`
- Modify: `web/src/pages/OrchestrationPage.tsx`
- Test: `tests/frontend-agents-module.test.ts`

- [ ] **Step 1: Write failing static tests**

Extend `tests/frontend-agents-module.test.ts` to assert:
- store contains `IssueRunRemediationDraft`
- store contains `runRemediationByRun`
- store contains `loadIssueRunRemediation`
- store contains `refreshIssueRunRemediation`
- store contains `recordIssueRunRemediationAction`
- Issue Detail contains `Remediation Orchestrator` and `RunRemediationPanel`
- Orchestration page contains `remediation_proposed` and `remediation_waiting_approval` tone entries

- [ ] **Step 2: Run RED**

Run: `npm test -- tests/frontend-agents-module.test.ts`
Expected: FAIL until frontend symbols exist.

- [ ] **Step 3: Implement store and panels**

In `web/src/stores/issues.ts` add remediation types, cache state, cleanup on issue removal, and actions calling:
- `GET /api/issues/:issueId/runs/:runId/remediation`
- `POST /api/issues/:issueId/runs/:runId/remediation/refresh`
- `POST /api/issues/:issueId/runs/:runId/remediation/actions`

In `web/src/pages/IssueDetailPage.tsx` add `RunRemediationPanel` below Production Health with stage, risk, recommended action, checklist, reason, and buttons for refresh / mark verifying / mark resolved / spawn fix proposal.

In `web/src/pages/OrchestrationPage.tsx` add tone mappings for remediation events.

- [ ] **Step 4: Run GREEN**

Run: `npm test -- tests/frontend-agents-module.test.ts`
Expected: PASS.

### Task 5: Final verification and review

**Files:**
- All Stage 23 files above.

- [ ] **Step 1: Run targeted tests**

Run: `npm test -- tests/remediation.test.ts tests/remediation-routes.test.ts tests/orchestration-control.test.ts tests/frontend-agents-module.test.ts`
Expected: PASS.

- [ ] **Step 2: Run typecheck and builds**

Run: `npm run typecheck && npm run build && npm run build:web`
Expected: PASS; existing Vite chunk-size warnings are acceptable.

- [ ] **Step 3: Request code review**

Dispatch review agent for Stage 23 changes and fix Critical/Important findings.

---

## Self-review

- Spec coverage: state machine, API, orchestration timeline, frontend panel, tests, and review are each mapped to one task.
- Placeholder scan: no TBD/TODO/later placeholders remain.
- Type consistency: route, frontend store, and orchestration event names consistently use `remediation_*` and `IssueRunRemediationDraft`.
