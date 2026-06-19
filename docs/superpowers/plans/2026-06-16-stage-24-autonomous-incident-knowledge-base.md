# Stage 24 Autonomous Incident Knowledge Base Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把生产事故、回滚建议、remediation 动作和恢复验证自动沉淀为可审计、可复用的 Incident Knowledge 条目。

**Architecture:** 新增 `src/incident-knowledge.ts` 纯函数，从 issue run events 派生 `IncidentKnowledgeEntry`，避免第一版引入新 DB 表。`src/routes/issues.ts` 暴露 run-level GET 与 archive API，archive 通过 `incident_knowledge_archived` run event 存快照；Orchestration Control 将 incident knowledge 事件纳入 timeline/summary；Issue Detail 增加 Incident Knowledge 面板，复用现有 Zustand run cache 模式。

**Tech Stack:** TypeScript, Hono routes, Vitest, Zustand, React, existing issue run events, production health, remediation, orchestration timeline.

---

### Task 1: Incident Knowledge pure state builder

**Files:**
- Create: `src/incident-knowledge.ts`
- Test: `tests/incident-knowledge.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/incident-knowledge.test.ts` covering:
- no incident-like event returns `entry: null`
- `production_incident_detected` creates an entry with `status: 'open'`
- `production_rollback_recommended` creates `severity: 'critical'`
- `remediation_action_recorded` is captured in `remediationActions`
- `production_recovered` / `remediation_resolved` resolves the entry
- `remediation_failed` marks unresolved failed knowledge
- repeated summaries produce a stable fingerprint

- [ ] **Step 2: Run RED**

Run: `npm test -- tests/incident-knowledge.test.ts`
Expected: FAIL because `src/incident-knowledge.ts` does not exist.

- [ ] **Step 3: Implement minimal pure function**

Export:
- `IncidentKnowledgeStatus = 'none' | 'open' | 'mitigating' | 'resolved' | 'failed'`
- `IncidentKnowledgeSeverity = 'low' | 'medium' | 'high' | 'critical'`
- `IncidentKnowledgeEvent`
- `IncidentKnowledgeEntry`
- `IncidentKnowledgePayload`
- `buildIncidentKnowledge(input)`

Rules:
- Incident sources: `production_health_signal_received(type=incident_detected|rollback_recommended)`, `production_incident_detected`, `production_rollback_recommended`, `remediation_failed`, `incident_knowledge_archived`.
- Resolution sources: `production_recovered`, `production_healthy`, `remediation_resolved`.
- Remediation action sources: `remediation_action_recorded`, `remediation_running`, `remediation_verifying`.
- Fingerprint uses normalized severity + normalized summary/detail keywords, prefixed with `ik_`.
- Prevention checklist contains concrete deterministic items such as verify recovery, preserve run evidence, and add production signal coverage.

- [ ] **Step 4: Run GREEN**

Run: `npm test -- tests/incident-knowledge.test.ts`
Expected: PASS.

### Task 2: Incident Knowledge issue run routes

**Files:**
- Modify: `src/routes/issues.ts`
- Test: `tests/incident-knowledge-routes.test.ts`

- [ ] **Step 1: Write failing route tests**

Create `tests/incident-knowledge-routes.test.ts` covering:
- `GET /:id/runs/:runId/incident-knowledge` is read-only
- `POST /:id/runs/:runId/incident-knowledge/archive` records one `incident_knowledge_archived` event
- archived snapshot merges with current derived entry
- no incident returns `{ incidentKnowledge: null }`

- [ ] **Step 2: Run RED**

Run: `npm test -- tests/incident-knowledge-routes.test.ts`
Expected: FAIL because incident knowledge routes do not exist.

- [ ] **Step 3: Implement route helpers and routes**

In `src/routes/issues.ts` add:
- `incidentKnowledgeEventsFromRunEvents(runId)` maps issue run events to `IncidentKnowledgeEvent[]`
- `buildIssueRunIncidentKnowledgePayload(run)` returns `{ incidentKnowledge, events }`
- `recordIssueRunDeliveryEventOnce(..., 'incident_knowledge_archived', ...)` for archive idempotency

Add routes:
- `GET /:id/runs/:runId/incident-knowledge`
- `POST /:id/runs/:runId/incident-knowledge/archive`

Archive response returns the latest payload and never triggers external remediation/rollback execution.

- [ ] **Step 4: Run GREEN**

Run: `npm test -- tests/incident-knowledge-routes.test.ts`
Expected: PASS.

### Task 3: Orchestration Control incident knowledge timeline

**Files:**
- Modify: `src/orchestration-control.ts`
- Test: `tests/orchestration-control.test.ts`

- [ ] **Step 1: Write failing tests**

Extend `tests/orchestration-control.test.ts` with `incident_knowledge_archived` and assert:
- event type maps to `incident_archived`
- archived incident increments `recovered` when payload status is `resolved`
- archived unresolved/failed incident increments `blocked` / `failed`

- [ ] **Step 2: Run RED**

Run: `npm test -- tests/orchestration-control.test.ts`
Expected: FAIL until incident knowledge mapping is added.

- [ ] **Step 3: Implement mapping**

Add event type union members:
- `incident_detected`
- `incident_archived`
- `incident_resolved`
- `incident_reusable`

Map `incident_knowledge_archived` to resolved/failed/archived by payload status, and include incident failures in summary blocked/failed counts.

- [ ] **Step 4: Run GREEN**

Run: `npm test -- tests/orchestration-control.test.ts`
Expected: PASS.

### Task 4: Frontend Incident Knowledge panel

**Files:**
- Modify: `web/src/stores/issues.ts`
- Modify: `web/src/pages/IssueDetailPage.tsx`
- Modify: `web/src/stores/orchestration.ts`
- Modify: `web/src/pages/OrchestrationPage.tsx`
- Test: `tests/frontend-agents-module.test.ts`

- [ ] **Step 1: Write failing static tests**

Extend `tests/frontend-agents-module.test.ts` to assert:
- store contains `IssueRunIncidentKnowledgeDraft`
- store contains `runIncidentKnowledgeByRun`
- store contains `loadIssueRunIncidentKnowledge`
- store contains `archiveIssueRunIncidentKnowledge`
- Issue Detail contains `Incident Knowledge Base` and `RunIncidentKnowledgePanel`
- Orchestration store/page contain `incident_archived` and `incident_resolved`

- [ ] **Step 2: Run RED**

Run: `npm test -- tests/frontend-agents-module.test.ts`
Expected: FAIL until frontend symbols exist.

- [ ] **Step 3: Implement store and panel**

In `web/src/stores/issues.ts` add incident knowledge types, cache, cleanup on issue deletion, and actions calling:
- `GET /api/issues/:issueId/runs/:runId/incident-knowledge`
- `POST /api/issues/:issueId/runs/:runId/incident-knowledge/archive`

In `web/src/pages/IssueDetailPage.tsx` add `RunIncidentKnowledgePanel` below `RunRemediationPanel` with fingerprint, status, severity, symptoms, remediation actions, verification signals, prevention checklist, refresh, and archive controls.

In orchestration frontend files add tone mappings for incident event types.

- [ ] **Step 4: Run GREEN**

Run: `npm test -- tests/frontend-agents-module.test.ts`
Expected: PASS.

### Task 5: Final verification and review

**Files:**
- All Stage 24 files above.

- [ ] **Step 1: Run targeted tests**

Run: `npm test -- tests/incident-knowledge.test.ts tests/incident-knowledge-routes.test.ts tests/orchestration-control.test.ts tests/frontend-agents-module.test.ts`
Expected: PASS.

- [ ] **Step 2: Run typecheck and builds**

Run: `npm run typecheck && npm run build && npm run build:web`
Expected: PASS; existing Vite chunk-size warnings are acceptable.

- [ ] **Step 3: Request code review**

Dispatch review agent for Stage 24 changes and fix Critical/Important findings.

---

## Self-review

- Spec coverage: pure builder, API, orchestration timeline, frontend panel, tests, and review are each mapped to one task.
- Placeholder scan: no TBD/TODO/later placeholders remain.
- Type consistency: route, frontend store, and orchestration event names consistently use `incident_knowledge_*` for source events and `incident_*` for orchestration event types.
- Scope check: persistence is intentionally event-sourced via archived snapshots; full DB-backed global search is deferred to avoid expanding Stage 24 beyond a single implementable slice.
