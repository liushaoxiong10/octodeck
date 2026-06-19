# Stage 22 Autonomous Production Health Watcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Stage 21 release governance 之后，增加发布后的生产健康观察状态机，识别 healthy / degraded / incident / recovered / rollback recommended，并接入 Issue Detail 与 Orchestration Control。

**Architecture:** 新增 `src/production-health.ts` 作为纯函数状态机，输入 release state 与 issue run health signal events，输出生产健康状态与 checklist。Issue routes 暴露只读 `GET /production-health`、写入 signal 的 `POST /production-health/signals`、会记录派生事件的 `POST /production-health/refresh`。前端沿用 issue store cache + Issue Detail run panel 模式。

**Tech Stack:** TypeScript, Hono routes, Vitest, Zustand, React, existing issue run event timeline.

---

### Task 1: Production health state machine

**Files:**
- Create: `src/production-health.ts`
- Test: `tests/production-health.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/production-health.test.ts` covering:
- release not completed → `not_observed`
- released without signal → `observing`
- healthy signal → `healthy`
- degraded signal → `degraded`
- incident signal → `incident_detected`
- rollback recommendation → `rollback_recommended`
- recovered signal → `recovered`

- [ ] **Step 2: Run RED**

Run: `npm test -- tests/production-health.test.ts`
Expected: FAIL because `src/production-health.ts` does not exist.

- [ ] **Step 3: Implement minimal state machine**

Export `buildProductionHealthState(input)` plus types `ProductionHealthSignal`, `ProductionHealthStage`, `ProductionHealthState`.

- [ ] **Step 4: Run GREEN**

Run: `npm test -- tests/production-health.test.ts`
Expected: PASS.

### Task 2: Production health API routes

**Files:**
- Modify: `src/routes/issues.ts`
- Test: `tests/production-health-routes.test.ts`

- [ ] **Step 1: Write failing route tests**

Cover:
- `GET /:id/runs/:runId/production-health` is read-only
- `POST /:id/runs/:runId/production-health/signals` records `production_health_signal_received`
- `POST /:id/runs/:runId/production-health/refresh` records derived event once
- incident signal returns `incident_detected`

- [ ] **Step 2: Run RED**

Run: `npm test -- tests/production-health-routes.test.ts`
Expected: FAIL because routes do not exist.

- [ ] **Step 3: Implement routes**

Add helpers to read release completion from run events, normalize health signal events, build state, and record events once.

- [ ] **Step 4: Run GREEN**

Run: `npm test -- tests/production-health-routes.test.ts`
Expected: PASS.

### Task 3: Orchestration Control production timeline

**Files:**
- Modify: `src/orchestration-control.ts`
- Test: `tests/orchestration-control.test.ts`

- [ ] **Step 1: Write failing tests**

Assert production events map to timeline event types and incident / rollback recommended increments blocked/failed-style summaries.

- [ ] **Step 2: Run RED**

Run: `npm test -- tests/orchestration-control.test.ts`
Expected: FAIL before production event mapping is added.

- [ ] **Step 3: Implement mapping**

Add `production_observing`, `production_healthy`, `production_degraded`, `production_incident`, `production_recovered`, `production_rollback_recommended` control event types.

- [ ] **Step 4: Run GREEN**

Run: `npm test -- tests/orchestration-control.test.ts`
Expected: PASS.

### Task 4: Frontend Production Health panel

**Files:**
- Modify: `web/src/stores/issues.ts`
- Modify: `web/src/pages/IssueDetailPage.tsx`
- Test: `tests/frontend-agents-module.test.ts`

- [ ] **Step 1: Write failing static tests**

Assert store exposes `IssueRunProductionHealthDraft`, `runProductionHealthByRun`, `loadIssueRunProductionHealth`, `refreshIssueRunProductionHealth`, `recordIssueRunProductionHealthSignal`, and Issue Detail renders `Production Health` / `RunProductionHealthPanel`.

- [ ] **Step 2: Run RED**

Run: `npm test -- tests/frontend-agents-module.test.ts`
Expected: FAIL until symbols exist.

- [ ] **Step 3: Implement store + panel**

Add cache/actions and a compact panel below Release Governance showing health stage, severity, checklist, latest signals, incident summary, and refresh/signal buttons.

- [ ] **Step 4: Run GREEN**

Run: `npm test -- tests/frontend-agents-module.test.ts`
Expected: PASS.

### Task 5: Final verification and review

**Files:**
- No new production files beyond prior tasks.

- [ ] **Step 1: Run targeted tests**

Run: `npm test -- tests/production-health.test.ts tests/production-health-routes.test.ts tests/orchestration-control.test.ts tests/frontend-agents-module.test.ts`
Expected: PASS.

- [ ] **Step 2: Run typecheck and builds**

Run: `npm run typecheck && npm run build && npm run build:web`
Expected: PASS; existing Vite chunk-size warnings are acceptable.

- [ ] **Step 3: Request code review**

Dispatch review agent for Stage 22 changes and fix Critical/Important findings.
