# Agent Team Workflow Runtime v2 全流程开发规划

日期：2026-06-08

## 1. 背景与目标

当前 OctoDeck 已经具备 Agent Team 的基础编排能力：`pipeline`、`parallel`、`leader-worker`、`judge-route`、`workflowSteps`、trace events、blackboard、approvals 与 checkpoints。关键代码入口包括：

- `src/agent-teams.ts`：Agent Team schema、默认角色、默认 workflowSteps、Team Architect prompt。
- `src/agent-team-engine.ts`：Agent Team 执行器。
- `src/routes/agent-teams.ts`：Agent Team API、run 创建、approval、checkpoint、blackboard 持久化。
- `src/db.ts`：`agent_team_runs`、`agent_team_tasks`、`agent_team_events`、`agent_team_blackboard`、`agent_team_checkpoints`、`agent_team_approvals`。

但当前 `workflowSteps` 更接近“顺序执行数组”：`dependsOn`、`inputKeys`、checkpoint、运行中审批等字段或能力尚未形成完整运行时闭环。本规划目标是把 Agent Team 升级为可治理的多智能体工作流运行时：

1. `dependsOn` 真正参与 DAG 调度。
2. `inputKeys / outputKey` 真正约束 artifact 传递。
3. 每个 step 有明确状态机。
4. 每个关键状态转换可追踪、可 checkpoint。
5. route step 可以在运行中请求 approval。
6. approval 通过后可以从 checkpoint 恢复执行。
7. cancel、failure、retry 保留足够状态，便于后续恢复和排障。

## 2. 本轮暂不做的内容

为避免 Runtime v2 第一阶段过度膨胀，本轮只打通 DAG 调度、artifact 契约、checkpoint、运行中 approval 与 resume 的最小闭环。以下内容明确不在本轮实现范围内：

1. **per-role workspace / worktree / sandbox 真隔离**
   - 本轮只保留 role policy / workspacePolicy 的设计衔接，不把每个 role 强制路由到独立 worktree、容器或设备沙箱。
   - 后续在 Runtime v2 稳定后，再把 workspace isolation 与 Agent Link / daemon runtime 打通。

2. **cancel token 贯穿正在运行的 role**
   - 本轮 cancel 至少写 run 状态、trace event 和 checkpoint。
   - 不保证能立即中断已经进入 runner、Agent Link 或 daemon runtime 的底层执行进程。

3. **数据库结构大迁移**
   - 本轮优先复用现有表和 JSON 字段：`agent_team_checkpoints.state`、`agent_team_approvals.payload`、`agent_team_events.payload`。
   - 不新增复杂表结构，不引入 blackboard version 表或 artifact lineage 表。

4. **blackboard versioning 与 provenance 完整模型**
   - 本轮 artifacts 仍主要保存在 runtime state / blackboard 现有结构中。
   - 不实现 artifact 多版本、TTL、owner、confidence、source task lineage 的完整查询模型。

5. **多人审批流与复杂审批策略**
   - 本轮 approval 只实现单 approval gate 的暂停、通过、拒绝、恢复。
   - 不实现多人会签、超时升级、审批角色矩阵或审批策略 DSL。

6. **Verifier / Critic / Debate / Voting / MoA 一等公民**
   - 本轮会在 Team Architect prompt 和默认模板中强化 review / verify 设计。
   - 不把投票、辩论、多候选聚合、rubric evaluator 做成独立运行时原语。

7. **Agent Team 模板库产品化**
   - 本轮只调整默认 shape 生成逻辑与 prompt 纪律。
   - 不新增完整模板库 UI、模板市场、模板版本管理或导入导出能力。

8. **前端 UI 大改造**
   - 本轮以后端运行时和测试为主。
   - 不实现 DAG 可视化、step 状态图、approval card 详情页或 checkpoint resume 操作面板。

9. **按 role 精准路由到 daemon / device runtime 的完整重构**
   - 本轮不重构 roleAssignments、Agent Link、daemon runtime 的执行节点选择策略。
   - 只确保 Runtime v2 的 checkpoint / approval / resume 设计能为后续接入 per-role routing 留接口。

10. **生产级指标面板**
    - 本轮会标准化关键 trace event，便于后续统计。
    - 不实现成功率、approval 延迟、retry 次数、并行收益、成本等 dashboard。

## 3. 设计原则

### 2.1 最小足够多智能体

每个新增 Agent、step 或运行时机制都必须回答：收益来自拆分、并行、复核、长状态、人审、权限隔离还是协议互联。能用单 Agent + tools 解决的任务，不应强制使用 Agent Team。

### 2.2 编排器拥有流程，Agent 只负责专长输出

Agent 不应隐式控制全局流程。流程控制权属于 `agent-team-engine`：DAG 调度、状态流转、失败处理、checkpoint、approval 暂停与恢复都由编排器负责。

### 2.3 Artifact 是 step 之间的契约

`inputKeys` 和 `outputKey` 不只是 prompt 提示字段，而是运行时契约：

- step 执行前必须校验 `inputKeys` 是否存在。
- step 输出必须写入 `state.artifacts[outputKey]`。
- 后续 step 只能依赖显式声明的 artifact。

### 2.4 可恢复优先于一次性跑完

长流程的可靠性来自 checkpoint，而不是聊天记录。每轮调度、step 状态变化、approval 等待、失败和完成都应写入 checkpoint。

### 2.5 人审是决策界面，不是背锅按钮

approval payload 必须包含 action、reason、scope、risk、rollback hint、stepId、traceId、当前 artifacts 摘要，确保审批人能判断影响和恢复路径。

## 4. 总体架构

### 3.1 Runtime v2 核心模块

1. **Workflow Validator**
   - 校验 step id 唯一。
   - 校验 `dependsOn` 引用存在。
   - 校验 DAG 无环。
   - 校验 step 类型字段完整。

2. **DAG Scheduler**
   - 维护 step 状态：`pending / ready / running / success / failed / skipped / waiting_approval`。
   - 每轮找出所有依赖已满足的 ready steps。
   - 同一轮 ready steps 可并发执行。
   - 对 `onFailure` 决定 retry、run_role、continue、abort。

3. **Artifact Contract Layer**
   - 执行前按 `inputKeys` 从 `state.artifacts` 取输入。
   - 缺失输入时生成结构化失败。
   - 执行后按 `outputKey` 写入 artifact。
   - prompt 构建时优先注入声明的输入 artifact，而不是无差别注入全部历史。

4. **Checkpoint Manager**
   - 在 workflow start、step ready、step running、step success、step failed、waiting approval、workflow complete 等节点写 checkpoint。
   - checkpoint state 记录 step 状态、artifacts、bus cursor、trace cursor、pending approvals、last error。

5. **Approval Gate**
   - route judge 输出 `request_approval` 时暂停 run。
   - 执行器返回 `waiting_approval` 结果。
   - API 层创建 approval 记录并把 run 标记为 `waiting_approval`。
   - 审批通过后恢复 checkpoint，继续执行等待中的 step 或后续 step。
   - 审批拒绝后终止 run，记录拒绝原因。

6. **Trace Event Standardizer**
   - 标准化事件类型，支持后续 UI、指标和问题排查。

### 3.2 数据流

```text
POST /agent-teams/:id/execute
  -> create run(status=running)
  -> executeAgentTeam(team, input, runner)
      -> validate workflowSteps
      -> create runtime state
      -> checkpoint(workflow.started)
      -> schedule ready steps
      -> execute step(s)
      -> write artifacts / trace / checkpoint
      -> if route requests approval: return waiting_approval
      -> if completed: return success
      -> if failed: return error
  -> route persists tasks/events/blackboard/checkpoints/approvals
```

approval 恢复：

```text
POST /agent-teams/runs/:runId/approvals/:approvalId/decide
  -> update approval(granted/rejected)
  -> if granted:
       load latest checkpoint
       executeAgentTeam(team, { resumeFromCheckpoint, approvalDecision }, runner)
       continue scheduling
     else:
       mark run failed/cancelled
```

## 5. 数据模型规划

### 4.1 复用现有表

第一阶段尽量不做数据库迁移，复用已有 JSON 字段：

- `agent_team_checkpoints.state` 存 Runtime v2 state JSON。
- `agent_team_approvals.payload` 存 approval card JSON。
- `agent_team_events.payload` 存 trace payload JSON。
- `agent_team_blackboard.value` 存 artifact value JSON 或文本。

### 4.2 Runtime checkpoint state

建议 checkpoint state 结构：

```json
{
  "schemaVersion": 2,
  "runId": "...",
  "traceId": "...",
  "workflowNode": "step-id-or-workflow",
  "status": "running | waiting_approval | success | error | cancelled",
  "stepStatuses": {
    "plan": {
      "status": "success",
      "attempt": 1,
      "startedAt": "...",
      "completedAt": "...",
      "outputKey": "plan",
      "error": null
    }
  },
  "artifacts": {
    "plan": "..."
  },
  "waitingApproval": {
    "approvalId": "...",
    "stepId": "route_or_gate",
    "requestedBy": "judge",
    "decision": null
  },
  "busMessageSeq": 12,
  "spanSeq": 18,
  "messageSeq": 7,
  "lastError": null,
  "updatedAt": "..."
}
```

### 4.3 Approval payload

```json
{
  "schemaVersion": 2,
  "action": "agent_team.route_approval",
  "reason": "judge requested approval before running high-risk role",
  "scope": {
    "teamId": "...",
    "runId": "...",
    "stepId": "...",
    "judgeRoleId": "...",
    "candidateRoleIds": ["executor", "reviewer"],
    "targetRoleId": "executor"
  },
  "risk": "medium | high | critical",
  "diff": null,
  "rollback": "Reject approval to stop this run before executing the selected role.",
  "artifactsPreview": {
    "plan": "first 1000 chars..."
  },
  "traceId": "..."
}
```

## 6. API 行为规划

### 5.1 Execute

现有 execute endpoint 保持兼容。新增运行时返回状态：

- `success`
- `error`
- `waiting_approval`

如果执行器返回 `waiting_approval`：

1. run.status 写为 `waiting_approval`。
2. 创建 `agent_team_approvals` 记录。
3. 写 checkpoint。
4. 返回 run 摘要，包含 approval id。

### 5.2 Decide approval

现有 approval decision API 需要扩展为：

- `approve/grant`：恢复运行。
- `reject/deny`：run 终止。

恢复运行时需要：

1. 读取 run。
2. 读取 team。
3. 读取 latest checkpoint。
4. 构造 runner。
5. 调用 `executeAgentTeam` resume 模式。
6. 持久化后续 events/tasks/blackboard/checkpoints。

### 5.3 Cancel

第一阶段至少做到：

- run.status 标记 `cancelled`。
- 写 trace event：`agent_team.run.cancelled`。
- 写 checkpoint：status = `cancelled`。

后续阶段再把 cancel token 贯穿到正在运行的 role、Agent Link、daemon runtime。

## 7. 执行器改造规划

### 6.1 类型扩展

在 `src/agent-team-engine.ts` 中新增：

```ts
type AgentTeamWorkflowRuntimeStatus =
  | 'running'
  | 'success'
  | 'error'
  | 'waiting_approval'
  | 'cancelled';

type AgentTeamWorkflowStepStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'success'
  | 'failed'
  | 'skipped'
  | 'waiting_approval';
```

扩展 `AgentTeamExecutionResult`：

```ts
status: 'success' | 'error' | 'waiting_approval';
waitingApproval?: AgentTeamWaitingApproval;
checkpoint?: AgentTeamRuntimeCheckpoint;
```

扩展 `AgentTeamExecutionInput`：

```ts
resumeFromCheckpoint?: AgentTeamRuntimeCheckpoint;
approvalDecision?: {
  approvalId: string;
  status: 'granted' | 'rejected';
  targetRoleId?: string;
  comment?: string;
};
```

### 6.2 DAG 校验

新增函数：

- `validateWorkflowGraph(team)`
- `buildWorkflowGraph(steps)`
- `assertNoCycles(graph)`
- `getReadySteps(state, graph)`

校验失败直接返回 error，trace 记录 `workflow.validation.failed`。

### 6.3 调度循环

伪代码：

```ts
while (hasPendingSteps(runtime)) {
  const ready = getReadySteps(runtime, graph);
  if (!ready.length) return fail('workflow deadlock');

  mark ready as running;
  checkpoint('workflow.batch.started');

  const outcomes = await Promise.all(ready.map(executeWorkflowStep));

  for (const outcome of outcomes) {
    if (outcome.status === 'waiting_approval') {
      mark step waiting_approval;
      checkpoint('workflow.waiting_approval');
      return waitingApproval(outcome);
    }
    if (outcome.status === 'error') {
      handle onFailure;
    }
    mark step success;
  }
}
return success;
```

### 6.4 inputKeys 处理

新增 `selectArtifactsForStep(step, state)`：

- 若 `step.inputKeys` 为空：默认可见全部 artifacts（兼容旧行为）。
- 若非空：只返回声明的 artifacts。
- 缺失 key：返回结构化错误。

`runWorkflowAction` 中传入 filtered artifacts，角色 prompt 只看到必要 artifact。

### 6.5 route approval

当前 route decision 支持 `request_approval`，但会被 fallback 继续执行。改造为：

1. `parseRouteDecision()` 得到 `action === 'request_approval'`。
2. 不再选择 fallback role。
3. 构造 `waitingApproval`。
4. emit bus：`approval.requested`。
5. return `{ status: 'waiting_approval', waitingApproval }`。

approval 恢复时：

- 若 approvalDecision granted 且指定 targetRoleId：继续执行 target role。
- 若没有 targetRoleId：使用 route fallback 或第一个 candidate。
- 若 rejected：workflow error/cancelled。

## 8. Team Architect 与默认模板改造

### 7.1 Team Architect prompt 增强

在 `buildAgentTeamGenerationPrompt()` 中加入要求：

1. 必须在 description 或 workflow 中写明为什么单 Agent + tools 不够。
2. 必须写明 shape 选择理由，以及为什么不用相邻 shape。
3. `workflowSteps` 必须是合法 DAG：id 唯一、dependsOn 显式、inputKeys 指向上游 outputKey。
4. 每个 role 的 outputs 应尽量对应 workflow step 的 outputKey。
5. route step 必须说明何时输出 `request_approval`。
6. review / verify step 必须有 rubric 和失败处理。
7. successCriteria 必须包含可验证条目。

### 7.2 默认 workflowSteps 增强

默认模板增加 `dependsOn`：

- pipeline：每一步 dependsOn 前一步。
- leader-worker：workers dependsOn `lead_plan`，final synthesis dependsOn `worker_parallel`。
- judge-route：judge dependsOn 前置产物，route 后 final review dependsOn route。
- parallel：synthesizer dependsOn parallel work。

## 9. 测试规划

### 8.1 单元测试：`tests/agent-team-engine.test.ts`

新增测试：

1. 顺序 workflow 仍然按依赖执行。
2. DAG 中两个无依赖 step 可并行执行。
3. `dependsOn` 引用不存在时失败。
4. DAG 有环时失败。
5. `inputKeys` 缺失时失败并写 trace。
6. `outputKey` 写入 artifacts，后续 step 能读取。
7. route decision 为 `request_approval` 时返回 `waiting_approval`。
8. approval granted 后从 checkpoint 继续执行。
9. approval rejected 后停止。
10. 旧的 shape fallback：没有 workflowSteps 时仍走原有 pipeline/parallel/leader-worker/judge-route。

### 8.2 API 测试：`tests/agent-team-runtime.test.ts`

新增或扩展测试：

1. execute 返回 waiting_approval 时 run.status 是 `waiting_approval`。
2. approval 记录 payload 包含 action/reason/scope/rollback/risk。
3. approve 后 run 继续并最终 success。
4. reject 后 run failed/cancelled。
5. checkpoint 表有 Runtime v2 state。
6. trace events 包含标准事件序列。

### 8.3 回归测试

运行：

```bash
npm test -- tests/agent-team-engine.test.ts tests/agent-team-runtime.test.ts tests/agent-teams.test.ts
npm run typecheck
```

若仓库没有 `typecheck` 脚本，则运行 `npm test -- --runInBand` 或项目现有等价命令，并记录实际命令。

## 10. 分阶段实施计划

### Phase 0：准备与边界确认

- [ ] 确认 Runtime v2 不做数据库迁移，优先复用 JSON payload。
- [ ] 梳理现有 approval decision API。
- [ ] 梳理现有 test helper 和 mock runner。
- [ ] 确认 run status 是否允许新增 `waiting_approval`。

### Phase 1：执行器类型与 DAG 校验

- [ ] 扩展 `AgentTeamExecutionResult` 支持 `waiting_approval`、checkpoint、waitingApproval。
- [ ] 增加 Workflow Validator。
- [ ] 增加 DAG graph builder。
- [ ] 增加 cycle detection。
- [ ] 增加 ready step 计算。
- [ ] 增加相关单元测试。

### Phase 2：DAG 调度循环与 step 状态机

- [ ] 用 Runtime v2 替换 `executeWorkflowSteps()` 的简单 for-loop。
- [ ] 保留 `executeWorkflowStep()` 内部 role/parallel/route 执行能力。
- [ ] 增加 step status map。
- [ ] 每次状态变更 emit trace / bus。
- [ ] 支持批次 ready steps 并行执行。
- [ ] 支持 deadlock 检测。
- [ ] 增加调度测试。

### Phase 3：Artifact Contract

- [ ] 实现 `selectArtifactsForStep()`。
- [ ] `inputKeys` 缺失时报错。
- [ ] `runWorkflowAction()` 只接收过滤后的 artifacts。
- [ ] `outputKey` 写入 artifacts 后同步 step status。
- [ ] 调整 prompt 构建逻辑，明确“以下是声明输入 artifacts”。
- [ ] 增加 input/output 测试。

### Phase 4：Checkpoint Manager

- [ ] 定义 Runtime v2 checkpoint JSON。
- [ ] 执行器在关键节点生成 checkpoint object。
- [ ] API 层将 checkpoint 写入 `agent_team_checkpoints`。
- [ ] 失败时也写 checkpoint。
- [ ] 增加 checkpoint 测试。

### Phase 5：运行中 Approval Gate

- [ ] 修改 route step：`request_approval` 不再 fallback 自动执行。
- [ ] 构造 `waitingApproval` payload。
- [ ] 执行器返回 `waiting_approval`。
- [ ] API 层创建 approval 记录。
- [ ] run.status 进入 `waiting_approval`。
- [ ] approval granted 后从 checkpoint resume。
- [ ] approval rejected 后终止 run。
- [ ] 增加 approval 闭环测试。

### Phase 6：Team Architect 与模板更新

- [ ] 更新 `buildAgentTeamGenerationPrompt()`。
- [ ] 默认 workflowSteps 加 dependsOn。
- [ ] 默认 successCriteria 加入验证、恢复、边界条目。
- [ ] 增加 / 更新 `tests/agent-teams.test.ts`。

### Phase 7：标准 trace events 与回归

- [ ] 标准化事件命名。
- [ ] 确保旧调用方仍能读取 trace events。
- [ ] 跑 agent team 相关测试。
- [ ] 跑 typecheck。
- [ ] 修复回归。

## 11. 风险与缓解

### 10.1 风险：DAG 并行改变旧 workflow 顺序

缓解：没有 `dependsOn` 的旧 workflowSteps 默认按数组顺序补隐式依赖，或仅对显式 `dependsOn` 的 team 启用并行。推荐第一阶段采用兼容策略：

- 如果所有 step 都没有 `dependsOn`，保持旧顺序。
- 如果任一 step 有 `dependsOn`，启用 DAG 调度。

### 10.2 风险：approval resume 需要重建 runner 上下文

缓解：resume 在 API 层复用 execute run 的 runner 构造逻辑；checkpoint 只保存 runtime state，不保存不可序列化函数。

### 10.3 风险：checkpoint state 过大

缓解：第一阶段保存 artifacts 全量以确保恢复正确；后续可改为 artifact ids / blackboard cursor。

### 10.4 风险：route approval 语义不明确

缓解：approval payload 必须带 targetRoleId 或 candidateRoleIds；若审批通过但无 target，则走 fallbackRoleId 或第一个 candidate。

### 10.5 风险：执行器函数膨胀

缓解：把 validator、scheduler、checkpoint builder、artifact selector 拆成小函数；如果文件过大，后续再拆 `agent-team-runtime.ts`，第一阶段尽量少动 import 边界。

## 12. 验收清单

- [ ] `dependsOn` 能控制执行顺序。
- [ ] 显式 DAG 中无依赖节点可并行。
- [ ] 缺失 `dependsOn` 引用会失败。
- [ ] DAG 环会失败。
- [ ] `inputKeys` 缺失会失败。
- [ ] `outputKey` 产物能被下游读取。
- [ ] route `request_approval` 会暂停 run。
- [ ] approval 通过后能继续 run。
- [ ] approval 拒绝后不会继续执行高风险 role。
- [ ] checkpoint 能说明 run 停在哪个 step。
- [ ] trace 能还原 workflow 关键状态变化。
- [ ] 旧 pipeline / parallel / leader-worker / judge-route 行为不破坏。
- [ ] agent team 相关测试通过。

## 13. 后续演进方向

Runtime v2 闭环完成后，再推进：

1. per-role workspace / worktree / sandbox 隔离。
2. cancel token 贯穿 role runner、Agent Link、daemon runtime。
3. blackboard versioning 与 provenance。
4. verifier / critic / debate / voting 一等公民。
5. Agent Team template library。
6. UI 上展示 DAG 图、step 状态、approval card、checkpoint resume。
7. 指标面板：成功率、retry 次数、approval 延迟、并行收益、成本。
