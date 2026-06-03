/**
 * Agent Link wire protocol — frames, schemas, type guards.
 *
 * 与 docs/agent-link-protocol.md 对齐。所有帧都是单行 JSON 文本。
 * Phase 5.1 真正用到的是 hello / hello_ack / ping / error；
 * run.* 一组在 5.2 接入，但 schema 这里就先定义好。
 */
import { z } from 'zod';

export const ResourceSnapshotSchema = z.object({
  cpuCount: z.number().int().nonnegative().optional(),
  cpuUsedPercent: z.number().min(0).max(100).optional(),
  load1: z.number().nonnegative().optional(),
  load5: z.number().nonnegative().optional(),
  load15: z.number().nonnegative().optional(),
  memoryTotalBytes: z.number().nonnegative().optional(),
  memoryUsedBytes: z.number().nonnegative().optional(),
  memoryUsedPercent: z.number().min(0).max(100).optional(),
  diskTotalBytes: z.number().nonnegative().optional(),
  diskUsedBytes: z.number().nonnegative().optional(),
  diskUsedPercent: z.number().min(0).max(100).optional(),
  collectedAt: z.string().max(64).optional(),
});
export type ResourceSnapshot = z.infer<typeof ResourceSnapshotSchema>;

export const RunningRunSchema = z.object({
  runId: z.string().min(1).max(128),
  backendId: z.string().min(1).max(128).optional(),
  cwd: z.string(),
  status: z
    .enum(['accepted', 'started', 'running', 'completed', 'failed'])
    .optional(),
  startedAt: z.string().max(64).optional(),
  lastActivityAt: z.string().max(64).optional(),
});
export type RunningRun = z.infer<typeof RunningRunSchema>;

export const RuntimeStatusSchema = z.object({
  runtimeId: z.string().min(1).max(256),
  deviceLinkId: z.string().min(1).max(128),
  agentClientId: z.string().min(1).max(128),
  displayName: z.string().max(128).optional(),
  status: z.enum(['idle', 'busy', 'draining', 'offline']),
  maxConcurrentRuns: z.number().int().nonnegative().optional(),
  runningRuns: z.array(RunningRunSchema).max(128).optional(),
  availableSlots: z.number().int().nonnegative().optional(),
});
export type RuntimeStatus = z.infer<typeof RuntimeStatusSchema>;

export const RuntimeCapabilitySchema = z.object({
  runtimeId: z.string().min(1).max(256),
  agentId: z.string().min(1).max(128),
  provider: z.string().max(128).optional(),
  transport: z.enum(['stdio', 'a2a', 'http']).optional(),
  features: z.array(z.string().max(64)).max(64).optional(),
  permissionModes: z.array(z.string().max(64)).max(32).optional(),
  allowedWorkspaces: z.array(z.string().max(4096)).max(128).optional(),
  allowedTools: z.array(z.string().max(256)).max(256).optional(),
  disallowedTools: z.array(z.string().max(256)).max(256).optional(),
  toolPolicy: z.record(z.string(), z.string()).optional(),
  maxConcurrentRuns: z.number().int().nonnegative().optional(),
  availableSlots: z.number().int().nonnegative().optional(),
});
export type RuntimeCapability = z.infer<typeof RuntimeCapabilitySchema>;

// ─── Outgoing (S→C) ──────────────────────────────────────────

export const HelloAckFrame = z.object({
  type: z.literal('hello_ack'),
  id: z.number().int().nonnegative(),
  clientId: z.string(),
  displayName: z.string(),
  serverVersion: z.string(),
  heartbeatIntervalMs: z.number().int().positive(),
});
export type HelloAckFrame = z.infer<typeof HelloAckFrame>;

export const RunRequestFrame = z.object({
  type: z.literal('run.request'),
  id: z.number().int().nonnegative(),
  runId: z.string(),
  backendId: z.string(),
  binary: z.string(),
  argv: z.array(z.string()),
  cwd: z.string().max(4096),
  env: z.record(z.string(), z.string()).optional(),
  outputProtocol: z.enum(['jsonline-stream-json', 'plain-text']),
  timeoutMs: z.number().int().positive(),
  maxOutputBytes: z.number().int().positive(),
  context: z.unknown().optional(),
  stdinJson: z.string().optional(),
  remoteCwdPlaceholder: z.string().max(128).optional(),
  workspaceRepo: z
    .object({
      kind: z.enum(['git', 'device_path', 'workspace']),
      gitUrl: z.string().max(2000).optional(),
      devicePath: z.string().max(4096).optional(),
      groupFolder: z.string().max(256),
    })
    .optional(),
});
export type RunRequestFrame = z.infer<typeof RunRequestFrame>;

export const RunCancelFrame = z.object({
  type: z.literal('run.cancel'),
  runId: z.string(),
  reason: z.enum([
    'user_abort',
    'server_shutdown',
    'link_replaced',
    'timeout',
    'group_deleted',
  ]),
});
export type RunCancelFrame = z.infer<typeof RunCancelFrame>;

export const AgentRunInputSchema = z.object({
  prompt: z.string(),
  sessionId: z.string().max(256).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type AgentRunInput = z.infer<typeof AgentRunInputSchema>;

export const AgentRunPolicySchema = z.object({
  permissionMode: z.string().max(64).optional(),
  allowedTools: z.array(z.string().max(256)).max(256).optional(),
  disallowedTools: z.array(z.string().max(256)).max(256).optional(),
  toolPolicy: z.record(z.string(), z.string()).optional(),
  model: z.string().max(256).optional(),
  systemPrompt: z.string().max(100_000).optional(),
});
export type AgentRunPolicy = z.infer<typeof AgentRunPolicySchema>;

export const AgentRunWorkspaceSchema = z.object({
  kind: z.enum(['git', 'device_path', 'workspace']).optional(),
  cwd: z.string().max(4096).optional(),
  folder: z.string().max(256).optional(),
  repo: z
    .object({
      kind: z.enum(['git', 'device_path', 'workspace']),
      gitUrl: z.string().max(2000).optional(),
      devicePath: z.string().max(4096).optional(),
      groupFolder: z.string().max(256),
    })
    .optional(),
  sessionRoot: z.string().max(4096).optional(),
});
export type AgentRunWorkspace = z.infer<typeof AgentRunWorkspaceSchema>;

export const AgentRunRequestFrame = z.object({
  type: z.literal('agent.run.request'),
  id: z.number().int().nonnegative(),
  runId: z.string(),
  agentId: z.string().min(1).max(128),
  workspace: AgentRunWorkspaceSchema.optional(),
  input: AgentRunInputSchema,
  cwd: z.string().max(4096).optional(),
  env: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().positive(),
  maxOutputBytes: z.number().int().positive(),
  policy: AgentRunPolicySchema.optional(),
  context: z.unknown().optional(),
  remoteCwdPlaceholder: z.string().max(128).optional(),
  workspaceRepo: z
    .object({
      kind: z.enum(['git', 'device_path', 'workspace']),
      gitUrl: z.string().max(2000).optional(),
      devicePath: z.string().max(4096).optional(),
      groupFolder: z.string().max(256),
    })
    .optional(),
});
export type AgentRunRequestFrame = z.infer<typeof AgentRunRequestFrame>;

export const AgentRunCancelFrame = z.object({
  type: z.literal('agent.run.cancel'),
  runId: z.string(),
  reason: z.enum([
    'user_abort',
    'server_shutdown',
    'link_replaced',
    'timeout',
    'group_deleted',
  ]),
});
export type AgentRunCancelFrame = z.infer<typeof AgentRunCancelFrame>;

export const AgentDiscoverRequestFrame = z.object({
  type: z.literal('agent.discover.request'),
  id: z.number().int().nonnegative(),
  requestId: z.string(),
});
export type AgentDiscoverRequestFrame = z.infer<
  typeof AgentDiscoverRequestFrame
>;

export const AgentSessionsRequestFrame = z.object({
  type: z.literal('agent.sessions.request'),
  id: z.number().int().nonnegative(),
  requestId: z.string(),
  agentId: z.string().max(128).optional(),
  workspace: z.string().max(256).optional(),
});
export type AgentSessionsRequestFrame = z.infer<
  typeof AgentSessionsRequestFrame
>;

export const AgentSessionDeleteRequestFrame = z.object({
  type: z.literal('agent.session.delete.request'),
  id: z.number().int().nonnegative(),
  requestId: z.string(),
  agentId: z.string().max(128),
  workspace: z.string().max(256),
  sessionId: z.string().max(512),
});
export type AgentSessionDeleteRequestFrame = z.infer<
  typeof AgentSessionDeleteRequestFrame
>;

export const AgentPermissionDecisionFrame = z.object({
  type: z.literal('agent.permission.decision'),
  runId: z.string(),
  requestId: z.string(),
  decision: z.enum(['approve', 'reject']),
  message: z.string().max(1024).optional(),
});
export type AgentPermissionDecisionFrame = z.infer<
  typeof AgentPermissionDecisionFrame
>;

export const ToolRequestFrame = z.object({
  type: z.literal('tool.request'),
  id: z.number().int().nonnegative(),
  requestId: z.string(),
  toolName: z.string().max(64),
  input: z.unknown(),
  cwd: z.string(),
  timeoutMs: z.number().int().positive(),
  maxOutputBytes: z.number().int().positive(),
});
export type ToolRequestFrame = z.infer<typeof ToolRequestFrame>;

export const ToolCancelFrame = z.object({
  type: z.literal('tool.cancel'),
  requestId: z.string(),
  reason: z.enum(['user_abort', 'server_shutdown', 'link_replaced', 'timeout']),
});
export type ToolCancelFrame = z.infer<typeof ToolCancelFrame>;

export const ModelsRequestFrame = z.object({
  type: z.literal('models.request'),
  id: z.number().int().nonnegative(),
  requestId: z.string(),
  providerId: z.string().max(64),
});
export type ModelsRequestFrame = z.infer<typeof ModelsRequestFrame>;

export const SkillsRequestFrame = z.object({
  type: z.literal('skills.request'),
  id: z.number().int().nonnegative(),
  requestId: z.string(),
  providerId: z.string().max(64),
  cwd: z.string().max(4096).optional(),
});
export type SkillsRequestFrame = z.infer<typeof SkillsRequestFrame>;

// ─── Incoming (C→S) ──────────────────────────────────────────

export const HelloFrame = z.object({
  type: z.literal('hello'),
  id: z.number().int().nonnegative(),
  version: z.string().max(64),
  protocolVersion: z.number().int().positive().optional(),
  protocolMinVersion: z.number().int().positive().optional(),
  os: z.string().max(32).optional(),
  arch: z.string().max(32).optional(),
  hostname: z.string().max(128).optional(),
  capabilities: z.array(z.string().max(64)).max(32),
  resources: ResourceSnapshotSchema.optional(),
  agentClients: z
    .array(
      z.object({
        id: z.string().max(64),
        displayName: z.string().max(64),
        binary: z.string().max(512),
        version: z.string().max(128).optional(),
        permissionModes: z.array(z.string().max(64)).max(16).optional(),
        capabilities: z.array(z.string().max(64)).max(32).optional(),
        provider: z.string().max(128).optional(),
        transport: z.enum(['stdio', 'a2a', 'http']).optional(),
      }),
    )
    .max(16)
    .optional(),
  agentRuntimeCapabilities: z.array(RuntimeCapabilitySchema).max(64).optional(),
});
export type HelloFrame = z.infer<typeof HelloFrame>;

export const PingFrame = z.object({
  type: z.literal('ping'),
  id: z.number().int().nonnegative(),
  resources: ResourceSnapshotSchema.optional(),
  status: z.enum(['idle', 'busy', 'draining']).optional(),
  runningRuns: z.array(RunningRunSchema).max(128).optional(),
  maxConcurrentRuns: z.number().int().nonnegative().optional(),
  availableSlots: z.number().int().nonnegative().optional(),
  runtimes: z.array(RuntimeStatusSchema).max(64).optional(),
});
export type PingFrame = z.infer<typeof PingFrame>;

export const RunStatusFrame = z.object({
  type: z.literal('run.status'),
  runId: z.string(),
  status: z.enum(['accepted', 'started', 'running', 'completed', 'failed']),
  backendId: z.string().max(128).optional(),
  cwd: z.string().max(4096).optional(),
  message: z.string().max(1024).optional(),
  startedAt: z.string().max(64).optional(),
  lastActivityAt: z.string().max(64).optional(),
});
export type RunStatusFrame = z.infer<typeof RunStatusFrame>;

export const RunEventFrame = z.object({
  type: z.literal('run.event'),
  runId: z.string(),
  stream: z.enum(['stdout', 'stderr']),
  data: z.string(),
});
export type RunEventFrame = z.infer<typeof RunEventFrame>;

export const RunResultFrame = z.object({
  type: z.literal('run.result'),
  runId: z.string(),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  timedOut: z.boolean(),
  durationMs: z.number().int().nonnegative(),
});
export type RunResultFrame = z.infer<typeof RunResultFrame>;

export const AgentRunStatusFrame = z.object({
  type: z.literal('agent.run.status'),
  runId: z.string(),
  agentId: z.string().max(128).optional(),
  status: z.enum(['accepted', 'started', 'running', 'completed', 'failed']),
  cwd: z.string().max(4096).optional(),
  message: z.string().max(1024).optional(),
  startedAt: z.string().max(64).optional(),
  lastActivityAt: z.string().max(64).optional(),
});
export type AgentRunStatusFrame = z.infer<typeof AgentRunStatusFrame>;

export const AgentRunEventFrame = z.object({
  type: z.literal('agent.run.event'),
  runId: z.string(),
  agentId: z.string().max(128).optional(),
  eventType: z.enum([
    'text_delta',
    'thinking_delta',
    'tool_call',
    'tool_result',
    'permission_request',
    'session',
    'usage',
    'log',
  ]),
  text: z.string().optional(),
  sessionId: z.string().max(256).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  at: z.string().max(64).optional(),
});
export type AgentRunEventFrame = z.infer<typeof AgentRunEventFrame>;

export const AgentRunResultFrame = z.object({
  type: z.literal('agent.run.result'),
  runId: z.string(),
  agentId: z.string().max(128).optional(),
  ok: z.boolean(),
  result: z.string().optional(),
  error: z.string().nullable(),
  errorInfo: z
    .object({
      code: z.string().max(64),
      message: z.string().max(2048),
      retryable: z.boolean().optional(),
      details: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  sessionId: z.string().max(256).optional(),
  usage: z.record(z.string(), z.unknown()).optional(),
  timedOut: z.boolean(),
  durationMs: z.number().int().nonnegative(),
});
export type AgentRunResultFrame = z.infer<typeof AgentRunResultFrame>;

export const AgentInfoSchema = z.object({
  id: z.string().max(64),
  displayName: z.string().max(64),
  binary: z.string().max(512),
  version: z.string().max(128).optional(),
  provider: z.string().max(128).optional(),
  transport: z.enum(['stdio', 'a2a', 'http']).optional(),
  permissionModes: z.array(z.string().max(64)).max(16).optional(),
  capabilities: z.array(z.string().max(64)).max(32).optional(),
});
export type AgentInfo = z.infer<typeof AgentInfoSchema>;

export const AgentDiscoverResultFrame = z.object({
  type: z.literal('agent.discover.result'),
  requestId: z.string(),
  ok: z.boolean(),
  agents: z.array(AgentInfoSchema).max(64),
  runtimeCapabilities: z.array(RuntimeCapabilitySchema).max(64).optional(),
  error: z.string().nullable(),
  durationMs: z.number().int().nonnegative(),
});
export type AgentDiscoverResultFrame = z.infer<typeof AgentDiscoverResultFrame>;

export const AgentSessionInfoSchema = z.object({
  id: z.string().min(1).max(512),
  agentId: z.string().min(1).max(128),
  workspace: z.string().min(1).max(256),
  title: z.string().max(1024).optional(),
  provider: z.string().max(128).optional(),
  path: z.string().min(1).max(4096),
  updatedAt: z.string().max(64).optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
});
export type AgentSessionInfo = z.infer<typeof AgentSessionInfoSchema>;

export const AgentSessionsResultFrame = z.object({
  type: z.literal('agent.sessions.result'),
  requestId: z.string(),
  ok: z.boolean(),
  sessions: z.array(AgentSessionInfoSchema).max(1024),
  error: z.string().nullable(),
  durationMs: z.number().int().nonnegative(),
});
export type AgentSessionsResultFrame = z.infer<typeof AgentSessionsResultFrame>;

export const AgentSessionDeleteResultFrame = z.object({
  type: z.literal('agent.session.delete.result'),
  requestId: z.string(),
  ok: z.boolean(),
  deleted: z.boolean(),
  error: z.string().nullable(),
  durationMs: z.number().int().nonnegative(),
});
export type AgentSessionDeleteResultFrame = z.infer<
  typeof AgentSessionDeleteResultFrame
>;

export const AgentRuntimeStatusFrame = z.object({
  type: z.literal('agent.runtime.status'),
  runtimeId: z.string().min(1).max(256),
  status: z.enum(['running', 'offline', 'restarting', 'degraded']),
  message: z.string().max(1024).optional(),
  startedAt: z.string().max(64).optional(),
  crashCount: z.number().int().nonnegative().optional(),
});
export type AgentRuntimeStatusFrame = z.infer<typeof AgentRuntimeStatusFrame>;

export const ToolEventFrame = z.object({
  type: z.literal('tool.event'),
  requestId: z.string(),
  stream: z.enum(['stdout', 'stderr']),
  data: z.string(),
});
export type ToolEventFrame = z.infer<typeof ToolEventFrame>;

export const ToolResultFrame = z.object({
  type: z.literal('tool.result'),
  requestId: z.string(),
  ok: z.boolean(),
  result: z.unknown().nullable(),
  error: z.string().nullable(),
  durationMs: z.number().int().nonnegative(),
});
export type ToolResultFrame = z.infer<typeof ToolResultFrame>;

export const MemorySyncFrame = z.object({
  type: z.literal('memory.sync'),
  deviceLinkId: z.string().min(1).max(128),
  agentId: z.string().min(1).max(128),
  path: z.string().min(1).max(4096),
  content: z.string().max(1_000_000),
  mtime: z.string().max(64).optional(),
  contentHash: z.string().max(256).optional(),
});
export type MemorySyncFrame = z.infer<typeof MemorySyncFrame>;

export const ModelInfoSchema = z.object({
  id: z.string().min(1).max(256),
  displayName: z.string().min(1).max(256).optional(),
});
export type ModelInfo = z.infer<typeof ModelInfoSchema>;

export const SkillInfoSchema = z.object({
  id: z.string().min(1).max(256),
  name: z.string().min(1).max(256).optional(),
  description: z.string().max(2048).optional(),
  source: z.enum(['workspace', 'cli']),
  enabled: z.boolean().optional(),
  packageName: z.string().max(512).optional(),
  content: z.string().max(200_000).optional(),
});
export type SkillInfo = z.infer<typeof SkillInfoSchema>;

const LegacySkillListSchema = z
  .union([z.array(SkillInfoSchema).max(256), z.null()])
  .transform((value) => value ?? []);

export const ModelsResultFrame = z.object({
  type: z.literal('models.result'),
  requestId: z.string(),
  ok: z.boolean(),
  models: z.array(ModelInfoSchema).max(256),
  error: z.string().nullable(),
  durationMs: z.number().int().nonnegative(),
});
export type ModelsResultFrame = z.infer<typeof ModelsResultFrame>;

export const SkillsResultFrame = z.object({
  type: z.literal('skills.result'),
  requestId: z.string(),
  ok: z.boolean(),
  workspaceSkills: LegacySkillListSchema,
  cliSkills: LegacySkillListSchema,
  error: z.string().nullable(),
  durationMs: z.number().int().nonnegative(),
});
export type SkillsResultFrame = z.infer<typeof SkillsResultFrame>;

// ─── Bidirectional ───────────────────────────────────────────

export const ErrorFrame = z.object({
  type: z.literal('error'),
  id: z.number().int().nonnegative().optional(),
  code: z.string().max(64),
  message: z.string().max(512),
  fatal: z.boolean().optional(),
});
export type ErrorFrame = z.infer<typeof ErrorFrame>;

// ─── Discriminated unions ────────────────────────────────────

export const InboundFrame = z.discriminatedUnion('type', [
  HelloFrame,
  PingFrame,
  RunStatusFrame,
  RunEventFrame,
  RunResultFrame,
  AgentRunStatusFrame,
  AgentRunEventFrame,
  AgentRunResultFrame,
  AgentDiscoverResultFrame,
  AgentSessionsResultFrame,
  AgentSessionDeleteResultFrame,
  AgentRuntimeStatusFrame,
  ToolEventFrame,
  ToolResultFrame,
  MemorySyncFrame,
  ModelsResultFrame,
  SkillsResultFrame,
  ErrorFrame,
]);
export type InboundFrame = z.infer<typeof InboundFrame>;

export const OutboundFrame = z.discriminatedUnion('type', [
  HelloAckFrame,
  RunRequestFrame,
  RunCancelFrame,
  AgentRunRequestFrame,
  AgentRunCancelFrame,
  AgentDiscoverRequestFrame,
  AgentSessionsRequestFrame,
  AgentSessionDeleteRequestFrame,
  AgentPermissionDecisionFrame,
  ToolRequestFrame,
  ToolCancelFrame,
  ModelsRequestFrame,
  SkillsRequestFrame,
  ErrorFrame,
]);
export type OutboundFrame = z.infer<typeof OutboundFrame>;

/** 安全解析 + 错误描述（不抛）。 */
export function parseInboundFrame(
  raw: string,
): { ok: true; frame: InboundFrame } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      error: `invalid_json: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const result = InboundFrame.safeParse(json);
  if (!result.success) {
    return {
      ok: false,
      error: result.error.issues.map((i) => i.message).join('; '),
    };
  }
  return { ok: true, frame: result.data };
}

export function encodeFrame(frame: OutboundFrame): string {
  return JSON.stringify(frame);
}

export const HEARTBEAT_INTERVAL_MS = 30_000;
export const HEARTBEAT_TIMEOUT_MS = 90_000; // 3 missed pings
export const HELLO_TIMEOUT_MS = 5_000;
