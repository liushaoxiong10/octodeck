# OctoDeck 对标 Multica 的产品与工程改进计划

## 背景

本计划基于对 `multica-ai/multica` 的完整学习，以及对当前 OctoDeck 代码库的架构梳理。Multica 的核心启发是：把 Agent 作为任务系统中的一等工作者，而不是只作为聊天会话里的工具。OctoDeck 当前已经具备 Device daemon、Repo Knowledge、Memory、Agent Team、Worktree 等很强的基础能力，下一阶段应重点补齐任务闭环、Git/PR 闭环、Runtime 治理、Agent/Skill Registry 与 Autopilot。

## 总目标

将 OctoDeck 从“多入口 Agent 驾驶舱”升级为“Device-native AI Coding Workspace”：

- 以 Issue / Task 为主线组织 Agent 工作。
- 以 Device Runtime / Server Runtime 作为统一执行资源池。
- 以 Repo Knowledge + Memory 作为上下文底座。
- 以 Agent Team 作为复杂任务编排层。
- 以 Git / Diff / PR / Review 形成交付闭环。

## 阶段一：主闭环建设（P0，建议 2 周）

### 1. Issue assign to Agent / Agent Team

目标：让 Issue 可以像分配给人一样分配给 Agent 或 Agent Team。

计划：

- 扩展 Issue assignee 模型，支持 `user`、`agent`、`agent_team`、`device_agent`。
- 在 Issue 创建 / 更新接口中支持 assignee 类型与 ID。
- Issue 分配给 Agent 后自动创建 AgentTask。
- Issue 分配给 Agent Team 后自动创建 Team Run。
- Web Issue 列表和详情页展示 assignee 类型、运行状态和最后一次执行结果。

关键代码落点：

- `src/db.ts`
- `src/routes/issues.ts`
- `src/issue-runner.ts`
- `src/issue-auto-driver.ts`
- `src/agent-team-engine.ts`
- `web/src/pages/IssuesPage.tsx`
- `web/src/pages/IssueDetailPage.tsx`

验收标准：

- 用户可在 Web 上把 Issue 分配给 Agent / Agent Team。
- 分配后自动进入 queued / running / completed / failed 状态流。
- Issue 详情页能看到 Agent run timeline。

### 2. AgentTask 状态机与 Run Timeline

目标：统一 Chat Task、Issue Run、Agent Team Step 的执行记录与状态表达。

计划：

- 引入或强化统一 AgentTask 数据结构。
- 状态至少包括：`queued`、`claimed`、`running`、`waiting_approval`、`completed`、`failed`、`cancelled`。
- 保存 runtime、device、agent client、workspace、repo、branch、worktree、session id、result summary、error。
- Web 端增加 Run Timeline 组件，统一展示 run events、日志摘要、产物和错误。

关键代码落点：

- `src/db.ts`
- `src/routes/tasks.ts`
- `src/tasks.ts`
- `src/task-scheduler.ts`
- `src/agent-link/protocol.ts`
- `web/src/components/issues/IssueRunLivePanel.tsx`
- `web/src/components/issues/IssueTimeline.tsx`
- `web/src/stores/tasks.ts`

验收标准：

- 每次 Agent 执行都有可查询、可重试、可取消的 task record。
- Issue 页面和 Tasks 页面使用同一套状态语义。
- daemon 断线 / 失败后能准确反映 task 状态。

## 阶段二：Coding Workspace 交付闭环（P0，建议 3-4 周）

### 3. Worktree Diff API + Web Diff Viewer

目标：让 Agent 的代码改动从“隐藏在本地 worktree”变成 Web 可审查资产。

计划：

- daemon 增加获取 worktree git status / diff / changed files 的 RPC。
- server 为 Issue Run / AgentTask 提供 diff snapshot API。
- Web Issue 详情页展示 changed files、diff、commit summary。
- 支持用户选择继续运行、丢弃修改、生成提交说明。

关键代码落点：

- `client/octodeck-daemon/runner.go`
- `client/octodeck-daemon/protocol.go`
- `src/agent-link/protocol.ts`
- `src/agent-link/run-rpc.ts`
- `src/routes/repos.ts`
- `src/routes/issues.ts`
- `web/src/pages/IssueDetailPage.tsx`

验收标准：

- 用户能在 Issue 页面看到 Agent 修改了哪些文件。
- 用户能查看每个文件 diff。
- diff 来源与 task run、branch、worktree 可追踪。

### 4. Commit / PR / Review 最小闭环

目标：从 Agent 产出代码推进到可交付变更。

计划：

- 增加 daemon git commit RPC。
- 增加 GitHub / GitLab / Codebase provider 抽象，先支持最小 create PR 能力。
- Issue Run 完成后可一键生成 commit message。
- 支持 Review Agent 对当前 diff 做 review。
- 后续扩展 CI status、merge、revert。

关键代码落点：

- `client/octodeck-daemon/runner.go`
- `src/routes/repos.ts`
- `src/agent-link/protocol.ts`
- `src/agent-team-templates.ts`
- `src/agent-definitions` 相关能力

验收标准：

- Agent 修改可以在 Web 上提交为 commit。
- 至少一种 Git provider 可以创建 PR。
- Review Agent 能基于 diff 产出结构化 review comment。

## 阶段三：Runtime 资源池与安全治理（P1，建议 1 个月）

### 5. Runtime 资源池化

目标：统一 Device、Agent Client、Backend、RuntimeProfile，形成可观测、可调度的执行资源。

计划：

- 定义 Runtime 一等对象：`server`、`device`、`cloud`。
- 汇总 provider、model、capabilities、permission modes、concurrency、online status、queue depth。
- Web 增加 Runtime / Capacity 视图。
- AgentTask 调度时按 runtime capability 和负载选择执行资源。

关键代码落点：

- `src/types.ts`
- `src/backends/registry.ts`
- `src/routes/agent-link.ts`
- `src/agent-link/registry.ts`
- `client/octodeck-daemon/agent_clients.go`
- `web/src/pages/DevicesPage.tsx`

验收标准：

- Web 能看到所有可用 runtime 和容量。
- runtime offline / busy 能影响调度决策。
- task 能记录自己实际使用的 runtime。

### 6. Task-scoped Token 与权限策略

目标：降低 Agent 执行权限风险，避免直接暴露用户全量权限。

计划：

- 为每个 AgentTask 生成短期 task-scoped token。
- token 绑定 task、runtime、workspace、repo 权限范围。
- 建立 run permission policy：filesystem、network、secrets、shell、git。
- 高风险操作进入 approval flow。
- 对强权限模式进行显式提示和审计。

关键代码落点：

- `src/auth.ts`
- `src/permissions.ts`
- `src/routes/agent-link.ts`
- `src/agent-link/protocol.ts`
- `src/backends/agent-client-adapter.ts`
- `src/agent-team-engine.ts`

验收标准：

- Agent run 只能使用绑定 task 的 scoped token。
- 高风险 shell / git push / secret access 可进入审批。
- 审计日志能追踪 token 创建、使用和失效。

## 阶段四：Agent Registry 与 Skill 治理（P1，建议 3-4 周）

### 7. Agent Store 升级为团队级 Registry

目标：从本地 file-based agent catalog 升级为可治理的团队资产。

计划：

- 区分 Agent Definition 与 Skill Package。
- Agent Definition 管理角色、系统提示词、默认模型、所需技能、可见性、版本。
- Skill Package 管理文件集合、provider target、版本、作者、checksum。
- 支持安装到不同 provider 的原生目录：Claude、Codex、Trae、OpenCode 等。
- 增加版本、审批、回滚、审计。

关键代码落点：

- `src/routes/agent-definitions.ts`
- `src/agent-marketplace-index.ts`
- `src/routes/skills.ts`
- `src/skill-utils.ts`
- `client/octodeck-daemon/skill_discovery.go`
- `web/src/stores/agent-definitions.ts`
- `web/src/pages/AgentDefinitionsPage.tsx`

验收标准：

- Agent 和 Skill 都有版本与安装记录。
- 用户能看到某个 Agent 依赖了哪些 Skill。
- 安装时能根据 provider 写入正确位置。

## 阶段五：Autopilot 与主动工作流（P1/P2，建议 1-2 个月）

### 8. Autopilot MVP

目标：让 Agent 从“被动响应”升级为“按计划主动工作”。

计划：

- 新增 Autopilot 对象，支持 `schedule`、`webhook`、`manual`、`api` 触发。
- action 支持 `create_issue`、`run_agent`、`run_agent_team`。
- 保存 autopilot run、触发 payload、skip reason、结果摘要。
- 内置三个模板：每日 repo health check、每周 dependency/TODO scan、webhook code review。

关键代码落点：

- `src/routes/autopilots.ts`（新增）
- `src/db.ts`
- `src/task-scheduler.ts`
- `src/repo-knowledge.ts`
- `src/agent-team-engine.ts`
- `web/src/pages` 新增 Autopilot 页面

验收标准：

- 用户可创建一个定时 Autopilot。
- Autopilot 可自动创建 Issue 或启动 Agent Run。
- 运行历史可查询，失败原因可追踪。

## 阶段六：Repo Knowledge 与 Realtime 体验增强（P2，持续迭代）

### 9. Repo Knowledge 搜索质量升级

目标：让 Repo Knowledge 真正成为 Agent 执行上下文，而不是只做页面检索。

计划：

- chunk 增加 embedding 或外部 vector index。
- graph edge 增加 confidence、source、runId。
- agent provider 输出统一 schema，包含 rationale、architecture summary、risk points。
- AgentTask 启动时自动注入相关 repo context。

关键代码落点：

- `src/db.ts`
- `src/repo-knowledge.ts`
- `src/repo-knowledge-search.ts`
- `src/routes/repos.ts`
- `container/skills/builtin-graph-scan/scripts/builtin_graph_scan.py`

验收标准：

- Agent run 能自动获取与 Issue 相关的 repo context。
- Repo Knowledge 搜索结果有来源、置信度和上下文片段。
- Web 可解释为什么某些 chunk 被注入。

### 10. Realtime Event 标准化

目标：让 Web 工作台由领域事件驱动，而不是各页面各自刷新。

计划：

- 定义统一 `OctoDeckEvent` schema。
- 覆盖 issue、agent_task、runtime、repo_knowledge、approval、device、memory。
- WebSocket 客户端按事件类型更新对应 store。
- 建立 notification center / approval inbox。

关键代码落点：

- `src/web.ts`
- `src/stream-event.types.ts`
- `shared/stream-event.ts`
- `web/src/api/ws.ts`
- `web/src/stores/*`

验收标准：

- Issue 状态、Task 进度、Device 在线状态可实时更新。
- Web 端减少手动轮询。
- Approval 请求可实时进入用户 inbox。

## 推荐实施顺序

1. Issue assign to Agent / Agent Team。
2. AgentTask 状态机与 Run Timeline。
3. Worktree Diff API + Web Diff Viewer。
4. Commit / PR / Review 最小闭环。
5. Runtime 资源池化。
6. Task-scoped Token 与权限策略。
7. Agent Store 团队级 Registry。
8. Autopilot MVP。
9. Repo Knowledge 搜索质量升级。
10. Realtime Event 标准化。

## 第一批可拆 Issue

### Issue 1：支持 Issue 分配给 Agent / Agent Team

- 扩展 DB schema。
- 扩展 Issue API。
- 更新 Web 表单和详情页。
- 分配后创建 AgentTask / Team Run。

### Issue 2：新增 AgentTask 状态机

- 定义 task schema。
- 接入 daemon run request。
- 保存 started / completed / failed events。
- Web 展示 timeline。

### Issue 3：daemon 提供 worktree diff RPC

- daemon 实现 git status / diff。
- protocol 增加 request / response frame。
- server route 暴露 diff API。
- Web Issue 详情页展示 changed files。

### Issue 4：Runtime 资源池视图

- 聚合 devices、agent clients、backend profiles。
- 展示 online、busy、capacity、models、permission modes。
- task 调度记录 runtime id。

### Issue 5：Autopilot 数据模型与手动触发 MVP

- 新增 autopilots / autopilot_runs。
- 支持 manual trigger。
- action 先支持 run_agent 和 create_issue。
- Web 提供最小配置页。

## 风险与注意事项

- 不要一次性推翻现有 Chat / Group 模型，应通过 Issue / Task 主线逐步收敛。
- Device offline 是常态，所有 task / runtime 逻辑必须支持等待、跳过、重试。
- Worktree diff / commit / PR 涉及真实代码变更，必须提供清晰的用户确认与回滚路径。
- 权限治理要尽早做，否则后续 Agent 自动化能力越强，风险越高。
- Agent Store 升级时要兼容现有 `~/.claude/agents/*.md` 文件，不破坏用户已有资产。

## 成功指标

- 80% Agent 执行都能挂到 Issue / AgentTask，而不是散落在 Chat 中。
- 用户可以从一个 Issue 完成：分配 Agent -> 执行 -> 查看 diff -> review -> commit / PR。
- Runtime 页面能解释“为什么这个任务由这个设备 / agent client 执行”。
- Autopilot 能稳定创建 Issue 或运行 Agent Team。
- Agent / Skill 安装、版本和使用记录可审计。
