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
  name?: string;
  id?: string;
  tool_use_id?: string;
  input?: unknown;
  content?: unknown;
  delta?: { role?: string; content?: string };
  message?: {
    role?: string;
    content?: string | Array<Record<string, unknown>>;
  };
}

const TOOL_RESULT_NAME_BY_ID = new Map<string, string>();

function compactJson(value: unknown, max = 2000): string | null {
  if (value === undefined || value === null) return null;
  const text =
    typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return text.length > max ? `${text.slice(0, max)}…` : text;
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

function normalizeUsagePayload(
  payload: Record<string, unknown> | undefined,
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
      'promptTokens',
      'prompt_tokens',
    ),
    outputTokens: num(
      'outputTokens',
      'output_tokens',
      'completionTokens',
      'completion_tokens',
    ),
    cacheReadInputTokens: num(
      'cacheReadInputTokens',
      'cache_read_input_tokens',
    ),
    cacheCreationInputTokens: num(
      'cacheCreationInputTokens',
      'cache_creation_input_tokens',
    ),
    costUSD: num('costUSD', 'cost_usd', 'cost'),
    durationMs: num('durationMs', 'duration_ms'),
    numTurns: num('numTurns', 'num_turns'),
  };
  if (!Object.values(normalized).some((value) => value > 0)) return undefined;
  return normalized;
}

function streamEventFromAgentRunFrame(frame: {
  eventType: string;
  text?: string;
  sessionId?: string;
  payload?: Record<string, unknown>;
}): StreamEvent | null {
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
    return {
      eventType: 'permission_denied',
      sessionId: frame.sessionId,
      detail: compactJson(frame.payload) ?? undefined,
      rawEvent: frame.payload,
    };
  }
  if (frame.eventType === 'usage') {
    return {
      eventType: 'usage',
      sessionId: frame.sessionId,
      usage: normalizeUsagePayload(frame.payload),
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
const MAIN_CONVERSATION_SCOPE_ID = 'main';

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
): string | undefined {
  const channel = getChannelFromJid(input.currentSourceJid || input.chatJid);
  const cacheKey = JSON.stringify({
    isHome: !!input.isHome,
    channel,
    hasAgentOverride: !!input.agentId,
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
      `<guidelines>\n${outputGuidelines}\n${webFetchGuidelines}\n${backgroundTaskGuidelines}\n</guidelines>`,
      ...(channelGuidelines
        ? [`<channel-format>\n${channelGuidelines}\n</channel-format>`]
        : []),
      ...(input.agentId
        ? [
            `<agent-override>\n${loadPromptFile('agent-override.md')}\n</agent-override>`,
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
): Record<string, unknown> {
  const policy: Record<string, unknown> = {};
  if (cfg.model) policy.model = cfg.model;
  const systemPrompt = buildDeviceCliSystemPrompt(input);
  if (systemPrompt) policy.systemPrompt = systemPrompt;
  return policy;
}

function appendClaudeCodeSystemPromptArg(
  argv: string[],
  agentClientId: string | undefined,
  input: BackendRunArgs['input'],
): string[] {
  if (agentClientId !== 'claude-code') return argv;
  if (argv.includes('--append-system-prompt')) return argv;
  const systemPrompt = buildDeviceCliSystemPrompt(input);
  if (!systemPrompt) return argv;
  return [...argv, '--append-system-prompt', systemPrompt];
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
  const scopeId = input.isScheduledTask
    ? input.taskRunId
    : input.agentId || MAIN_CONVERSATION_SCOPE_ID;
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
  return !!meta?.capabilities?.includes('agent.run');
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

  return new Promise<ContainerOutput>((resolve) => {
    let settled = false;
    let textAccum = '';
    let logAccum = '';
    let lastStatusMessage = '';
    let lastSessionId: string | undefined = input.sessionId;
    const resolveOnce = (out: ContainerOutput): void => {
      if (settled) return;
      settled = true;
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
    onProcess(fakeProc, processId, null);

    const finalize = async (
      info:
        | {
            kind: 'result';
            ok: boolean;
            result?: string;
            error: string | null;
            sessionId?: string;
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
      const out: ContainerOutput = info.ok
        ? { status: 'success', result: resultText, newSessionId: lastSessionId }
        : {
            status: 'error',
            result: resultText || info.error || `${cfg.backendId} 返回错误`,
            error:
              info.error || resultText || `${cfg.backendId} reported failure`,
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
        const structuredEvent = streamEventFromAgentRunFrame(frame);
        if (structuredEvent) {
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
    const workspacePayload: Record<string, unknown> = {
      kind: 'workspace',
      cwd: groupDir,
      folder: remoteWorkspaceFolder,
      ...workspaceMeta,
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
        metadata: { scheduledTask: !!input.isScheduledTask },
      },
      cwd: groupDir,
      env: remoteEnv,
      timeoutMs,
      maxOutputBytes,
      policy: buildAgentRunPolicy(cfg, input),
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
    group.customCwd ||
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
    groupFolder: remoteWorkspaceFolder,
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
    argv = cfg.buildArgv({
      prompt: input.prompt,
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
    const resolveOnce = (out: ContainerOutput): void => {
      if (settled) return;
      settled = true;
      unregisterRun(runId);
      resolve(out);
    };

    let buf = '';
    let stdoutAccum = '';
    let stderrAccum = '';
    let lastStatusMessage = '';
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
          const structuredEvent = streamEventFromCocoEvent(evt);
          if (structuredEvent) {
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
