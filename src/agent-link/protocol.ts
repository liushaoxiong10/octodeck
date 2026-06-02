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
  cwd: z.string(),
  env: z.record(z.string(), z.string()).optional(),
  outputProtocol: z.enum(['jsonline-stream-json', 'plain-text']),
  timeoutMs: z.number().int().positive(),
  maxOutputBytes: z.number().int().positive(),
  context: z.unknown().optional(),
  stdinJson: z.string().optional(),
  remoteCwdPlaceholder: z.string().max(128).optional(),
  workspaceRepo: z
    .object({
      kind: z.enum(['git', 'device_path']),
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
      }),
    )
    .max(16)
    .optional(),
});
export type HelloFrame = z.infer<typeof HelloFrame>;

export const PingFrame = z.object({
  type: z.literal('ping'),
  id: z.number().int().nonnegative(),
  resources: ResourceSnapshotSchema.optional(),
});
export type PingFrame = z.infer<typeof PingFrame>;

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
  RunEventFrame,
  RunResultFrame,
  ToolEventFrame,
  ToolResultFrame,
  ModelsResultFrame,
  SkillsResultFrame,
  ErrorFrame,
]);
export type InboundFrame = z.infer<typeof InboundFrame>;

export const OutboundFrame = z.discriminatedUnion('type', [
  HelloAckFrame,
  RunRequestFrame,
  RunCancelFrame,
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
    return { ok: false, error: result.error.issues.map((i) => i.message).join('; ') };
  }
  return { ok: true, frame: result.data };
}

export function encodeFrame(frame: OutboundFrame): string {
  return JSON.stringify(frame);
}

export const HEARTBEAT_INTERVAL_MS = 30_000;
export const HEARTBEAT_TIMEOUT_MS = 90_000; // 3 missed pings
export const HELLO_TIMEOUT_MS = 5_000;
