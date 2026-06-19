# Stage 21 Autonomous Release Governance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Stage 20 产出的 PR/MR 接入发布治理状态机，判断交付是否可合并、已发布、被阻断或需要回滚。

**Architecture:** 新增 `issue-release.ts` 作为纯函数 release state machine，平行于 `issue-delivery.ts`，避免 delivery 逻辑继续膨胀。`git-provider.ts` 增加 PR/MR status adapter，Issue routes 暴露 read-only `GET /release` 与会记录事件的 `POST /release/refresh`。Orchestration Control 和 Issue Detail 页面消费 release events/state。

**Tech Stack:** TypeScript, Hono routes, Vitest, Zustand, React, existing GitHub/GitLab provider abstractions.

---

### Task 1: Release state machine

**Files:**
- Create: `src/issue-release.ts`
- Test: `tests/issue-release.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/issue-release.test.ts` with cases for `checks_failed`, `merge_ready`, `released`, and `rollback_required`.

- [ ] **Step 2: Run tests to verify RED**

Run: `npm test -- tests/issue-release.test.ts`
Expected: FAIL because `src/issue-release.ts` does not exist.

- [ ] **Step 3: Implement minimal state machine**

Create `buildIssueRunReleaseState(input)` returning `{ stage, nextAction, mergeable, checks, review, releaseGate, checklist }`.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `npm test -- tests/issue-release.test.ts`
Expected: PASS.

### Task 2: Git provider PR/MR status adapter

**Files:**
- Modify: `src/git-provider.ts`
- Modify: `tests/git-provider.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests for GitHub PR status normalization, GitLab MR status normalization, and missing token returning `provider_not_configured`.

- [ ] **Step 2: Run tests to verify RED**

Run: `npm test -- tests/git-provider.test.ts`
Expected: FAIL because `getIssueRunPullRequestStatus` is not exported.

- [ ] **Step 3: Implement adapter**

Export `getIssueRunPullRequestStatus(input, options)` and normalized types for checks/reviews/state.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `npm test -- tests/git-provider.test.ts`
Expected: PASS.

### Task 3: Release API routes

**Files:**
- Modify: `src/routes/issues.ts`
- Test: `tests/issue-release-routes.test.ts`

- [ ] **Step 1: Write failing route tests**

Cover read-only `GET /:id/runs/:runId/release`, event-recording `POST /:id/runs/:runId/release/refresh`, and provider-not-configured manual state.

- [ ] **Step 2: Run tests to verify RED**

Run: `npm test -- tests/issue-release-routes.test.ts`
Expected: FAIL because release routes do not exist.

- [ ] **Step 3: Implement routes**

Add helpers to locate latest `pull_request_created` event, fetch provider status, build release state, and record release events only from `POST /release/refresh`.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `npm test -- tests/issue-release-routes.test.ts`
Expected: PASS.

### Task 4: Orchestration release timeline

**Files:**
- Modify: `src/orchestration-control.ts`
- Modify: `web/src/stores/orchestration.ts`
- Test: `tests/orchestration-control.test.ts`

- [ ] **Step 1: Write failing tests**

Add assertions that `release_checks_failed` maps to `release_blocked`, `release_merge_ready` maps to `release_ready`, and `release_rollback_required` increments blocked/failed-style summaries.

- [ ] **Step 2: Run tests to verify RED**

Run: `npm test -- tests/orchestration-control.test.ts`
Expected: FAIL because release event mapping is absent.

- [ ] **Step 3: Implement mapping**

Add release event union members and summary handling.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `npm test -- tests/orchestration-control.test.ts`
Expected: PASS.

### Task 5: Frontend Release Governance panel

**Files:**
- Modify: `web/src/stores/issues.ts`
- Modify: `web/src/pages/IssueDetailPage.tsx`
- Test: `tests/frontend-agents-module.test.ts`

- [ ] **Step 1: Write failing static/frontend tests**

Assert store exposes `IssueRunReleaseDraft`, `loadIssueRunRelease`, `refreshIssueRunRelease`, and Issue Detail renders `Release Governance`.

- [ ] **Step 2: Run tests to verify RED**

Run: `npm test -- tests/frontend-agents-module.test.ts`
Expected: FAIL until release UI symbols exist.

- [ ] **Step 3: Implement store + panel**

Add release draft cache, load/refresh actions, and a compact panel showing release stage, provider status, checklist, and PR/MR link.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `npm test -- tests/frontend-agents-module.test.ts`
Expected: PASS.

### Task 6: Final verification and review

**Files:**
- No new production files beyond prior tasks.

- [ ] **Step 1: Run targeted tests**

Run: `npm test -- tests/issue-release.test.ts tests/git-provider.test.ts tests/issue-release-routes.test.ts tests/orchestration-control.test.ts tests/frontend-agents-module.test.ts`
Expected: PASS.

- [ ] **Step 2: Run typecheck and builds**

Run: `npm run typecheck && npm run build && npm run build:web`
Expected: PASS, except existing Vite chunk-size warnings are acceptable.

- [ ] **Step 3: Request code review**

Dispatch review agent for Stage 21 release governance changes and fix Critical/Important findings.
