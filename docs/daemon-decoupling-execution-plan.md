# Daemon Agent Runtime 解耦 - Agent Team 执行计划

## 0. 目标

按 `docs/daemon-agent-runtime-decoupling-plan.md` 第 7 节验收标准，分阶段并行执行六大块解耦改造，最终满足：

- `NewAgent` 是公共代码中**唯一** family 分发点
- 公共层不再导出 `Claude/Codex/Traecli/Traex*ArgvBuilder`、`*PermissionMode`、`*PermissionPrefix`、`ProfileForAgentClient`、`FamilyForClient`、`SpecNormalizeACPServerArgs`、`NewACPConnection`、`ACPConnection`、`NormalizeAgentFamily` 等
- 每个 agent 子包闭环拥有 discovery / descriptor / runtime / stdio / ACP / permission / model / skill / session / MCP 接入 / output parser
- `inventory` 收敛为薄聚合层；新增 `agentclient` 与 `resources` 包
- ACP session map / process pool 迁出共享 state；output parser 按 family 拆分

## 1. 当前关键现状（来自探索）

- 子包目录已搭好（claudecode/codex/traecli/traex 各 9 文件），但**绝大多数是常量/桩**；真实实现仍在公共层。
- 公共层违规集中点：
  - `internal/agentruntime/permission.go`（4 ArgvBuilder + Codex/TraexPermissionMode/Prefix + SpecNormalizeACPServerArgs）
  - `internal/agentruntime/profile.go`（4 ClientProfile + AgentSpecRegistry + ProfileForAgentClient）
  - `internal/agentruntime/metadata.go`（FamilyDisplayName + FamilyForClient）
  - `internal/agentruntime/helpers.go`（NormalizeAgentFamily 转发）
  - `internal/agentruntime/acpconnection.go`（公共 ACPConnection / NewACPConnection）
  - `internal/agentruntime/baseagent.go:64`（依赖 ProfileForAgentClient）
- inventory 集中违规：
  - `agent_clients.go` 内置 supportedAgentClients、4 张能力 map、`NormalizeFamily`
  - `models.go`：`profileFor` switch + 4 family profile + 4 schema 私有解析
  - `skills.go`：`profileSkillDir/Provider` switch + `.claude/skills`/`.trae/skills` 硬编码
- output：`parser.go` 同时解析 Anthropic stream-json / Codex JSONL / TraeCLI / TraeX schema
- state：`acp_processes.go` (813 行) + `session_map.go` 仅服务 ACP；`cache.go:494 memoryPathForClient` 是 family switch
- debug：`debug/health.go:53-57` 含 `NormalizeFamily(...) == "claude"` 特判
- **隐藏 bug**：仓库内零处 `import _ ".../agentruntime/builtinfactories"`，`BuiltinAgentFactories` 实际为空，`NewBuiltinAgent` 落到 `PlainAgent` 兜底。第 1 阶段必须先修复。

## 2. 阶段拆分与依赖

```
阶段 A (基础设施前置)         ┐
  A1 修复 builtinfactories     │
  A2 新建 internal/resources/  │── 并行
  A3 新建 internal/agentclient/┘
        ↓
阶段 B (公共层下沉, 4 family 并行)
  B-claude / B-codex / B-traecli / B-traex
  每条线：argv + permission + descriptor + sessions/profile  ── 并行
        ↓
阶段 C (跨 family 能力下沉, 4 family 并行)
  C-claude / C-codex / C-traecli / C-traex
  每条线：models + skills + output parser + memory path     ── 并行
        ↓
阶段 D (ACP 私有化, 4 family 并行)
  D-claude / D-codex / D-traecli / D-traex
  每条线：自己的 transport_acp 完整实现 + 私有 state         ── 并行
        ↓
阶段 E (公共层清理 + 验收)
  E1 删除 permission.go/profile.go/metadata.go/acpconnection.go 公共 API
  E2 inventory 改写为薄聚合层 + collector 调 agentclient/resources
  E3 output/parser.go 删除多 family 解析；stream.go 接受 parser 注入
  E4 state 删除 acp_processes/session_map（迁出后）
  E5 debug/health.go 删除 family 特判
  E6 全量测试 + grep 验收禁止规则
```

## 3. 角色分配（Agent Team）

由主对话作为 **Coordinator**，使用 TaskCreate 建立任务清单，按阶段分发给 subagent；同一阶段内的并行任务用单个 message 多 Agent 调用。

| 角色 | 职责 | subagent_type |
| --- | --- | --- |
| Coordinator (主) | 维护 TaskList、串联阶段、做 `go build` / `go test` 验收、做 grep 禁止规则验收、跨 family 接口仲裁 | (主对话) |
| Infra Agent | 执行 A1/A2/A3 与 E1-E5 公共层骨架变动 | general-purpose |
| Family Agent ×4 | 各自负责 claude/codex/traecli/traex 在 B/C/D 阶段的全部能力下沉 | general-purpose ×4 |
| Verifier | 在每个阶段结束跑 `go vet`、`go build ./...`、关键单测，并 grep 禁止符号 | general-purpose |

并行约束：
- B/C/D 三阶段内 4 个 family 互不依赖，可在同一 message 中开 4 个 Agent 并行
- 阶段间必须等编译/测试通过再前进；阶段切换由 Coordinator 控制
- 公共接口（如 `agentruntime.Agent` / `agentclient.Descriptor` / `ModelProvider` / `SkillProvider` / `OutputParser`）由 Coordinator 在阶段 A 锁定后下发给 Family Agent，避免冲突

## 4. 详细任务

### 阶段 A：基础设施前置

A1. **修复 builtinfactories 副作用 import**
- 在 `cmd/octodeck-daemon/main.go`（或 `internal/node/wiring.go`）添加 `_ "github.com/.../agentruntime/builtinfactories"`
- 验收：`go build ./...` 通过；`agentruntime.BuiltinAgentFactories` 在运行时非空

A2. **新建 `internal/resources/`**
- 文件：`snapshot.go`（合并 inventory/snapshot.go）/ `cpu.go`（load avg）/ `memory.go`（合并 inventory/resources.go 内存部分）/ `disk.go`（df 解析）
- 暴露：`Snapshot`、`DiskUsage`、`CollectSnapshot()`
- 同步迁移测试 `snapshot_test.go`
- inventory 旧文件保留薄壳临时转发（阶段 E 删除）

A3. **新建 `internal/agentclient/`**
- 文件：`info.go`（迁 `Info`/`RegistryEntry`/`Config`/`ModelInfo`/`SkillInfo`/`SkillsResult`/`SkillsConfig`）/ `descriptor.go`（新 `Descriptor` 类型与 `ModelProvider`/`SkillProvider`/`CapabilityProvider` 可选接口）/ `registry.go`（`Register(Descriptor)` + `RegisteredDescriptors()`）/ `discovery.go`（PATH 扫描 + executable probe + `Discover(descriptors, cfg)`）/ `probe.go`（`DetectVersion`/`NormalizeVersionOutput` 等）
- 暴露与 inventory 现有 API 等价的便利函数，inventory 改成转发，阶段 E 删除
- `agentclient` 不得包含具体 family 列表

A 阶段产物：4 个 Family Agent 后续均消费 `agentclient.Descriptor` 注册形态。

### 阶段 B：argv / permission / descriptor 下沉

每个 family 子包独立完成（Family Agent 并行执行）：

通用模板（以 codex 为例，其他 family 类比）：
1. 在 `agentruntime/codex/` 新增 `permission.go`：迁入 `CodexPermissionMode`，去掉 export（首字母小写或包内可见）
2. 在 `agentruntime/codex/transport_stdio.go` 落地 `buildArgv(req)` 实现，迁入 `CodexArgvBuilder` 内容
3. 在 `agentruntime/codex/discovery.go` 暴露 `Descriptor()`，含 binary 名/versionArgs/permissionModes/capabilities/transport
4. 在 `agentruntime/codex/factory.go` 的 `init()` 改为 `agentclient.Register(Descriptor())` + `agentruntime.RegisterBuiltinFactory(FamilyID, New)`
5. 在 `agentruntime/codex/sessions.go` 实现 `ListSessions/DeleteSession`（接管 BaseAgent 当前依赖 ProfileForAgentClient 的部分）
6. 修改 `agentruntime/codex/runtime.go`：所有 `agentruntime.Codex*` 调用改为本包私有函数

family 一一对应：
- B-claude：迁 `ClaudeArgvBuilder` → `claudecode/transport_stdio.go`，新建 `claudecode/permission.go`（如有），实现 Descriptor + Sessions
- B-codex：见上
- B-traecli：迁 `TraecliArgvBuilder`，新建 Descriptor + Sessions
- B-traex：迁 `TraexArgvBuilder` + `TraexPermissionPrefix`；`CodexPermissionMode` 复用方式 → traex 内部 import codex 子包并调其包内私有 helper（或 traex 自行复制一份）

公共层在阶段 B 暂保留旧函数以避免破坏，B 结束后阶段 E 统一删除。

每条 family 任务结束验收：
- 子包 `go build` 通过
- 子包内不再 import `agentruntime` 的 family-specific symbol（仅依赖公共 BaseAgent / Run / proto）
- `agentruntime.NewAgent` 返回该 family 的实现可被 `agent.Discover/Connect/CreateSession/RunPrompt` 调用（可写 smoke 测试）

### 阶段 C：models / skills / output / memory path 下沉

每个 family 并行完成：
1. **Models**：迁 `inventory/models.go` 中本 family 的 profile + 私有 schema 解析到 `agentruntime/<f>/models.go`，实现 `ListModels(ctx) ([]agentclient.ModelInfo, error)`（即 `ModelProvider` 接口）
2. **Skills**：迁 `inventory/skills.go` 中本 family 的 `profileSkillDir/Provider` + workspace/cli roots 到 `agentruntime/<f>/skills.go`，实现 `ListSkills(ctx, cwd) (agentclient.SkillsResult, error)`（即 `SkillProvider` 接口）
3. **Output**：从 `output/parser.go` 抽出本 family 的 schema 解析到 `agentruntime/<f>/output.go`，实现 `ParseLine(line string) []proto.AgentRunEventFrame`（暂记为 `OutputParser` 接口）
4. **Memory path**：把 `state/cache.go::memoryPathForClient` 中本 family 分支迁到本子包，作为 `MemoryPath(home string) string` 接口实现

公共解析 helper（`firstString` / `findMapDeep` / `usageFromPayload` / `LooksLikeSessionNotification` / `agentBlockPayload`）保留在 `output/`，不绑定 family。

### 阶段 D：ACP 私有化

每个 family 并行完成：
1. 在 `agentruntime/<f>/transport_acp.go` 落地 ACP 实现：
   - 自己持有 `Process` 包装 / `Pool`（可第一版直接复制 `state/acp_processes.go` 中通用部分到本子包，符合 plan §5.5 "允许短期重复代码"）
   - 自己持有 `SessionMap`（仅本 family 的 record；文件名按 `<family>-acp-session-map.json` 隔离）
   - 自己实现 `RunPrompt` 路径：argv 构造 → 启动 → SDKBridge → session create/load/resume → permission request → usage 提取
2. `runtime.go` 删除对 `agentruntime.NewACPConnection` 的引用，改成本包 `runACP(ctx, run)`
3. `SpecNormalizeACPServerArgs` 中本 family 分支迁入子包私有 normalizer（`injectModelArgs`/`injectBypassArgs`/`requiresServeSubcommand`）
4. ACP 通用工具（`IsTransportDisconnect`/`SDKPayload*`/`UsageToMap`/`Permission*`）保留在 `agentruntime/acpsupport/`（新建子目录，公共层但**不含 family 知识**）供四个 family import

### 阶段 E：公共层清理 + 验收

E1. 删除/降级公共 API：
- `internal/agentruntime/permission.go`：删除 `Claude/Codex/Traecli/TraexArgvBuilder`、`CodexPermissionMode`、`TraexPermissionPrefix`、`SpecNormalizeACPServerArgs`、`injectACP*`、`requiresACPServeSubcommand`；保留 `PromptWithSystemContext`、`shouldAutoApprove`、`acpHasConfigOverride`、`specContainsString`。文件可改名为 `runhelpers.go`
- `internal/agentruntime/profile.go`：删除 4 个 ClientProfile + `agentClientProfileFactories` + `ProfileForAgentClient` + `AgentSpecRegistry`（改由各子包自注册）+ `TraeCLIModelCachePaths`/`CodexStyleDefaultModels`（迁子包）
- `internal/agentruntime/metadata.go`：删除 `FamilyDisplayName` 与 `FamilyForClient`，改为通过 `agentclient.Descriptor.DisplayName()` 取
- `internal/agentruntime/helpers.go`：删除 `NormalizeAgentFamily` 转发；调用方改为：使用 descriptor / 在 `factory.go` 单点 normalize
- `internal/agentruntime/acpconnection.go`：删除 `ACPConnection` / `NewACPConnection`；保留必要时迁 `acpsupport/`
- `internal/agentruntime/baseagent.go:64`：删除 `ProfileForAgentClient` 调用，`ProviderDirName` 改成 family 子包重写

E2. **inventory 改薄**：
- 删除 `agent_clients.go` 中 `supportedAgentClients`、能力 map、`supportsEmbeddedACPClientCandidate`、`NormalizeFamily`、`Discover/DiscoverForConfig`，改为 `agentclient.Discover` 调用
- `models.go` / `skills.go` 完全清空（迁完后只剩 deprecated 类型别名，最终删除）
- `collector.go` 改为：`Resources = resources.CollectSnapshot()` + `AgentClients = agentclient.Discover(...)`，仅保留 `Inventory` 聚合 DTO
- 删除 `agent_clients_test.go` 中 family 字面量断言，改测 round-trip

E3. **output 收窄**：
- `parser.go` 删除 4 family schema 解析；保留 `firstString/findMapDeep/usageFromPayload/agentBlockPayload/LooksLikeSessionNotification` 等 generic helper（如不再被通用调用，迁入 `acpsupport/`）
- `stream.go::PumpStdout` 接受 `parser func(string) []proto.AgentRunEventFrame` 由 family agent 注入

E4. **state 清理**：
- 删除 `state/acp_processes.go`、`acp_processes_test.go`、`session_map.go`（已迁子包）
- `cache.go::memoryPathForClient` 删除，改为 `agent.(MemorySource).MemoryPath(home)`
- 保留 `RunPool`、`locks`、`store`

E5. **debug 修复**：
- `debug/health.go:53-57` 删除 `NormalizeFamily == "claude"` 特判，改为通过 descriptor / 可选 `DiagnosticProvider` 接口

E6. **验收 (Verifier)**：
- `go build ./...` & 全量 `go test ./...`（client/octodeck-daemon 模块）
- grep 验证（白名单 = `agentruntime/factory.go` + `agentruntime/<family>/**`）：
  ```
  Grep "case \"claude\"|case \"codex\"|case \"traecli\"|case \"traex\""
  Grep "FamilyClaude|FamilyCodex|FamilyTraecli|FamilyTraex"
  Grep "ClaudeArgvBuilder|CodexArgvBuilder|TraecliArgvBuilder|TraexArgvBuilder"
  Grep "CodexPermissionMode|TraexPermissionPrefix|ProfileForAgentClient"
  Grep "SpecNormalizeACPServerArgs|NewACPConnection|ACPConnection"
  Grep "FamilyForClient|DisplayNameForFamily|NormalizeAgentFamily"
  ```
  公共目录命中条数应为 0
- 跑一次端到端：`octodeck-daemon` 启动 → discovery 出至少 1 个 builtin agent → 提交一个 prompt → ACP & stdio 路径冒烟通过

## 5. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 阶段 A 接口未锁定，B/C 并行 agent 出现冲突 | A 阶段必须由 Coordinator 一次性敲定 `Descriptor`、`ModelProvider`、`SkillProvider`、`OutputParser`、`MemorySource` 接口签名并写入本文件 §6 接口冻结表，B/C/D 严格按此实现 |
| ACP 代码重复导致维护负担 | 阶段 D 共享部分迁入 `agentruntime/acpsupport/`（不含 family），仅协议/session 行为下沉 |
| traex 复用 codex permission 逻辑 | 接受 traex 子包 `import codex` 调用 codex 私有 helper，或 traex 自带副本（plan §5.5 允许） |
| 多 agent 并行修改公共文件冲突 | 阶段 E 集中由 Infra Agent 串行处理；B/C/D 改 family 子包，且 B 阶段保留公共旧函数兼容，避免和子包 PR 冲突 |
| inventory ↔ agentruntime 反向依赖 | 阶段 A 落地 agentclient 后即解除：子包只 import agentclient/proto/state；inventory 反过来 import agentclient |

## 6. 接口冻结（阶段 A 完成后写入此处，B/C/D 必须遵守）

```go
// internal/agentclient/descriptor.go
type Descriptor struct {
    ID, DisplayName, Family, Provider, Transport string
    Binary          string
    SearchDirs      []string   // 不含 PATH 已包含目录
    VersionArgs     []string
    PermissionModes []string
    Capabilities    []string
}

// 各子包在 init 中调用
func Register(d Descriptor)
func RegisteredDescriptors() []Descriptor

// internal/agentruntime/capability.go
type ModelProvider    interface { ListModels(ctx context.Context) ([]agentclient.ModelInfo, error) }
type SkillProvider    interface { ListSkills(ctx context.Context, cwd string) (agentclient.SkillsResult, error) }
type OutputParser     interface { ParseLine(line string) []proto.AgentRunEventFrame }
type MemorySource     interface { MemoryPath(home string) string }
type DiagnosticProvider interface { Health(ctx context.Context) DiagnosticInfo }
```

`agentruntime.Agent` 接口保持 plan §4.1 已定形态。

## 7. 任务清单（TaskCreate 落库）

```
[A1] 修复 builtinfactories 副作用 import
[A2] 新建 internal/resources/ 包并迁移 snapshot/cpu/memory/disk
[A3] 新建 internal/agentclient/ 包并冻结接口（Descriptor/ModelProvider/SkillProvider/OutputParser/MemorySource）
[B-claude] argv+permission+descriptor+sessions 下沉
[B-codex]  argv+permission+descriptor+sessions 下沉
[B-traecli] argv+permission+descriptor+sessions 下沉
[B-traex]   argv+permission+descriptor+sessions 下沉
[C-claude] models+skills+output+memory path 下沉
[C-codex]  ...
[C-traecli] ...
[C-traex]   ...
[D-claude] ACP 私有化（含 acpsupport 抽象）
[D-codex]  ACP 私有化
[D-traecli] ACP 私有化
[D-traex]   ACP 私有化
[E1] 删除公共层 family API（permission/profile/metadata/helpers/acpconnection/baseagent）
[E2] inventory 改写为薄聚合层
[E3] output/parser.go 收窄 + stream.go 注入 parser
[E4] state 删除 ACP 文件 + memoryPathForClient
[E5] debug/health.go 删除 family 特判
[E6] 全量 go test + grep 验收
```

依赖：A* 全部完成 → B 并行 → B 全部通过 → C 并行 → C 全部通过 → D 并行 → D 全部通过 → E 串行
