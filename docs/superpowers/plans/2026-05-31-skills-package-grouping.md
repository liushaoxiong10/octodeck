# Skills Package Grouping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Skills 在 Agent 详情与 `/skills` 页面按 package 分组，支持点击查看详情，并在 `/skills` 页面按 device/workspace 筛选。

**Architecture:** 扩展 skill 元数据模型，新增 `packageName`、`content`、`deviceId`、`workspacePath` 等可选字段。设备侧 RPC 返回 workspace/CLI skill 的详情内容与 package，前端用共享的 package grouping helper 渲染分组与详情；本地 `/api/skills` 保持现有接口，前端在页面层合并本地、设备、workspace 数据。

**Tech Stack:** Go octodeck-daemon、TypeScript/Zod/Hono、React/Vite/Zustand、Vitest、Go test。

---

### Task 1: 扩展设备侧 SkillInfo 元数据

**Files:**
- Modify: `client/octodeck-daemon/protocol.go`
- Modify: `client/octodeck-daemon/skill_discovery.go`
- Test: `client/octodeck-daemon/skill_discovery_test.go`

- [ ] 新增 failing test：扫描 skill 时返回 `packageName` 与 `content`，无 package 时为空。
- [ ] 在 Go `SkillInfo` 添加 `PackageName string`、`Content string`。
- [ ] `scanSkillDirectory` 读取 `.skills-manifest.json` 中 package 信息，读取 SKILL.md 内容。
- [ ] 运行 `cd client/octodeck-daemon && go test ./...`。

### Task 2: 扩展 Agent Link skills 协议

**Files:**
- Modify: `src/agent-link/protocol.ts`
- Test: `tests/agent-link-skills-rpc.test.ts`

- [ ] 新增 failing test：`skills.result` 接受 `packageName`、`content`。
- [ ] 扩展 `SkillInfoSchema` 字段。
- [ ] 保持 `workspaceSkills` / `cliSkills` 对 legacy `null` 的兼容。
- [ ] 运行 `npm test -- tests/agent-link-skills-rpc.test.ts`。

### Task 3: 前端共享 package 分组与详情 UI

**Files:**
- Create: `web/src/utils/skillsGrouping.ts`
- Modify: `web/src/pages/AgentsPage.tsx`
- Modify: `web/src/pages/SkillsPage.tsx`
- Modify: `web/src/stores/skills.ts`
- Test: `tests/frontend-agents-module.test.ts`

- [ ] 新增 helper：`groupSkillsByPackage(skills)`，无 packageName 归为 `本地/未知来源`。
- [ ] Agent Skills 面板中 CLI Skills 按 package 分组，点击 skill 展开详情。
- [ ] `/skills` 页面改为按 package 分组，保留 source 信息和安装/启用操作。
- [ ] `/skills` 页面增加 device/workspace 筛选：local/system、device、workspace 三类来源。
- [ ] 运行 `npm test -- tests/frontend-agents-module.test.ts`。

### Task 4: 完整验证

- [ ] `cd client/octodeck-daemon && go test ./...`
- [ ] `npm test -- tests/agent-link-skills-rpc.test.ts tests/frontend-agents-module.test.ts`
- [ ] `npm run typecheck`
- [ ] 重建并重启 `~/.hcagent/bin/hcagent`，刷新 `/agents` 与 `/skills`。

### Self-review

- A 方案明确：无 packageName 归为“本地/未知来源”。
- 覆盖 Agent 详情页与 `/skills` 页面。
- 后端兼容旧客户端 null skill list，不再因空列表断开连接。
