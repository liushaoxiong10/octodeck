# OctoDeck Daemon Module Split Design

## Goals

This document describes the target module split for `client/octodeck-daemon`.
The goal is to remove the historical `daemonapp` package and make each daemon
capability live behind a clear boundary.

Core principles:

1. `cmd/octodeck-daemon` contains command entry points only.
2. The uplink owns server communication, but never executes work directly.
3. `session` is the daemon's long-lived work context for a platform
   conversation, task, issue run, or similar execution scope.
4. `executor` handles individual requests.
5. `agentruntime` exposes one unified runtime interface. Claude Code, Codex,
   TraeX, and Trae CLI implementations live in separate subpackages.
6. Provider session IDs, such as Claude or Codex `sessionId`, are provider
   metadata inside a daemon `Session`; they are not daemon scheduling objects.

## Target Directory Structure

```text
client/octodeck-daemon/
  cmd/
    octodeck-daemon/
      main.go
      root.go
      debug.go
      runtime.go
      update.go
      version.go
      team_mcp.go

  internal/
    config/
      config.go
      defaults.go
      paths.go
      policy.go

    node/
      node.go
      lifecycle.go
      wiring.go
      signals.go
      reconnect.go
      heartbeat.go

    uplink/
      client.go
      url.go
      handshake.go
      sender.go
      receiver.go
      dispatcher.go
      handlers.go

    protocol/
      frames.go
      encode.go
      decode.go
      version.go

    session/
      manager.go
      session.go
      key.go
      state.go
      metadata.go
      events.go
      cancel.go
      pool.go

    executor/
      executor.go
      command.go
      tool.go
      agent.go
      maintenance.go

    agentruntime/
      runtime.go
      factory.go
      registry.go
      capability.go
      events.go
      errors.go
      permission.go
      metadata.go

      claudecode/
        runtime.go
        discovery.go
        run.go
        models.go
        skills.go
        sessions.go
        transport_stdio.go
        transport_acp.go

      codex/
        runtime.go
        discovery.go
        run.go
        models.go
        skills.go
        sessions.go
        transport_stdio.go
        transport_acp.go

      traex/
        runtime.go
        discovery.go
        run.go
        models.go
        skills.go
        sessions.go
        transport_stdio.go

      traecli/
        runtime.go
        discovery.go
        run.go
        models.go
        skills.go
        sessions.go
        transport_stdio.go

    inventory/
      snapshot.go
      resources.go
      agent_clients.go
      models.go
      skills.go
      collector.go

    workspace/
      workspace.go
      cwd.go
      repo.go
      cleanup.go
      names.go
      uri.go
      roots.go

    security/
      binaries.go
      env.go
      paths.go
      tools.go
      permissions.go
      limits.go

    state/
      store.go
      runtime_state.go
      session_map.go
      acp_processes.go
      locks.go
      cache.go

    debug/
      snapshot.go
      render.go
      commands.go
      health.go

    update/
      update.go
      uninstall.go
      install_script.go

    mcp/
      config.go
      agent_team.go

    output/
      parser.go
      stream.go
```

## Module Responsibilities

### `cmd/octodeck-daemon`

Command entry layer.

Responsibilities:

- `main`
- subcommand dispatch
- flag parsing
- stdout and stderr output
- invoke `node`, `debug`, `update`, and runtime command entry points

Commands:

```text
octodeck-daemon
octodeck-daemon debug
octodeck-daemon agent-runtime
octodeck-daemon mcp-agent-team
octodeck-daemon update
octodeck-daemon uninstall
octodeck-daemon version
```

This layer must not contain WebSocket handling, task execution, workspace
resolution, agent provider logic, or protocol frame business handling.

### `internal/config`

Configuration parsing layer.

Responsibilities:

- read config files
- apply defaults
- expand paths
- parse server, link ID, token, version, and update settings
- parse allowed binaries and allowed roots
- parse runtime policy
- parse configured agent clients

This package produces a stable `Config` value. It should not start services,
open links, or execute discovery.

### `internal/node`

Main daemon orchestration layer.

Responsibilities:

- initialize configuration
- initialize state, session manager, uplink, inventory, and executors
- start the server uplink
- own reconnect strategy
- handle OS signals
- perform graceful shutdown
- aggregate heartbeat payloads
- wire module dependencies

This package replaces the orchestration role previously held by `daemonapp`.
It should coordinate modules but avoid embedding domain logic from agent
providers, command execution, or tool execution.

### `internal/uplink`

Server communication layer.

Responsibilities:

- WebSocket dial
- URL construction
- hello and hello_ack handshake
- heartbeat sending
- inbound frame reading
- outbound frame serialization
- send queue ownership
- fatal error and reconnect signaling
- dispatch server messages to the configured dispatcher

The uplink must not directly execute `run.request`, `agent.run.request`, or
`tool.request`. It only transports and dispatches protocol frames.

### `internal/protocol`

Wire protocol layer.

Responsibilities:

- frame type definitions
- payload structs
- encode and decode
- protocol versioning
- compatibility with the TypeScript server protocol

This package is the daemon/server contract.

### `internal/session`

Daemon session layer.

A `Session` is the daemon's long-lived work context. It corresponds to a
platform conversation stream, task, issue run, or other sustained execution
scope.

Responsibilities:

- resolve a session key from conversation, task, run, or execution scope
- create, find, close, and garbage collect sessions
- keep the session's unique backend
- keep the session's unique workspace and cwd
- hold the session's unique `agentruntime.Runtime` instance
- store provider session metadata
- track cancellation and running requests
- expose status snapshots
- emit events and results to the outside world

Terminology:

- **Session** means daemon session.
- **Provider Session** means an agent provider's own session ID, such as a
  Claude, Codex, or ACP session ID. Provider sessions are metadata inside a
  daemon Session and are not top-level daemon scheduling objects.

### `internal/executor`

Single-request execution layer.

Responsibilities:

- `command.go`: execute `run.request`
- `tool.go`: execute `tool.request`
- `agent.go`: execute `agent.run.request`
- `maintenance.go`: execute maintenance requests such as workspace cleanup,
  memory sync, or update requests

Executors may be invoked by a Session, but they do not own long-lived daemon
context.

### `internal/agentruntime`

Unified agent runtime abstraction.

Responsibilities:

- define the unified `Runtime` interface
- define capability, model, skill, run input, run result, event, and permission
  types
- create concrete runtimes from backend or family configuration
- maintain the provider registry

Upper layers depend on this package's interface and do not need to know whether
the implementation is Claude Code, Codex, TraeX, or Trae CLI.

Illustrative interface:

```go
type Runtime interface {
	ID() string
	BackendID() string
	Family() Family

	Discover(ctx context.Context) (Capability, error)
	Connect(ctx context.Context) error
	Run(ctx context.Context, input RunInput) (RunResult, error)
	Models(ctx context.Context) ([]Model, error)
	Skills(ctx context.Context) ([]Skill, error)
	Close(ctx context.Context) error
}
```

Provider implementations:

- `internal/agentruntime/claudecode`
- `internal/agentruntime/codex`
- `internal/agentruntime/traex`
- `internal/agentruntime/traecli`

Each provider package owns:

- agent discovery
- runtime connection
- prompt execution
- provider session metadata parsing
- model discovery
- skill discovery
- transport adapters such as stdio, ACP, HTTP, or A2A

Provider packages must not import `session`, `uplink`, or `node`. Events should
flow through injected interfaces.

### `internal/inventory`

Device information and capability inventory layer.

Responsibilities:

- CPU, memory, and disk snapshots
- OS, arch, and hostname
- daemon version
- running run summaries
- local agent client discovery
- agent runtime capability snapshots
- model snapshots
- skill snapshots

Inventory can aggregate multiple collectors, but collectors should remain
independent. Resource collection should not directly drive complex agent
execution.

### `internal/workspace`

Workspace and filesystem layer.

Responsibilities:

- workspace, session, task, and tmp directories
- cwd resolution
- managed URI resolution
- repository checkout and reuse
- workspace cleanup
- group folder naming
- session and task scoped paths
- path normalization

Command, tool, and agent execution should all use this package for cwd and
workspace rules instead of implementing path behavior independently.

### `internal/security`

Security policy layer.

Responsibilities:

- binary allowlist
- root allowlist
- path guard
- dangerous environment key filtering
- tool allow and deny policies
- permission policy
- timeout, output, and concurrency limits

This is the local execution node's security boundary and should remain easy to
audit.

### `internal/state`

Local state layer.

Responsibilities:

- volatile running state
- persisted metadata
- provider session maps
- ACP process maps
- locks
- cache metadata
- memory sync cursors

`session` may depend on this package to persist metadata. `state` should avoid
knowing uplink frame details.

### `internal/debug`

Diagnostics layer.

Responsibilities:

- collect daemon snapshots
- render debug status
- render JSON output
- show config summaries
- show uplink state
- show daemon sessions
- show provider sessions
- show runtime capabilities
- show ACP mappings and live processes
- show workspace and state paths

Debug code should be read-only with respect to normal business flow.

### `internal/update`

Update and uninstall layer.

Responsibilities:

- daemon update
- graceful update
- uninstall
- install script logic
- version comparison

### `internal/mcp`

MCP-related capabilities.

Responsibilities:

- agent team MCP server
- MCP config generation
- MCP argument preparation for agent runs

### `internal/output`

Output parsing and streaming layer.

Responsibilities:

- agent stream parsing
- stdout and stderr event conversion
- max output caps
- structured output parsing

## Execution Flows

### Main Flow

```text
cmd/octodeck-daemon
  -> node.Start
    -> config.Load
    -> node wiring
    -> uplink.Connect
      -> hello / heartbeat
      -> receive frame
        -> uplink.Dispatch
          -> session.Manager get/create Session
            -> executor handles request
              -> command executor
              -> tool executor
              -> agent executor
                -> session.Runtime.Run
                  -> agentruntime.Runtime implementation
            -> session emits events/results
          -> uplink.Send
```

### `agent.run.request`

```text
server
  -> uplink receives agent.run.request
  -> session.Manager resolves Session key
  -> Session owns cwd/backend/runtime
  -> executor/agent invokes Session runtime
  -> agentruntime factory creates claudecode/codex/traex/traecli runtime if needed
  -> runtime runs prompt
  -> provider session ID saved as metadata
  -> events/results sent through uplink
```

### `run.request`

```text
server
  -> uplink receives run.request
  -> session.Manager resolves Session
  -> executor/command resolves cwd through workspace
  -> security validates binary/env/path/limits
  -> command executes
  -> output emits run.event
  -> result emits run.result
```

### `tool.request`

```text
server
  -> uplink receives tool.request
  -> session.Manager resolves Session
  -> executor/tool normalizes cwd
  -> security validates path/tool policy
  -> tool executes Read/Write/Edit/LS/Bash/etc
  -> result emits tool.result
```

## Dependency Direction

Preferred dependency direction:

```text
cmd
  -> node
    -> config
    -> uplink
    -> session
      -> executor
      -> agentruntime
    -> inventory
    -> workspace
    -> security
    -> state
```

Provider implementations should stay below the runtime interface:

```text
session
  -> agentruntime
    -> agentruntime/claudecode
    -> agentruntime/codex
    -> agentruntime/traex
    -> agentruntime/traecli
```

Avoid these reverse dependencies:

- provider implementation -> `session`
- provider implementation -> `uplink`
- provider implementation -> `node`
- `uplink` -> concrete executors
- `config` -> runtime execution or discovery

## Boundary Summary

```text
cmd is the entry layer.
node is the main lifecycle and wiring layer.
uplink is server communication.
session is the long-lived daemon work context.
executor is single-request execution.
agentruntime is the unified agent instance abstraction.
workspace, security, state, inventory, debug, update, mcp, and output are
supporting capabilities.
```
