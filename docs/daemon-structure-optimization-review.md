# Daemon 代码结构优化 Review

> 评审范围：当前 working tree 中 `client/octodeck-daemon/cmd/`、`client/octodeck-daemon/internal/` 以及与 daemon 协议衔接相关的 `src/agent-link/*`、`src/backends/*`。
>
> 验证状态：已运行 `go -C client/octodeck-daemon test ./...`，daemon Go 测试通过。

## 总体判断

当前 daemon 重构方向是正确的：原先集中在单包/大文件里的逻辑已经拆分到 `cmd`、`node`、`uplink`、`protocol`、`agentruntime`、`executor`、`session`、`workspace`、`security`、`resources`、`inventory` 等模块中。

但现阶段更像是“文件和包已经拆开，模块边界还需要继续沉淀”。主要结构问题集中在：

1. `node/wiring.go` 仍然承担过多装配和业务路由职责。
2. `protocol`、`config`、`uplink` 仍依赖业务 domain 类型，依赖方向不够干净。
3. `agentruntime` 各 family 之间保留了大量行为保持式复制。
4. `executor`、`session`、`state`、`workspace`、`security` 的取消、路径和安全策略职责有交叉。
5. TypeScript 与 Go 的 Agent Link 协议定义双写，后续存在漂移风险。

## P0 / 高优先级优化点

### 1. 拆薄 `node/wiring.go`，避免成为新的上帝装配层

**定位**

- `client/octodeck-daemon/internal/node/wiring.go:37`
- `client/octodeck-daemon/internal/node/wiring.go:74`
- `client/octodeck-daemon/internal/node/wiring.go:223`
- `client/octodeck-daemon/internal/node/wiring.go:337`

**现状**

`wireConnection` 负责 discovery、run pool、executor bundle、uplink dial options、hello ack 保存等连接装配逻辑。后续 `connection.Run` 又继续构造 models/skills discoverer、组装完整 uplink handlers、启动 heartbeat 和接收 loop。同一个文件还包含 cwd 解析、agent client resolve、model/skill discoverer 等业务逻辑。

**问题**

`node` 本应是 daemon 生命周期 orchestration 层，但当前已经混入 agent model discovery、skill discovery、workspace URI 解析、agent registry 查找、memory sync source 构建、update request handling 等业务能力。后续新增 frame 类型时，往往需要同时改 `protocol`、`uplink.Handlers`、`uplink.dispatch`、`node/wiring.go`，扩展成本偏高。

**建议**

拆成三个更明确的边界：

1. `connection_factory`：只负责 `cfg + runtime snapshot -> uplink.Client`。
2. `handler_factory`：只负责 `executors + services -> uplink.Handlers`。
3. `agentcatalog` 或 `inventory_service`：负责 agent client、model、skill 的 resolve/discovery。

目标是让 `node` 只做生命周期 orchestration，不直接持有大量业务细节。

### 2. 不再把 `config.Config` 当运行时状态容器

**定位**

- `client/octodeck-daemon/internal/config/config.go:54`
- `client/octodeck-daemon/internal/config/config.go:55`
- `client/octodeck-daemon/internal/node/wiring.go:38`
- `client/octodeck-daemon/internal/node/wiring.go:343`

**现状**

`Config` 中包含 `AgentClients []inventory.Info json:"-"`，`node` 启动时会在 `cfg.AgentClients == nil` 时写入 discovery 结果，后续 `resolveAgentClient` 也从 `cfg.AgentClients` 读取。

**问题**

`config` 的职责应是加载、校验、默认值，不应承载 mutable runtime inventory。`AgentClients` 是运行时 discovery 结果，不是用户配置。放在 `Config` 中会让很多包为了拿 runtime state 依赖 `config`，并使配置对象变成隐式全局应用状态。

**建议**

引入独立运行时上下文，例如：

```go
type RuntimeContext struct {
    Config       *config.Config
    AgentClients []inventory.Info
    Pool         *state.RunPool
}
```

`Config` 删除或停止作为主要通道使用 `AgentClients`。Discovery 结果显式传给 runtime capability builder、hello builder、heartbeat builder、agent discover/session handlers。

### 3. 修正 daemon version 注入链路，避免默认值分散

**定位**

- `client/octodeck-daemon/cmd/octodeck-daemon/version.go:12`
- `client/octodeck-daemon/internal/config/defaults.go:5`
- `client/octodeck-daemon/internal/config/defaults.go:74`
- `client/octodeck-daemon/internal/node/wiring.go:55`
- `client/octodeck-daemon/internal/uplink/handshake.go:19`

**现状**

真实版本通过 `cmd` 下的 embed 生成，但 config、node、uplink 中仍分别存在 fallback 默认值。`config.SetDefaultVersion` 存在但当前链路中没有明确调用。

**问题**

入口层知道真实版本，但运行链路不一定使用它。`uplink` 是连接层，不应该决定 daemon 产品版本。

**建议**

在 `node.Options` 中显式加入 `Version string`，由 `main()` 传入 `daemonVersion`。删除 `node/wiring.go` 和 `uplink/handshake.go` 中的产品版本硬编码 fallback。`uplink` 只接受已经构造好的 hello payload。

### 4. `protocol` 不应反向依赖 `inventory` 业务模型

**定位**

- `client/octodeck-daemon/internal/protocol/frames.go:6`
- `client/octodeck-daemon/internal/protocol/frames.go:21`
- `client/octodeck-daemon/internal/protocol/frames.go:23`
- `client/octodeck-daemon/internal/protocol/frames.go:45`
- `client/octodeck-daemon/internal/protocol/frames.go:150`
- `client/octodeck-daemon/internal/protocol/frames.go:210`

**现状**

`protocol/frames.go` import `inventory`，wire frame 直接使用本地 domain 类型，例如 `HelloFrame.AgentClients []inventory.Info`、`HelloFrame.Resources inventory.Snapshot`、`PingFrame.Resources inventory.Snapshot`。

**问题**

`protocol` 应是 wire contract，不应依赖 inventory 的内部 domain model。否则 inventory 字段调整可能无意改变 wire JSON shape。

**建议**

在 `protocol` 内定义独立 DTO：

- `AgentClientInfo`
- `ResourceSnapshot`
- `ModelInfo`
- `SkillInfo`

由 inventory/resources 或 adapter 层提供转换函数。目标依赖方向是业务层转换到 protocol，而不是 protocol import 业务层。

### 5. `uplink` 连接层不应暴露 inventory/resource 业务字段

**定位**

- `client/octodeck-daemon/internal/uplink/client.go:22`
- `client/octodeck-daemon/internal/uplink/client.go:50`
- `client/octodeck-daemon/internal/uplink/client.go:51`
- `client/octodeck-daemon/internal/uplink/client.go:52`
- `client/octodeck-daemon/internal/uplink/handshake.go:16`

**现状**

`uplink.DialOptions` 包含 `AgentClients []inventory.Info`、`AgentRuntimeCapabilities []proto.RuntimeCapability`、`InitialResources inventory.Snapshot`，并在 `sendHello` 内组装 `proto.HelloFrame`。

**问题**

`uplink` 是 WebSocket transport + handshake + routing 层，但当前知道 inventory snapshot、agent clients、runtime capabilities。未来 hello 字段变化时，会改连接层而不是只改 node/protocol builder。

**建议**

由 node 或单独的 `hello` builder 构造完整 `*proto.HelloFrame`。`uplink.DialOptions` 保留 transport 字段和 `Hello *proto.HelloFrame`。`uplink` 只负责 encode/write、read ack 和 dispatch。

### 6. 收敛 agentruntime family 的 ACP transport glue 重复

**定位**

- `client/octodeck-daemon/internal/agentruntime/claudecode/transport_acp.go:57`
- `client/octodeck-daemon/internal/agentruntime/codex/transport_acp.go:56`
- `client/octodeck-daemon/internal/agentruntime/traecli/transport_acp.go:113`
- `client/octodeck-daemon/internal/agentruntime/traex/transport_acp.go:113`

**现状**

四个 family 都重复实现 `runACP`、`acpDirectRunner`、`RunDirect`、`acpPermissionWaiter`。差异主要是 adapter 策略、server args、embedded backend、native system prompt 支持。

**问题**

ACP transport 生命周期、permission waiter、direct runner 包装是 family 无关逻辑。当前重复会导致权限等待、结果封装、重试语义等未来改动需要同步四份。

**建议**

在 `acpsupport` 或 `agentruntime` 增加通用 helper，例如：

```go
RunACPAgentPrompt(ctx, run, client, entry, adapter)
```

family 包只保留：

- `familyAdapter`
- `normalizeACPServerArgs`
- embedded backend 选择
- native system prompt 支持策略

### 7. `RunStdioAgentPrompt` 不应重新 `NewAgent` 只为获取 parser

**定位**

- `client/octodeck-daemon/internal/agentruntime/promptrunner.go:16`

**现状**

`RunStdioAgentPrompt` 通过 `NewAgent(run.Client, FindAgentRegistryEntry(...)).(OutputParser)` 重新构造 agent 获取 `ParseLine`。

**问题**

transport runner 不应依赖 factory 再构造 agent。如果未来 parser 需要 family 实例状态、entry 配置、缓存或测试注入，重新构造会绕过当前运行中的 agent 实例。

**建议**

修改调用链，让 `RunStdioAgentPrompt` 接收 parser：

```go
RunStdioAgentPrompt(ctx, run, argv, outputJSON, parser)
```

family 的 `RunPrompt` 调用时直接传当前实例的 parser。

### 8. 统一 executor / runner / pool / cancel 的抽象边界

**定位**

- `client/octodeck-daemon/internal/executor/executor.go:20`
- `client/octodeck-daemon/internal/executor/executor.go:30`
- `client/octodeck-daemon/internal/node/wiring.go:80`
- `client/octodeck-daemon/internal/node/wiring.go:81`
- `client/octodeck-daemon/internal/node/wiring.go:83`

**现状**

普通 run cancel 直接调用 pool，agent run cancel 走 `AgentExecutor.CancelRun`，tool cancel 当前为空。

**问题**

取消路径不一致。`RunPool` 既是 executor 内部实现细节，又被 node 直接操作。随着 runner 类型增加，调用方需要知道不同执行类型的取消细节。

**建议**

引入统一执行控制接口，例如：

```go
type Cancellable interface {
    CancelRun(runID string, reason string) bool
}
```

让 command、agent、tool executor 显式暴露各自取消能力。`node` 不直接操作 `state.RunPool`。

### 9. `RunPool` 不要在持锁状态下调用 cancel

**定位**

- `client/octodeck-daemon/internal/state/runtime_state.go:70`
- `client/octodeck-daemon/internal/state/runtime_state.go:124`
- `client/octodeck-daemon/internal/state/runtime_state.go:138`

**现状**

`RunPool.CancelRun()`、`CancelAll()`、`Attach()` 中存在持有 `p.mu` 时调用 cancel 的路径。

**问题**

锁内调用外部函数是并发设计异味。`context.CancelFunc` 可能触发派生 context 取消链、goroutine 退出、defer 逻辑，间接访问 pool 或发送状态时容易形成锁顺序风险。

**建议**

短期先改为锁内取出 cancel，锁外调用：

```go
func (p *RunPool) CancelRun(runID string) bool {
    var cancel context.CancelFunc

    p.mu.Lock()
    entry, ok := p.runs[runID]
    if ok && entry != nil {
        cancel = entry.cancel
    }
    p.mu.Unlock()

    if cancel != nil {
        cancel()
    }
    return ok
}
```

长期可拆成 `RunRegistry` 和 `CancellationRegistry`。

### 10. 解开 workspace 与 security 的概念耦合

**定位**

- `client/octodeck-daemon/internal/security/binaries.go:11`
- `client/octodeck-daemon/internal/security/binaries.go:87`
- `client/octodeck-daemon/internal/workspace/repo.go:314`
- `client/octodeck-daemon/internal/workspace/repo.go:316`
- `client/octodeck-daemon/internal/security/paths.go:12`

**现状**

`security` 为判断 managed URI import `workspace`。而 `workspace/repo.go` 又复制了 `security.CleanExistingDirectory` 以避免 import cycle。

**问题**

这是典型包边界反向依赖：security 想复用 workspace URI 判断，workspace 想复用 security path clean，最终导致工具函数复制和语义漂移风险。

**建议**

抽出底层无依赖包：

- `internal/pathutil`
- `internal/uriutil`

放置：

- `CleanExistingDirectory`
- `IsPathWithinRoot`
- `IsManagedURI`
- URI prefix / classifier

依赖方向调整为：

```text
security -> pathutil / uriutil
workspace -> pathutil / uriutil
executor -> security + workspace
```

## P1 / 中高优先级优化点

### 11. 抽共享 skill scanner

**定位**

- `client/octodeck-daemon/internal/agentruntime/claudecode/skills.go:112`
- `client/octodeck-daemon/internal/agentruntime/codex/skills.go:153`
- `client/octodeck-daemon/internal/agentruntime/traecli/skills.go:121`
- `client/octodeck-daemon/internal/agentruntime/traex/skills.go:127`

**建议**

新建 `internal/agentruntime/skillscan`，统一处理 `.skills-manifest.json`、`SKILL.md`、`SKILL.md.disabled`、frontmatter、symlink directory、path dedupe。family 包只声明搜索根目录和 `SourceProvider`。

### 12. session helper 回收到通用 ProviderSessionStore / Base hook

**定位**

- `client/octodeck-daemon/internal/agentruntime/claudecode/sessions.go:34`
- `client/octodeck-daemon/internal/agentruntime/codex/sessions.go:34`
- `client/octodeck-daemon/internal/agentruntime/traecli/sessions.go:34`
- `client/octodeck-daemon/internal/agentruntime/traex/sessions.go:34`
- `client/octodeck-daemon/internal/agentruntime/baseagent.go:70`

**建议**

在 `agentruntime` 提供通用 helper：

```go
ListProviderSessions(ctx, cfg, agentClientID, providerDir, workspace)
DeleteProviderSession(ctx, cfg, agentClientID, providerDir, workspace, sessionID)
```

family 只声明 `ProviderDir`。

### 13. 将 session 能力从 `Agent` 强制接口迁移为 optional capability

**定位**

- `client/octodeck-daemon/internal/agentruntime/agent.go:24`
- `client/octodeck-daemon/internal/agentruntime/agent.go:29`
- `client/octodeck-daemon/internal/agentruntime/capabilities_optional.go:23`

**建议**

新增：

```go
type SessionProvider interface {
    ListSessions(...)
    DeleteSession(...)
}
```

`Agent` 主接口只保留核心 run lifecycle。list/delete session 时先判断是否实现 `SessionProvider`。

### 14. `session.Session` 导出字段过多，状态机容易被绕过

**定位**

- `client/octodeck-daemon/internal/session/session.go:21`
- `client/octodeck-daemon/internal/session/session.go:31`
- `client/octodeck-daemon/internal/session/cancel.go:15`
- `client/octodeck-daemon/internal/session/state.go:39`

**建议**

将 `Status`、`ProviderSessionID`、`LastUsedAt` 等改为非导出字段，提供 `Snapshot()`、`CurrentState()`、`SetProviderSessionID()` 等访问器。`RegisterCancel` 应在 session 已 terminal 时拒绝注册新的 cancel。

### 15. 拆分 `state/cache.go` 的不同生命周期职责

**定位**

- `client/octodeck-daemon/internal/state/cache.go:1`
- `client/octodeck-daemon/internal/state/cache.go:26`
- `client/octodeck-daemon/internal/state/cache.go:172`
- `client/octodeck-daemon/internal/state/cache.go:369`

**建议**

按生命周期拆分：

- `internal/runcontext`：placeholder、group folder、workspace shared dir。
- `internal/sessionstore`：provider session metadata list/write/delete。
- `internal/memorysync`：source、poller。
- `internal/state`：只保留 live runtime state，例如 `RunPool`。

### 16. 统一 workspace resolver，避免 command / agent / tool 各自原地修改 request

**定位**

- `client/octodeck-daemon/internal/executor/runner_impl.go:66`
- `client/octodeck-daemon/internal/agentruntime/cwdresolver.go:31`
- `client/octodeck-daemon/internal/executor/tool.go:65`

**建议**

引入统一解析器：

```go
type WorkspaceResolver interface {
    ResolveRun(ctx context.Context, req WorkspaceRequest) (ResolvedWorkspace, error)
}
```

要求输入 request 不被修改，解析结果包含 cwd、shared dir、resolved repos、context、argv 等。command、agent、tool 都使用同一个 resolver。

### 17. 安全策略不要在 executor/tool runner 内重复实现

**定位**

- `client/octodeck-daemon/internal/executor/runner_impl.go:192`
- `client/octodeck-daemon/internal/executor/runner_impl.go:229`
- `client/octodeck-daemon/internal/security/binaries.go:47`
- `client/octodeck-daemon/internal/security/paths.go:103`
- `client/octodeck-daemon/internal/executor/tool_impl.go:241`
- `client/octodeck-daemon/internal/executor/tool_impl.go:377`

**建议**

让 executor 依赖 security 单一入口：

```go
security.ValidateRunRequest(cfg, req)
security.IsRunCwdAllowed(cfg, cwd)
security.IsAllowedBinary(cfg, binary)
security.IsPathAllowedByRoots(path, roots)
```

工具路径策略也收敛到统一 `ToolPolicy` / `PathPolicy`，并明确 `ListDirectories` 是受 allowlist 限制，还是独立 UI browse capability。

### 18. 收敛 `inventory.Snapshot` 兼容壳，资源模型直接归 resources

**定位**

- `client/octodeck-daemon/internal/inventory/snapshot.go:7`
- `client/octodeck-daemon/internal/inventory/snapshot.go:19`
- `client/octodeck-daemon/internal/protocol/frames.go:23`
- `client/octodeck-daemon/internal/protocol/frames.go:45`
- `client/octodeck-daemon/internal/node/heartbeat.go:29`

**建议**

`protocol.HelloFrame.Resources`、`protocol.PingFrame.Resources` 改为 `resources.Snapshot` 或 protocol 内 DTO。`node` 直接依赖 `resources.CollectSnapshot()`。`inventory/snapshot.go` 保留一个迁移周期后删除。

### 19. 为 debug/health 建统一诊断模型

**定位**

- `client/octodeck-daemon/internal/debug/snapshot.go:26`
- `client/octodeck-daemon/internal/debug/health.go:16`
- `client/octodeck-daemon/internal/debug/render.go:23`

**建议**

新增诊断模型：

```go
type DiagnosticSnapshot struct {
    Meta       SnapshotMeta
    Host       HostInfo
    Resources  resources.Snapshot
    Inventory  []inventory.Info
    Sessions   []proto.AgentSessionInfo
    Checks     []HealthCheck
}

type HealthCheck struct {
    Name    string
    Status  string // ok/warn/error
    Message string
    Details map[string]any
}
```

`debug.Healthy` 基于 `[]HealthCheck` 判断，`render.go` 只负责展示。

### 20. 拆分 `mcp/config.go` 的职责

**定位**

- `client/octodeck-daemon/internal/mcp/config.go:19`
- `client/octodeck-daemon/internal/mcp/config.go:98`
- `client/octodeck-daemon/internal/mcp/config.go:150`
- `client/octodeck-daemon/internal/mcp/config.go:187`
- `client/octodeck-daemon/internal/mcp/config.go:253`

**建议**

拆成：

```text
internal/mcp/spec.go
internal/mcp/env.go
internal/mcp/daemon_adapter.go
internal/mcp/argv.go
internal/mcp/installers/trae.go
internal/mcp/installers/codex.go
internal/mcp/installers/global.go
```

同时把“生成配置”和“写文件”拆开，先产出 `ConfigPlan`，再 apply。

### 21. update/service 管理逻辑抽象为 service manager

**定位**

- `client/octodeck-daemon/internal/update/update.go:139`
- `client/octodeck-daemon/internal/update/update.go:212`
- `client/octodeck-daemon/internal/update/uninstall.go:67`

**建议**

抽出：

```go
type Manager interface {
    Restart(ctx context.Context) error
    Stop(ctx context.Context) error
    Remove(ctx context.Context) error
    Installed() bool
}
```

`UpdateBinary` 只调用 `service.Restart()`，`RunUninstallCommand` 只调用 `service.Remove()`。

## P2 / 中长期优化点

### 22. TypeScript 与 Go Agent Link 协议建立单一事实源或 golden tests

**定位**

- `src/agent-link/protocol.ts:10`
- `src/agent-link/protocol.ts:616`
- `client/octodeck-daemon/internal/protocol/frames.go:11`
- `client/octodeck-daemon/internal/protocol/version.go:18`

**建议**

短期添加跨语言 golden tests：

- Go 生成每类 frame JSON，TS `parseInboundFrame` 验证全部通过。
- TS `encodeFrame` 输出由 Go `ParseInbound` 验证通过。

长期可考虑协议 schema/codegen，生成 TS Zod schema、TS types、Go structs、frame constants。

### 23. 统一 AgentClient DTO

**定位**

- `src/agent-link/protocol.ts:330`
- `src/agent-link/protocol.ts:459`
- `src/backends/agent-client-adapter.ts:4`
- `src/types.ts:250`
- `client/octodeck-daemon/internal/agentclient/info.go:12`

**建议**

抽出统一 `AgentClientInfoSchema` / `AgentClientInfo`，让 `HelloFrame.agentClients`、`AgentDiscoverResultFrame.agents`、`AgentLink.agentClients`、`DiscoveredAgentClient` 复用同一类型。

### 24. 统一 AgentRunEventType，避免 TS strict enum 与 Go 自由字符串漂移

**定位**

- `src/agent-link/protocol.ts:404`
- `src/agent-link/protocol.ts:408`
- `client/octodeck-daemon/internal/protocol/frames.go:114`
- `client/octodeck-daemon/internal/agentruntime/acpsupport/bridge.go:50`
- `client/octodeck-daemon/internal/agentruntime/claudecode/output.go:62`

**建议**

daemon 侧定义统一 event type 常量，TS 侧由协议源生成 union。`parseInboundFrame` 对未知 `eventType` 可考虑先接受 string，再在转换层降级为 `log` 或 debug event，避免新 daemon event 导致连接断开。

### 25. `agent-link-driver.ts` 拆分 request builder / event codec / lifecycle

**定位**

- `src/backends/agent-link-driver.ts:57`
- `src/backends/agent-link-driver.ts:466`
- `src/backends/agent-link-driver.ts:918`
- `src/backends/agent-link-driver.ts:1211`
- `src/backends/agent-link-driver.ts:1566`

**建议**

拆成：

- `agent-link-workspace.ts`
- `agent-link-request-builder.ts`
- `agent-run-event-codec.ts`
- `remote-run-lifecycle.ts`

`agent-link-driver.ts` 只保留 orchestration：解析 target、选择 `agent.run` 或 legacy、调用 lifecycle。

### 26. `registry.ts` 拆分 session registry、frame router、runtime-state aggregator

**定位**

- `src/agent-link/registry.ts:64`
- `src/agent-link/registry.ts:221`
- `src/agent-link/registry.ts:252`
- `src/agent-link/registry.ts:339`

**建议**

拆出：

- `agent-link/session-registry.ts`
- `agent-link/frame-router.ts`
- `agent-link/runtime-state.ts`

`runtime-state.ts` 统一处理 `hello.agentClients`、`hello.agentRuntimeCapabilities`、`ping.runningRuns`、`ping.runtimes`、`agent.runtime.status`。

## 建议推进顺序

### 第一阶段：清理 daemon 核心边界

1. 拆薄 `node/wiring.go`。
2. `protocol`、`uplink`、`config` 去除对 inventory runtime model 的依赖。
3. 修正 version 注入链路。

### 第二阶段：收敛 agentruntime 重复

1. ACP glue 抽通用。
2. `RunStdioAgentPrompt` 改 parser 注入。
3. skill scanner、session helper、output parser 收敛。

### 第三阶段：统一执行、安全和 workspace 边界

1. executor cancel 抽象统一。
2. `RunPool` 锁内 cancel 修正。
3. workspace resolver 统一。
4. security/path/tool policy 单一入口。

### 第四阶段：协议和 TS 侧长期治理

1. Agent Link schema/golden tests。
2. `AgentClientInfo` / `AgentRunEventType` DTO 收敛。
3. 拆分 `agent-link-driver.ts` 和 `registry.ts`。

