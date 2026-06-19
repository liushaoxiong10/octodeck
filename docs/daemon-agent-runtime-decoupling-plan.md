# Daemon AgentRuntime 解耦规划

## 1. 核心目标

`agentruntime` 是 daemon 内部对外调用 agent 能力的唯一入口。

外部模块只能依赖 `agentruntime` 暴露的统一接口和协议，不能直接调用具体 agent package。

目标调用方向：

```text
node / executor / debug / 其他 daemon 模块
  -> agentruntime
    -> agentruntime/{claudecode,codex,traecli,traex}
```

不允许：

```text
node / executor / debug / 其他 daemon 模块
  -> agentruntime/claudecode
  -> agentruntime/codex
  -> agentruntime/traecli
  -> agentruntime/traex
```

也不允许具体 agent 反向调用 `agentruntime` 的运行 helper / factory / registry。

为了避免具体 agent 依赖 `agentruntime` 造成循环依赖，运行协议相关的结构单独下沉到：

```text
internal/agentprotocol
```

`Agent` interface 仍然留在 `agentruntime`，因为它是 runtime facade 对外管理 agent 的抽象；具体 agent 不需要 import 这个 interface 名称也能隐式实现它。

核心原则：

1. `agentruntime` 只定义统一入口、接口、协议、调度门面。
2. `agentprotocol` 只定义 runtime 与 agent 共同使用的运行协议结构。
3. 具体 agent 保持当前目录结构：`agentruntime/{claudecode,codex,traecli,traex}`。
4. 每个 agent 在自己的目录内实现完整能力闭环。
5. `NewAgent` / factory resolution 是唯一 family 分发点。
6. 不再存在共享 `acpsupport`。
7. 不再存在公共 ACP / stdio / permission / output parser 实现供多个 agent 复用。

## 2. 目标目录结构

保持当前具体 agent 目录层级，不迁入 nested `internal`：

```text
client/octodeck-daemon/internal/agentruntime/
  agent.go
  baseagent.go
  factory.go
  child.go
  supervisor.go
  runtime.go
  capability.go
  validation.go
  env.go
  errors.go
  discovery.go
  models.go
  skills.go

  claudecode/
    factory.go
    runtime.go
    descriptor.go
    discovery.go
    models.go
    skills.go
    sessions.go
    stdio.go
    acp.go
    permission.go
    output.go

  codex/
    factory.go
    runtime.go
    descriptor.go
    discovery.go
    models.go
    skills.go
    sessions.go
    stdio.go
    acp.go
    permission.go
    output.go

  traecli/
    factory.go
    runtime.go
    descriptor.go
    discovery.go
    models.go
    skills.go
    sessions.go
    stdio.go
    acp.go
    permission.go
    output.go

  traex/
    factory.go
    runtime.go
    descriptor.go
    discovery.go
    models.go
    skills.go
    sessions.go
    stdio.go
    acp.go
    permission.go
    output.go
```

新增运行协议包：

```text
client/octodeck-daemon/internal/agentprotocol/
  run.go
  permission.go
  events.go
```

其中：

- `agentruntime` 可以依赖 `agentprotocol`。
- 具体 agent 可以依赖 `agentprotocol`。
- 具体 agent 不应该依赖 `agentruntime`。

明确不应存在：

```text
agentruntime/acpsupport/
agentruntime/builtinfactories/
```

说明：

- `acpsupport/` 不应该存在。ACP 连接方式是具体 agent 的协议能力，应分别在 `claudecode` / `codex` / `traecli` / `traex` 中实现。
- `builtinfactories/` 不应该作为额外目录存在。内置 agent 的注册/分发逻辑应收敛到 `agentruntime/factory.go` 或同级文件中，对外仍然只表现为 `agentruntime` 的统一入口。

## 3. `agentruntime` 的职责

`agentruntime` 是 facade / gateway，不是具体 agent 能力实现层。

它负责：

- 定义统一 `Agent` 接口。
- 使用 `agentprotocol.RunContext` 作为统一运行上下文。
- 定义 runtime child / supervisor 协议。
- 定义 agent run request / result / event / permission decision 的交互协议。
- 提供外部调用 agent 能力的统一入口。
- 在 `NewAgent` / factory resolution 中选择具体 agent。
- 组装 runtime capability / runtime status。
- 转发 discover / run / sessions / models / skills 等请求到具体 agent。

它不负责：

- ACP 连接实现。
- stdio argv 构造。
- permission mode 到具体 CLI / ACP 参数的映射。
- output schema parser。
- model discovery 的具体逻辑。
- skill discovery 的具体逻辑。
- session provider directory 规则。
- 除 `NewAgent` 外的 family 分支。

`agentruntime` 中保留：

- `Agent` interface。
- factory / registry / `NewAgent`。
- supervisor / child server。
- 对外 facade 函数。

`agentruntime` 中不保留：

- `RunContext` 的具体定义。
- `PermissionWaiter` 的具体定义。
- `EventEmitter` 的具体定义。

这些运行协议结构迁移到 `agentprotocol`。

## 4. `agentprotocol` 的职责

`agentprotocol` 是 runtime 与具体 agent 的共同底层依赖。

它只定义运行协议结构，不创建 agent、不调度 agent、不包含 family 分支。

它应该包含：

```go
type RunContext struct {
    Permission PermissionWaiter
    Out        io.Writer
    Cfg        *config.Config
    Client     agentclient.Info
    Req        *proto.AgentRunRequestFrame
    Cwd        string
    Started    time.Time
    Emit       EventEmitter
}
```

```go
type PermissionWaiter interface {
    AwaitPermissionDecision(ctx context.Context, runID, requestID string, timeout time.Duration) (proto.AgentPermissionDecisionFrame, error)
}
```

```go
type EventEmitter func(proto.AgentRunEventFrame)
```

`agentprotocol` 不应该包含：

- `Agent` interface。
- `NewAgent`。
- factory / registry。
- runtime supervisor / child server。
- ACP / stdio 实现。
- permission mode 映射。
- output parser。
- 任何 family 分支。

依赖方向：

```text
agentruntime -> agentprotocol
agentruntime/{claudecode,codex,traecli,traex} -> agentprotocol
```

禁止：

```text
agentprotocol -> agentruntime
```

## 5. 统一接口

外部模块只依赖 `agentruntime` 定义的接口。

示意：

```go
type Agent interface {
    Discover(ctx context.Context) agentclient.Info
    Connect(ctx context.Context, run *agentprotocol.RunContext) error
    CreateSession(ctx context.Context, run *agentprotocol.RunContext) error
    RunPrompt(ctx context.Context, run *agentprotocol.RunContext) (proto.AgentRunResultFrame, error)
    ListSessions(ctx context.Context, cfg *config.Config, workspace string) ([]proto.AgentSessionInfo, error)
    DeleteSession(ctx context.Context, cfg *config.Config, workspace, sessionID string) (bool, error)
}
```

可选能力通过接口表达，而不是通过 family 判断：

```go
type ModelProvider interface {
    ListModels(ctx context.Context) ([]agentclient.ModelInfo, error)
}

type SkillProvider interface {
    ListSkills(ctx context.Context, cwd string) (agentclient.SkillsResult, error)
}

type DescriptorProvider interface {
    Descriptor() agentclient.Descriptor
}

type OutputParser interface {
    ParseLine(line string) []proto.AgentRunEventFrame
}
```

允许：

```go
if provider, ok := agent.(ModelProvider); ok {
    return provider.ListModels(ctx)
}
```

禁止：

```go
switch family {
case "claude":
case "codex":
case "traecli":
case "traex":
}
```

`Agent` interface 不放入 `agentprotocol`，而是留在 `agentruntime`。

原因：

- `Agent` 是 `agentruntime` facade 管理具体 agent 的抽象。
- Go interface 是隐式实现的，具体 agent 不需要 import `agentruntime.Agent`。
- 具体 agent 只需要使用 `agentprotocol.RunContext` 等底层协议类型即可。

## 6. 具体 agent 的职责

每个具体 agent 目录必须自闭环实现自己的能力。

例如 `agentruntime/codex` 自己负责：

- Codex descriptor。
- Codex discovery。
- Codex stdio 运行方式。
- Codex ACP 连接方式。
- Codex permission 映射。
- Codex model discovery。
- Codex skill discovery。
- Codex session list / delete。
- Codex MCP 接入方式。
- Codex output parser。
- Codex embedded adapter 配置。

其他 agent 同理：

```text
agentruntime/claudecode
agentruntime/codex
agentruntime/traecli
agentruntime/traex
```

具体 agent 可以暴露给 `agentruntime` 使用的构造能力，例如：

```go
func New(client agentclient.Info, entry *config.AgentRegistryEntry) agentruntime.Agent
func Descriptor() agentclient.Descriptor
```

但这些不是外部模块 API。外部模块不得直接调用。

具体 agent 的方法签名应依赖 `agentprotocol`，而不是依赖 `agentruntime` 的运行结构：

```go
func (a *Agent) RunPrompt(ctx context.Context, run *agentprotocol.RunContext) (proto.AgentRunResultFrame, error)
```

不应该是：

```go
func (a *Agent) RunPrompt(ctx context.Context, run *agentruntime.Run) (proto.AgentRunResultFrame, error)
```

## 7. NewAgent 是唯一 family 分发点

允许在 `agentruntime` 内部根据 family 选择具体 agent。

示意：

```go
func NewAgent(client agentclient.Info, entry *config.AgentRegistryEntry) Agent {
    switch client.Family {
    case "claude":
        return claudecode.New(client, entry)
    case "codex":
        return codex.New(client, entry)
    case "traecli":
        return traecli.New(client, entry)
    case "traex":
        return traex.New(client, entry)
    default:
        return custom.New(client, entry)
    }
}
```

也可以使用 map registry：

```go
if factory := builtinFactories[client.Family]; factory != nil {
    return factory(client, entry)
}
```

关键约束：

> family 分发只能发生在 `agentruntime` 内部的 `NewAgent` / factory resolution。

## 8. Agent 不反向调用 runtime helper

具体 agent package 可以实现 `agentruntime.Agent`，但不应该调用 `agentruntime` 的运行 helper、factory 或 registry。

禁止具体 agent 调用：

```text
agentruntime.RunDirectAgentPrompt
agentruntime.RunStdioAgentPrompt
agentruntime.NewAgent
agentruntime.BuildAgents
agentruntime.BuiltinAgentFactories
agentruntime.RegisterBuiltinFactory
agentruntime.NewACPConnection
agentruntime/acpsupport
```

具体 agent 也不应 import `agentruntime` 来获得 `Run`、`PermissionWaiter`、`EventEmitter` 等结构；这些都应来自 `agentprotocol`。

如果 agent 需要运行 stdio 或 ACP，应该在自己的目录内实现。

如果多个 agent 有相似逻辑，优先允许重复，而不是抽成共享协议 skeleton。

## 9. ACP 边界

ACP 是具体 agent 的协议能力，不是公共 runtime 能力。

目标：

- 删除公共 `agentruntime.ACPConnection`。
- 删除 `agentruntime/acpsupport/`。
- 不再有共享 ACP connection skeleton。
- 不再有共享 ACP session map。
- 不再有共享 ACP process pool。

每个 agent 自己实现 ACP：

```text
agentruntime/claudecode/acp.go
agentruntime/codex/acp.go
agentruntime/traecli/acp.go
agentruntime/traex/acp.go
```

每个 agent 的 ACP 实现自己拥有：

- process lifecycle。
- session create / load / resume。
- session key / persistence。
- retry / reconnect。
- permission bridge。
- MCP server injection。
- prompt wrapping。
- usage extraction。
- embedded adapter integration。

## 10. Stdio 边界

stdio 是具体 agent 的运行方式。

每个 agent 自己负责：

- argv construction。
- permission mode -> CLI flags。
- system prompt injection。
- MCP config integration。
- process / pipe lifecycle。
- stdout parser。
- stderr parser。

`agentruntime` 不提供共享 stdio runner 供 agent 反向调用。

## 11. Output 边界

具体 output parser 归具体 agent。

```text
agentruntime/claudecode/output.go
agentruntime/codex/output.go
agentruntime/traecli/output.go
agentruntime/traex/output.go
```

`agentruntime` 可以定义事件协议，但不解析具体 agent 的输出 schema。

## 12. Models / Skills 边界

models / skills 是 agent 能力。

外部调用统一走：

```go
agentruntime.ListModels(ctx, providerID)
agentruntime.ListSkills(ctx, providerID, cwd)
```

`agentruntime` 内部通过能力接口分发：

```go
provider, ok := agent.(ModelProvider)
provider, ok := agent.(SkillProvider)
```

具体实现留在：

```text
agentruntime/claudecode/models.go
agentruntime/codex/models.go
agentruntime/traecli/models.go
agentruntime/traex/models.go

agentruntime/claudecode/skills.go
agentruntime/codex/skills.go
agentruntime/traecli/skills.go
agentruntime/traex/skills.go
```

## 13. 禁止规则

除 `agentruntime` 内部的 `NewAgent` / factory resolution 和具体 agent package 外，公共代码禁止出现：

```text
case "claude"
case "codex"
case "traecli"
case "traex"

== "claude"
== "codex"
== "traecli"
== "traex"
```

外部模块禁止 import：

```text
internal/agentruntime/claudecode
internal/agentruntime/codex
internal/agentruntime/traecli
internal/agentruntime/traex
```

具体 agent package 禁止依赖：

```text
agentruntime/acpsupport
agentruntime.Run
agentruntime.PermissionWaiter
agentruntime.EventEmitter
```

具体 agent package 应依赖：

```text
agentprotocol.RunContext
agentprotocol.PermissionWaiter
agentprotocol.EventEmitter
```

## 14. 验收标准

改造完成时应满足：

1. `agentruntime` 是外部调用 agent 能力的唯一入口。
2. 外部模块不直接 import 具体 agent package。
3. `NewAgent` / factory resolution 是唯一 family 分发点。
4. 具体 agent package 不调用 `agentruntime` runner/helper/factory/registry。
5. 具体 agent package 不依赖 `agentruntime.Run` / `agentruntime.PermissionWaiter` / `agentruntime.EventEmitter`，而是依赖 `agentprotocol`。
6. `Agent` interface 留在 `agentruntime`，不迁入 `agentprotocol`。
7. 不存在 `agentruntime/acpsupport/`。
8. 不存在公共 `ACPConnection`。
9. 不存在 `agentruntime/builtinfactories/`。
10. 每个 agent 自己实现 ACP / stdio / permission / model / skill / session / output parser。
11. 搜索公共包中的具体 family branch，不应在非允许位置出现生产代码匹配。

## 15. 总结

最终边界一句话：

> 外部只调用 `agentruntime`；`agentruntime` 内部通过 `NewAgent` 选择具体 agent；`Agent` interface 留在 `agentruntime`；运行协议结构下沉到 `agentprotocol`；具体 agent 在自己的目录内实现所有协议和能力，不共享 ACP / stdio / output / permission 等行为实现，也不反向调用 runtime helper。
