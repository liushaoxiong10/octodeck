# Stage 20 Autonomous Delivery Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将通过质量门禁的 Issue Agent Run 推进为可审查、可提交、可创建 PR/MR、可追踪的交付流水线。

**Architecture:** 在既有 `issue-delivery.ts` 上扩展纯函数状态机，接入 Stage 19 `evaluateRunQuality()` 的结果作为交付门禁。Issue routes 负责采集 diff/commit/PR/review 上下文、执行动作前校验 gate、记录 delivery 事件；前端 Issue 详情页展示 delivery checklist 与下一步动作。

**Tech Stack:** TypeScript, Hono, Vitest, existing Agent Link workspace git RPC, existing GitHub/GitLab provider helpers, React/Zustand.

---

### Task 1: Delivery Gate 状态机

**Files:**
- Modify: `src/issue-delivery.ts`
- Modify: `tests/issue-delivery.test.ts`

- [ ] 写失败测试：quality failed 时 delivery state 为 `blocked_by_quality`，下一步为 `none`。
- [ ] 写失败测试：quality needs_review 时 delivery state 为 `review_required`，下一步为 `inspect_diff`。
- [ ] 扩展 `IssueRunDeliveryState.stage` 与 checklist，新增 `quality` 检查项。
- [ ] 在 `buildIssueRunDeliveryState()` 中接收 `qualityEvaluation`，按 outcome 决定是否阻断。
- [ ] 运行 `npm test -- tests/issue-delivery.test.ts --run`。

### Task 2: Delivery API 接入质量门禁

**Files:**
- Modify: `src/routes/issues.ts`
- Modify: existing route tests if available; otherwise extend `tests/issue-delivery.test.ts` for pure route helper inputs.

- [ ] 在 `GET /api/issues/:id/runs/:runId/delivery` 中评估 run quality，并传给 delivery state。
- [ ] 在 commit / create PR route 前复用同一 gate，`failed` 阻断，`needs_review` 标记 review required。
- [ ] 记录 `delivery_quality_blocked`、`delivery_review_required`、`delivery_pr_ready` 等事件。
- [ ] 运行 `npm test -- tests/issue-delivery.test.ts --run`。

### Task 3: Control Tower 显示 Delivery 事件

**Files:**
- Modify: `src/orchestration-control.ts`
- Modify: `tests/orchestration-control.test.ts`
- Modify: `web/src/stores/orchestration.ts`
- Modify: `web/src/pages/OrchestrationPage.tsx`

- [ ] 添加 delivery event types 与色彩映射。
- [ ] 将 issue run delivery events 纳入 timeline。
- [ ] 让 delivery blocked 进入 blocked summary。
- [ ] 运行 `npm test -- tests/orchestration-control.test.ts --run`。

### Task 4: Issue 详情页 Delivery Panel

**Files:**
- Modify: `web/src/stores/issues.ts`
- Modify: `web/src/pages/IssueDetailPage.tsx`

- [ ] 添加 delivery state 类型与加载 action。
- [ ] 在 run detail 区域展示 quality gate、delivery checklist、PR draft 和 review draft。
- [ ] 根据 `nextAction` 显示 Open Diff / Commit / Create PR / Review Agent 入口。
- [ ] 运行 `npm run build:web`。

### Task 5: Verification

**Files:**
- No source edits expected.

- [ ] 运行 `npm test -- tests/issue-delivery.test.ts tests/orchestration-control.test.ts --run`。
- [ ] 运行 `npm run typecheck`。
- [ ] 运行 `npm run build`。
- [ ] 运行 `npm run build:web`。
- [ ] 如时间允许，运行 `npm test -- --run`。
