# Agent Link Protocol (v1)

Server ↔ octodeck-daemon client 之间的 WebSocket 协议规范。

每帧 = 单行 UTF-8 JSON（不允许内嵌换行），通过 ws text frame 传输。
连接路径：`/api/agent-link/ws`，client 出站连接，握手 header `X-Link-Token: <plain token>`。

## 顶层字段

每帧必含 `type`。请求 / 响应类帧含 `id`（client 自增整数，server 仅在响应该 id 时镜像它）。

## 握手 / 保活

### `hello` (C→S)
Client 在 ws 建立后第一帧发送（5 秒内必须发，否则 server 关闭）。

```json
{
  "type": "hello",
  "id": 1,
  "version": "0.1.0",
  "os": "darwin",
  "arch": "arm64",
  "hostname": "my-mac",
  "capabilities": ["link.v1"]
}
```

字段：
- `version` — client 二进制版本（octodeck-daemon 自报）
- `os` / `arch` — runtime 平台
- `hostname` — 主机名（仅展示用途，不参与鉴权）
- `capabilities[]` — client 能力声明。`link.v1` 必填（基础协议）；后续可加 `host-cli`、`container`、`sdk-runner`

校验失败时 server 回 `error` 并 close。

### `hello_ack` (S→C)
Server 在 `hello` 校验通过后立即回。

```json
{
  "type": "hello_ack",
  "id": 1,
  "clientId": "cl_abcdef0123456789",
  "displayName": "我的 MacBook",
  "serverVersion": "0.42.0",
  "heartbeatIntervalMs": 30000
}
```

### `ping` (C→S)
Client 每 `heartbeatIntervalMs` 毫秒发一次。Server 不回复，仅刷新 `last_seen_at`。
连续 2 个心跳周期（默认 60s）没收到任何帧 → server 主动 close。

```json
{ "type": "ping", "id": 17 }
```

## 命令执行（Phase 5.2）

### `run.request` (S→C)
Server 在接到 group run 时下发。

```json
{
  "type": "run.request",
  "id": 42,
  "runId": "run_8a3f1c2e7d6b4a90",
  "backendId": "coco",
  "binary": "/usr/local/bin/coco",
  "argv": ["-p", "<rendered prompt>", "--output-format=stream-json", "-y"],
  "cwd": "/Users/lsx/code/proj",
  "env": { "FOO": "bar" },
  "outputProtocol": "jsonline-stream-json",
  "timeoutMs": 1800000,
  "maxOutputBytes": 10485760
}
```

约束：
- `binary` 必须是绝对路径，且 client 端 `allowedBinaries` 白名单内
- `argv` 已由 server 渲染完成（占位符 `{prompt}` `{cwd}` 等都已替换）
- `env` 不含 server 进程环境变量；client 用 `process.env ⨁ env` 启动子进程
- `cwd` 必须是 client 上真实存在的绝对路径
- `outputProtocol` ∈ {`jsonline-stream-json`, `plain-text`}

### `run.event` (C→S, 流式)
Client 收到 stdout/stderr 时按行/按 chunk 推送。

```json
{ "type": "run.event", "runId": "run_xxxx", "stream": "stdout", "data": "..." }
{ "type": "run.event", "runId": "run_xxxx", "stream": "stderr", "data": "..." }
```

`data` 是 raw 文本（client 不做 stream-json 解析，由 server 端按 outputProtocol 处理）。

### `run.result` (C→S, 终结)
进程结束（正常退出 / 信号 / 超时）时发一次，之后该 runId 不应再出现。

```json
{
  "type": "run.result",
  "runId": "run_xxxx",
  "exitCode": 0,
  "signal": null,
  "timedOut": false,
  "durationMs": 12345
}
```

### `run.cancel` (S→C)
用户中断、group 被删除、连接将关闭等场景下发。Client 收到后立刻 SIGTERM，2s 后 SIGKILL，最后再发 `run.result(timedOut=false, signal='SIGTERM')`。

```json
{ "type": "run.cancel", "runId": "run_xxxx", "reason": "user_abort" }
```

`reason` ∈ {`user_abort`, `server_shutdown`, `link_replaced`, `timeout`, `group_deleted`}.

## 错误帧

```json
{
  "type": "error",
  "id": 42,
  "code": "invalid_token",
  "message": "token revoked",
  "fatal": true
}
```

- 双向可发；`fatal: true` 表示发送方将立刻 close ws
- 常见 `code`：
  - `invalid_token` / `link_revoked` (S→C, fatal)
  - `link_replaced` (S→C, fatal) — 同 linkId 的新连接抢占
  - `hello_timeout` (S→C, fatal)
  - `unknown_run` (双向) — 未注册的 runId
  - `binary_denied` (C→S) — binary 不在白名单
  - `cwd_missing` (C→S) — cwd 不存在
  - `concurrency_limit` (C→S) — 已达 `maxConcurrentRuns`
  - `protocol_violation` (双向, fatal)

## 鉴权

1. Client 连接时 header 带 `X-Link-Token: <plain token>`
2. Server 用 bcrypt.compare 在 `agent_links` 表查匹配（仅 `revoked_at IS NULL`）
3. 找不到 → 401 关闭，找到 → 接受 ws 等待 `hello`
4. 同 linkId 旧连接被踢（发 `error.link_replaced` 后 close）

## 速率限制 / 并发

- 单 IP ws 握手 5/min（沿用现有限速基础设施）
- 每个 link 同时进行的 run 数由 client `maxConcurrentRuns` 限制；超限 client 直接回 `error.concurrency_limit`，server 立刻把对应 run 标记失败

## 兼容性

- 帧的未知字段一律忽略（双端）
- 未知 `type` 一律忽略 + 打 warn 日志
- 协议升级走 `capabilities[]`：v1 client 永远不会收到非 v1 帧
