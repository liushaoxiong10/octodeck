/**
 * Agent-link driver — Phase 5.2.
 *
 * Mirror of host-cli-driver, but instead of `child_process.spawn` we ship the
 * `run.request` frame to a remote octodeck-daemon via the AgentLink ws session and
 * route incoming `run.event` / `run.result` frames back through the same
 * parsing/finalizing pipeline that host-cli-driver uses.
 *
 * Reuses host-cli-driver's parser by feeding it the same stdout text byte-by-
 * byte; the only behavior diff vs local spawn:
 *   - cwd validation runs *server-side* (we still need an absolute, existing
 *     dir for run logs); the remote daemon may reject if its filesystem is
 *     different — surfaced via run.result(exitCode != 0)
 *   - onProcess receives a fake ChildProcess-like shim whose .kill() sends
 *     run.cancel
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';

import { createAgentToolToken, GROUPS_DIR } from '../config.js';
import { logger } from '../logger.js';
import { getCloudMemory } from '../memory-store.js';
import {
  LONG_RUNNING_LOCAL_CLI_TIMEOUT_MS,
  getSystemSettings,
} from '../runtime-config.js';
import type { ContainerOutput } from '../container-runner.js';
import type { StreamEvent } from '../stream-event.types.js';
import { getOnlineMeta, getSession } from '../agent-link/registry.js';
import { listOnlineRuntimesByProvider } from '../agent-link/registry.js';
import type { AgentLinkSession } from '../agent-link/session.js';
import {
  registerAgentRun,
  registerRun,
  unregisterAgentRun,
  unregisterRun,
  type AgentRunController,
  type RunController,
} from '../agent-link/run-rpc.js';
import type { BackendRunArgs } from './types.js';
import type { HostCliDriverConfig } from './host-cli-driver.js';
import {
  applyAgentPermissionArgs,
  normalizePermissionModeForAgent,
} from './agent-permission-args.js';
import { loadUserMcpServers } from '../mcp-utils.js';
import { listManagedReposByUser } from '../db.js';
import type { ManagedRepo } from '../types.js';
import {
  shouldDisableAgentTeamMcp,
  stripAgentTeamMcpConfigArgs,
} from './validation.js';

interface CocoEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  is_error?: boolean;
  usage?: Record<string, unknown>;
  response_meta?: {
    usage?: Record<string, unknown>;
  };
  name?: string;
  id?: string;
  tool_use_id?: string;
  input?: unknown;
  content?: unknown;
  delta?: {
    role?: string;
    content?: string;
    response_meta?: {
      usage?: Record<string, unknown>;
    };
  };
  message?: {
    role?: string;
    content?: string | Array<Record<string, unknown>>;
    response_meta?: {
      usage?: Record<string, unknown>;
    };
  };
}

const TOOL_RESULT_NAME_BY_ID = new Map<string, string>();

/**
 * Try to extract a human-readable error message from a string that may be a
 * JSON-RPC error object. Some ACP/MCP SDKs wrap transport errors in a
 * JSON-RPC -32603 (Internal error) envelope with the real reason in `data.error`.
 * Returns a clean, readable message instead of raw JSON.
 */
function extractErrorMessage(raw: string | null | undefined): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return raw;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (parsed.jsonrpc === '2.0' || typeof parsed.code === 'number') {
      const message = typeof parsed.message === 'string' ? parsed.message : '';
      const data = parsed.data as Record<string, unknown> | undefined;
      const dataError =
        data && typeof data.error === 'string' ? data.error : '';
      if (dataError && message && dataError !== message) {
        return `${message}: ${dataError}`;
      }
      return dataError || message || raw;
    }
  } catch {
    // Not valid JSON — return as-is
  }
  return raw;
}

function compactJson(value: unknown, max = 2000): string | null {
  if (value === undefined || value === null) return null;
  const text =
    typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function usagePayloadFromCocoEvent(
  evt: CocoEvent,
): Record<string, unknown> | undefined {
  return (
    evt.usage ??
    evt.response_meta?.usage ??
    evt.delta?.response_meta?.usage ??
    evt.message?.response_meta?.usage
  );
}

function summarizeToolInput(input: unknown): string | undefined {
  if (!input || typeof input !== 'object')
    return compactJson(input, 240) ?? undefined;
  const record = input as Record<string, unknown>;
  for (const key of [
    'description',
    'command',
    'file_path',
    'path',
    'pattern',
    'query',
    'url',
    'prompt',
  ]) {
    const value = record[key];
    if (typeof value === 'string' && value.trim())
      return `${key}: ${value.slice(0, 220)}`;
  }
  return compactJson(record, 240) ?? undefined;
}

function firstContentBlock(
  evt: CocoEvent,
  type: string,
): Record<string, unknown> | null {
  const content = evt.message?.content;
  if (!Array.isArray(content)) return null;
  return content.find((block) => block?.type === type) ?? null;
}

function firstStringValue(
  source: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

function streamEventFromCocoEvent(evt: CocoEvent): StreamEvent | null {
  const sessionId = evt.session_id;
  const toolUseBlock = firstContentBlock(evt, 'tool_use');
  const toolResultBlock = firstContentBlock(evt, 'tool_result');
  const thinkingBlock =
    firstContentBlock(evt, 'thinking') ?? firstContentBlock(evt, 'reasoning');
  if (
    evt.type === 'thinking' ||
    evt.type === 'reasoning' ||
    evt.type === 'reasoning_delta' ||
    thinkingBlock
  ) {
    const source = thinkingBlock ?? (evt as unknown as Record<string, unknown>);
    const text = firstStringValue(source, [
      'thinking',
      'reasoning',
      'reason',
      'text',
      'content',
    ]);
    if (text) {
      return {
        eventType: 'thinking_delta',
        sessionId,
        text,
        rawEvent: evt as unknown as Record<string, unknown>,
      };
    }
  }
  if (
    evt.type === 'tool_use' ||
    evt.type === 'tool_call' ||
    evt.type === 'tool_use_start' ||
    toolUseBlock
  ) {
    const source = toolUseBlock ?? (evt as unknown as Record<string, unknown>);
    const input = source.input;
    const toolInput =
      input && typeof input === 'object' && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : undefined;
    return {
      eventType: 'tool_use_start',
      sessionId,
      toolName: typeof source.name === 'string' ? source.name : 'unknown',
      toolUseId:
        typeof source.id === 'string'
          ? source.id
          : typeof source.tool_use_id === 'string'
            ? source.tool_use_id
            : undefined,
      toolInputSummary: summarizeToolInput(input),
      toolInput,
      detail: compactJson(input) ?? undefined,
      rawEvent: evt as unknown as Record<string, unknown>,
    };
  }
  if (
    evt.type === 'tool_result' ||
    evt.type === 'tool_use_end' ||
    toolResultBlock
  ) {
    const source =
      toolResultBlock ?? (evt as unknown as Record<string, unknown>);
    const content = source.content ?? source.result ?? source.text;
    const isError = Boolean(source.is_error ?? evt.is_error);
    return {
      eventType: 'tool_use_end',
      sessionId,
      toolUseId:
        typeof source.tool_use_id === 'string'
          ? source.tool_use_id
          : typeof source.id === 'string'
            ? source.id
            : undefined,
      statusText: isError ? 'error' : 'completed',
      summary: isError ? 'Tool returned error' : 'Tool response received',
      detail: compactJson(content) ?? undefined,
      rawEvent: evt as unknown as Record<string, unknown>,
    };
  }
  return null;
}

function valueFromPayload(
  payload: Record<string, unknown> | undefined,
  keys: string[],
): unknown {
  if (!payload) return undefined;
  for (const key of keys) {
    const value = payload[key];
    if (value !== undefined && value !== null) return value;
  }
  const blocks = (payload.message as Record<string, unknown> | undefined)
    ?.content;
  if (Array.isArray(blocks)) {
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      const record = block as Record<string, unknown>;
      for (const key of keys) {
        const value = record[key];
        if (value !== undefined && value !== null) return value;
      }
    }
  }
  return undefined;
}

function nestedObjectFromPayload(
  payload: Record<string, unknown> | undefined,
  keys: string[],
): Record<string, unknown> | undefined {
  const value = valueFromPayload(payload, keys);
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizeModelUsagePayload(
  usage: Record<string, unknown>,
): NonNullable<StreamEvent['usage']>['modelUsage'] | undefined {
  const raw = nestedObjectFromPayload(usage, ['modelUsage', 'model_usage']);
  if (!raw) return undefined;

  const modelUsage: NonNullable<StreamEvent['usage']>['modelUsage'] = {};
  for (const [model, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const item = value as Record<string, unknown>;
    const num = (...keys: string[]) => {
      for (const key of keys) {
        const v = item[key];
        if (typeof v === 'number' && Number.isFinite(v)) return v;
        if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) {
          return Number(v);
        }
      }
      return 0;
    };
    modelUsage[model] = {
      inputTokens: num(
        'inputTokens',
        'input_tokens',
        'inputTokenCount',
        'input_token_count',
        'promptTokens',
        'prompt_tokens',
        'promptTokenCount',
        'prompt_token_count',
      ),
      outputTokens: num(
        'outputTokens',
        'output_tokens',
        'outputTokenCount',
        'output_token_count',
        'completionTokens',
        'completion_tokens',
        'completionTokenCount',
        'completion_token_count',
      ),
      cacheReadInputTokens: num(
        'cacheReadInputTokens',
        'cache_read_input_tokens',
        'cacheReadTokens',
        'cache_read_tokens',
        'cachedReadTokens',
        'cached_read_tokens',
        'cachedInputTokens',
        'cached_input_tokens',
      ),
      cacheCreationInputTokens: num(
        'cacheCreationInputTokens',
        'cache_creation_input_tokens',
        'cacheCreationTokens',
        'cache_creation_tokens',
        'cacheWriteInputTokens',
        'cache_write_input_tokens',
        'cacheWriteTokens',
        'cache_write_tokens',
        'cachedWriteTokens',
        'cached_write_tokens',
      ),
      costUSD: num('costUSD', 'cost_usd', 'cost'),
    };
  }
  return Object.keys(modelUsage).length > 0 ? modelUsage : undefined;
}

function firstStringFromPayload(
  payload: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function normalizeUsagePayload(
  payload: Record<string, unknown> | undefined,
  fallbackModel?: string,
): StreamEvent['usage'] | undefined {
  const usage = nestedObjectFromPayload(payload, ['usage']) ?? payload;
  if (!usage) return undefined;
  const num = (...keys: string[]) => {
    for (const key of keys) {
      const value = usage[key];
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (
        typeof value === 'string' &&
        value.trim() &&
        Number.isFinite(Number(value))
      )
        return Number(value);
    }
    return 0;
  };
  const normalized = {
    inputTokens: num(
      'inputTokens',
      'input_tokens',
      'inputTokenCount',
      'input_token_count',
      'promptTokens',
      'prompt_tokens',
      'promptTokenCount',
      'prompt_token_count',
    ),
    outputTokens: num(
      'outputTokens',
      'output_tokens',
      'outputTokenCount',
      'output_token_count',
      'completionTokens',
      'completion_tokens',
      'completionTokenCount',
      'completion_token_count',
    ),
    cacheReadInputTokens: num(
      'cacheReadInputTokens',
      'cache_read_input_tokens',
      'cacheReadTokens',
      'cache_read_tokens',
      'cachedReadTokens',
      'cached_read_tokens',
      'cachedInputTokens',
      'cached_input_tokens',
    ),
    cacheCreationInputTokens: num(
      'cacheCreationInputTokens',
      'cache_creation_input_tokens',
      'cacheCreationTokens',
      'cache_creation_tokens',
      'cacheWriteInputTokens',
      'cache_write_input_tokens',
      'cacheWriteTokens',
      'cache_write_tokens',
      'cachedWriteTokens',
      'cached_write_tokens',
    ),
    costUSD: num('costUSD', 'cost_usd', 'cost'),
    durationMs: num('durationMs', 'duration_ms'),
    numTurns: num('numTurns', 'num_turns'),
  };
  const modelUsage = normalizeModelUsagePayload(usage);
  if (modelUsage) {
    return { ...normalized, modelUsage };
  }
  if (!Object.values(normalized).some((value) => value > 0)) return undefined;
  const model =
    firstStringFromPayload(usage, ['model', 'modelId', 'model_id']) ??
    fallbackModel;
  if (model) {
    return {
      ...normalized,
      modelUsage: {
        [model]: {
          inputTokens: normalized.inputTokens,
          outputTokens: normalized.outputTokens,
          cacheReadInputTokens: normalized.cacheReadInputTokens,
          cacheCreationInputTokens: normalized.cacheCreationInputTokens,
          costUSD: normalized.costUSD,
        },
      },
    };
  }
  return normalized;
}

function streamEventFromAgentRunFrame(
  frame: {
    eventType: string;
    text?: string;
    sessionId?: string;
    payload?: Record<string, unknown>;
  },
  fallbackModel?: string,
): StreamEvent | null {
  if (frame.eventType === 'tool_call' || frame.eventType === 'tool_use_start') {
    const input = valueFromPayload(frame.payload, [
      'input',
      'arguments',
      'params',
    ]);
    const toolUseId = String(
      valueFromPayload(frame.payload, ['id', 'toolUseId', 'tool_use_id']) || '',
    );
    const toolName = String(
      valueFromPayload(frame.payload, ['name', 'toolName']) || 'unknown',
    );
    if (toolUseId && toolName !== 'unknown') {
      TOOL_RESULT_NAME_BY_ID.set(toolUseId, toolName);
    }
    const toolInput =
      input && typeof input === 'object' && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : undefined;
    return {
      eventType: 'tool_use_start',
      sessionId: frame.sessionId,
      toolName,
      toolUseId,
      toolInputSummary: summarizeToolInput(input),
      toolInput,
      detail: compactJson(input) ?? undefined,
      rawEvent: frame.payload,
    };
  }
  if (frame.eventType === 'tool_result' || frame.eventType === 'tool_use_end') {
    const content = valueFromPayload(frame.payload, [
      'content',
      'result',
      'text',
      'output',
    ]);
    const isError = Boolean(
      valueFromPayload(frame.payload, ['is_error', 'isError', 'error']),
    );
    const toolUseId = String(
      valueFromPayload(frame.payload, ['toolUseId', 'tool_use_id', 'id']) || '',
    );
    const toolName = String(
      valueFromPayload(frame.payload, ['name', 'toolName']) ||
        TOOL_RESULT_NAME_BY_ID.get(toolUseId) ||
        'unknown',
    );
    if (toolUseId) TOOL_RESULT_NAME_BY_ID.delete(toolUseId);
    return {
      eventType: 'tool_use_end',
      sessionId: frame.sessionId,
      toolName,
      toolUseId,
      statusText: isError ? 'error' : 'completed',
      summary: isError ? 'Tool returned error' : 'Tool response received',
      detail: compactJson(content) ?? undefined,
      rawEvent: frame.payload,
    };
  }
  if (frame.eventType === 'permission_request') {
    const payload = (frame.payload ?? {}) as Record<string, unknown>;
    const toolName =
      (typeof payload.toolName === 'string' ? payload.toolName : undefined) ??
      (typeof payload.tool_name === 'string' ? payload.tool_name : undefined);
    return {
      eventType: 'permission_request',
      sessionId: frame.sessionId,
      toolName,
      title: toolName
        ? `Permission request: ${toolName}`
        : 'Permission request',
      summary: toolName
        ? `Agent is requesting permission to use ${toolName}.`
        : 'Agent is requesting permission.',
      detail: compactJson(frame.payload) ?? undefined,
      rawEvent: frame.payload,
    };
  }
  if (frame.eventType === 'usage') {
    return {
      eventType: 'usage',
      sessionId: frame.sessionId,
      usage: normalizeUsagePayload(frame.payload, fallbackModel),
      detail: compactJson(frame.payload) ?? undefined,
      rawEvent: frame.payload,
    };
  }
  if (frame.eventType === 'session') {
    return {
      eventType: 'status',
      sessionId: frame.sessionId,
      statusText: 'session',
      detail: compactJson(frame.payload) ?? undefined,
      rawEvent: frame.payload,
    };
  }
  return null;
}

function extractAssistantText(evt: CocoEvent): string | null {
  if (
    evt.type === 'stream_event' &&
    evt.delta?.role === 'assistant' &&
    typeof evt.delta.content === 'string'
  ) {
    return evt.delta.content;
  }
  if (evt.type !== 'assistant') return null;
  const content = evt.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = content
      .filter(
        (block) => block?.type === 'text' && typeof block.text === 'string',
      )
      .map((block) => block.text)
      .join('');
    return text || null;
  }
  return null;
}

function parseEvent(line: string): CocoEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as CocoEvent;
  } catch {
    return null;
  }
}

interface ParseState {
  finalResultText: string | null;
  finalIsError: boolean;
  lastSessionId?: string;
  lastAssistantText: string | null;
}

const REMOTE_CWD_PLACEHOLDER = '__OCTODECK_REMOTE_CWD__';
const DEVICE_WORKSPACE_URI_PREFIX = 'octodeck-workspace://';

const PROMPTS_DIR = path.join(
  process.cwd(),
  'container',
  'agent-runner',
  'prompts',
);

const deviceSystemPromptCache = new Map<string, string | null>();

function loadPromptFile(...segments: string[]): string {
  return fs
    .readFileSync(path.join(PROMPTS_DIR, ...segments), 'utf-8')
    .trimEnd();
}

function getChannelFromJid(jid: string | undefined): string | null {
  if (!jid) return null;
  const idx = jid.indexOf(':');
  if (idx <= 0) return null;
  const channel = jid.slice(0, idx);
  return channel === 'web' ? null : channel;
}

function buildDeviceCliSystemPrompt(
  input: BackendRunArgs['input'],
  group: BackendRunArgs['group'],
  ownerUserId?: string,
): string | undefined {
  const channel = getChannelFromJid(input.currentSourceJid || input.chatJid);

  // 拉取云端全局记忆 (cloud_memories memoryType='global'),拼进 systemPrompt。
  // 记忆内容随用户编辑会变化,因此按 owner+contentHash 作为缓存 key。
  let cloudGlobalMemoryContent = '';
  if (ownerUserId) {
    try {
      const record = getCloudMemory({
        userId: ownerUserId,
        memoryType: 'global',
        path: 'CLAUDE.md',
      });
      if (record?.content) cloudGlobalMemoryContent = record.content.trim();
    } catch (err) {
      logger.warn(
        { err, ownerUserId },
        'Failed to load cloud global memory for device CLI system prompt',
      );
    }
  }

  const cacheKey = JSON.stringify({
    isHome: !!input.isHome,
    groupFolder: input.groupFolder,
    channel,
    hasAgentOverride: !!input.agentId,
    workspacePromptHash: group.systemPrompt
      ? crypto.createHash('sha256').update(group.systemPrompt).digest('hex')
      : '',
    ownerUserId: ownerUserId ?? '',
    cloudHash: cloudGlobalMemoryContent
      ? crypto
          .createHash('sha256')
          .update(cloudGlobalMemoryContent)
          .digest('hex')
      : '',
  });
  if (deviceSystemPromptCache.has(cacheKey)) {
    return deviceSystemPromptCache.get(cacheKey) || undefined;
  }

  try {
    const securityRules = loadPromptFile('security-rules.md');
    const outputGuidelines = loadPromptFile('output.md');
    const webFetchGuidelines = loadPromptFile('web-fetch.md');
    const backgroundTaskGuidelines = loadPromptFile('background-tasks.md');
    const memoryPrompt = loadPromptFile(
      input.isHome ? 'memory-system.home.md' : 'memory-system.guest.md',
    );
    const channelGuidelines = channel
      ? (() => {
          try {
            return loadPromptFile('channels', `${channel}.md`);
          } catch {
            return '';
          }
        })()
      : '';

    const pieces = [
      `<behavior>\n${loadPromptFile('interaction.md')}\n</behavior>`,
      `<skill-routing>\n${loadPromptFile('skill-routing.md')}\n</skill-routing>`,
      `<security>\n${securityRules}\n</security>`,
      `<memory-system>\n${memoryPrompt}\n</memory-system>`,
      `<workspace-memory>\n当前 workspace 记忆的云端权威范围: cloud://session/session:${input.groupFolder}/...。如 device CLI 支持 OctoDeck memory MCP 工具,当前 workspace 的长期项目记忆必须通过 workspace_memory_* 或 cloud_memory_* 写入云端;本地文件记忆仅限当前会话。workspace 记忆本地副本路径为工作区下 .octodeck/memory,仅用于快捷检索。\n</workspace-memory>`,
      ...(cloudGlobalMemoryContent
        ? [
            `<cloud-global-memory>\n以下是该用户在 OctoDeck 云端的全局记忆 (cloud://global/global:${ownerUserId}/CLAUDE.md)。请将其作为长期记忆参考,在适当时遵循其中的偏好与约定。\n\n${cloudGlobalMemoryContent}\n</cloud-global-memory>`,
          ]
        : []),
      `<guidelines>\n${outputGuidelines}\n${webFetchGuidelines}\n${backgroundTaskGuidelines}\n</guidelines>`,
      ...(channelGuidelines
        ? [`<channel-format>\n${channelGuidelines}\n</channel-format>`]
        : []),
      ...(input.agentId
        ? [
            `<agent-override>\n${loadPromptFile('agent-override.md')}\n</agent-override>`,
          ]
        : []),
      ...(group.systemPrompt?.trim()
        ? [
            `<workspace-system-prompt>\n${group.systemPrompt.trim()}\n</workspace-system-prompt>`,
          ]
        : []),
    ];

    deviceSystemPromptCache.set(cacheKey, pieces.join('\n'));
  } catch (err) {
    logger.warn({ err }, 'Failed to build OctoDeck device CLI system prompt');
    deviceSystemPromptCache.set(cacheKey, null);
  }

  return deviceSystemPromptCache.get(cacheKey) || undefined;
}

function buildAgentRunPolicy(
  cfg: HostCliDriverConfig,
  input: BackendRunArgs['input'],
  group: BackendRunArgs['group'],
  agentClientId?: string,
  ownerUserId?: string,
): Record<string, unknown> {
  const policy: Record<string, unknown> = {};
  if (cfg.model) policy.model = cfg.model;
  const permissionMode = normalizePermissionModeForAgent(
    agentClientId ?? cfg.agentClientId ?? cfg.backendId,
    group.permissionMode ?? cfg.permissionMode,
  );
  if (permissionMode && permissionMode !== 'default') {
    policy.permissionMode = permissionMode;
  }
  if (isStartingNewDeviceCliSession(input)) {
    const systemPrompt = buildDeviceCliSystemPrompt(input, group, ownerUserId);
    if (systemPrompt) policy.systemPrompt = systemPrompt;
  }
  return policy;
}

function isStartingNewDeviceCliSession(
  input: BackendRunArgs['input'],
): boolean {
  return !input.sessionId;
}

function appendClaudeCodeSystemPromptArg(
  argv: string[],
  agentClientId: string | undefined,
  input: BackendRunArgs['input'],
  group: BackendRunArgs['group'],
  ownerUserId?: string,
): string[] {
  if (agentClientId !== 'claude-code' && agentClientId !== 'claude-acp')
    return argv;
  if (!isStartingNewDeviceCliSession(input)) return argv;
  if (argv.includes('--append-system-prompt')) return argv;
  const systemPrompt = buildDeviceCliSystemPrompt(input, group, ownerUserId);
  if (!systemPrompt) return argv;
  return [...argv, '--append-system-prompt', systemPrompt];
}

function buildDeviceCliUserPromptWithSystemContext(
  input: BackendRunArgs['input'],
  group: BackendRunArgs['group'],
  ownerUserId?: string,
): string {
  if (!isStartingNewDeviceCliSession(input)) return input.prompt;
  const systemPrompt = buildDeviceCliSystemPrompt(input, group, ownerUserId);
  if (!systemPrompt) return input.prompt;
  return [
    '<octodeck-system-context>',
    systemPrompt,
    '</octodeck-system-context>',
    '',
    '<user-prompt>',
    input.prompt,
    '</user-prompt>',
  ].join('\n');
}

function shouldInlineSystemPromptForLegacyDeviceCli(
  agentClientId: string | undefined,
): boolean {
  // Claude Code has a native --append-system-prompt path. Other device CLIs
  // (Codex / TraeCLI / custom clients) may ignore argv-level system prompt
  // conventions, so inline OctoDeck system context into the user prompt to make
  // cloud global memory visible consistently in legacy run.request mode.
  return (
    !!agentClientId &&
    agentClientId !== 'claude-code' &&
    agentClientId !== 'claude-acp'
  );
}

type RemoteWorkspaceScope =
  | 'workspace'
  | 'session'
  | 'direct_session'
  | 'task'
  | 'skills';

interface RemoteWorkspaceMeta {
  agentId: string;
  agentRoot?: string;
  workdirMode: 'auto' | 'custom';
  scope: RemoteWorkspaceScope;
  scopeId?: string;
  taskId?: string;
  taskRunId?: string;
}

function newRunId(): string {
  return crypto.randomUUID();
}

export function parseAgentLinkTarget(
  target: string,
  userId?: string,
): { linkId: string; agentClientId?: string } | null {
  const trimmed = target.trim();
  if (/^cl_[0-9a-f]{16}$/.test(trimmed)) return { linkId: trimmed };
  const runtimeMatch = /^runtime:(cl_[0-9a-f]{16}):([^:]+)$/.exec(trimmed);
  if (runtimeMatch)
    return { linkId: runtimeMatch[1], agentClientId: runtimeMatch[2] };
  const legacyRuntimeMatch = /^(cl_[0-9a-f]{16}):([^:]+)$/.exec(trimmed);
  if (legacyRuntimeMatch)
    return {
      linkId: legacyRuntimeMatch[1],
      agentClientId: legacyRuntimeMatch[2],
    };
  const providerMatch = /^provider:([^:]+)$/.exec(trimmed);
  if (providerMatch) {
    if (!userId) return null;
    const selected = listOnlineRuntimesByProvider(providerMatch[1], userId)[0];
    if (selected)
      return {
        linkId: selected.deviceLinkId,
        agentClientId: selected.agentClientId,
      };
  }
  return null;
}

function buildRunContext(
  args: BackendRunArgs,
  cfg: HostCliDriverConfig,
  cwd: string,
): Record<string, unknown> {
  const { group, input, executionMode } = args;
  const repo = buildRepoContext(group, cwd);
  return {
    backendId: cfg.backendId,
    executionMode,
    input,
    cwd,
    ...(repo ? { repo } : {}),
    group: {
      name: group.name,
      folder: group.folder,
      backend: group.backend,
      executionMode: group.executionMode,
      executionNode: group.executionNode,
      customCwd: group.customCwd,
      repoId: group.repoId,
      repoGitUrl: group.repoGitUrl,
      repoDevicePath: group.repoDevicePath,
      created_by: group.created_by,
      is_home: group.is_home,
    },
  };
}

function buildRepoContext(
  group: BackendRunArgs['group'],
  cwd: string,
): Record<string, unknown> | null {
  if (!group.repoId && !group.repoGitUrl && !group.repoDevicePath) {
    return null;
  }
  return {
    id: group.repoId,
    gitUrl: group.repoGitUrl,
    mainBranch: group.repoMainBranch,
    devicePath: group.repoDevicePath,
    kind: group.repoGitUrl
      ? 'git'
      : group.repoDevicePath
        ? 'device_path'
        : undefined,
    cwd,
  };
}

type WorkspaceRepo =
  | ({
      kind: 'git';
      gitUrl: string;
      mainBranch?: string;
      groupFolder: string;
      name?: string;
    } & Partial<RemoteWorkspaceMeta>)
  | ({
      kind: 'device_path';
      devicePath: string;
      groupFolder: string;
      name?: string;
    } & Partial<RemoteWorkspaceMeta>)
  | ({
      kind: 'workspace';
      groupFolder: string;
      name?: string;
    } & Partial<RemoteWorkspaceMeta>);

function buildWorkspaceRepos(
  group: BackendRunArgs['group'],
  linkId: string,
  userId: string | undefined,
  meta?: RemoteWorkspaceMeta,
  options?: { includeRepos?: boolean },
): WorkspaceRepo[] {
  if (options?.includeRepos === false) return [];
  const workspaceFields = meta
    ? {
        agentId: meta.agentId,
        agentRoot: meta.agentRoot,
        workdirMode: meta.workdirMode,
        scope: meta.scope,
        scopeId: meta.scopeId,
        taskId: meta.taskId,
        taskRunId: meta.taskRunId,
      }
    : {};

  const managedRepos = userId ? listManagedReposByUser(userId) : [];
  const explicitVisibleRepoMode = group.visibleRepoMode;
  if (explicitVisibleRepoMode) {
    const sourceRepos =
      explicitVisibleRepoMode === 'selected'
        ? managedRepos.filter((repo) =>
            (group.visibleRepoIds ?? []).includes(repo.id),
          )
        : managedRepos;
    return managedReposToWorkspaceRepos(
      sourceRepos,
      group.folder,
      linkId,
      workspaceFields,
    );
  }

  // 指定单一 repo
  if (group.repoGitUrl) {
    return [
      {
        kind: 'git',
        name: deriveRepoNameFromGitUrl(group.repoGitUrl),
        gitUrl: group.repoGitUrl,
        mainBranch: group.repoMainBranch,
        groupFolder: group.folder,
        ...workspaceFields,
      },
    ];
  }
  if (group.repoDevicePath) {
    return [
      {
        kind: 'device_path',
        name: path.basename(path.normalize(group.repoDevicePath)) || undefined,
        devicePath: group.repoDevicePath,
        groupFolder: group.folder,
        ...workspaceFields,
      },
    ];
  }
  // 全部可见：枚举该用户所有 managed repo
  return managedReposToWorkspaceRepos(
    managedRepos,
    group.folder,
    linkId,
    workspaceFields,
  );
}

function managedReposToWorkspaceRepos(
  repos: ManagedRepo[],
  groupFolder: string,
  linkId: string,
  workspaceFields: Partial<RemoteWorkspaceMeta>,
): WorkspaceRepo[] {
  const out: WorkspaceRepo[] = [];
  const seen = new Set<string>();
  for (const r of repos) {
    if (r.kind === 'git' && r.gitUrl) {
      const key = `git:${r.gitUrl}:${r.mainBranch ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        kind: 'git',
        name: r.name || deriveRepoNameFromGitUrl(r.gitUrl),
        gitUrl: r.gitUrl,
        mainBranch: r.mainBranch,
        groupFolder,
        ...workspaceFields,
      });
    } else if (
      r.kind === 'device_path' &&
      r.devicePath &&
      r.deviceLinkId === linkId
    ) {
      const key = `device_path:${r.devicePath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        kind: 'device_path',
        name:
          r.name || path.basename(path.normalize(r.devicePath)) || undefined,
        devicePath: r.devicePath,
        groupFolder,
        ...workspaceFields,
      });
    }
  }
  return out;
}

function deriveRepoNameFromGitUrl(gitUrl: string): string {
  try {
    const u = new URL(gitUrl);
    // path like "/org/repo.git"
    let base = path.posix.basename(u.pathname);
    if (base.endsWith('.git')) base = base.slice(0, -4);
    if (base) return base;
  } catch {
    // fall through
  }
  // fallback: strip last path segment
  const m = gitUrl.match(/([^/:]+?)(?:\.git)?\/?$/);
  return m?.[1] || 'repo';
}

function safeWorkspaceScopeSegment(
  value: string | undefined,
  fallback: string,
): string {
  const cleaned = (value || '')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 96);
  return cleaned || fallback;
}

function buildStableWorkspaceScopeId(
  args: BackendRunArgs,
  cfg: HostCliDriverConfig,
  agentId: string,
): string | undefined {
  const { input, group } = args;
  if (input.isScheduledTask) return input.taskRunId;

  if (input.workspaceSessionId) {
    return safeWorkspaceScopeSegment(input.workspaceSessionId, 'session');
  }

  // Workspace scope must be rooted in the OctoDeck workspace/group, not the
  // transient chat channel. A single workspace may be driven from web/IM/etc.;
  // changing chatJid must not move the daemon cwd or split the ACP process key.
  const workspaceKey = group.folder;
  const readableWorkspace = safeWorkspaceScopeSegment(
    workspaceKey,
    group.folder || 'main',
  );
  const readableAgent = safeWorkspaceScopeSegment(agentId, cfg.backendId);
  const digest = crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        userId: group.created_by,
        groupFolder: group.folder,
        agentId,
        backendId: cfg.backendId,
        repoId: group.repoId,
        repoGitUrl: group.repoGitUrl,
        repoDevicePath: group.repoDevicePath,
      }),
    )
    .digest('hex')
    .slice(0, 12);

  return `octodeck-${readableWorkspace}-${readableAgent}-${digest}`;
}

function buildStableChatId(args: BackendRunArgs): string | undefined {
  const { input, group } = args;
  // Conversation-scoped chatId: same workspace can host multiple conversation
  // agents (kind:'conversation'), each must own its own daemon-side workdir
  // and ACP session. The daemon's acpConversationID/acpSessionProcessKey reads
  // metadata.chatId first, so it MUST encode the agentId — otherwise two
  // conversations under the same workspace collapse onto a single ACP session.
  // Prefer workspaceSessionId (already per-(folder, agentId)); else build a
  // virtual chatJid with the agentId suffix; else fall back to the legacy
  // single-conversation identifiers.
  if (input.workspaceSessionId) return input.workspaceSessionId;
  if (input.chatJid && input.agentId) {
    return `${input.chatJid}#agent:${input.agentId}`;
  }
  return (
    input.chatJid || input.taskRunId || input.messageTaskId || group.folder
  );
}

function buildRemoteSessionScopeId(
  args: BackendRunArgs,
  workspaceId: string | undefined,
): string | undefined {
  const { input } = args;
  if (input.isScheduledTask) return input.taskRunId;
  if (input.workspaceSessionId) {
    return safeWorkspaceScopeSegment(input.workspaceSessionId, 'session');
  }
  const chatId = buildStableChatId(args);
  return chatId || workspaceId;
}

function buildRemoteWorkspaceMeta(
  args: BackendRunArgs,
  cfg: HostCliDriverConfig,
): RemoteWorkspaceMeta {
  const { input, group } = args;
  const agentId = input.agentId || cfg.backendId;
  const scope: RemoteWorkspaceScope = input.isScheduledTask
    ? 'task'
    : group.is_home && !input.agentId
      ? 'direct_session'
      : 'session';
  const scopeId = buildStableWorkspaceScopeId(args, cfg, agentId);
  return {
    agentId,
    agentRoot: cfg.workdirMode === 'custom' ? cfg.workdir : undefined,
    workdirMode: cfg.workdirMode === 'custom' ? 'custom' : 'auto',
    scope,
    scopeId,
    taskId: input.isScheduledTask ? input.messageTaskId : undefined,
    taskRunId: input.isScheduledTask ? input.taskRunId : undefined,
  };
}

function supportsAgentRun(linkId: string, agentClientId?: string): boolean {
  if (!agentClientId) return false;
  const meta = getOnlineMeta(linkId);
  if (!meta?.capabilities?.includes('agent.run')) return false;
  const runtimes = meta.runtimes ?? [];
  if (runtimes.length === 0) return true;
  return runtimes.some(
    (runtime) =>
      runtime.agentClientId === agentClientId && runtime.status !== 'offline',
  );
}

function buildRemoteEnv(
  baseEnv: Record<string, string> | undefined,
  userId: string | undefined,
  deviceLinkId: string,
): Record<string, string> | undefined {
  const env: Record<string, string> = { ...(baseEnv ?? {}) };
  if (userId) {
    env.OCTODECK_AGENT_TOOL_TOKEN = createAgentToolToken(userId);
    const mcpServers = loadUserMcpServers(userId, { deviceLinkId });
    if (Object.keys(mcpServers).length > 0) {
      env.OCTODECK_USER_MCP_SERVERS_JSON = JSON.stringify(mcpServers);
    }
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

function cancelReasonFromSignal(
  signal: AbortSignal | undefined,
):
  | 'user_abort'
  | 'server_shutdown'
  | 'link_replaced'
  | 'timeout'
  | 'group_deleted' {
  return signal?.reason === 'timeout' ? 'timeout' : 'user_abort';
}

async function runViaAgentRuntime(opts: {
  args: BackendRunArgs;
  cfg: HostCliDriverConfig;
  linkId: string;
  agentClientId: string;
  session: AgentLinkSession;
  groupDir: string;
  logsDir: string;
  workspaceMeta: RemoteWorkspaceMeta;
  workspaceRepos: WorkspaceRepo[];
  runContext: Record<string, unknown>;
  timeoutMs: number;
  maxOutputBytes: number;
}): Promise<ContainerOutput> {
  const {
    args,
    cfg,
    linkId,
    agentClientId,
    session,
    groupDir,
    logsDir,
    workspaceMeta,
    workspaceRepos,
    runContext,
    timeoutMs,
    maxOutputBytes,
  } = opts;
  const { group, input, onProcess, onOutput } = args;
  const startTime = Date.now();
  const runId = newRunId();
  const processId = `${cfg.backendId}-${group.folder}-${linkId}-${agentClientId}-${startTime}`;
  const chatId = buildStableChatId(args);

  return new Promise<ContainerOutput>((resolve) => {
    let settled = false;
    let textAccum = '';
    let logAccum = '';
    let lastStatusMessage = '';
    let lastSessionId: string | undefined = input.sessionId;
    let usageEventSeen = false;
    let onAbort: (() => void) | undefined;
    const resolveOnce = (out: ContainerOutput): void => {
      if (settled) return;
      settled = true;
      if (onAbort) args.signal?.removeEventListener('abort', onAbort);
      unregisterAgentRun(runId);
      resolve(out);
    };
    const emitWrapped = async (output: ContainerOutput): Promise<void> => {
      if (!onOutput) return;
      try {
        await onOutput(output);
      } catch (err) {
        logger.error(
          { group: group.name, err },
          `${cfg.backendId} onOutput callback failed (agent-run)`,
        );
      }
    };

    const fakeProc = new EventEmitter() as ChildProcess & EventEmitter;
    Object.assign(fakeProc, {
      pid: undefined,
      stdin: null,
      stdout: null,
      stderr: null,
      stdio: [null, null, null] as unknown as ChildProcess['stdio'],
      killed: false,
      kill: (_signal?: NodeJS.Signals | number): boolean => {
        const s = getSession(linkId);
        if (s && s.state === 'open') {
          s.send({ type: 'agent.run.cancel', runId, reason: 'user_abort' });
        }
        return true;
      },
    });
    onAbort = () => {
      const s = getSession(linkId);
      if (s && s.state === 'open') {
        s.send({
          type: 'agent.run.cancel',
          runId,
          reason: cancelReasonFromSignal(args.signal),
        });
      }
    };
    args.signal?.addEventListener('abort', onAbort, { once: true });
    if (args.signal?.aborted) onAbort();
    onProcess(fakeProc, processId, null);

    const finalize = async (
      info:
        | {
            kind: 'result';
            ok: boolean;
            result?: string;
            error: string | null;
            sessionId?: string;
            usage?: Record<string, unknown>;
            timedOut: boolean;
            durationMs: number;
          }
        | { kind: 'fail'; reason: string },
    ): Promise<void> => {
      try {
        const ts = new Date(startTime).toISOString().replace(/[:.]/g, '-');
        const logFile = path.join(logsDir, `${cfg.backendId}-${ts}.log`);
        fs.writeFileSync(
          logFile,
          [
            `=== ${cfg.backendId} run ${processId} (via agent.run ${linkId}/${agentClientId}) ===`,
            `Group: ${group.name} (${group.folder})`,
            `Cwd: ${groupDir}`,
            `Agent: ${agentClientId}`,
            info.kind === 'result'
              ? `Result: ok=${info.ok} duration=${info.durationMs}ms timedOut=${info.timedOut}`
              : `Failed: ${info.reason}`,
            ``,
            `=== TEXT ===`,
            textAccum,
            ``,
            `=== LOG ===`,
            logAccum,
          ].join('\n'),
          { mode: 0o600 },
        );
      } catch (err) {
        logger.warn(
          { group: group.name, err },
          `${cfg.backendId} failed to write run log (agent-run)`,
        );
      }

      if (info.kind === 'fail') {
        const out: ContainerOutput = {
          status: 'error',
          result: `Agent Link ${linkId} 失败：${info.reason}`,
          error: `agent-run failed: ${info.reason}`,
          newSessionId: lastSessionId,
        };
        await emitWrapped(out);
        resolveOnce(out);
        return;
      }
      if (info.sessionId) lastSessionId = info.sessionId;
      if (info.usage && !usageEventSeen) {
        const usage = normalizeUsagePayload(info.usage, cfg.model);
        if (usage) {
          usageEventSeen = true;
          await emitWrapped({
            status: 'stream',
            result: null,
            newSessionId: lastSessionId,
            streamEvent: {
              eventType: 'usage',
              sessionId: lastSessionId,
              usage,
              detail: compactJson(info.usage) ?? undefined,
              rawEvent: info.usage,
            },
          });
        }
      }
      if (info.timedOut) {
        const out: ContainerOutput = {
          status: 'error',
          result: `${cfg.backendId} 执行超时（${Math.round(info.durationMs / 1000)}s）`,
          error: `${cfg.backendId} timeout after ${info.durationMs}ms (agent-run)`,
          newSessionId: lastSessionId,
        };
        await emitWrapped(out);
        resolveOnce(out);
        return;
      }
      const resultText =
        (info.result ?? textAccum.trimEnd()) || lastStatusMessage;
      const cleanError = info.error ? extractErrorMessage(info.error) : '';
      const out: ContainerOutput = info.ok
        ? { status: 'success', result: resultText, newSessionId: lastSessionId }
        : {
            status: 'error',
            result: resultText || cleanError || `${cfg.backendId} 返回错误`,
            error:
              cleanError || resultText || `${cfg.backendId} reported failure`,
            newSessionId: lastSessionId,
          };
      await emitWrapped(out);
      resolveOnce(out);
    };

    const timer = setTimeout(() => {
      logger.error(
        { group: group.name, runId, linkId, agentClientId },
        `${cfg.backendId} agent-run timeout, sending agent.run.cancel`,
      );
      const s = getSession(linkId);
      if (s && s.state === 'open') {
        s.send({ type: 'agent.run.cancel', runId, reason: 'timeout' });
      }
      setTimeout(() => {
        if (!settled) void finalize({ kind: 'fail', reason: 'server_timeout' });
      }, 5_000);
    }, timeoutMs);

    const controller: AgentRunController = {
      runId,
      linkId,
      onEvent(frame) {
        if (frame.sessionId) lastSessionId = frame.sessionId;
        if (frame.eventType === 'log') {
          if (frame.text && logAccum.length < 20000) {
            logAccum += frame.text.slice(0, 20000 - logAccum.length);
          }
          return;
        }
        // 'final_result' 是 daemon 在解析到 stream-json 中的 {"type":"result"}
        // 时为「单 shot CLI 兜底」发出的事件（daemon 已经保证：当流式 text_delta
        // 已存在时不会再发 final_result 的副本）。这里只做累积兜底，不再下发
        // 重复的 stream event 给 UI。
        if (frame.eventType === 'final_result') {
          if (frame.text && textAccum.length === 0) {
            textAccum = frame.text.slice(0, maxOutputBytes);
          }
          return;
        }
        const structuredEvent = streamEventFromAgentRunFrame(frame, cfg.model);
        if (structuredEvent) {
          if (structuredEvent.eventType === 'usage' && structuredEvent.usage) {
            usageEventSeen = true;
          }
          void emitWrapped({
            status: 'stream',
            result: null,
            newSessionId: lastSessionId,
            streamEvent: structuredEvent,
          });
        }
        if (
          frame.text &&
          (frame.eventType === 'text_delta' ||
            frame.eventType === 'thinking_delta')
        ) {
          if (
            frame.eventType !== 'thinking_delta' &&
            textAccum.length < maxOutputBytes
          ) {
            textAccum += frame.text.slice(0, maxOutputBytes - textAccum.length);
          }
          void emitWrapped({
            status: 'stream',
            result: null,
            newSessionId: lastSessionId,
            streamEvent: {
              eventType:
                frame.eventType === 'thinking_delta'
                  ? 'thinking_delta'
                  : 'text_delta',
              text: frame.text,
              sessionId: lastSessionId,
            },
          });
        }
      },
      onStatus(status) {
        if (status.message) lastStatusMessage = status.message;
      },
      finish(result) {
        clearTimeout(timer);
        void finalize({
          kind: 'result',
          ok: result.ok,
          result: result.result,
          error: result.error,
          sessionId: result.sessionId,
          usage: result.usage,
          timedOut: result.timedOut,
          durationMs: result.durationMs,
        });
      },
      fail(reason) {
        clearTimeout(timer);
        void finalize({ kind: 'fail', reason });
      },
    };

    registerAgentRun(controller);
    const remoteEnv = buildRemoteEnv(
      cfg.envOverrides,
      group.created_by,
      linkId,
    );
    const primaryRepo = workspaceRepos[0];
    const remoteWorkspaceFolder =
      input.isScheduledTask && !input.scheduledTaskHasWorkspace
        ? ''
        : group.folder;
    const workspaceId = remoteWorkspaceFolder || group.folder;
    const sessionScopeId = buildRemoteSessionScopeId(args, workspaceId);
    const workspacePayload: Record<string, unknown> = {
      kind: 'workspace',
      cwd: groupDir,
      folder: remoteWorkspaceFolder,
      ...workspaceMeta,
      scopeId:
        workspaceMeta.scope === 'session' ||
        workspaceMeta.scope === 'direct_session'
          ? sessionScopeId
          : workspaceMeta.scopeId,
    };
    if (workspaceRepos.length > 0) {
      workspacePayload.repos = workspaceRepos;
    }
    const ok = session.send({
      type: 'agent.run.request',
      id: 0,
      runId,
      agentId: agentClientId,
      workspace: workspacePayload,
      input: {
        prompt: input.prompt,
        sessionId: input.sessionId,
        metadata: {
          scheduledTask: !!input.isScheduledTask,
          workspaceId,
          workspaceSessionId: input.workspaceSessionId,
          groupFolder: group.folder,
          chatId,
          conversationId: chatId,
          sessionKey: chatId,
          chatJid: input.chatJid,
        },
      },
      cwd: groupDir,
      env: remoteEnv,
      timeoutMs,
      maxOutputBytes,
      policy: buildAgentRunPolicy(cfg, input, group, agentClientId, group.created_by),
      context: runContext,
      remoteCwdPlaceholder: REMOTE_CWD_PLACEHOLDER,
      workspaceRepos: workspaceRepos.length > 0 ? workspaceRepos : undefined,
      workspaceRepo: primaryRepo,
    });
    if (!ok) {
      clearTimeout(timer);
      void finalize({ kind: 'fail', reason: 'send_failed' });
    }
  });
}

/**
 * Run a host-mode CLI on a remote octodeck-daemon and return a ContainerOutput.
 * Returns a synthetic `not online` error result if the link isn't connected,
 * letting the caller decide whether to fall back to server-local.
 */
export async function runViaAgentLink(
  args: BackendRunArgs,
  cfg: HostCliDriverConfig,
  target: string,
): Promise<ContainerOutput> {
  const { group, input, onProcess, onOutput } = args;

  const resolvedTarget = parseAgentLinkTarget(target, group.created_by);
  const linkId = resolvedTarget?.linkId ?? target;

  const session = getSession(linkId);
  if (!session || session.state !== 'open') {
    return {
      status: 'error',
      result: `Agent Link ${linkId} 离线`,
      error: `agent-link ${linkId} not online`,
    };
  }

  // 1. Server-side cwd: keep run logs locally; remote daemon will resolve its
  //    own cwd from this path. Only enforce absolute + existence on server.
  //    优先用 group.folder 派生独立 workspace URI，避免多个 workspace 共享
  //    agent 默认目录（原先 fallback 到 agentId 会让所有无 repo workspace
  //    落在同一个 .octodeck/workspace/<agentId>/）。
  const defaultGroupDir = path.join(GROUPS_DIR, group.folder);
  fs.mkdirSync(defaultGroupDir, { recursive: true });
  const workspaceMeta = buildRemoteWorkspaceMeta(args, cfg);
  const workspaceRepos = buildWorkspaceRepos(
    group,
    linkId,
    group.created_by,
    workspaceMeta,
    {
      includeRepos: !input.isScheduledTask || !!input.scheduledTaskHasWorkspace,
    },
  );
  const remoteWorkspaceFolder =
    input.isScheduledTask && !input.scheduledTaskHasWorkspace
      ? ''
      : group.folder;
  const groupDir =
    (group.agentAccessScope ?? 'all') === 'workspace'
      ? `${DEVICE_WORKSPACE_URI_PREFIX}${remoteWorkspaceFolder || group.folder}`
      : group.customCwd ||
        workspaceMeta.agentRoot ||
        `${DEVICE_WORKSPACE_URI_PREFIX}${remoteWorkspaceFolder || group.folder}`;
  if (
    !path.isAbsolute(groupDir) &&
    !groupDir.startsWith(DEVICE_WORKSPACE_URI_PREFIX)
  ) {
    return {
      status: 'error',
      result: `${cfg.backendId} 后端启动失败：工作目录必须是绝对路径：${groupDir}`,
      error: `non-absolute cwd: ${groupDir}`,
    };
  }
  const logsDir = path.join(defaultGroupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  const contextCwd =
    workspaceRepos.length > 0 ||
    groupDir.startsWith(DEVICE_WORKSPACE_URI_PREFIX)
      ? REMOTE_CWD_PLACEHOLDER
      : groupDir;
  const runContext = buildRunContext(args, cfg, contextCwd);
  const workspaceOnlySpec: WorkspaceRepo = {
    kind: 'workspace',
    groupFolder: group.folder,
    agentId: workspaceMeta.agentId,
    agentRoot: workspaceMeta.agentRoot,
    workdirMode: workspaceMeta.workdirMode,
    scope: workspaceMeta.scope,
    scopeId: workspaceMeta.scopeId,
    taskId: workspaceMeta.taskId,
    taskRunId: workspaceMeta.taskRunId,
  };

  const settings = getSystemSettings();
  const configuredTimeoutMs =
    group.containerConfig?.timeout && group.containerConfig.timeout > 0
      ? group.containerConfig.timeout
      : cfg.timeoutMs && cfg.timeoutMs > 0
        ? cfg.timeoutMs
        : undefined;
  const timeoutMs =
    configuredTimeoutMs ||
    (input.isScheduledTask
      ? Math.max(settings.containerTimeout, LONG_RUNNING_LOCAL_CLI_TIMEOUT_MS)
      : settings.containerTimeout);
  const maxOutputBytes =
    (cfg.maxOutputBytes && cfg.maxOutputBytes > 0 ? cfg.maxOutputBytes : 0) ||
    settings.containerMaxOutputSize;

  if (supportsAgentRun(linkId, resolvedTarget?.agentClientId)) {
    return runViaAgentRuntime({
      args,
      cfg,
      linkId,
      agentClientId: resolvedTarget!.agentClientId!,
      session,
      groupDir,
      logsDir,
      workspaceMeta,
      workspaceRepos,
      runContext,
      timeoutMs,
      maxOutputBytes,
    });
  }

  // 2. binary
  // Remote runs must use the binary path as seen by the daemon/device. For
  // device-discovered custom CLIs this can be an absolute path that does not
  // exist on the server, so do not run the local existence check here.
  const binary = cfg.resolveRemoteBinary?.() ?? cfg.resolveBinary();
  if (!binary) {
    return {
      status: 'error',
      result: `${cfg.backendId} 后端启动失败：未找到可执行文件`,
      error: `${cfg.backendId} binary not found`,
    };
  }
  // 3. argv
  let argv: string[];
  try {
    const promptForArgv = shouldInlineSystemPromptForLegacyDeviceCli(
      resolvedTarget?.agentClientId,
    )
      ? buildDeviceCliUserPromptWithSystemContext(input, group, group.created_by)
      : input.prompt;
    argv = cfg.buildArgv({
      prompt: promptForArgv,
      sessionId: input.sessionId,
      cwd: REMOTE_CWD_PLACEHOLDER,
      folder: group.folder,
      backendId: cfg.backendId,
    });
    if (shouldDisableAgentTeamMcp(input, group.folder)) {
      argv = stripAgentTeamMcpConfigArgs(argv);
    }
    argv = appendClaudeCodeSystemPromptArg(
      argv,
      resolvedTarget?.agentClientId,
      input,
      group,
      group.created_by,
    );
    argv = applyAgentPermissionArgs(
      argv,
      resolvedTarget?.agentClientId ?? cfg.agentClientId ?? cfg.backendId,
      group.permissionMode ?? cfg.permissionMode,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: 'error',
      result: `${cfg.backendId} 后端启动失败：构建参数出错：${msg}`,
      error: `${cfg.backendId} buildArgv error: ${msg}`,
    };
  }
  const startTime = Date.now();
  const runId = newRunId();
  const processId = `${cfg.backendId}-${group.folder}-${linkId}-${startTime}`;

  return new Promise<ContainerOutput>((resolve) => {
    let settled = false;
    let onAbort: (() => void) | undefined;
    const resolveOnce = (out: ContainerOutput): void => {
      if (settled) return;
      settled = true;
      if (onAbort) args.signal?.removeEventListener('abort', onAbort);
      unregisterRun(runId);
      resolve(out);
    };

    let buf = '';
    let stdoutAccum = '';
    let stderrAccum = '';
    let lastStatusMessage = '';
    let finalUsage: Record<string, unknown> | undefined;
    let usageEventSeen = false;
    const state: ParseState = {
      finalResultText: null,
      finalIsError: false,
      lastSessionId: undefined,
      lastAssistantText: null,
    };

    const emitWrapped = async (output: ContainerOutput): Promise<void> => {
      if (!onOutput) return;
      try {
        await onOutput(output);
      } catch (err) {
        logger.error(
          { group: group.name, err },
          `${cfg.backendId} onOutput callback failed (agent-link)`,
        );
      }
    };

    const fakeProc = new EventEmitter() as ChildProcess & EventEmitter;
    Object.assign(fakeProc, {
      pid: undefined,
      stdin: null,
      stdout: null,
      stderr: null,
      stdio: [null, null, null] as unknown as ChildProcess['stdio'],
      killed: false,
      kill: (_signal?: NodeJS.Signals | number): boolean => {
        const s = getSession(linkId);
        if (s && s.state === 'open') {
          s.send({ type: 'run.cancel', runId, reason: 'user_abort' });
        }
        return true;
      },
    });

    onAbort = () => {
      const s = getSession(linkId);
      if (s && s.state === 'open') {
        s.send({
          type: 'run.cancel',
          runId,
          reason: cancelReasonFromSignal(args.signal),
        });
      }
    };
    args.signal?.addEventListener('abort', onAbort, { once: true });
    if (args.signal?.aborted) onAbort();

    onProcess(fakeProc, processId, null);

    const handleStdoutChunk = (chunk: string): void => {
      if (stdoutAccum.length < maxOutputBytes) {
        stdoutAccum += chunk.slice(0, maxOutputBytes - stdoutAccum.length);
      }
      if (cfg.outputProtocol !== 'jsonline-stream-json') return;
      buf += chunk;
      let nl = buf.indexOf('\n');
      while (nl !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const evt = parseEvent(line);
        if (evt) {
          if (evt.session_id) state.lastSessionId = evt.session_id;
          const usagePayload = usagePayloadFromCocoEvent(evt);
          if (usagePayload) finalUsage = usagePayload;
          const structuredEvent = streamEventFromCocoEvent(evt);
          if (structuredEvent) {
            if (structuredEvent.eventType === 'usage' && structuredEvent.usage) {
              usageEventSeen = true;
            }
            void emitWrapped({
              status: 'stream',
              result: null,
              newSessionId: state.lastSessionId,
              streamEvent: structuredEvent,
            });
          }
          const assistantText = extractAssistantText(evt);
          if (assistantText) {
            state.lastAssistantText = `${state.lastAssistantText ?? ''}${assistantText}`;
            void emitWrapped({
              status: 'stream',
              result: null,
              newSessionId: state.lastSessionId,
              streamEvent: {
                eventType: 'text_delta',
                text: assistantText,
                sessionId: state.lastSessionId,
              },
            });
          }
          if (evt.type === 'result') {
            if (typeof evt.result === 'string') {
              state.finalResultText = evt.result;
            }
            state.finalIsError = !!evt.is_error;
          }
        }
        nl = buf.indexOf('\n');
      }
    };

    const finalize = async (
      info:
        | {
            kind: 'result';
            exitCode: number | null;
            signal: string | null;
            timedOut: boolean;
            durationMs: number;
            usage?: Record<string, unknown>;
          }
        | { kind: 'fail'; reason: string },
    ): Promise<void> => {
      // Persist run log
      try {
        const ts = new Date(startTime).toISOString().replace(/[:.]/g, '-');
        const logFile = path.join(logsDir, `${cfg.backendId}-${ts}.log`);
        fs.writeFileSync(
          logFile,
          [
            `=== ${cfg.backendId} run ${processId} (via agent-link ${linkId}) ===`,
            `Group: ${group.name} (${group.folder})`,
            `Cwd: ${groupDir}`,
            `Args: ${argv.join(' ')}`,
            info.kind === 'result'
              ? `Exit: code=${info.exitCode} signal=${info.signal} duration=${info.durationMs}ms timedOut=${info.timedOut}`
              : `Failed: ${info.reason}`,
            ``,
            `=== STDOUT ===`,
            stdoutAccum,
            ``,
            `=== STDERR ===`,
            stderrAccum,
          ].join('\n'),
          { mode: 0o600 },
        );
      } catch (err) {
        logger.warn(
          { group: group.name, err },
          `${cfg.backendId} failed to write run log (agent-link)`,
        );
      }

      if (info.kind === 'fail') {
        const out: ContainerOutput = {
          status: 'error',
          result: `Agent Link ${linkId} 失败：${info.reason}`,
          error: `agent-link run failed: ${info.reason}`,
          newSessionId: state.lastSessionId,
        };
        await emitWrapped(out);
        resolveOnce(out);
        return;
      }

      const { exitCode, signal, timedOut, durationMs } = info;

      if (info.kind === 'result' && info.usage) {
        finalUsage = info.usage;
      }
      if (finalUsage && !usageEventSeen) {
        const usage = normalizeUsagePayload(finalUsage, cfg.model);
        if (usage) {
          usageEventSeen = true;
          await emitWrapped({
            status: 'stream',
            result: null,
            newSessionId: state.lastSessionId,
            streamEvent: {
              eventType: 'usage',
              sessionId: state.lastSessionId,
              usage,
              detail: compactJson(finalUsage) ?? undefined,
              rawEvent: finalUsage,
            },
          });
        }
      }

      if (timedOut) {
        const out: ContainerOutput = {
          status: 'error',
          result: `${cfg.backendId} 执行超时（${Math.round(durationMs / 1000)}s）`,
          error: `${cfg.backendId} timeout after ${durationMs}ms (agent-link)`,
          newSessionId: state.lastSessionId,
        };
        await emitWrapped(out);
        resolveOnce(out);
        return;
      }

      if (
        exitCode !== 0 &&
        state.finalResultText === null &&
        cfg.outputProtocol !== 'plain-text'
      ) {
        const tail =
          stderrAccum.slice(-400) ||
          stdoutAccum.slice(-400) ||
          lastStatusMessage;
        const suffix = tail ? `：${tail}` : '';
        const out: ContainerOutput = {
          status: 'error',
          result: `${cfg.backendId} 进程退出 code=${exitCode}${suffix}`,
          error: `${cfg.backendId} exit code=${exitCode} signal=${signal}: ${tail}`,
          newSessionId: state.lastSessionId,
        };
        await emitWrapped(out);
        resolveOnce(out);
        return;
      }

      let text: string;
      let isErr: boolean;
      if (cfg.outputProtocol === 'plain-text') {
        text =
          stdoutAccum.trimEnd() || stderrAccum.trimEnd() || lastStatusMessage;
        isErr = exitCode !== 0;
        if (isErr && !text) {
          text = `${cfg.backendId} 进程退出 code=${exitCode}`;
        }
      } else {
        text = state.finalResultText ?? state.lastAssistantText ?? '';
        isErr = state.finalIsError;
      }

      const out: ContainerOutput = isErr
        ? {
            status: 'error',
            result: text || `${cfg.backendId} 返回错误`,
            error:
              text || `${cfg.backendId} reported failure (code=${exitCode})`,
            newSessionId: state.lastSessionId,
          }
        : {
            status: 'success',
            result: text,
            newSessionId: state.lastSessionId,
          };
      await emitWrapped(out);
      resolveOnce(out);
    };

    // Server-side timeout watchdog (in case remote never sends run.result).
    const timer = setTimeout(() => {
      logger.error(
        { group: group.name, runId, linkId },
        `${cfg.backendId} agent-link timeout, sending run.cancel`,
      );
      const s = getSession(linkId);
      if (s && s.state === 'open') {
        s.send({ type: 'run.cancel', runId, reason: 'timeout' });
      }
      // Still wait for result; if it doesn't come within 5s, fail manually.
      setTimeout(() => {
        if (!settled) {
          void finalize({ kind: 'fail', reason: 'server_timeout' });
        }
      }, 5_000);
    }, timeoutMs);

    const controller: RunController = {
      runId,
      linkId,
      onChunk(stream, data) {
        if (stream === 'stderr') {
          if (stderrAccum.length < 20000) {
            stderrAccum += data.slice(0, 20000 - stderrAccum.length);
          }
        } else {
          handleStdoutChunk(data);
        }
      },
      onStatus(status) {
        if (status.message) lastStatusMessage = status.message;
      },
      finish(result) {
        clearTimeout(timer);
        void finalize({ kind: 'result', ...result });
      },
      fail(reason) {
        clearTimeout(timer);
        void finalize({ kind: 'fail', reason });
      },
    };

    registerRun(controller);

    const remoteEnv = buildRemoteEnv(
      cfg.envOverrides,
      group.created_by,
      linkId,
    );
    const ok = session.send({
      type: 'run.request',
      id: 0,
      runId,
      backendId: cfg.backendId,
      binary,
      argv,
      cwd: groupDir,
      env: remoteEnv,
      outputProtocol: cfg.outputProtocol,
      timeoutMs,
      maxOutputBytes,
      context: runContext,
      stdinJson: JSON.stringify(input),
      remoteCwdPlaceholder: REMOTE_CWD_PLACEHOLDER,
      workspaceRepos: workspaceRepos.length > 0 ? workspaceRepos : undefined,
      workspaceRepo: workspaceRepos[0] ?? workspaceOnlySpec,
    });
    if (!ok) {
      clearTimeout(timer);
      void finalize({ kind: 'fail', reason: 'send_failed' });
    }
  });
}
