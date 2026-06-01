# Phase 5 — Client Daemon (Distributed Execution) Plan

> 目标：把所有「在用户机器上跑命令」的工作从 server 搬到用户本地常驻的 Go daemon，
> server 只做调度。本计划只覆盖 **Phase 5.1 协议 + 注册 + 健康通道**，
> 是后续所有下发的地基；Phase 5.2~5.4 留待对齐后再下计划。

## 决策摘要（已确认）

| 方面 | 决策 |
| ---- | ---- |
| 客户端形态 | Go 静态二进制（`hcagent`），本目标 **不写代码**，只定协议 + server 端绑定 |
| 通道 | Client 出站 WebSocket 到 `/api/agent-link/ws`，单连接复用所有 RPC |
| 用户 ↔ Client | 1 用户 N client；group 显式选定哪台 client 执行（沿用 `group.backend` 的下拉位置，多一层「执行节点」选项） |
| Server-local spawn | **彻底移除**（最终态）。Phase 5.1 不动现有 spawn，仅为 Phase 5.2 铺路 |
| 下发范围 | 所有 host backend、SDK 工具、container 都下发；Phase 5.1 不实际下发，仅完成连接 |

---

## Phase 5.1 — Agent Link Protocol & Client Registry

### 范围
1. WebSocket 协议草案（双向 JSON-RPC over WS，frame 是单行 JSON）
2. Server 端「Client 注册 / token / 心跳 / 在线列表」管理
3. 数据库表 + admin/user UI
4. Group 字段：`executionNode`（client id 或 `server-local`）
5. 旧行为保持不变：`executionNode === 'server-local'` 走原逻辑

### 不在范围（留 Phase 5.2+）
- 实际把 backend run 调用通过 WS 转发
- Container 下发（Phase 5.4）
- SDK Bash/Edit 下发（Phase 5.3，需要把 agent-runner 移植到 client）

---

### 架构图

```
                       ┌──────────────────────────────┐
                       │   happyclaw server (this)    │
                       │  ─ /api/agent-link/ws (WS)   │
                       │  ─ AgentLinkRegistry         │
                       │  ─ resolveBackend()          │
                       │       │                       │
                       │       ▼                       │
                       │  if group.executionNode = X   │
                       │     → AgentLinkRegistry.send  │
                       │  else (server-local)          │
                       │     → 现有 host-cli-driver    │
                       └──────────────┬───────────────┘
                                      │ WSS (client 出站)
                          ┌───────────▼──────────┐
                          │  hcagent (Go)        │
                          │   ─ outbound ws conn │
                          │   ─ command runner   │   ← Phase 5.2 起接管
                          │   ─ file streamer    │
                          └──────────────────────┘
```

---

### 协议草案 `docs/agent-link-protocol.md`（新文档）

每帧 = 一行 JSON。所有 RPC 都有 `id`（client 自增）+ `type`：

| type | 方向 | 说明 |
| ---- | ---- | ---- |
| `hello` | C→S | 启动时发送：`{ token, version, os, arch, hostname, capabilities[] }` |
| `hello_ack` | S→C | server 回执：`{ clientId, displayName, serverVersion }` |
| `ping` | C→S | 30s 心跳，server 不回复（保活） |
| `run.request` | S→C | **Phase 5.2 引入**，预留 type；本期协议先定义但不实现 |
| `run.event` | C→S | **Phase 5.2 引入** |
| `run.result` | C→S | **Phase 5.2 引入** |
| `run.cancel` | S→C | **Phase 5.2 引入** |
| `error` | 双向 | 通用错误帧 |

`capabilities[]` Phase 5.1 仅声明 `link.v1`，未来加 `host-cli`、`container`、`sdk-runner` 等。

---

### 数据库（`src/db.ts` 新表）

```sql
CREATE TABLE agent_links (
  id TEXT PRIMARY KEY,                  -- 'cl_' + 16 hex
  user_id TEXT NOT NULL,                -- 归属用户
  display_name TEXT NOT NULL,           -- 用户起的名字（"我的 MacBook"）
  token_hash TEXT NOT NULL,             -- bcrypt(token) — 注册时返回明文一次
  capabilities TEXT NOT NULL DEFAULT '[]',
  os TEXT, arch TEXT, hostname TEXT,    -- hello 上报时填
  client_version TEXT,
  last_connected_at TEXT,               -- ISO timestamp
  last_seen_at TEXT,                    -- 最近一次 ping
  created_at TEXT NOT NULL,
  revoked_at TEXT,                      -- 软删；revoked 后该 token 永远拒绝
  FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE INDEX idx_agent_links_user ON agent_links(user_id) WHERE revoked_at IS NULL;
```

在线状态 **不入库**，只在 `AgentLinkRegistry` 内存 Map 里：`Map<linkId, AgentLinkSession>`。

---

### 新增源文件（server 端）

| 文件 | 内容 | 行数预估 |
| ---- | ---- | -------- |
| `src/agent-link/registry.ts` | `Map<linkId, Session>`、`send()`、`isOnline()`、broadcast 监听器 | ~150 |
| `src/agent-link/session.ts` | 单条 WS 包装：发送队列、心跳超时、close hook | ~120 |
| `src/agent-link/protocol.ts` | 帧的 Zod schema、type guards | ~80 |
| `src/routes/agent-link.ts` | `/api/agent-link/*`：list/create/revoke + WS upgrade | ~200 |
| `src/db.ts`（修改） | 加表 migrate + CRUD: `createAgentLink`、`listAgentLinksByUser`、`getAgentLinkById`、`updateAgentLinkSeen`、`revokeAgentLink`、`findAgentLinkByTokenHash` | +~100 |
| `docs/agent-link-protocol.md`（修改） | 协议文档 | — |

### 现有文件修改

| 文件 | 修改 |
| ---- | ---- |
| `src/index.ts` | mount `agentLinkRoutes` + WS upgrade handler；`shutdown` 关掉 registry |
| `src/types.ts` + `src/schemas.ts` + `src/db.ts` | `RegisteredGroup.executionNode?: string`；group create/patch schema 加字段；migration 增列 |
| `src/routes/groups.ts` | 持久化 `executionNode` |
| `src/backends/registry.ts` 或新文件 `src/backends/dispatch.ts` | `resolveExecutionTarget(group)`：返回 `{ kind: 'server-local' }` 或 `{ kind: 'agent-link', linkId }`。Phase 5.1 仅在 `executionNode !== 'server-local' && link online` 时返回 agent-link，调用方还没接，先打 warn 并降级到 server-local |
| `src/backends/host-cli-driver.ts` | **不动**（Phase 5.2 才包一层 dispatch） |

---

### Server 端 API

| 方法 | 路径 | 鉴权 | 说明 |
| ---- | ---- | ---- | ---- |
| `GET` | `/api/agent-link` | session | 列出当前用户所有 link，含在线状态、capabilities |
| `POST` | `/api/agent-link` | session | 创建：`{ displayName }` → 返回 `{ id, token }`（**token 仅本次返回，server 只存 hash**） |
| `DELETE` | `/api/agent-link/:id` | session | 撤销：标记 `revoked_at`，踢掉对应 WS |
| `POST` | `/api/agent-link/:id/rotate` | session | 旋转 token：旧 token 立即作废 |
| `GET` | `/api/agent-link/ws` | header `X-Link-Token` | WS upgrade 入口，握手成功后等 `hello` 帧 |

WS 握手鉴权流程：
1. Client 发 `Upgrade`，header 带 `X-Link-Token`
2. Server 用 bcrypt.compare 找匹配的 link；找不到 → 401 关闭
3. 接受连接，等 `hello`（5s 超时）；hello 校验通过 → 注册到 registry，回 `hello_ack`
4. Registry 同 linkId 的旧 session 主动断开（防止两台机器抢同一 token）
5. ping 30s，60s 没收到任何帧就主动 close

---

### Client 端（Phase 5.1 不实现，仅约定）

Go 项目骨架放 `client/hcagent/`（Phase 5.1 末期可选 commit 一份「能连上、发 hello、保活」的最小 demo，~300 行 Go），用 `nhooyr.io/websocket` + `koanf` 配置。**本期允许只做到 server 端，让客户端用 wscat/简单脚本验证连接。**

---

### 前端（`web/`）

| 页面 | 修改 |
| ---- | ---- |
| `web/src/components/settings/types.ts` | `SettingsTab` 加 `'agent-links'` |
| `web/src/components/settings/AgentLinksSection.tsx`（**新增**） | 列表 + 新建（弹出 token 一次性复制） + 撤销；轮询 5s 拉在线状态 |
| `web/src/stores/agentLinks.ts`（**新增**） | Zustand store，CRUD + load |
| `web/src/components/groups/GroupDetail.tsx` | 已有 backend 选择处加「执行节点」下拉：`server-local`（默认）/ 用户自己的 online links |
| `web/src/components/settings/SystemSettingsSection.tsx` | 不改本期，避免再撑大 |

---

### 安全与可观测

- token 64 位随机 hex；server 用 bcrypt(cost=10) 存 hash
- WS 握手 rate-limit：单 IP 5/min，复用现有 session-secret 文件机制
- `agent_links` 表所有写入走 audit log（沿用 `data/config/custom-backends.audit.log` 模式 → 新文件 `data/logs/agent-link.audit.log`）
- registry 关闭时给所有 session 发 `error: server_shutdown` 再 close，让 client 优雅重连

---

### 测试 / 验证（Phase 5.1 验收点）

1. `npx tsc --noEmit`（root + web）通过
2. `npm run dev` 起服后：
   - admin/user 登录 → Settings → 「Agent Links」 → 点新建 → 看到一次性 token
   - `wscat -c ws://localhost:3000/api/agent-link/ws -H "X-Link-Token: <token>"` 连上后发 `{"type":"hello","id":1,"token":"<token>","version":"0.0.0","os":"darwin","arch":"arm64","hostname":"x","capabilities":["link.v1"]}`，应收到 `hello_ack`
   - 关闭 wscat，5s 内列表里那台 link 应变「离线」
3. group 详情页能选执行节点，存盘后刷新仍在；`server-local` 模式行为完全等同改造前
4. revoke 后用旧 token 连 ws，立刻 401 关闭
5. 同 linkId 重复连接，旧连接被踢掉

---

## Phase 5.2 — Host CLI 下发到 client（本次一并实施）

### 范围
1. 协议补齐 `run.request` / `run.event` / `run.result` / `run.cancel` 4 帧
2. `src/backends/dispatch.ts` 真正切流量：`executionNode != 'server-local'` 时走 link
3. 新建 `src/agent-link/run-rpc.ts`：把 `BackendRunArgs` 包装成 `run.request`，把 client 流式回包重新装成 `ContainerOutput`（含 `onOutput` 回调）
4. `src/backends/host-cli-driver.ts` 不动；新增 `runHostCliViaLink()` 当 dispatch 选 link 时使用
5. `client/hcagent/`（Go）真实实现：维持 ws 连接、收 `run.request` 后 spawn 命令、按行回 `run.event`、close 时回 `run.result`、收到 `run.cancel` 杀进程
6. Client 配置文件 `~/.hcagent/config.json`：server URL + token + 可执行白名单

### 不在范围
- SDK 工具调用下发（5.3）
- Container 下发（5.4）
- 文件流式上传/下载（5.2 阶段假设 cwd 已在 client 本机存在，并由用户自己保证）

### 协议（追加 4 帧）

```jsonc
// S→C
{
  "type": "run.request",
  "id": 42,
  "runId": "run_xxxx",          // server 生成的运行 ID
  "backendId": "coco",
  "binary": "/usr/local/bin/coco",
  "argv": ["-p", "<prompt>", "--output-format=stream-json", "-y"],
  "cwd": "/Users/lsx/code/proj", // 必须 client 上真实存在
  "env": { "FOO": "bar" },        // 仅自定义 backend 的 env，不含 server 进程 env
  "outputProtocol": "jsonline-stream-json",
  "timeoutMs": 1800000,
  "maxOutputBytes": 10485760
}

// C→S（流式，可多次）
{ "type": "run.event", "runId": "run_xxxx", "stream": "stdout", "data": "..." }
{ "type": "run.event", "runId": "run_xxxx", "stream": "stderr", "data": "..." }

// C→S（最后一帧）
{
  "type": "run.result",
  "runId": "run_xxxx",
  "exitCode": 0,
  "signal": null,
  "timedOut": false,
  "durationMs": 12345
}

// S→C（用户中断时）
{ "type": "run.cancel", "runId": "run_xxxx", "reason": "user_abort" }
```

### Server 端实现

| 文件 | 内容 |
| ---- | ---- |
| `src/agent-link/run-rpc.ts`（新） | `runOnLink(session, args)`：注册 runId → resolver，发 `run.request`，监听 `run.event` 累积输出 + 调用 `onOutput`，收 `run.result` 后 finalize 成 `ContainerOutput`，超时本地 timer 发 `run.cancel`。语义和 host-cli-driver 一致 |
| `src/backends/dispatch.ts`（新） | `dispatchBackendRun(group, runArgs, backend)`：解析 executionNode → server-local 走 backend.run；agent-link 走 run-rpc。Phase 5.1 占位代码这里就升级成真分发 |
| `src/index.ts` | 把所有调 `backend.run()` 的入口（chat / spawn / scheduled task）改成调 `dispatchBackendRun()` |
| `src/agent-link/registry.ts` | 加 `Map<runId, RunController>`：被踢/断线时取消所有进行中的 run |
| `src/agent-link/session.ts` | 收到 `run.event/run.result` 时按 runId 路由到对应 RunController |

### 安全约束（Server 端校验）

- `binary` 走和自定义 backend 同一套 `validateBinaryPath`
- `argv` 走 `validateArgvTemplate` + `renderArgv`（绝不在 server 直接拼字符串发出去）
- `env` 走 `validateBackendEnv`（黑名单 LD_PRELOAD/NODE_OPTIONS 等）
- `cwd` 必须绝对路径；server 不做 realpath（client 端做）
- `maxOutputBytes` 双端各自 enforce（client 超限主动 close，server 收到时再 cap 一次）
- runId 用 `crypto.randomUUID()`；server 维护 `Map<runId, ownerUserId>`，跨用户事件丢弃

### Client 端 (`client/hcagent/`) Phase 5.2 最小实现

目录结构（约 8 个 Go 文件 + go.mod）：
```
client/hcagent/
├── go.mod
├── main.go             // 入口 + 信号处理 + 配置加载
├── config.go           // ~/.hcagent/config.json 读写
├── ws.go               // 出站 ws 连接 + 重连退避（1s,2s,4s,...,30s）
├── protocol.go         // 帧编解码 + type guards
├── runner.go           // run.request handler：spawn + stdout pump + run.cancel 监听
├── runner_pool.go      // Map<runId, *exec.Cmd> + 并发上限
├── safety.go           // binary 白名单 / cwd 校验 / 危险 env 拒绝（client 也要校验，纵深防御）
└── README.md           // 安装/启动/卸载说明
```

发布形态：`go build -ldflags="-s -w" -o hcagent`，目标 `darwin/arm64`、`darwin/amd64`、`linux/amd64`、`linux/arm64`。本期**仅本地构建**，不接 CI、不打 release。

Client 配置：
```json
{
  "server": "https://my-happyclaw.example.com",
  "token": "<注册时 server 返回的明文>",
  "linkId": "cl_xxxx",
  "allowedBinaries": [
    "/usr/local/bin/coco",
    "/Users/lsx/.bun/bin/aider"
  ],
  "maxConcurrentRuns": 4
}
```

### 验收点（Phase 5.2 在 5.1 基础上追加）

1. 用一台真实 Mac 安装 hcagent + 启动，`/api/agent-link` 列表显示在线
2. 在 group 里把 backend 设为 `coco`、execution node 设为这台 client，发消息 → server 日志显示「dispatch via link」，client 端真的 spawn 出 coco，stdout 实时流回前端
3. 输出超长 / 超时 / 用户中断三种异常路径 client 都能正确退出，server 端 ContainerOutput 状态正确
4. 杀掉 client（kill -9），server 端进行中的 run 在 5s 心跳超时后被标记 error，不会卡住任务
5. server 重启过程中正在跑的 run，client 收到断连后主动 kill 子进程，重连后不会"幽灵跑完"再上报
6. 向 client 发未在 `allowedBinaries` 的 binary，client 拒绝并回 `error` 帧，server 标记 run 失败

---

## 实施顺序（5.1 + 5.2 合并提交）

| 步骤 | 内容 | 阶段 |
| ---- | ---- | ---- |
| 1 | `docs/agent-link-protocol.md`：完整协议（hello + run.* + ping + error） | 5.1 |
| 2 | `src/db.ts`：`agent_links` 表 + 5 个 CRUD 函数 + migrate | 5.1 |
| 3 | `src/agent-link/{protocol,session,registry}.ts` | 5.1 |
| 4 | `src/routes/agent-link.ts`：REST + WS upgrade + token bcrypt | 5.1 |
| 5 | `src/types.ts/schemas.ts/db.ts/routes/groups.ts`：group 加 `executionNode` | 5.1 |
| 6 | 前端 `agentLinks` store + `AgentLinksSection` + group 下拉 | 5.1 |
| 7 | `src/agent-link/run-rpc.ts`：runOnLink，加 runId 路由 | 5.2 |
| 8 | `src/backends/dispatch.ts` 真正分发，所有调 backend.run 入口替换 | 5.2 |
| 9 | client `client/hcagent/`：Go 项目骨架 + ws + runner + safety | 5.2 |
| 10 | tsc + wscat 冒烟（5.1）+ hcagent 端到端跑一次 coco（5.2） | 5.1+5.2 |

## 后续阶段简述（仍不在本次范围）

- **Phase 5.3** — SDK 下发：把 `container/agent-runner` 移植到客户端，需在 client 上有 Node + `@anthropic-ai/claude-agent-sdk` + `claude` CLI；这步最难
- **Phase 5.4** — Container 下发：client 端调本机 docker，server 不再持有 docker daemon
- **Phase 5.5** — 移除 server-local：所有 admin 都先安装一个本机 hcagent，把 server 的 spawn 路径全部删掉
