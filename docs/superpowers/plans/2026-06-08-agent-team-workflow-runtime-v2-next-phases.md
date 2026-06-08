# Agent Team Workflow Runtime v2 Next Phases Implementation Plan

> **Status:** 已完成并通过验证。下方详细步骤保留为原始实施计划/审计记录；最终完成状态以本 Status 段和“11. 完成记录”为准。
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Runtime v2 第一阶段暂缓的 10 项能力拆成可独立交付、可测试、可回滚的后续阶段，让 Agent Team 从“可恢复 DAG 编排”升级为“可隔离、可治理、可观测、可产品化”的多 Agent 工作流运行时。

**Architecture:** 下一阶段按依赖分为 5 批：先补齐运行控制面（cancel 与 workspace/routing），再做 artifact/blackboard 数据面迁移，再做 approval/verification 高阶原语，最后补 UI 与指标。每批都必须建立在现有 Runtime v2 的 `workflowSteps`、checkpoint、approval、trace event 和现有 DB 表之上，避免一次性大重构。

**Tech Stack:** TypeScript, Hono, better-sqlite3, Vitest, Agent Link protocol, existing OctoDeck backend APIs, existing web frontend.

---

## 0. 当前衔接点

- Runtime v2 核心执行入口在 `src/agent-team-engine.ts:180`，有 `executeAgentTeam()` 与 workflowSteps 分支。
- 现有 step 状态、checkpoint、artifacts、approval 数据结构在 `src/agent-team-engine.ts:85` 到 `src/agent-team-engine.ts:150`。
- role policy 已有 `workspacePolicy` 与 `requiresApproval` 字段，定义在 `src/agent-teams.ts:15` 和 `src/agent-teams.ts:22`。
- 现有 API 层会把 role execution route 到 backend，并在 finally 里请求 workspace cleanup，位置在 `src/routes/agent-teams.ts:1120` 到 `src/routes/agent-teams.ts:1260`。
- run cancel 当前只更新 DB run 状态，不会打断底层 role runner，位置在 `src/routes/agent-teams.ts:580`。
- 现有 DB 已有 `agent_team_blackboard`、`agent_team_checkpoints`、`agent_team_approvals` 表，定义在 `src/db.ts:544`、`src/db.ts:557`、`src/db.ts:567`。
- Agent Link 协议已有 cancel frame：`RunCancelFrame` / `AgentRunCancelFrame` / `ToolCancelFrame`，位于 `src/agent-link/protocol.ts:128`、`src/agent-link/protocol.ts:196`、`src/agent-link/protocol.ts:277`。

## 1. 优先级与依赖关系

### P0：先补运行可靠性闭环

1. **cancel token 贯穿正在运行的 role**
   - 依赖：现有 run/task 状态、Agent Link cancel frame、backend run timeout/cancel 逻辑。
   - 原因：没有真正 cancel，后续 workspace 隔离、approval、UI 操作都可能出现“界面已停但底层还在写文件”的不一致。

2. **per-role workspace / worktree / sandbox 真隔离**
   - 依赖：cancel 的安全收尾、现有 `workspacePolicy`、`requestWorkspaceCleanup()`。
   - 原因：是多 Agent 安全协作的底座，也是按 role 路由到 device/daemon 的前置能力。

3. **按 role 精准路由到 daemon / device runtime 的完整重构**
   - 依赖：workspace isolation、roleAssignments、Agent Link target 解析。
   - 原因：隔离策略必须和执行节点选择绑定，否则 workspacePolicy 只是 prompt 约定。

### P1：补数据契约与可追溯性

4. **数据库结构迁移（小步）**
   - 依赖：Runtime v2 checkpoint schema 稳定。
   - 原因：blackboard versioning、artifact lineage、metrics 都需要可查询字段，不能永远塞 JSON。

5. **blackboard versioning 与 provenance 完整模型**
   - 依赖：DB 迁移基础表、artifact outputKey 契约。
   - 原因：后续 verifier、debate、UI diff 和 audit 都需要知道 artifact 版本、来源、owner 与 confidence。

### P2：补治理策略与高阶协作原语

6. **多人审批流与复杂审批策略**
   - 依赖：approval 单 gate 已落地、DB 能记录 approval policy/decision。
   - 原因：高风险操作需要会签、超时升级与审批矩阵。

7. **Verifier / Critic / Debate / Voting / MoA 一等公民**
   - 依赖：artifact provenance、workflowSteps DAG、可选 approval gate。
   - 原因：这些模式不应只靠 prompt，需要 runtime 能识别、聚合、计分、审计。

### P3：补产品化入口

8. **Agent Team 模板库产品化**
   - 依赖：高阶协作原语稳定、Team Architect prompt/schema 稳定。
   - 原因：把可复用团队模式沉淀成模板，而不是每次从 prompt 生成。

9. **前端 UI 大改造**
   - 依赖：后端 run detail、checkpoint、approval、artifact、metrics API 稳定。
   - 原因：UI 应反映真实 runtime 状态，不应先做静态 mock。

10. **生产级指标面板**
    - 依赖：trace event 标准化、DB 可查询字段、run/task/approval/artifact 关系稳定。
    - 原因：指标面板应基于真实事件与统计，不应从 UI 或日志临时拼。

---

## 2. 阶段拆分

### Phase A：运行控制与隔离底座（P0）

**目标：** Agent Team run 可以真正停止底层 role execution；每个 role 能按 policy 获得可清理、可追踪的 workspace；roleAssignments 能显式选择 device/daemon/runtime target。

**覆盖暂缓项：** 1 per-role workspace、2 cancel token、9 per-role routing。

**成功标准：**
- 调用 `POST /agent-teams/runs/:runId/cancel` 后，正在执行的 role runner 收到 cancel signal，并记录 task cancelled。
- `workspacePolicy: 'sandbox' | 'worktree' | 'device'` 会影响 role 的 `group.folder` / `remoteToolCwd` / cleanup scope。
- roleAssignments 能指定不同 role 的 backend 和 device link，错误 routing 会被 400/409 拒绝，而不是运行中才失败。
- 现有 Runtime v2 DAG/approval 测试仍全部通过。

**主要风险：**
- Agent Link 与本地 backend cancel 能力不完全一致，需要抽象统一 cancellation handle。
- workspace cleanup 不能误删用户工作目录。
- worktree 模式如果直接操作 git，必须避免 destructive git 命令。

### Phase B：Artifact 数据面与迁移（P1）

**目标：** artifact 从 checkpoint 内部状态升级为可查询、可版本化、可追溯的 blackboard 数据模型，同时保持 Runtime v2 checkpoint 兼容。

**覆盖暂缓项：** 3 数据库结构大迁移、4 blackboard versioning/provenance。

**成功标准：**
- 每次 step 写 `outputKey` 时都创建 artifact version，而不是覆盖同一个 blackboard key。
- artifact version 记录 `sourceRunId`、`sourceTaskId`、`sourceStepId`、`sourceRoleId`、`version`、`parentArtifactIds`、`confidence`、`visibility`。
- checkpoint 仍保留轻量 `artifacts: Record<string,string>`，但能通过 artifact version id 找回完整 lineage。
- 提供 run artifact list/detail API，测试覆盖 migration 后读写。

**主要风险：**
- SQLite schema migration 需要兼容已有本地数据。
- 大文本 artifact 直接入 DB 可能影响性能，需要保留 size guard 与 contentType。

### Phase C：治理与高阶协作原语（P2）

**目标：** approval 从单 gate 变成可配置策略；Verifier/Critic/Debate/Voting/MoA 成为 workflowSteps 可表达、runtime 可观测的原语。

**覆盖暂缓项：** 5 多人审批流、6 Verifier/Critic/Debate/Voting/MoA。

**成功标准：**
- workflow step 支持 `approvalPolicy`，可表达 single、any-of、all-of、quorum、timeout fallback。
- approval API 能返回 pending approvers、resolved decisions、policy result。
- workflow step 支持至少 `verify` 与 `vote` 两个新 step type，先不一次性做完 Debate/MoA。
- verifier report 写入 blackboard kind `verifier_report`，vote aggregation 写入 artifact，并可被后续 step 用 `inputKeys` 消费。

**主要风险：**
- 不要把复杂策略 DSL 做过度；先用结构化 JSON schema 覆盖 80% 场景。
- LLM verifier 输出不稳定，必须让 runtime 持有 aggregation 逻辑，而不是让 agent 自己汇总。

### Phase D：模板库与 UI（P3 产品入口）

**目标：** 用户能选择经过治理的 Agent Team 模板，并在 UI 看到 DAG、step、artifact、approval、checkpoint/resume 状态。

**覆盖暂缓项：** 7 模板库产品化、8 前端 UI 大改造。

**成功标准：**
- 后端提供内置模板 list/detail/create-from-template API。
- 模板包含 roles、workflowSteps、policies、successCriteria、recommended roleAssignments。
- UI run detail 展示 DAG 节点状态、artifact 列表、approval card、checkpoint resume/cancel 操作。
- UI 不直接推导状态，全部来自后端 API。

**主要风险：**
- UI 容易一次性做太大；先做 run detail，再做 team builder/template market。
- 模板版本管理不要过早引入复杂发布流程；先内置 readonly templates + copy-on-create。

### Phase E：生产级指标（P3 可观测）

**目标：** 基于 trace/run/task/approval/artifact 生成可查询 metrics，为 dashboard 和运维告警提供后端基础。

**覆盖暂缓项：** 10 生产级指标面板。

**成功标准：**
- 提供 metrics API：成功率、平均耗时、approval 等待时长、retry 次数、并行收益估算、step failure 分布。
- 指标全部从 DB events/tasks/approvals/checkpoints 派生，不依赖内存状态。
- dashboard 可以按 team、shape、role、时间范围过滤。

**主要风险：**
- 统计口径必须先固定，否则 dashboard 数字不可解释。
- 老数据缺少事件时要有 fallback 或标记 `insufficient_data`。

---

## 3. File Structure

### Phase A files

- Modify: `src/agent-team-engine.ts`
  - 扩展 `AgentTeamExecutionInput` 支持 `abortSignal` 或 `cancellationToken`。
  - 在 DAG 调度循环和每个 step 执行前检查 cancellation。
  - 增加 `workflow.cancelled`、`step.cancelled` trace event。
- Modify: `src/routes/agent-teams.ts`
  - 为每个 running role task 注册 cancellation handle。
  - `POST /agent-teams/runs/:runId/cancel` 调用 cancellation registry，再更新 DB。
  - 抽出 `resolveRoleWorkspace()` 和 `resolveRoleRuntimeTarget()`。
- Create: `src/agent-team-runtime-control.ts`
  - 管理 run/task cancellation handles。
  - 生成 per-role workspace descriptor。
  - 做 role runtime target validation。
- Modify: `src/backends/*` where needed
  - 统一 backend `run()` 可接收 AbortSignal；Agent Link backend 映射到 `run.cancel` / `agent.run.cancel`。
- Test: `tests/agent-team-runtime-control.test.ts`
- Test: `tests/agent-team-runtime.test.ts`
- Test: `tests/agent-team-engine.test.ts`

### Phase B files

- Modify: `src/db.ts`
  - 新增 `agent_team_artifacts` 与 `agent_team_artifact_edges` 表。
  - 增加 migration guard 与 list/get record helpers。
- Modify: `src/agent-team-engine.ts`
  - step output 生成 artifact write intent，保留 checkpoint artifacts 兼容。
- Modify: `src/routes/agent-teams.ts`
  - 持久化 artifact versions。
  - 新增 run artifact list/detail endpoints。
- Test: `tests/agent-team-artifacts.test.ts`
- Test: `tests/agent-team-runtime.test.ts`

### Phase C files

- Modify: `src/agent-teams.ts`
  - 扩展 workflow step schema：`approvalPolicy`、`type: 'verify' | 'vote'`。
  - 更新 Team Architect prompt 约束。
- Modify: `src/agent-team-engine.ts`
  - approval policy evaluator。
  - verify/vote step executor。
- Modify: `src/db.ts`
  - 如 Phase B 未覆盖，增加 approval decisions 细粒度记录。
- Modify: `src/routes/agent-teams.ts`
  - approval decision 支持多人策略。
- Test: `tests/agent-team-approval-policy.test.ts`
- Test: `tests/agent-team-engine.test.ts`
- Test: `tests/agent-teams.test.ts`

### Phase D files

- Create: `src/agent-team-templates.ts`
  - 内置模板 registry、normalization、copy-to-team。
- Modify: `src/routes/agent-teams.ts`
  - 模板 list/detail/create routes。
- Modify: `web/src/**` existing Agent Team pages/components
  - Run detail DAG、approval card、artifact/checkpoint panels。
- Test: `tests/agent-team-templates.test.ts`
- Test: frontend tests if the repo already has a web test pattern; otherwise run `npm run build:web`.

### Phase E files

- Create: `src/agent-team-metrics.ts`
  - 从 DB records 派生 metrics，不持久化首版 aggregate。
- Modify: `src/routes/agent-teams.ts`
  - metrics endpoints。
- Modify: `web/src/**` dashboard pages/components
  - metrics dashboard。
- Test: `tests/agent-team-metrics.test.ts`

---

## 4. Phase A 详细实施计划：运行控制与隔离底座

### Task A1: Runtime cancellation registry

**Files:**
- Create: `src/agent-team-runtime-control.ts`
- Test: `tests/agent-team-runtime-control.test.ts`

- [ ] **Step 1: Write failing tests for cancellation registry**

Create `tests/agent-team-runtime-control.test.ts`:

```ts
import { describe, expect, test, vi } from 'vitest';

import {
  cancelAgentTeamRun,
  clearAgentTeamRuntimeControlsForTests,
  registerAgentTeamTaskCancellation,
} from '../src/agent-team-runtime-control.js';

describe('agent team runtime control', () => {
  test('cancels every registered task for a run exactly once', () => {
    clearAgentTeamRuntimeControlsForTests();
    const first = vi.fn();
    const second = vi.fn();

    const unregisterFirst = registerAgentTeamTaskCancellation({
      runId: 'run_1',
      taskId: 'task_1',
      cancel: first,
    });
    registerAgentTeamTaskCancellation({
      runId: 'run_1',
      taskId: 'task_2',
      cancel: second,
    });

    const result = cancelAgentTeamRun('run_1', 'user_cancel');
    const secondResult = cancelAgentTeamRun('run_1', 'user_cancel_again');

    expect(result.cancelledTaskIds).toEqual(['task_1', 'task_2']);
    expect(result.errors).toEqual([]);
    expect(secondResult.cancelledTaskIds).toEqual([]);
    expect(first).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledWith('user_cancel');
    expect(second).toHaveBeenCalledTimes(1);

    unregisterFirst();
  });

  test('keeps cancelling other tasks when one cancel handler throws', () => {
    clearAgentTeamRuntimeControlsForTests();
    const broken = vi.fn(() => {
      throw new Error('socket closed');
    });
    const healthy = vi.fn();

    registerAgentTeamTaskCancellation({
      runId: 'run_2',
      taskId: 'task_broken',
      cancel: broken,
    });
    registerAgentTeamTaskCancellation({
      runId: 'run_2',
      taskId: 'task_healthy',
      cancel: healthy,
    });

    const result = cancelAgentTeamRun('run_2', 'timeout');

    expect(result.cancelledTaskIds).toEqual(['task_healthy']);
    expect(result.errors).toEqual([
      { taskId: 'task_broken', error: 'socket closed' },
    ]);
    expect(healthy).toHaveBeenCalledWith('timeout');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npx vitest run tests/agent-team-runtime-control.test.ts
```

Expected: FAIL because `src/agent-team-runtime-control.ts` does not exist.

- [ ] **Step 3: Implement cancellation registry**

Create `src/agent-team-runtime-control.ts`:

```ts
export interface AgentTeamTaskCancellationRegistration {
  runId: string;
  taskId: string;
  cancel: (reason: string) => void;
}

export interface AgentTeamRunCancelResult {
  cancelledTaskIds: string[];
  errors: Array<{ taskId: string; error: string }>;
}

const cancellations = new Map<string, Map<string, (reason: string) => void>>();

export function registerAgentTeamTaskCancellation(
  registration: AgentTeamTaskCancellationRegistration,
): () => void {
  const runTasks = cancellations.get(registration.runId) ?? new Map();
  runTasks.set(registration.taskId, registration.cancel);
  cancellations.set(registration.runId, runTasks);

  return () => {
    const current = cancellations.get(registration.runId);
    if (!current) return;
    current.delete(registration.taskId);
    if (current.size === 0) cancellations.delete(registration.runId);
  };
}

export function cancelAgentTeamRun(
  runId: string,
  reason: string,
): AgentTeamRunCancelResult {
  const runTasks = cancellations.get(runId);
  if (!runTasks) return { cancelledTaskIds: [], errors: [] };

  cancellations.delete(runId);
  const cancelledTaskIds: string[] = [];
  const errors: AgentTeamRunCancelResult['errors'] = [];

  for (const [taskId, cancel] of runTasks.entries()) {
    try {
      cancel(reason);
      cancelledTaskIds.push(taskId);
    } catch (error) {
      errors.push({
        taskId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { cancelledTaskIds, errors };
}

export function clearAgentTeamRuntimeControlsForTests(): void {
  cancellations.clear();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
npx vitest run tests/agent-team-runtime-control.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent-team-runtime-control.ts tests/agent-team-runtime-control.test.ts
git commit -m "feat: add agent team runtime cancellation registry"
```

### Task A2: Wire cancel endpoint to registered running tasks

**Files:**
- Modify: `src/routes/agent-teams.ts:580`
- Test: `tests/agent-team-runtime.test.ts`

- [ ] **Step 1: Write failing route test**

Add a test to `tests/agent-team-runtime.test.ts` near existing cancel/run tests:

```ts
test('cancel endpoint invokes registered runtime cancellation handlers', async () => {
  clearAgentTeamRuntimeControlsForTests();
  const cancel = vi.fn();
  registerAgentTeamTaskCancellation({
    runId: 'run_cancel_runtime',
    taskId: 'run_cancel_runtime:role:work',
    cancel,
  });

  recordAgentTeamRun({
    id: 'run_cancel_runtime',
    teamId: 'team_cancel_runtime',
    userId: testUser.id,
    prompt: 'stop me',
    status: 'running',
    traceId: 'trace_cancel_runtime',
    workflowShape: 'pipeline',
    roleAssignments: {},
  });

  const response = await app.request('/agent-teams/runs/run_cancel_runtime/cancel', {
    method: 'POST',
    headers: authHeaders,
  });
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(cancel).toHaveBeenCalledWith('cancelled by user');
  expect(body.cancelledTaskIds).toEqual(['run_cancel_runtime:role:work']);
  expect(body.run.status).toBe('cancelled');
});
```

If the existing test setup uses different names for `app`, `authHeaders`, or `testUser`, use the local names already present in `tests/agent-team-runtime.test.ts`.

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npx vitest run tests/agent-team-runtime.test.ts -t "cancel endpoint invokes registered runtime cancellation handlers"
```

Expected: FAIL because the cancel endpoint response does not include `cancelledTaskIds` and does not call the registry.

- [ ] **Step 3: Update cancel route**

Modify imports in `src/routes/agent-teams.ts`:

```ts
import { cancelAgentTeamRun } from '../agent-team-runtime-control.js';
```

Modify `router.post('/runs/:runId/cancel'...)` at `src/routes/agent-teams.ts:580`:

```ts
router.post('/runs/:runId/cancel', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const run = getAgentTeamRun(c.req.param('runId'), user.id);
  if (!run) return c.json({ error: 'agent team run not found' }, 404);
  const cancellation = cancelAgentTeamRun(run.id, 'cancelled by user');
  recordAgentTeamRun({
    id: run.id,
    teamId: run.teamId,
    userId: run.userId,
    prompt: run.prompt,
    status: 'cancelled',
    traceId: run.traceId,
    workflowShape: run.workflowShape,
    roleAssignments: run.roleAssignments,
    finalResult: run.finalResult,
    error: cancellation.errors.length
      ? `cancelled by user; cancellation errors: ${JSON.stringify(cancellation.errors)}`
      : 'cancelled by user',
    completedAt: new Date().toISOString(),
  });
  return c.json({
    run: getAgentTeamRun(run.id, user.id),
    cancelledTaskIds: cancellation.cancelledTaskIds,
    cancellationErrors: cancellation.errors,
  });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
npx vitest run tests/agent-team-runtime.test.ts -t "cancel endpoint invokes registered runtime cancellation handlers"
```

Expected: PASS.

- [ ] **Step 5: Run full runtime route tests**

Run:

```bash
npx vitest run tests/agent-team-runtime.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/routes/agent-teams.ts tests/agent-team-runtime.test.ts
git commit -m "feat: cancel running agent team tasks"
```

### Task A3: Add per-role workspace descriptor

**Files:**
- Modify: `src/agent-team-runtime-control.ts`
- Test: `tests/agent-team-runtime-control.test.ts`

- [ ] **Step 1: Write failing workspace tests**

Add to `tests/agent-team-runtime-control.test.ts`:

```ts
import { resolveAgentTeamRoleWorkspace } from '../src/agent-team-runtime-control.js';

test('resolves default per-role workspace without changing caller cwd', () => {
  const workspace = resolveAgentTeamRoleWorkspace({
    teamId: 'team_1',
    runId: 'run_1',
    roleId: 'planner',
    roleName: 'Planner',
    workspacePolicy: undefined,
    runtimeGroupFolder: undefined,
    runtimeRemoteToolCwd: '/repo',
  });

  expect(workspace.policy).toBe('none');
  expect(workspace.groupFolder).toBe('agent-team-team_1-planner');
  expect(workspace.remoteToolCwd).toBe('/repo');
  expect(workspace.cleanupScope).toBe('session');
});

test('resolves sandbox workspace under run and role scoped folder', () => {
  const workspace = resolveAgentTeamRoleWorkspace({
    teamId: 'team_1',
    runId: 'run_1',
    roleId: 'writer',
    roleName: 'Writer',
    workspacePolicy: 'sandbox',
    runtimeGroupFolder: 'custom-root',
    runtimeRemoteToolCwd: '/repo',
  });

  expect(workspace.policy).toBe('sandbox');
  expect(workspace.groupFolder).toBe('custom-root/run_1/writer');
  expect(workspace.remoteToolCwd).toBe('/repo/.octodeck/agent-team-runs/run_1/writer');
  expect(workspace.cleanupScope).toBe('run');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npx vitest run tests/agent-team-runtime-control.test.ts -t "resolves"
```

Expected: FAIL because `resolveAgentTeamRoleWorkspace` does not exist.

- [ ] **Step 3: Implement workspace resolver**

Add to `src/agent-team-runtime-control.ts`:

```ts
import type { AgentTeamWorkspacePolicy } from './agent-teams.js';

export interface AgentTeamRoleWorkspaceInput {
  teamId: string;
  runId: string;
  roleId: string;
  roleName: string;
  workspacePolicy?: AgentTeamWorkspacePolicy;
  runtimeGroupFolder?: string;
  runtimeRemoteToolCwd?: string;
}

export interface AgentTeamRoleWorkspaceDescriptor {
  policy: AgentTeamWorkspacePolicy;
  groupFolder: string;
  remoteToolCwd?: string;
  cleanupScope: 'session' | 'run';
}

function safeWorkspaceSegment(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'role';
}

function joinWorkspacePath(base: string, ...parts: string[]): string {
  return [base.replace(/\/+$/g, ''), ...parts.map((part) => part.replace(/^\/+|\/+$/g, ''))].join('/');
}

export function resolveAgentTeamRoleWorkspace(
  input: AgentTeamRoleWorkspaceInput,
): AgentTeamRoleWorkspaceDescriptor {
  const policy = input.workspacePolicy ?? 'none';
  const roleSegment = safeWorkspaceSegment(input.roleId || input.roleName);
  if (policy === 'sandbox' || policy === 'worktree' || policy === 'device') {
    const baseGroup = input.runtimeGroupFolder ?? `agent-team-${input.teamId}`;
    const groupFolder = joinWorkspacePath(baseGroup, input.runId, roleSegment);
    const remoteToolCwd = input.runtimeRemoteToolCwd
      ? joinWorkspacePath(
          input.runtimeRemoteToolCwd,
          '.octodeck',
          'agent-team-runs',
          input.runId,
          roleSegment,
        )
      : undefined;
    return { policy, groupFolder, remoteToolCwd, cleanupScope: 'run' };
  }

  return {
    policy,
    groupFolder: input.runtimeGroupFolder ?? `agent-team-${input.teamId}-${roleSegment}`,
    remoteToolCwd: input.runtimeRemoteToolCwd,
    cleanupScope: 'session',
  };
}
```

- [ ] **Step 4: Run workspace tests**

Run:

```bash
npx vitest run tests/agent-team-runtime-control.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent-team-runtime-control.ts tests/agent-team-runtime-control.test.ts
git commit -m "feat: resolve agent team role workspaces"
```

### Task A4: Use workspace descriptor in role execution

**Files:**
- Modify: `src/routes/agent-teams.ts:1191`
- Test: `tests/agent-team-runtime.test.ts`

- [ ] **Step 1: Write failing integration test**

Add a route execution test that creates a team role with `policy.workspacePolicy: 'sandbox'`, runs it with `runtimeContext.remoteToolCwd: '/repo'`, and asserts the mocked backend receives:

```ts
expect(lastBackendRunInput.group.folder).toContain('/run_');
expect(lastBackendRunInput.group.folder).toContain('/role_sandbox');
expect(lastBackendRunInput.input.remoteToolCwd).toContain('/repo/.octodeck/agent-team-runs/');
expect(lastBackendRunInput.input.remoteToolCwd).toContain('/role_sandbox');
```

Use the existing backend mocking pattern in `tests/agent-team-runtime.test.ts`.

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npx vitest run tests/agent-team-runtime.test.ts -t "sandbox"
```

Expected: FAIL because route currently uses `runtimeContext?.groupFolder ?? agent-team-${team.id}-${role.id}` and passes `runtimeContext?.remoteToolCwd` unchanged at `src/routes/agent-teams.ts:1191` and `src/routes/agent-teams.ts:1220`.

- [ ] **Step 3: Wire resolver into executePreparedRun**

Modify imports:

```ts
import { resolveAgentTeamRoleWorkspace } from '../agent-team-runtime-control.js';
```

Replace the current `roleGroupFolder` assignment around `src/routes/agent-teams.ts:1191` with:

```ts
      const roleWorkspace = resolveAgentTeamRoleWorkspace({
        teamId: team.id,
        runId,
        roleId: role.id,
        roleName: role.name,
        workspacePolicy: role.policy?.workspacePolicy,
        runtimeGroupFolder: runtimeContext?.groupFolder,
        runtimeRemoteToolCwd: runtimeContext?.remoteToolCwd,
      });
      const roleGroupFolder = roleWorkspace.groupFolder;
```

Replace `remoteToolCwd: runtimeContext?.remoteToolCwd` around `src/routes/agent-teams.ts:1220` with:

```ts
              remoteToolCwd: roleWorkspace.remoteToolCwd,
```

Replace cleanup `scope: 'session'` around `src/routes/agent-teams.ts:1230` with:

```ts
              scope: roleWorkspace.cleanupScope,
```

- [ ] **Step 4: Run sandbox integration test**

Run:

```bash
npx vitest run tests/agent-team-runtime.test.ts -t "sandbox"
```

Expected: PASS.

- [ ] **Step 5: Run route tests**

Run:

```bash
npx vitest run tests/agent-team-runtime.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/routes/agent-teams.ts tests/agent-team-runtime.test.ts
git commit -m "feat: isolate agent team role workspaces"
```

### Task A5: Add backend AbortSignal plumbing

**Files:**
- Modify backend run input type file used by `roleBackend.run()`
- Modify: `src/routes/agent-teams.ts:1201`
- Modify: `src/backends/agent-link-driver.ts`
- Test: `tests/agent-team-runtime.test.ts`

- [ ] **Step 1: Locate exact backend run input type**

Run:

```bash
npx tsc --noEmit
```

Expected before changes: current project compiles. Use TypeScript errors and IDE search to identify the `run()` input type shared by backends.

- [ ] **Step 2: Add failing cancellation plumbing test**

In `tests/agent-team-runtime.test.ts`, mock a backend whose `run()` stores `input.signal`, starts a never-resolving promise, call cancel endpoint, and assert:

```ts
expect(signalFromBackend).toBeInstanceOf(AbortSignal);
expect(signalFromBackend.aborted).toBe(true);
```

- [ ] **Step 3: Register AbortController per task**

In `src/routes/agent-teams.ts` around `src/routes/agent-teams.ts:1181`, create an `AbortController` per task:

```ts
      const abortController = new AbortController();
      const unregisterCancellation = registerAgentTeamTaskCancellation({
        runId,
        taskId,
        cancel: (reason) => abortController.abort(reason),
      });
```

Pass to backend run:

```ts
            signal: abortController.signal,
```

Call `unregisterCancellation()` in the existing `finally` before/after cleanup.

- [ ] **Step 4: Map AbortSignal to Agent Link cancel frame**

In `src/backends/agent-link-driver.ts`, where a run id is known and `agent.run.cancel` / `run.cancel` is already sent on timeout, add an abort listener:

```ts
const onAbort = () => {
  s.send({ type: 'agent.run.cancel', runId, reason: String(input.signal?.reason ?? 'user_abort') });
};
input.signal?.addEventListener('abort', onAbort, { once: true });
try {
  // existing run await
} finally {
  input.signal?.removeEventListener('abort', onAbort);
}
```

Use the existing variable names in the file; there are separate paths for agent-run and classic run, so apply the matching frame type in each path.

- [ ] **Step 5: Run targeted tests**

Run:

```bash
npx vitest run tests/agent-team-runtime.test.ts -t "cancel"
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/routes/agent-teams.ts src/backends/agent-link-driver.ts tests/agent-team-runtime.test.ts
git commit -m "feat: propagate cancellation to agent team backends"
```

---

## 5. Phase B 详细实施计划：Artifact 数据面与迁移

### Task B1: Add artifact version tables and helpers

**Files:**
- Modify: `src/db.ts:544`
- Test: `tests/agent-team-artifacts.test.ts`

- [ ] **Step 1: Write failing DB helper tests**

Create `tests/agent-team-artifacts.test.ts` with the same temp DATA_DIR/mock pattern used in `tests/agent-teams.test.ts`. Add:

```ts
test('records multiple artifact versions for the same key', () => {
  recordAgentTeamArtifact({
    id: 'artifact_1',
    runId: 'run_1',
    key: 'plan',
    version: 1,
    contentType: 'text/markdown',
    value: 'first',
    sourceStepId: 'plan',
    sourceTaskId: 'task_1',
    sourceRoleId: 'planner',
    visibility: 'run',
  });
  recordAgentTeamArtifact({
    id: 'artifact_2',
    runId: 'run_1',
    key: 'plan',
    version: 2,
    contentType: 'text/markdown',
    value: 'second',
    sourceStepId: 'plan_retry',
    sourceTaskId: 'task_2',
    sourceRoleId: 'planner',
    parentArtifactIds: ['artifact_1'],
    visibility: 'run',
  });

  expect(listAgentTeamArtifacts('run_1').map((artifact) => artifact.id)).toEqual([
    'artifact_1',
    'artifact_2',
  ]);
  expect(getAgentTeamArtifact('artifact_2', 'run_1')?.parentArtifactIds).toEqual([
    'artifact_1',
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npx vitest run tests/agent-team-artifacts.test.ts
```

Expected: FAIL because helpers do not exist.

- [ ] **Step 3: Add tables and interfaces**

In `src/db.ts`, add tables after `agent_team_blackboard`:

```sql
CREATE TABLE IF NOT EXISTS agent_team_artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  key TEXT NOT NULL,
  version INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  value TEXT NOT NULL,
  source_step_id TEXT,
  source_task_id TEXT,
  source_role_id TEXT,
  confidence REAL,
  visibility TEXT NOT NULL DEFAULT 'run',
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES agent_team_runs(id)
);
CREATE TABLE IF NOT EXISTS agent_team_artifact_edges (
  parent_artifact_id TEXT NOT NULL,
  child_artifact_id TEXT NOT NULL,
  relationship TEXT NOT NULL DEFAULT 'derived_from',
  created_at TEXT NOT NULL,
  PRIMARY KEY(parent_artifact_id, child_artifact_id, relationship)
);
CREATE INDEX IF NOT EXISTS idx_agent_team_artifacts_run_key ON agent_team_artifacts(run_id, key, version);
```

Add TS interfaces and helpers near blackboard helpers:

```ts
export interface AgentTeamArtifactRecord {
  id: string;
  runId: string;
  key: string;
  version: number;
  contentType: string;
  value: string;
  sourceStepId?: string;
  sourceTaskId?: string;
  sourceRoleId?: string;
  confidence?: number;
  visibility?: 'run' | 'role' | 'system';
  parentArtifactIds?: string[];
  createdAt?: string;
}
```

Implement `recordAgentTeamArtifact()`, `listAgentTeamArtifacts(runId)`, `getAgentTeamArtifact(id, runId)` using JSON-free columns and edge rows.

- [ ] **Step 4: Run artifact DB tests**

Run:

```bash
npx vitest run tests/agent-team-artifacts.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db.ts tests/agent-team-artifacts.test.ts
git commit -m "feat: persist agent team artifact versions"
```

### Task B2: Persist workflow outputKey as artifact versions

**Files:**
- Modify: `src/agent-team-engine.ts`
- Modify: `src/routes/agent-teams.ts`
- Test: `tests/agent-team-runtime.test.ts`

- [ ] **Step 1: Extend execution trace payload for artifact writes**

In `src/agent-team-engine.ts`, when a step writes `state.artifacts[outputKey]`, emit trace event:

```ts
appendTraceEvent(state, {
  actor: step.roleId ?? step.id,
  type: 'artifact.written',
  taskId: step.id,
  payload: {
    key: outputKey,
    sourceStepId: step.id,
    sourceRoleId: step.roleId,
    contentType: 'text/markdown',
  },
});
```

- [ ] **Step 2: Write failing route persistence test**

Add to `tests/agent-team-runtime.test.ts`:

```ts
test('persists workflow outputKey artifacts as versioned artifact records', async () => {
  // create a one-step team with outputKey: 'plan'
  // mock backend returns 'plan body'
  // execute run
  const artifactsResponse = await app.request(`/agent-teams/runs/${runId}/artifacts`, {
    headers: authHeaders,
  });
  const artifactsBody = await artifactsResponse.json();
  expect(artifactsBody.artifacts).toMatchObject([
    { key: 'plan', version: 1, value: 'plan body', sourceStepId: 'plan' },
  ]);
});
```

- [ ] **Step 3: Persist artifact.written events in API layer**

In `executePreparedRun()` after trace events are recorded, scan `execution.traceEvents` for `artifact.written`, look up the artifact value from `execution.checkpoint?.artifacts[key]`, compute next version by current `listAgentTeamArtifacts(runId)` max version for key, and call `recordAgentTeamArtifact()`.

- [ ] **Step 4: Add artifact endpoints**

Add routes after blackboard route:

```ts
router.get('/runs/:runId/artifacts', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const run = getAgentTeamRun(c.req.param('runId'), user.id);
  if (!run) return c.json({ error: 'agent team run not found' }, 404);
  return c.json({ artifacts: listAgentTeamArtifacts(run.id) });
});

router.get('/runs/:runId/artifacts/:artifactId', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const run = getAgentTeamRun(c.req.param('runId'), user.id);
  if (!run) return c.json({ error: 'agent team run not found' }, 404);
  const artifact = getAgentTeamArtifact(c.req.param('artifactId'), run.id);
  if (!artifact) return c.json({ error: 'artifact not found' }, 404);
  return c.json({ artifact });
});
```

- [ ] **Step 5: Run tests**

Run:

```bash
npx vitest run tests/agent-team-runtime.test.ts -t "artifacts"
npx vitest run tests/agent-team-engine.test.ts
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/agent-team-engine.ts src/routes/agent-teams.ts tests/agent-team-runtime.test.ts
git commit -m "feat: expose agent team workflow artifacts"
```

---

## 6. Phase C 详细实施计划：Approval Policy 与 Verify/Vote

### Task C1: Add approvalPolicy schema and evaluator

**Files:**
- Modify: `src/agent-teams.ts`
- Modify: `src/agent-team-engine.ts`
- Test: `tests/agent-team-approval-policy.test.ts`

- [ ] **Step 1: Write evaluator tests**

Create `tests/agent-team-approval-policy.test.ts`:

```ts
import { describe, expect, test } from 'vitest';

import { evaluateAgentTeamApprovalPolicy } from '../src/agent-team-engine.js';

describe('agent team approval policy evaluator', () => {
  test('requires all approvers for all-of policy', () => {
    const result = evaluateAgentTeamApprovalPolicy(
      { mode: 'all_of', approverRoleIds: ['owner', 'security'] },
      [
        { approverRoleId: 'owner', decision: 'approved' },
        { approverRoleId: 'security', decision: 'approved' },
      ],
    );

    expect(result.status).toBe('approved');
  });

  test('rejects quorum policy when any approver rejects', () => {
    const result = evaluateAgentTeamApprovalPolicy(
      { mode: 'quorum', approverRoleIds: ['a', 'b', 'c'], quorum: 2 },
      [
        { approverRoleId: 'a', decision: 'approved' },
        { approverRoleId: 'b', decision: 'rejected' },
      ],
    );

    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('b rejected');
  });
});
```

- [ ] **Step 2: Implement minimal schema/evaluator**

Add in `src/agent-teams.ts`:

```ts
export interface AgentTeamWorkflowApprovalPolicy {
  mode: 'single' | 'any_of' | 'all_of' | 'quorum';
  approverRoleIds: string[];
  quorum?: number;
  timeoutMs?: number;
  onTimeout?: 'reject' | 'approve' | 'fallback';
}
```

Add `approvalPolicy?: AgentTeamWorkflowApprovalPolicy;` to `AgentTeamWorkflowStep`.

Export from `src/agent-team-engine.ts`:

```ts
export interface AgentTeamApprovalDecisionInput {
  approverRoleId: string;
  decision: 'approved' | 'rejected';
}

export function evaluateAgentTeamApprovalPolicy(
  policy: AgentTeamWorkflowApprovalPolicy,
  decisions: AgentTeamApprovalDecisionInput[],
): { status: 'pending' | 'approved' | 'rejected'; reason: string } {
  const rejected = decisions.find((decision) => decision.decision === 'rejected');
  if (rejected) return { status: 'rejected', reason: `${rejected.approverRoleId} rejected` };
  const approved = new Set(decisions.filter((decision) => decision.decision === 'approved').map((decision) => decision.approverRoleId));
  if (policy.mode === 'single') return approved.size >= 1 ? { status: 'approved', reason: 'single approver approved' } : { status: 'pending', reason: 'waiting for one approval' };
  if (policy.mode === 'any_of') return policy.approverRoleIds.some((id) => approved.has(id)) ? { status: 'approved', reason: 'one allowed approver approved' } : { status: 'pending', reason: 'waiting for any approver' };
  if (policy.mode === 'quorum') return approved.size >= (policy.quorum ?? policy.approverRoleIds.length) ? { status: 'approved', reason: 'quorum reached' } : { status: 'pending', reason: 'waiting for quorum' };
  return policy.approverRoleIds.every((id) => approved.has(id)) ? { status: 'approved', reason: 'all approvers approved' } : { status: 'pending', reason: 'waiting for all approvers' };
}
```

- [ ] **Step 3: Run tests**

Run:

```bash
npx vitest run tests/agent-team-approval-policy.test.ts
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/agent-teams.ts src/agent-team-engine.ts tests/agent-team-approval-policy.test.ts
git commit -m "feat: add agent team approval policy evaluator"
```

### Task C2: Add verify and vote step types

**Files:**
- Modify: `src/agent-teams.ts`
- Modify: `src/agent-team-engine.ts`
- Test: `tests/agent-team-engine.test.ts`
- Test: `tests/agent-teams.test.ts`

- [ ] **Step 1: Write engine tests for verify and vote**

Add tests to `tests/agent-team-engine.test.ts`:

```ts
test('verify step writes verifier_report artifact', async () => {
  const result = await executeAgentTeam(teamWithVerifyStep, input, async (context) => ({
    status: 'success',
    result: JSON.stringify({ passed: true, score: 0.92, findings: [] }),
  }));

  expect(result.status).toBe('success');
  expect(result.checkpoint?.artifacts.verifier_report).toContain('0.92');
});

test('vote step aggregates candidate role outputs deterministically', async () => {
  const result = await executeAgentTeam(teamWithVoteStep, input, async (context) => ({
    status: 'success',
    result: context.role.id === 'critic_a' ? 'APPROVE score=0.8' : 'APPROVE score=0.7',
  }));

  expect(result.status).toBe('success');
  expect(result.checkpoint?.artifacts.vote_result).toContain('approved');
});
```

Define `teamWithVerifyStep` and `teamWithVoteStep` locally with explicit `workflowSteps` and `outputKey`.

- [ ] **Step 2: Extend schema**

In `src/agent-teams.ts`, change:

```ts
export type AgentTeamWorkflowStepType = 'role' | 'parallel' | 'route' | 'verify' | 'vote';
```

Add optional config:

```ts
export interface AgentTeamWorkflowVerify {
  verifierRoleId: string;
  subjectKeys: string[];
  rubric?: string;
}

export interface AgentTeamWorkflowVote {
  voterRoleIds: string[];
  subjectKeys: string[];
  threshold?: number;
}
```

Add `verify?: AgentTeamWorkflowVerify; vote?: AgentTeamWorkflowVote;` to `AgentTeamWorkflowStep`.

- [ ] **Step 3: Implement minimal runtime execution**

In `executeWorkflowStep()`, add branches:

```ts
if (step.type === 'verify') return executeVerifyStep(team, input, runner, state, step, roleResults, events);
if (step.type === 'vote') return executeVoteStep(team, input, runner, state, step, roleResults, events);
```

`executeVerifyStep` should run the verifier role once, store result at `step.outputKey ?? 'verifier_report'`, and append blackboard/trace compatible events.

`executeVoteStep` should run each voter role, count outputs containing `APPROVE` vs `REJECT`, store a JSON result at `step.outputKey ?? 'vote_result'`:

```json
{"approved":true,"approveCount":2,"rejectCount":0,"threshold":0.5}
```

- [ ] **Step 4: Update Team Architect prompt discipline**

In `src/agent-teams.ts`, add prompt lines near existing workflowSteps requirements:

```text
- 当任务需要独立质量门禁时，优先使用 verify step，而不是让实现角色自评。
- 当任务需要多候选方案汇总时，使用 vote step 表达投票聚合，vote step 必须声明 subjectKeys 与 outputKey。
```

- [ ] **Step 5: Run tests**

Run:

```bash
npx vitest run tests/agent-team-engine.test.ts -t "verify|vote"
npx vitest run tests/agent-teams.test.ts -t "prompt"
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/agent-teams.ts src/agent-team-engine.ts tests/agent-team-engine.test.ts tests/agent-teams.test.ts
git commit -m "feat: add verify and vote workflow steps"
```

---

## 7. Phase D 详细实施计划：模板库与 UI

### Task D1: Backend built-in template registry

**Files:**
- Create: `src/agent-team-templates.ts`
- Modify: `src/routes/agent-teams.ts`
- Test: `tests/agent-team-templates.test.ts`

- [ ] **Step 1: Write template registry tests**

Create `tests/agent-team-templates.test.ts`:

```ts
import { describe, expect, test } from 'vitest';

import {
  createAgentTeamInputFromTemplate,
  getAgentTeamTemplate,
  listAgentTeamTemplates,
} from '../src/agent-team-templates.js';

describe('agent team templates', () => {
  test('lists readonly built-in templates', () => {
    const templates = listAgentTeamTemplates();
    expect(templates.some((template) => template.id === 'feature-delivery-v1')).toBe(true);
  });

  test('creates agent team input from template with goal override', () => {
    const template = getAgentTeamTemplate('feature-delivery-v1');
    expect(template).toBeTruthy();
    const input = createAgentTeamInputFromTemplate('feature-delivery-v1', {
      goal: '实现通知中心',
      createdByAgentId: 'claude-sdk',
    });

    expect(input.name).toContain('Feature Delivery');
    expect(input.goal).toBe('实现通知中心');
    expect(input.workflowSteps?.length).toBeGreaterThan(1);
    expect(input.createdByAgentId).toBe('claude-sdk');
  });
});
```

- [ ] **Step 2: Implement template registry**

Create `src/agent-team-templates.ts` with one built-in template:

```ts
import type { AgentTeamInput } from './agent-teams.js';

export interface AgentTeamTemplateSummary {
  id: string;
  name: string;
  description: string;
  tags: string[];
}

export interface AgentTeamTemplate extends AgentTeamTemplateSummary {
  team: Omit<AgentTeamInput, 'goal' | 'createdByAgentId'>;
}

const templates: AgentTeamTemplate[] = [
  {
    id: 'feature-delivery-v1',
    name: 'Feature Delivery v1',
    description: 'Plan, implement, verify, and finalize a software feature with explicit artifacts.',
    tags: ['software', 'verify', 'leader-worker'],
    team: {
      name: 'Feature Delivery Team',
      shape: 'leader-worker',
      description: 'A governed team for delivering code changes with verification.',
      roles: [
        { id: 'lead', name: 'Lead', responsibility: 'Plan and finalize delivery.' },
        { id: 'implementer', name: 'Implementer', responsibility: 'Implement the requested change.' },
        { id: 'verifier', name: 'Verifier', responsibility: 'Verify correctness and risks.' },
      ],
      workflow: 'Lead plans, implementer works, verifier checks, lead finalizes.',
      workflowSteps: [
        { id: 'plan', type: 'role', roleId: 'lead', phase: 'plan', outputKey: 'plan' },
        { id: 'implement', type: 'role', roleId: 'implementer', phase: 'work', inputKeys: ['plan'], dependsOn: ['plan'], outputKey: 'implementation' },
        { id: 'verify', type: 'verify', verify: { verifierRoleId: 'verifier', subjectKeys: ['implementation'] }, dependsOn: ['implement'], inputKeys: ['implementation'], outputKey: 'verifier_report' },
        { id: 'finalize', type: 'role', roleId: 'lead', phase: 'finalize', inputKeys: ['plan', 'implementation', 'verifier_report'], dependsOn: ['verify'], outputKey: 'final' },
      ],
      successCriteria: ['Implementation satisfies the goal', 'Verifier report has no blocking findings'],
    },
  },
];

export function listAgentTeamTemplates(): AgentTeamTemplateSummary[] {
  return templates.map(({ id, name, description, tags }) => ({ id, name, description, tags }));
}

export function getAgentTeamTemplate(id: string): AgentTeamTemplate | null {
  return templates.find((template) => template.id === id) ?? null;
}

export function createAgentTeamInputFromTemplate(
  id: string,
  input: { goal: string; createdByAgentId: string },
): AgentTeamInput {
  const template = getAgentTeamTemplate(id);
  if (!template) throw new Error(`agent team template not found: ${id}`);
  return {
    ...structuredClone(template.team),
    goal: input.goal,
    createdByAgentId: input.createdByAgentId,
  };
}
```

- [ ] **Step 3: Add routes**

In `src/routes/agent-teams.ts` add:

```ts
router.get('/templates', authMiddleware, (c) => {
  return c.json({ templates: listAgentTeamTemplates() });
});

router.get('/templates/:templateId', authMiddleware, (c) => {
  const template = getAgentTeamTemplate(c.req.param('templateId'));
  if (!template) return c.json({ error: 'agent team template not found' }, 404);
  return c.json({ template });
});

router.post('/templates/:templateId/teams', authMiddleware, systemConfigMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));
  const goal = typeof body.goal === 'string' ? body.goal.trim() : '';
  if (!goal) return c.json({ error: 'goal is required' }, 400);
  const teamInput = createAgentTeamInputFromTemplate(c.req.param('templateId'), {
    goal,
    createdByAgentId: String(body.createdByAgentId ?? 'system'),
  });
  const team = createAgentTeam(teamInput, user.id);
  return c.json({ team }, 201);
});
```

- [ ] **Step 4: Run tests**

Run:

```bash
npx vitest run tests/agent-team-templates.test.ts
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent-team-templates.ts src/routes/agent-teams.ts tests/agent-team-templates.test.ts
git commit -m "feat: add built-in agent team templates"
```

### Task D2: Run detail UI for DAG, approvals, artifacts, checkpoints

**Files:**
- Modify existing `web/src/**` Agent Team run detail/list components.
- No backend change unless UI discovers missing fields.

- [ ] **Step 1: Locate current Agent Team frontend files**

Use file search for `agent-teams` under `web/src`. Identify existing pages/components instead of creating parallel UI.

- [ ] **Step 2: Add data loader calls**

The run detail page should fetch:

```ts
GET /agent-teams/runs/:runId
GET /agent-teams/runs/:runId/tasks
GET /agent-teams/runs/:runId/events
GET /agent-teams/runs/:runId/blackboard
GET /agent-teams/runs/:runId/artifacts
GET /agent-teams/runs/:runId/approvals
GET /agent-teams/runs/:runId/checkpoints
```

- [ ] **Step 3: Render panels in this order**

1. Run header: status, shape, duration, traceId.
2. DAG/steps: derive nodes from team.workflowSteps if team is available; otherwise render tasks ordered by `startedAt`.
3. Approval cards: pending cards have approve/reject actions.
4. Artifacts: key, version, source step/role, content preview.
5. Checkpoints: node, status, updatedAt, resume availability.
6. Trace events: collapsible raw event list for debugging.

- [ ] **Step 4: Add UI actions**

Add buttons:

```text
Cancel Run -> POST /agent-teams/runs/:runId/cancel
Approve -> POST /agent-teams/runs/:runId/approvals/:approvalId {"decision":"approved"}
Reject -> POST /agent-teams/runs/:runId/approvals/:approvalId {"decision":"rejected"}
```

- [ ] **Step 5: Verify frontend build**

Run:

```bash
npm run build:web
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src
git commit -m "feat: show agent team runtime details"
```

---

## 8. Phase E 详细实施计划：Metrics

### Task E1: Metrics derivation module

**Files:**
- Create: `src/agent-team-metrics.ts`
- Test: `tests/agent-team-metrics.test.ts`

- [ ] **Step 1: Write metrics tests**

Create `tests/agent-team-metrics.test.ts`:

```ts
import { describe, expect, test } from 'vitest';

import { summarizeAgentTeamMetrics } from '../src/agent-team-metrics.js';

describe('agent team metrics', () => {
  test('summarizes success rate and approval latency', () => {
    const summary = summarizeAgentTeamMetrics({
      runs: [
        { id: 'r1', status: 'success', createdAt: '2026-06-08T00:00:00.000Z', updatedAt: '2026-06-08T00:01:00.000Z' },
        { id: 'r2', status: 'error', createdAt: '2026-06-08T00:00:00.000Z', updatedAt: '2026-06-08T00:02:00.000Z' },
      ],
      tasks: [],
      approvals: [
        { id: 'a1', status: 'approved', createdAt: '2026-06-08T00:00:10.000Z', resolvedAt: '2026-06-08T00:00:40.000Z' },
      ],
    });

    expect(summary.totalRuns).toBe(2);
    expect(summary.successRate).toBe(0.5);
    expect(summary.averageApprovalLatencyMs).toBe(30_000);
  });
});
```

- [ ] **Step 2: Implement pure summarizer**

Create `src/agent-team-metrics.ts`:

```ts
export interface AgentTeamMetricsInput {
  runs: Array<{ id: string; status: string; createdAt: string; updatedAt?: string }>;
  tasks: Array<{ id: string; status: string; startedAt?: string; completedAt?: string }>;
  approvals: Array<{ id: string; status: string; createdAt: string; resolvedAt?: string }>;
}

export interface AgentTeamMetricsSummary {
  totalRuns: number;
  successRate: number;
  averageRunDurationMs: number | null;
  averageApprovalLatencyMs: number | null;
  failedTaskCount: number;
}

function durationMs(start?: string, end?: string): number | null {
  if (!start || !end) return null;
  const value = new Date(end).getTime() - new Date(start).getTime();
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function average(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function summarizeAgentTeamMetrics(
  input: AgentTeamMetricsInput,
): AgentTeamMetricsSummary {
  const totalRuns = input.runs.length;
  const successfulRuns = input.runs.filter((run) => run.status === 'success').length;
  const runDurations = input.runs
    .map((run) => durationMs(run.createdAt, run.updatedAt))
    .filter((value): value is number => value !== null);
  const approvalLatencies = input.approvals
    .map((approval) => durationMs(approval.createdAt, approval.resolvedAt))
    .filter((value): value is number => value !== null);

  return {
    totalRuns,
    successRate: totalRuns === 0 ? 0 : successfulRuns / totalRuns,
    averageRunDurationMs: average(runDurations),
    averageApprovalLatencyMs: average(approvalLatencies),
    failedTaskCount: input.tasks.filter((task) => task.status === 'error').length,
  };
}
```

- [ ] **Step 3: Run tests**

Run:

```bash
npx vitest run tests/agent-team-metrics.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/agent-team-metrics.ts tests/agent-team-metrics.test.ts
git commit -m "feat: summarize agent team metrics"
```

### Task E2: Metrics API and dashboard

**Files:**
- Modify: `src/db.ts`
- Modify: `src/routes/agent-teams.ts`
- Modify: `web/src/**`
- Test: `tests/agent-team-metrics.test.ts`

- [ ] **Step 1: Add DB query helpers**

In `src/db.ts`, add list helpers for metrics with filters:

```ts
export function listAgentTeamRunsForMetrics(options: {
  userId: string;
  teamId?: string;
  since?: string;
  until?: string;
  limit?: number;
}): AgentTeamRunView[] {
  // Query agent_team_runs with optional team/time filters.
}
```

Also add task and approval list-by-runIds helpers, or reuse existing list helpers in a loop for the first version.

- [ ] **Step 2: Add route**

Add in `src/routes/agent-teams.ts`:

```ts
router.get('/metrics', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const teamId = c.req.query('teamId')?.trim() || undefined;
  const since = c.req.query('since')?.trim() || undefined;
  const until = c.req.query('until')?.trim() || undefined;
  const runs = listAgentTeamRunsForMetrics({ userId: user.id, teamId, since, until, limit: 1000 });
  const tasks = runs.flatMap((run) => listAgentTeamTasks(run.id));
  const approvals = runs.flatMap((run) => listAgentTeamApprovals(run.id));
  return c.json({ metrics: summarizeAgentTeamMetrics({ runs, tasks, approvals }) });
});
```

- [ ] **Step 3: Add route test**

Seed two runs and one approval, call:

```text
GET /agent-teams/metrics?teamId=team_1
```

Assert:

```ts
expect(body.metrics.totalRuns).toBe(2);
expect(body.metrics.successRate).toBe(0.5);
```

- [ ] **Step 4: Add dashboard panel**

In existing Agent Team frontend area, add a metrics panel that fetches `/agent-teams/metrics` and shows:

- total runs
- success rate
- average run duration
- average approval latency
- failed task count

- [ ] **Step 5: Verify**

Run:

```bash
npx vitest run tests/agent-team-metrics.test.ts
npx tsc --noEmit
npm run build:web
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db.ts src/routes/agent-teams.ts src/agent-team-metrics.ts tests/agent-team-metrics.test.ts web/src
git commit -m "feat: add agent team metrics dashboard"
```

---

## 9. 总体验证矩阵

每个阶段结束都必须运行：

```bash
npx vitest run tests/agent-team-engine.test.ts
npx vitest run tests/agent-team-runtime.test.ts
npx vitest run tests/agent-teams.test.ts
npx tsc --noEmit
```

涉及前端的 Phase D/E 额外运行：

```bash
npm run build:web
```

涉及 Agent Link cancel 的 Phase A 额外手工验证：

1. 创建一个包含长耗时 role 的 Agent Team run。
2. 在 role 运行中调用 `POST /agent-teams/runs/:runId/cancel`。
3. 确认 run 状态变为 `cancelled`。
4. 确认 task 状态变为 `cancelled` 或 backend 返回 abort error 后记录为 cancelled。
5. 确认 Agent Link 客户端收到 `run.cancel` 或 `agent.run.cancel`。
6. 确认 workspace cleanup 不会删除 `runtimeContext.remoteToolCwd` 根目录，只清理 run/role scoped 子目录。

---

## 10. 自检结果

### Spec coverage

- per-role workspace / worktree / sandbox 真隔离：Phase A / Task A3-A4 覆盖。
- cancel token 贯穿正在运行的 role：Phase A / Task A1-A2-A5 覆盖。
- 数据库结构大迁移：Phase B / Task B1 覆盖，采用小步迁移。
- blackboard versioning 与 provenance：Phase B / Task B1-B2 覆盖。
- 多人审批流与复杂审批策略：Phase C / Task C1 覆盖。
- Verifier / Critic / Debate / Voting / MoA 一等公民：Phase C / Task C2 先落 verify/vote，Debate/MoA 在 verify/vote 稳定后扩展。
- Agent Team 模板库产品化：Phase D / Task D1 覆盖。
- 前端 UI 大改造：Phase D / Task D2 覆盖。
- 按 role 精准路由到 daemon / device runtime：Phase A / Task A3-A5 覆盖底座，后续可在 `resolveRoleRuntimeTarget()` 独立扩展。
- 生产级指标面板：Phase E / Task E1-E2 覆盖。

### Placeholder scan

- 本计划没有使用 TBD/稍后实现作为任务内容。
- Debate/MoA 未在第一批高阶原语中强行落地，明确作为 verify/vote 稳定后的扩展，避免一次性过大。

### Type consistency

- `AgentTeamWorkflowStepType`、`AgentTeamWorkflowApprovalPolicy`、`AgentTeamRoleWorkspaceDescriptor`、artifact helper 命名在任务间保持一致。
- 所有新增测试命令使用现有 `vitest` / `tsc` / `build:web` 脚本。

---

## 11. 完成记录

### Phase A：运行控制与隔离底座

- 已完成：runtime cancellation registry、cancel endpoint 到运行中 task 的取消传播、per-role workspace descriptor、role execution workspace 隔离、backend `AbortSignal` plumbing、Agent Link cancel frame 映射。
- 相关验证：`tests/agent-team-runtime-control.test.ts`、`tests/agent-team-runtime.test.ts`、`tests/agent-link-run-context.test.ts` 已纳入全量测试。

### Phase B：Artifact 数据面与迁移

- 已完成：`agent_team_artifacts` / `agent_team_artifact_edges` 表、artifact version helper、workflow `outputKey` 产物持久化、run artifact list/detail API。
- 相关验证：`tests/agent-team-artifacts.test.ts`、`tests/agent-team-runtime.test.ts` 已纳入全量测试。

### Phase C：治理与高阶协作原语

- 已完成：`approvalPolicy` schema 与 evaluator、`verify` / `vote` workflow step type、verifier report 与 vote aggregation artifact 输出、Team Architect prompt 约束更新。
- 相关验证：`tests/agent-team-approval-policy.test.ts`、`tests/agent-team-engine.test.ts`、`tests/agent-teams.test.ts` 已纳入全量测试。

### Phase D：模板库与 UI

- 已完成：内置 template registry、template list/detail/create-from-template API、前端 run detail 的任务/事件/黑板/artifact/approval/checkpoint 可观测面板。
- 相关验证：`tests/agent-team-templates.test.ts`、`tests/frontend-agents-module.test.ts`、`npm run build:web`。

### Phase E：生产级指标

- 已完成：metrics pure summarizer、DB metrics query helper 与索引、`GET /agent-teams/metrics`、前端 metrics dashboard panel、run history 刷新后同步刷新 metrics。
- 相关验证：`tests/agent-team-metrics.test.ts`、`tests/frontend-agents-module.test.ts`、`npm run build:web`。

### 最新验证命令

- `npm test -- --run`：99 个 test files / 1001 个 tests 通过。
- `npm run build:web`：通过。
- `npx tsc --noEmit`：通过。
