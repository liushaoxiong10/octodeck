# Agent Backend Skills RPC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agent 详情页 Skills 模块从对应后端 CLI 获取 workspace skills 和 cli skills，并分组展示。

**Architecture:** 复用现有 Agent Link RPC 模式，新增 `skills.request` / `skills.result`。服务端按 device/client 转发查询，hcagent 在设备侧扫描对应 CLI 的 workspace/user skill 目录并返回结构化列表，前端 AgentsPage 在 Skills tab 异步加载并展示。

**Tech Stack:** TypeScript/Hono/Zod/WebSocket RPC、React/Zustand、Go hcagent、Vitest、Go test。

---

### Task 1: 扩展 Agent Link skills 协议与服务端 RPC

**Files:**
- Modify: `src/agent-link/protocol.ts`
- Create: `src/agent-link/skills-rpc.ts`
- Modify: `src/agent-link/registry.ts`
- Modify: `src/routes/agent-link.ts`

- [ ] 新增 `SkillInfoSchema`、`SkillsRequestFrame`、`SkillsResultFrame`，并加入 `InboundFrame` / `OutboundFrame`。
- [ ] 新增 `requestProviderSkills(session, opts)`，结构与 `model-rpc.ts` 保持一致，支持 timeout、send_failed、link_offline。
- [ ] registry 在收到 `skills.result` 时交给 `deliverSkillsResult`，断线时调用 `failSkillsRequestsForLink`。
- [ ] 新增 REST：`GET /api/agent-links/:id/providers/:providerId/skills?cwd=...`，校验用户、设备、client、在线状态后转发 RPC。

### Task 2: 扩展 hcagent 协议与设备侧 skill 发现

**Files:**
- Modify: `client/hcagent/protocol.go`
- Create: `client/hcagent/skill_discovery.go`
- Modify: `client/hcagent/ws.go`

- [ ] 新增 Go frame 类型 `skills.request` / `skills.result` 和 `SkillInfo`。
- [ ] 实现 `skillDiscoverer.handle`，异步扫描并返回结果。
- [ ] 对 `claude-code`、`codex`、`traecli` 先使用目录扫描策略：workspace = `<cwd>/.claude/skills`，cli = `~/.claude/skills`。
- [ ] 读取 `SKILL.md` / `SKILL.md.disabled`，解析 frontmatter `name`、`description`，识别 enabled 状态。
- [ ] ws 收到 `skills.request` 时路由到 discoverer。

### Task 3: 前端 AgentsPage 加载和展示分组 skills

**Files:**
- Modify: `web/src/pages/AgentsPage.tsx`

- [ ] 增加 `AgentSkillInfo` / `AgentSkillsResponse` 类型。
- [ ] 在选中 local-device Agent 的 Skills tab 时调用 `/api/agent-links/:deviceId/providers/:clientId/skills`。
- [ ] 展示 Workspace Skills、CLI Skills 两组列表，支持 loading、error、retry。
- [ ] 非 local-device Agent 保留当前 capabilities 展示。

### Task 4: 测试与验证

**Files:**
- Create: `tests/agent-link-skills-rpc.test.ts`
- Create: `client/hcagent/skill_discovery_test.go`
- Modify: `tests/frontend-agents-module.test.ts`

- [ ] Vitest 覆盖 skills RPC schema 与 pending result delivery。
- [ ] Go test 覆盖 workspace/cli skill 目录扫描、disabled skill、frontmatter 解析。
- [ ] 前端测试覆盖 AgentsPage 包含 skills API 调用和分组展示文案。
- [ ] 运行 `npm test -- tests/agent-link-skills-rpc.test.ts tests/frontend-agents-module.test.ts`。
- [ ] 运行 `go test ./...` in `client/hcagent`。
- [ ] 运行 `npm run typecheck`。

### Self-review

- 覆盖了协议、服务端 REST、设备侧发现、前端展示、测试验证。
- 未依赖不存在的 CLI skill list 命令，先用目录扫描满足 workspace/cli skill 展示。
- 路径与类型名保持一致：`SkillInfo` / `skills.request` / `skills.result`。
