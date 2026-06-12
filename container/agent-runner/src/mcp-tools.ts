/**
 * MCP Tool Definitions for OctoDeck Agent Runner.
 *
 * Uses SDK's `tool()` helper to define in-process MCP tools.
 * These tools communicate with the host process via IPC files.
 *
 * Context (chatJid, groupFolder, etc.) is passed via McpContext
 * rather than read from environment variables, enabling in-process usage.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

/** Context required by MCP tools. Passed at construction time. */
export interface McpContext {
  chatJid: string;
  groupFolder: string;
  isHome: boolean;
  isAdminHome: boolean;
  isScheduledTask?: boolean;
  /** Mutable: set when the current IPC turn was triggered by a task prompt.
   * Cleared between turns by the agent-runner main loop so that regular
   * follow-up messages aren't misattributed to the prior task. */
  currentTaskId?: string | null;
  workspaceIpc: string;
  workspaceGroup: string;
  workspaceGlobal: string;
  workspaceMemory: string;
  /** Owner user id for 云端模式 cloud memory tools. */
  ownerUserId?: string;
  /** Base URL and secret for cloud memory DB bridge. */
  serverBaseUrl?: string;
  agentRunnerSecret?: string;
  agentToolToken?: string;
  // 禁用 OctoDeck 的 memory MCP 工具（memory_append/search/get），
  // 让 Agent 完全按用户本机 ~/.claude/ 下的 Playbook 约定管理记忆
  disableMemoryLayer?: boolean;
}

const RoleAssignmentsSchema = z.record(z.string(), z.object({
  runnerAgentId: z.string(),
  linkId: z.string().optional(),
  agentClientId: z.string().optional(),
}));

async function invokeCloudMemory(ctx: McpContext, payload: Record<string, unknown>): Promise<any> {
  if (!ctx.ownerUserId) throw new Error('ownerUserId is required for cloud memory tools');
  const baseUrl = ctx.serverBaseUrl || process.env.OCTODECK_SERVER_URL || 'http://127.0.0.1:3000';
  const secret = ctx.agentToolToken || ctx.agentRunnerSecret || process.env.OCTODECK_AGENT_TOOL_TOKEN || process.env.OCTODECK_AGENT_RUNNER_SECRET || '';
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/cloud-memory/tool`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({ userId: ctx.ownerUserId, ...payload }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `cloud_memory_http_${res.status}`);
  return data;
}

async function invokeCloudSkill(ctx: McpContext, payload: Record<string, unknown>): Promise<any> {
  if (!ctx.ownerUserId) throw new Error('ownerUserId is required for cloud skill tools');
  const baseUrl = ctx.serverBaseUrl || process.env.OCTODECK_SERVER_URL || 'http://127.0.0.1:3000';
  const secret = ctx.agentToolToken || ctx.agentRunnerSecret || process.env.OCTODECK_AGENT_TOOL_TOKEN || process.env.OCTODECK_AGENT_RUNNER_SECRET || '';
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/cloud-skills/tool`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({ userId: ctx.ownerUserId, ...payload }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `cloud_skill_http_${res.status}`);
  return data;
}

async function invokeAgentTeamTool(ctx: McpContext, payload: Record<string, unknown>): Promise<any> {
  if (!ctx.ownerUserId) throw new Error('ownerUserId is required for agent team tools');
  const baseUrl = ctx.serverBaseUrl || process.env.OCTODECK_SERVER_URL || 'http://127.0.0.1:3000';
  const secret = ctx.agentRunnerSecret || process.env.OCTODECK_AGENT_RUNNER_SECRET || '';
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/agent-teams/tool`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({ userId: ctx.ownerUserId, ...payload }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `agent_team_http_${res.status}`);
  return data;
}

async function invokeRepoKnowledgeTool(ctx: McpContext, payload: Record<string, unknown>): Promise<any> {
  if (!ctx.ownerUserId) throw new Error('ownerUserId is required for repo knowledge tools');
  const baseUrl = ctx.serverBaseUrl || process.env.OCTODECK_SERVER_URL || 'http://127.0.0.1:3000';
  const secret = ctx.agentToolToken || ctx.agentRunnerSecret || process.env.OCTODECK_AGENT_TOOL_TOKEN || process.env.OCTODECK_AGENT_RUNNER_SECRET || '';
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/repo-knowledge/tool`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({ userId: ctx.ownerUserId, ...payload }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `repo_knowledge_http_${res.status}`);
  return data;
}

function toolJson(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function toolError(err: unknown) {
  return { content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }], isError: true };
}

function isNestedAgentTeamContext(ctx: McpContext): boolean {
  return ctx.chatJid.startsWith('system:agent-team:') || ctx.groupFolder.startsWith('agent-team-');
}

function writeIpcFile(dir: string, data: object): string {
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);
  const tempPath = `${filepath}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    // Atomic write: temp file then rename
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
    fs.renameSync(tempPath, filepath);
  } catch (err) {
    // Clean up temp file on failure
    try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
    throw new Error(`IPC 写入失败 (${dir}): ${err instanceof Error ? err.message : String(err)}`);
  }
  return filename;
}

/**
 * Send an IPC request and poll for the result file.
 * Fixes TOCTOU by directly attempting readFileSync and catching ENOENT.
 * Returns the parsed JSON result, or throws on timeout.
 */
async function pollIpcResult(
  dir: string,
  data: Record<string, unknown> & { requestId: string },
  resultFilePrefix: string,
  timeoutMs: number = 30_000,
): Promise<Record<string, unknown>> {
  const resultFileName = `${resultFilePrefix}_${data.requestId}.json`;
  const resultFilePath = path.join(dir, resultFileName);

  writeIpcFile(dir, data);

  const pollInterval = 500;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const raw = fs.readFileSync(resultFilePath, 'utf-8');
      fs.unlinkSync(resultFilePath);
      return JSON.parse(raw) as Record<string, unknown>;
    } catch (err) {
      // File not ready yet — only swallow ENOENT
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }
  throw new Error(`Timeout waiting for IPC result (${timeoutMs / 1000}s)`);
}

function newRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// --- Memory helpers ---
const MEMORY_EXTENSIONS = new Set(['.md', '.txt']);
const MEMORY_SUBDIRS = new Set(['memory', 'conversations']);
const MEMORY_SKIP_DIRS = new Set(['logs', '.claude', 'node_modules', '.git']);
const MAX_MEMORY_FILE_SIZE = 512 * 1024; // 512KB per file
const MAX_MEMORY_APPEND_SIZE = 16 * 1024; // 16KB per append
const MEMORY_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function normalizeMemoryRelativePath(input: string): string {
  const normalized = input.replace(/\\/g, '/').trim().replace(/^\/+/, '');
  if (!normalized || normalized.includes('\0')) {
    throw new Error('Invalid memory path');
  }
  const parts = normalized.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Invalid memory path');
  }
  return normalized;
}

function writeWorkspaceMemoryMirror(ctx: McpContext, memory: any): void {
  if (!memory || typeof memory.path !== 'string' || typeof memory.content !== 'string') return;
  const relativePath = normalizeMemoryRelativePath(memory.path);
  const target = path.resolve(ctx.workspaceMemory, relativePath);
  const root = path.resolve(ctx.workspaceMemory);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error('Invalid memory mirror path');
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, memory.content, 'utf-8');
}

function shouldMirrorWorkspaceMemory(ctx: McpContext, memory: any): boolean {
  return Boolean(
    memory &&
    memory.memoryType === 'session' &&
    (memory.groupFolder === ctx.groupFolder || memory.scopeKey === `session:${ctx.groupFolder}`),
  );
}

async function syncWorkspaceMemoryMirror(ctx: McpContext): Promise<{ synced: number }> {
  const data = await invokeCloudMemory(ctx, {
    operation: 'list',
    memoryType: 'session',
    groupFolder: ctx.groupFolder,
    limit: 500,
  });
  const memories: any[] = Array.isArray(data?.memories) ? data.memories : [];
  let synced = 0;
  for (const memory of memories) {
    try {
      writeWorkspaceMemoryMirror(ctx, memory);
      synced += 1;
    } catch {
      // Skip invalid/unsafe paths from old data without failing agent startup/tool call.
    }
  }
  return { synced };
}

function collectMemoryFiles(
  baseDir: string,
  out: string[],
  maxDepth: number,
  depth = 0,
): void {
  if (depth > maxDepth || !fs.existsSync(baseDir)) return;
  try {
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(baseDir, entry.name);
      if (entry.isDirectory()) {
        if (MEMORY_SKIP_DIRS.has(entry.name)) continue;
        if (depth === 0 || MEMORY_SUBDIRS.has(entry.name)) {
          collectMemoryFiles(fullPath, out, maxDepth, depth + 1);
        }
      } else if (entry.isFile()) {
        if (
          entry.name === 'CLAUDE.md' ||
          MEMORY_EXTENSIONS.has(path.extname(entry.name))
        ) {
          out.push(fullPath);
        }
      }
    }
  } catch {
    /* skip unreadable */
  }
}

function createToRelativePath(ctx: McpContext) {
  return (filePath: string): string => {
    if (
      filePath === ctx.workspaceGlobal ||
      filePath.startsWith(ctx.workspaceGlobal + path.sep)
    ) {
      return `[global] ${path.relative(ctx.workspaceGlobal, filePath)}`;
    }
    if (
      filePath === ctx.workspaceMemory ||
      filePath.startsWith(ctx.workspaceMemory + path.sep)
    ) {
      return `[memory] ${path.relative(ctx.workspaceMemory, filePath)}`;
    }
    return path.relative(ctx.workspaceGroup, filePath);
  };
}

function parseMemoryFileReference(fileRef: string): {
  pathRef: string;
  lineFromRef?: number;
} {
  const trimmed = fileRef.trim();
  const lineRefMatch = trimmed.match(/^(.*?):(\d+)$/);
  if (!lineRefMatch) return { pathRef: trimmed };

  const lineFromRef = Number(lineRefMatch[2]);
  if (!Number.isInteger(lineFromRef) || lineFromRef <= 0) {
    return { pathRef: trimmed };
  }
  return { pathRef: lineRefMatch[1].trim(), lineFromRef };
}

/**
 * Build the IPC payload shared by send_message / send_image MCP tools.
 *
 * Always stamps `chatJid`, `groupFolder`, `timestamp`. Conditionally stamps
 * `isScheduledTask` (when ctx.isScheduledTask is truthy) and `taskId` (when
 * ctx.currentTaskId is non-empty). The conditional stamping matters for host-
 * side routing: a missing `taskId` key means "regular user-turn reply", while
 * a present `taskId` key triggers the task-broadcast branch in the IPC
 * consumer. `extras` carries per-tool fields (`type`, `text`, `imageBase64`, …).
 *
 * Pure function; exported for unit testing.
 */
export function buildSendMessageData(
  ctx: McpContext,
  extras: Record<string, unknown>,
): Record<string, unknown> {
  const data: Record<string, unknown> = {
    chatJid: ctx.chatJid,
    groupFolder: ctx.groupFolder,
    timestamp: new Date().toISOString(),
    ...extras,
  };
  if (ctx.isScheduledTask) {
    data.isScheduledTask = true;
  }
  if (ctx.currentTaskId) {
    data.taskId = ctx.currentTaskId;
  }
  return data;
}

/**
 * Create all OctoDeck MCP tool definitions for in-process SDK MCP server.
 */
export function createMcpTools(ctx: McpContext): SdkMcpToolDefinition<any>[] {
  const MESSAGES_DIR = path.join(ctx.workspaceIpc, 'messages');
  const TASKS_DIR = path.join(ctx.workspaceIpc, 'tasks');
  const hasCrossGroupAccess = ctx.isAdminHome;

  /**
   * Generic IPC call helper: writes a request with requestId to TASKS_DIR,
   * polls for `${type}_result_${requestId}.json`, returns the parsed result.
   */
  function ipcCall<T extends Record<string, unknown>>(
    type: string,
    input: Record<string, unknown>,
    timeoutMs: number = 30_000,
  ): Promise<T> {
    const resultPrefix = `${type}_result`;
    const requestId = newRequestId();
    return pollIpcResult(
      TASKS_DIR,
      {
        type,
        requestId,
        groupFolder: ctx.groupFolder,
        chatJid: ctx.chatJid,
        isAdminHome: hasCrossGroupAccess,
        timestamp: new Date().toISOString(),
        ...input,
      },
      resultPrefix,
      timeoutMs,
    ) as Promise<T>;
  }

  const tools: SdkMcpToolDefinition<any>[] = [
    tool(
      'repo_knowledge_list',
      '列出当前用户的仓库及其知识库状态。先用它发现 repo_id，再用 repo_knowledge_search / repo_knowledge_get_chunk。',
      {},
      async () => {
        try {
          return toolJson(await invokeRepoKnowledgeTool(ctx, { operation: 'list_repos' }));
        } catch (err) {
          return toolError(err);
        }
      },
    ),
    tool(
      'repo_knowledge_status',
      '查看某个仓库知识库生成状态、摘要和统计信息。',
      { repo_id: z.string().describe('Repo ID') },
      async (args) => {
        try {
          return toolJson(await invokeRepoKnowledgeTool(ctx, { operation: 'status', repoId: args.repo_id }));
        } catch (err) {
          return toolError(err);
        }
      },
    ),
    tool(
      'repo_knowledge_search',
      '在仓库知识库中搜索架构、文件、符号、依赖和文档片段。适合先理解代码图谱再动手修改。',
      {
        query: z.string().describe('搜索问题或关键词'),
        repo_id: z.string().optional().describe('可选 Repo ID；不传则搜索当前用户全部已生成知识库'),
        limit: z.number().int().min(1).max(50).optional().describe('返回条数，默认 20'),
        kind: z.enum(['overview', 'file', 'symbol', 'dependency', 'doc', 'graph']).optional().describe('按 chunk 类型过滤'),
        language: z.string().optional().describe('按语言过滤，例如 typescript/python/go'),
        path_prefix: z.string().optional().describe('按路径前缀过滤'),
        include_related: z.boolean().optional().describe('是否返回相关图谱边'),
      },
      async (args) => {
        try {
          return toolJson(await invokeRepoKnowledgeTool(ctx, {
            operation: 'search',
            query: args.query,
            repoId: args.repo_id,
            limit: args.limit,
            kind: args.kind,
            language: args.language,
            pathPrefix: args.path_prefix,
            includeRelated: args.include_related,
          }));
        } catch (err) {
          return toolError(err);
        }
      },
    ),
    tool(
      'repo_knowledge_list_chunks',
      '列出某个仓库知识库的 chunk，可按文件 path 过滤。',
      {
        repo_id: z.string().describe('Repo ID'),
        path: z.string().optional().describe('可选文件路径'),
        kind: z.enum(['overview', 'file', 'symbol', 'dependency', 'doc', 'graph']).optional().describe('可选 chunk 类型'),
        language: z.string().optional().describe('可选语言过滤'),
        path_prefix: z.string().optional().describe('可选路径前缀过滤'),
        limit: z.number().int().min(1).max(200).optional().describe('返回条数，默认 100'),
      },
      async (args) => {
        try {
          return toolJson(await invokeRepoKnowledgeTool(ctx, {
            operation: 'list_chunks',
            repoId: args.repo_id,
            path: args.path,
            kind: args.kind,
            language: args.language,
            pathPrefix: args.path_prefix,
            limit: args.limit,
          }));
        } catch (err) {
          return toolError(err);
        }
      },
    ),
    tool(
      'repo_knowledge_get_chunk',
      '读取知识库搜索结果中的完整 chunk 内容。',
      { chunk_id: z.string().describe('Chunk ID') },
      async (args) => {
        try {
          return toolJson(await invokeRepoKnowledgeTool(ctx, { operation: 'get_chunk', chunkId: args.chunk_id }));
        } catch (err) {
          return toolError(err);
        }
      },
    ),
    tool(
      'repo_knowledge_graph',
      '查看仓库知识库图谱边，包括 imports、depends_on、documents、references。',
      {
        repo_id: z.string().describe('Repo ID'),
        path: z.string().optional().describe('可选文件路径，返回与该文件相关的边'),
        edge_kind: z.enum(['imports', 'imported_by', 'depends_on', 'exports', 'documents', 'references']).optional().describe('边类型过滤'),
        limit: z.number().int().min(1).max(200).optional().describe('返回条数，默认 100'),
      },
      async (args) => {
        try {
          return toolJson(await invokeRepoKnowledgeTool(ctx, {
            operation: 'graph',
            repoId: args.repo_id,
            path: args.path,
            edgeKind: args.edge_kind,
            limit: args.limit,
          }));
        } catch (err) {
          return toolError(err);
        }
      },
    ),
    tool(
      'repo_knowledge_related',
      '根据 chunk_id 或 path 获取相关 chunks 和图谱边。',
      {
        repo_id: z.string().describe('Repo ID'),
        chunk_id: z.string().optional().describe('可选 chunk ID'),
        path: z.string().optional().describe('可选文件路径'),
        limit: z.number().int().min(1).max(100).optional().describe('返回条数，默认 30'),
      },
      async (args) => {
        try {
          return toolJson(await invokeRepoKnowledgeTool(ctx, {
            operation: 'related',
            repoId: args.repo_id,
            chunkId: args.chunk_id,
            path: args.path,
            limit: args.limit,
          }));
        } catch (err) {
          return toolError(err);
        }
      },
    ),
    tool(
      'repo_knowledge_context',
      '获取面向改代码的上下文包：命中 chunk、同文件 chunks、相关 chunks、依赖、文档和图谱边。优先用它在修改前聚合上下文。',
      {
        repo_id: z.string().describe('Repo ID'),
        query: z.string().optional().describe('可选搜索问题；不传 chunk_id/path 时用它定位 anchor chunk'),
        chunk_id: z.string().optional().describe('可选 chunk ID，精确定位上下文 anchor'),
        path: z.string().optional().describe('可选文件路径，按文件聚合上下文'),
        limit: z.number().int().min(1).max(80).optional().describe('每类上下文返回上限，默认 20'),
      },
      async (args) => {
        try {
          return toolJson(await invokeRepoKnowledgeTool(ctx, {
            operation: 'context',
            repoId: args.repo_id,
            query: args.query,
            chunkId: args.chunk_id,
            path: args.path,
            limit: args.limit,
          }));
        } catch (err) {
          return toolError(err);
        }
      },
    ),
    tool(
      'repo_knowledge_plugins',
      '查看 OctoDeck Repo 知识库生成器插件状态，包括 builtin、graphify、codegraph。',
      {},
      async () => {
        try {
          return toolJson(await invokeRepoKnowledgeTool(ctx, { operation: 'plugins' }));
        } catch (err) {
          return toolError(err);
        }
      },
    ),
    tool(
      'repo_knowledge_search_backends',
      '查看 Repo 知识库搜索后端状态，包括 SQLite、PostgreSQL、MongoDB。',
      {},
      async () => {
        try {
          return toolJson(await invokeRepoKnowledgeTool(ctx, { operation: 'search_backends' }));
        } catch (err) {
          return toolError(err);
        }
      },
    ),
    tool(
      'agent_team_list',
      '列出当前用户可用的 OctoDeck Agent Team。用于先发现 team_id，再调用 agent_team_run。',
      {},
      async () => {
        try {
          return toolJson(await invokeAgentTeamTool(ctx, { operation: 'list_teams' }));
        } catch (err) {
          return toolError(err);
        }
      },
    ),
    tool(
      'agent_team_get',
      '读取指定 OctoDeck Agent Team 的结构、角色、策略和预算。',
      { team_id: z.string().describe('Agent Team ID') },
      async (args) => {
        try {
          return toolJson(await invokeAgentTeamTool(ctx, { operation: 'get_team', teamId: args.team_id }));
        } catch (err) {
          return toolError(err);
        }
      },
    ),
    tool(
      'agent_team_run',
      '启动一个 OctoDeck Agent Team 运行。可指定默认 runner_agent_id，也可通过 role_assignments 为每个角色指定 runner。若返回 waiting_approval，请用 agent_team_decide_approval 继续。',
      {
        team_id: z.string().describe('要运行的 Agent Team ID'),
        prompt: z.string().describe('交给 Agent Team 的任务目标'),
        runner_agent_id: z.string().optional().describe('默认 Runner / Agent 后端 ID；不传则使用 Team 创建时的默认后端'),
        role_assignments: RoleAssignmentsSchema.optional().describe('按 roleId 覆盖 Runner，如 {"builder":{"runnerAgentId":"claude-sdk"}}'),
        max_feedback_iterations: z.number().int().min(0).max(5).optional().describe('测试/评审反馈返工最多轮数'),
      },
      async (args) => {
        try {
          return toolJson(await invokeAgentTeamTool(ctx, {
            operation: 'run_team',
            teamId: args.team_id,
            prompt: args.prompt,
            runnerAgentId: args.runner_agent_id,
            roleAssignments: args.role_assignments,
            maxFeedbackIterations: args.max_feedback_iterations,
            runtimeContext: {
              groupFolder: ctx.groupFolder,
              chatJid: ctx.chatJid,
              workspacePath: ctx.workspaceGroup,
            },
          }));
        } catch (err) {
          return toolError(err);
        }
      },
    ),
    tool(
      'agent_team_get_run',
      '读取 Agent Team Run 的状态、任务、trace events、blackboard、approvals 和 checkpoints。',
      { run_id: z.string().describe('Agent Team Run ID') },
      async (args) => {
        try {
          return toolJson(await invokeAgentTeamTool(ctx, { operation: 'get_run', runId: args.run_id }));
        } catch (err) {
          return toolError(err);
        }
      },
    ),
    tool(
      'agent_team_decide_approval',
      '批准或拒绝一个等待审批的 Agent Team Run。批准后会继续执行；拒绝后会取消 Run。',
      {
        run_id: z.string().describe('Agent Team Run ID'),
        approval_id: z.string().describe('Approval ID'),
        decision: z.enum(['approved', 'rejected']).describe('审批决策'),
      },
      async (args) => {
        try {
          return toolJson(await invokeAgentTeamTool(ctx, {
            operation: 'decide_approval',
            runId: args.run_id,
            approvalId: args.approval_id,
            decision: args.decision,
          }));
        } catch (err) {
          return toolError(err);
        }
      },
    ),
    tool(
      'agent_team_cancel_run',
      '取消一个 Agent Team Run。',
      { run_id: z.string().describe('Agent Team Run ID') },
      async (args) => {
        try {
          return toolJson(await invokeAgentTeamTool(ctx, { operation: 'cancel_run', runId: args.run_id }));
        } catch (err) {
          return toolError(err);
        }
      },
    ),
    tool(
      'cloud_memory_search',
      '搜索云端数据库记忆。云端模式使用此工具读取全局记忆、会话记忆和只读的 client agent 记忆镜像。',
      {
        query: z.string().describe('搜索关键词'),
        memory_type: z.enum(['global', 'session', 'agent']).optional().describe('可选过滤：global/session/agent'),
      },
      async (args) => {
        try {
          const data = await invokeCloudMemory(ctx, { operation: 'search', query: args.query, memoryType: args.memory_type });
          return { content: [{ type: 'text' as const, text: JSON.stringify(data.memories ?? [], null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }], isError: true };
        }
      },
    ),
    tool(
      'cloud_memory_get',
      '读取云端数据库记忆。agent 类型是 client 本地权威的只读镜像，不可用 update 修改。',
      {
        memory_type: z.enum(['global', 'session', 'agent']),
        path: z.string().describe('记忆路径，如 CLAUDE.md 或 memory/YYYY-MM-DD.md'),
        group_folder: z.string().optional().describe('session 记忆所属 workspace/group folder'),
        device_link_id: z.string().optional().describe('agent 记忆镜像所属 client device id'),
        agent_id: z.string().optional().describe('agent 记忆镜像所属 agent id'),
      },
      async (args) => {
        try {
          const data = await invokeCloudMemory(ctx, {
            operation: 'get', memoryType: args.memory_type, path: args.path,
            groupFolder: args.group_folder, deviceLinkId: args.device_link_id, agentId: args.agent_id,
          });
          return { content: [{ type: 'text' as const, text: JSON.stringify(data.memory ?? null, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }], isError: true };
        }
      },
    ),
    tool(
      'cloud_memory_append',
      '追加写入云端权威记忆。仅允许 global/session；client agent 记忆由 client 本地权威维护。',
      {
        memory_type: z.enum(['global', 'session']),
        path: z.string().describe('记忆路径，如 CLAUDE.md 或 memory/YYYY-MM-DD.md'),
        content: z.string().describe('要追加的内容'),
        group_folder: z.string().optional().describe('session 记忆所属 workspace/group folder'),
      },
      async (args) => {
        try {
          const data = await invokeCloudMemory(ctx, {
            operation: 'append', memoryType: args.memory_type, path: args.path,
            content: args.content, groupFolder: args.group_folder,
          });
          if (shouldMirrorWorkspaceMemory(ctx, data.memory)) {
            writeWorkspaceMemoryMirror(ctx, data.memory);
          }
          return { content: [{ type: 'text' as const, text: JSON.stringify(data.memory, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }], isError: true };
        }
      },
    ),
    tool(
      'cloud_memory_update',
      '覆盖更新云端权威记忆。仅允许 global/session；可传 expected_revision 防止并发覆盖。',
      {
        memory_type: z.enum(['global', 'session']),
        path: z.string().describe('记忆路径，如 CLAUDE.md 或 memory/YYYY-MM-DD.md'),
        content: z.string().describe('完整的新内容'),
        group_folder: z.string().optional().describe('session 记忆所属 workspace/group folder'),
        expected_revision: z.number().optional().describe('期望 revision，若落后则拒绝覆盖'),
      },
      async (args) => {
        try {
          const data = await invokeCloudMemory(ctx, {
            operation: 'update', memoryType: args.memory_type, path: args.path,
            content: args.content, groupFolder: args.group_folder, expectedRevision: args.expected_revision,
          });
          if (shouldMirrorWorkspaceMemory(ctx, data.memory)) {
            writeWorkspaceMemoryMirror(ctx, data.memory);
          }
          return { content: [{ type: 'text' as const, text: JSON.stringify(data.memory, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }], isError: true };
        }
      },
    ),
    tool(
      'workspace_memory_search',
      '搜索当前 workspace 的云端会话记忆（等价于 cloud_memory_search + session 过滤）。',
      { query: z.string().describe('搜索关键词') },
      async (args) => {
        try {
          const data = await invokeCloudMemory(ctx, { operation: 'search', query: args.query, memoryType: 'session' });
          const scope = `session:${ctx.groupFolder}`;
          const memories = (data.memories ?? []).filter((memory: any) => memory.scopeKey === scope || memory.groupFolder === ctx.groupFolder);
          return { content: [{ type: 'text' as const, text: JSON.stringify(memories, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }], isError: true };
        }
      },
    ),
    tool(
      'workspace_memory_get',
      '读取当前 workspace 的云端记忆。',
      { path: z.string().describe('记忆路径，如 CLAUDE.md 或 memory/notes.md') },
      async (args) => {
        try {
          const data = await invokeCloudMemory(ctx, { operation: 'get', memoryType: 'session', groupFolder: ctx.groupFolder, path: args.path });
          return { content: [{ type: 'text' as const, text: JSON.stringify(data.memory ?? null, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }], isError: true };
        }
      },
    ),
    tool(
      'workspace_memory_append',
      '追加写入当前 workspace 的云端记忆。',
      { path: z.string().describe('记忆路径'), content: z.string().describe('要追加的内容') },
      async (args) => {
        try {
          const data = await invokeCloudMemory(ctx, { operation: 'append', memoryType: 'session', groupFolder: ctx.groupFolder, path: args.path, content: args.content });
          writeWorkspaceMemoryMirror(ctx, data.memory);
          return { content: [{ type: 'text' as const, text: JSON.stringify(data.memory, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }], isError: true };
        }
      },
    ),
    tool(
      'workspace_memory_update',
      '覆盖更新当前 workspace 的云端记忆，可传 expected_revision 防止并发覆盖。',
      { path: z.string().describe('记忆路径'), content: z.string().describe('完整的新内容'), expected_revision: z.number().optional() },
      async (args) => {
        try {
          const data = await invokeCloudMemory(ctx, { operation: 'update', memoryType: 'session', groupFolder: ctx.groupFolder, path: args.path, content: args.content, expectedRevision: args.expected_revision });
          writeWorkspaceMemoryMirror(ctx, data.memory);
          return { content: [{ type: 'text' as const, text: JSON.stringify(data.memory, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }], isError: true };
        }
      },
    ),
    // --- send_message ---
    tool(
      'send_message',
      "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times. Note: when running as a scheduled task, your final output is NOT sent to the user — use this tool if you need to communicate with the user or group.",
      { text: z.string().describe('The message text to send') },
      async (args) => {
        const data = buildSendMessageData(ctx, {
          type: 'message',
          text: args.text,
        });
        writeIpcFile(MESSAGES_DIR, data);
        return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
      },
    ),

    // --- send_image ---
    tool(
      'send_image',
      'Send an image file from the workspace to the user via IM. Supports PNG/JPEG/GIF/WebP. Optional caption.',
      {
        file_path: z
          .string()
          .describe(
            'Path to the image file in the workspace (relative to workspace root or absolute)',
          ),
        caption: z
          .string()
          .optional()
          .describe('Optional caption text to send with the image'),
      },
      async (args) => {
        // NOTE: Web-prefixed JIDs (e.g. web:main) are no longer rejected here.
        // The main process routes the image to the correct IM channel via
        // activeImReplyRoutes, so the agent-runner should let the IPC
        // request through regardless of JID prefix.

        // Resolve path relative to workspace
        const absPath = path.isAbsolute(args.file_path)
          ? args.file_path
          : path.join(ctx.workspaceGroup, args.file_path);

        // Security: ensure path is within workspace
        // Use path.sep suffix to prevent prefix-bypass (e.g. /ws/group1 matching /ws/group10/evil.png)
        const resolved = path.resolve(absPath);
        const safeRoot = ctx.workspaceGroup.endsWith(path.sep)
          ? ctx.workspaceGroup
          : ctx.workspaceGroup + path.sep;
        if (resolved !== ctx.workspaceGroup && !resolved.startsWith(safeRoot)) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error: file path must be within workspace directory.`,
              },
            ],
            isError: true,
          };
        }

        // Check file exists
        if (!fs.existsSync(resolved)) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error: file not found: ${args.file_path}`,
              },
            ],
            isError: true,
          };
        }

        // Read file and check size (10MB limit for both Feishu and Telegram)
        const stat = fs.statSync(resolved);
        if (stat.size > 10 * 1024 * 1024) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error: image file too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Maximum is 10MB.`,
              },
            ],
            isError: true,
          };
        }
        if (stat.size === 0) {
          return {
            content: [
              { type: 'text' as const, text: `Error: image file is empty.` },
            ],
            isError: true,
          };
        }

        const buffer = fs.readFileSync(resolved);
        const base64 = buffer.toString('base64');

        // Detect MIME type from magic bytes
        const { detectImageMimeTypeFromBase64Strict } =
          await import('./image-detector.js');
        const mimeType = detectImageMimeTypeFromBase64Strict(base64);
        if (!mimeType) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error: file does not appear to be a supported image format (PNG, JPEG, GIF, WebP, TIFF, BMP).`,
              },
            ],
            isError: true,
          };
        }

        const data = buildSendMessageData(ctx, {
          type: 'image',
          imageBase64: base64,
          mimeType,
          caption: args.caption || undefined,
          fileName: path.basename(resolved),
        });
        writeIpcFile(MESSAGES_DIR, data);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Image sent: ${path.basename(resolved)} (${mimeType}, ${(stat.size / 1024).toFixed(1)}KB)`,
            },
          ],
        };
      },
    ),

    // --- send_file ---
    tool(
      'send_file',
      `Send a file to the current chat (the user you're talking to) via IM (Feishu/Telegram/DingTalk/QQ/Discord). The file path is relative to the workspace/group directory.
Supports: PDF, DOC, XLS, PPT, MP4, ZIP, SO, etc. Max file size: 30MB.`,
      {
        filePath: z
          .string()
          .describe(
            'File path relative to workspace/group (e.g., "output/report.pdf")',
          ),
        fileName: z
          .string()
          .describe('File name to display (e.g., "report.pdf")'),
      },
      async (args) => {
        // NOTE: Web-prefixed JIDs (e.g. web:main) are no longer rejected here.
        // The main process routes the file to the correct IM channel via
        // activeImReplyRoutes, so the agent-runner should let the IPC
        // request through regardless of JID prefix.

        // Handle both absolute and relative paths
        let resolvedPath: string;
        let relativePath: string;

        if (path.isAbsolute(args.filePath)) {
          // Absolute path provided - validate and convert to relative
          resolvedPath = path.resolve(args.filePath);
          const safeRoot = ctx.workspaceGroup.endsWith(path.sep)
            ? ctx.workspaceGroup
            : ctx.workspaceGroup + path.sep;
          if (
            resolvedPath !== ctx.workspaceGroup &&
            !resolvedPath.startsWith(safeRoot)
          ) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: 'Error: file must be within the workspace/group directory.',
                },
              ],
              isError: true,
            };
          }
          // Convert to relative path
          relativePath = path.relative(ctx.workspaceGroup, resolvedPath);
        } else {
          // Relative path provided
          relativePath = args.filePath;
          resolvedPath = path.resolve(ctx.workspaceGroup, args.filePath);
          // Validate resolved path is still within workspace
          const safeRoot = ctx.workspaceGroup.endsWith(path.sep)
            ? ctx.workspaceGroup
            : ctx.workspaceGroup + path.sep;
          if (
            resolvedPath !== ctx.workspaceGroup &&
            !resolvedPath.startsWith(safeRoot)
          ) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: 'Error: file must be within the workspace/group directory.',
                },
              ],
              isError: true,
            };
          }
        }

        if (!fs.existsSync(resolvedPath)) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error: file not found: ${args.filePath}`,
              },
            ],
            isError: true,
          };
        }

        const data = {
          type: 'send_file',
          chatJid: ctx.chatJid,
          filePath: relativePath,
          fileName: args.fileName,
          timestamp: new Date().toISOString(),
        };
        writeIpcFile(TASKS_DIR, data);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Sending file "${args.fileName}"...`,
            },
          ],
        };
      },
    ),

    // --- schedule_task ---
    tool(
      'schedule_task',
      `Schedule a recurring or one-time task.

EXECUTION TYPE:
\u2022 "agent" (default): Task runs as a full Claude Agent with access to all tools. Consumes API tokens.
\u2022 "script" (admin only): Task runs a shell command directly on the host. Zero API token cost. Use for deterministic tasks like health checks, data collection, cURL calls, or cron-like scripts.

EXECUTION MODE:
\u2022 "host": Task runs directly on the host machine. Admin only.
\u2022 "container" (default for non-admin): Task runs in a Docker container.
Each agent task automatically gets its own dedicated workspace.

CONTEXT MODE (agent mode only) - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history.
\u2022 "isolated": Task runs in a fresh session with no conversation history.

MESSAGING BEHAVIOR - The task output is sent to the user or group.
\u2022 Agent mode: output is sent via MCP tool or stdout. Use <internal> tags to suppress.
\u2022 Script mode: stdout is sent as the result. stderr is included on failure.

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
      {
        prompt: z
          .string()
          .optional()
          .default('')
          .describe(
            'What the agent should do (agent mode) or task description (script mode, optional).',
          ),
        schedule_type: z
          .enum(['cron', 'interval', 'once'])
          .describe(
            'cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time',
          ),
        schedule_value: z
          .string()
          .describe(
            'cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)',
          ),
        execution_type: z
          .enum(['agent', 'script'])
          .default('agent')
          .describe(
            'agent=full Claude Agent (default), script=shell command (admin only, zero token cost)',
          ),
        script_command: z
          .string()
          .max(4096)
          .optional()
          .describe(
            'Shell command to execute (required for script mode). Runs in the group workspace directory.',
          ),
        execution_mode: z
          .enum(['host', 'container'])
          .optional()
          .describe(
            'Execution mode: host runs directly on the server, container runs in Docker isolation',
          ),
        context_mode: z
          .enum(['group', 'isolated'])
          .default('group')
          .describe(
            '(agent mode only) group=runs with persistent workspace context (recommended), isolated=fresh session each time',
          ),
        target_group_jid: z
          .string()
          .optional()
          .describe(
            '(Admin home only) JID of the group to schedule the task for. Defaults to the current group.',
          ),
      },
      async (args) => {
        const execType = args.execution_type || 'agent';

        // Validate execution_type constraints
        if (execType === 'agent' && !args.prompt?.trim()) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Agent mode requires a prompt. Provide instructions for what the agent should do.',
              },
            ],
            isError: true,
          };
        }
        if (execType === 'script' && !args.script_command?.trim()) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Script mode requires script_command. Provide the shell command to execute.',
              },
            ],
            isError: true,
          };
        }
        if (execType === 'script' && !ctx.isAdminHome) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Only admin home container can create script tasks.',
              },
            ],
            isError: true,
          };
        }

        // Validate schedule_value before writing IPC
        if (args.schedule_type === 'cron') {
          try {
            CronExpressionParser.parse(args.schedule_value, { tz: process.env.TZ || 'Asia/Shanghai' });
          } catch {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).`,
                },
              ],
              isError: true,
            };
          }
        } else if (args.schedule_type === 'interval') {
          const ms = parseInt(args.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).`,
                },
              ],
              isError: true,
            };
          }
        } else if (args.schedule_type === 'once') {
          const date = new Date(args.schedule_value);
          if (isNaN(date.getTime())) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Invalid timestamp: "${args.schedule_value}". Use ISO 8601 format like "2026-02-01T15:30:00.000Z".`,
                },
              ],
              isError: true,
            };
          }
        }

        const targetJid =
          hasCrossGroupAccess && args.target_group_jid
            ? args.target_group_jid
            : ctx.chatJid;
        const data: Record<string, unknown> = {
          type: 'schedule_task',
          prompt: args.prompt || '',
          schedule_type: args.schedule_type,
          schedule_value: args.schedule_value,
          context_mode: args.context_mode || 'isolated',
          execution_type: execType,
          targetJid,
          createdBy: ctx.groupFolder,
          timestamp: new Date().toISOString(),
        };
        if (execType === 'script') {
          data.script_command = args.script_command;
        }
        if (args.execution_mode) {
          data.execution_mode = args.execution_mode;
        }
        const filename = writeIpcFile(TASKS_DIR, data);
        const modeLabel = execType === 'script' ? 'script' : 'agent';
        return {
          content: [
            {
              type: 'text' as const,
              text: `Task scheduled [${modeLabel}] (${filename}): ${args.schedule_type} - ${args.schedule_value}`,
            },
          ],
        };
      },
    ),

    // --- list_tasks ---
    tool(
      'list_tasks',
      "List all scheduled tasks. From admin home: shows all tasks. From other groups: shows only that group's tasks.",
      {},
      async () => {
        const requestId = newRequestId();
        try {
          const result = await pollIpcResult(
            TASKS_DIR,
            {
              type: 'list_tasks',
              requestId,
              groupFolder: ctx.groupFolder,
              isAdminHome: hasCrossGroupAccess,
              timestamp: new Date().toISOString(),
            },
            'list_tasks_result',
          );
          if (!result.success) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Error listing tasks: ${result.error || 'Unknown error'}`,
                },
              ],
              isError: true,
            };
          }
          const tasks = (result.tasks || []) as Array<{
            id: string;
            prompt: string;
            schedule_type: string;
            schedule_value: string;
            status: string;
            next_run: string;
          }>;
          if (tasks.length === 0) {
            return {
              content: [
                { type: 'text' as const, text: 'No scheduled tasks found.' },
              ],
            };
          }
          const formatted = tasks
            .map(
              (t) =>
                `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
            )
            .join('\n');
          return {
            content: [
              { type: 'text' as const, text: `Scheduled tasks:\n${formatted}` },
            ],
          };
        } catch {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Timeout waiting for task list response.',
              },
            ],
            isError: true,
          };
        }
      },
    ),

    // --- pause_task ---
    tool(
      'pause_task',
      'Pause a scheduled task. It will not run until resumed.',
      { task_id: z.string().describe('The task ID to pause') },
      async (args) => {
        const data = {
          type: 'pause_task',
          taskId: args.task_id,
          groupFolder: ctx.groupFolder,
          isMain: hasCrossGroupAccess,
          timestamp: new Date().toISOString(),
        };
        writeIpcFile(TASKS_DIR, data);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Task ${args.task_id} pause requested.`,
            },
          ],
        };
      },
    ),

    // --- resume_task ---
    tool(
      'resume_task',
      'Resume a paused task.',
      { task_id: z.string().describe('The task ID to resume') },
      async (args) => {
        const data = {
          type: 'resume_task',
          taskId: args.task_id,
          groupFolder: ctx.groupFolder,
          isMain: hasCrossGroupAccess,
          timestamp: new Date().toISOString(),
        };
        writeIpcFile(TASKS_DIR, data);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Task ${args.task_id} resume requested.`,
            },
          ],
        };
      },
    ),

    // --- cancel_task ---
    tool(
      'cancel_task',
      'Cancel and delete a scheduled task.',
      { task_id: z.string().describe('The task ID to cancel') },
      async (args) => {
        const data = {
          type: 'cancel_task',
          taskId: args.task_id,
          groupFolder: ctx.groupFolder,
          isMain: hasCrossGroupAccess,
          timestamp: new Date().toISOString(),
        };
        writeIpcFile(TASKS_DIR, data);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Task ${args.task_id} cancellation requested.`,
            },
          ],
        };
      },
    ),

    // --- register_group ---
    tool(
      'register_group',
      `Register a new group so the agent can respond to messages there. Admin home only.

Use available_groups.json to find the JID for a group. The folder name should be lowercase with hyphens (e.g., "family-chat").
You can optionally specify execution_mode: "container" (default, isolated Docker) or "host" (direct host access, admin only).`,
      {
        jid: z.string().describe('The chat JID (e.g., "feishu:oc_xxxx")'),
        name: z.string().describe('Display name for the group'),
        folder: z
          .string()
          .describe(
            'Folder name for group files (lowercase, hyphens, e.g., "family-chat")',
          ),
        execution_mode: z
          .enum(['container', 'host'])
          .optional()
          .describe(
            'Execution mode: "container" (default, isolated Docker) or "host" (direct host access)',
          ),
      },
      async (args) => {
        if (!hasCrossGroupAccess) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Only the admin home container can register new groups.',
              },
            ],
            isError: true,
          };
        }
        const data = {
          type: 'register_group',
          jid: args.jid,
          name: args.name,
          folder: args.folder,
          executionMode: args.execution_mode,
          timestamp: new Date().toISOString(),
        };
        writeIpcFile(TASKS_DIR, data);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Group "${args.name}" registered. It will start receiving messages immediately.`,
            },
          ],
        };
      },
    ),

    // --- discord_get_history ---
    tool(
      'discord_get_history',
      `Fetch recent messages from the current Discord channel or DM. Only works when the current chat is a Discord channel.
Returns up to 100 messages per call (default 50), ordered oldest-first. Use "before" with a message ID to paginate older messages.`,
      {
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Number of messages to fetch (1-100, default 50)'),
        before: z
          .string()
          .regex(/^\d{17,20}$/, 'must be a Discord snowflake')
          .optional()
          .describe(
            'Message ID (snowflake) — only return messages older than this. Use the "id" of the oldest message in your previous batch to paginate.',
          ),
      },
      async (args) => {
        if (!ctx.chatJid.startsWith('discord:')) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error: discord_get_history only works in Discord channels. Current chat: ${ctx.chatJid}`,
              },
            ],
            isError: true,
          };
        }
        const requestId = newRequestId();
        try {
          const result = await pollIpcResult(
            TASKS_DIR,
            {
              type: 'discord_get_history',
              chatJid: ctx.chatJid,
              limit: args.limit,
              before: args.before,
              requestId,
              timestamp: new Date().toISOString(),
            },
            'discord_get_history_result',
          );
          if (!result.success) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Error fetching Discord history: ${result.error || 'Unknown error'}`,
                },
              ],
              isError: true,
            };
          }
          const messages = (result.messages || []) as Array<{
            id: string;
            authorName: string;
            authorBot: boolean;
            content: string;
            timestamp: string;
            attachments: Array<{ name: string; url: string }>;
            replyToId?: string;
            edited: boolean;
          }>;
          if (messages.length === 0) {
            return {
              content: [
                { type: 'text' as const, text: 'No messages found in this channel.' },
              ],
            };
          }
          const formatted = messages
            .map((m) => {
              const tag = m.authorBot ? ' [bot]' : '';
              const editFlag = m.edited ? ' (edited)' : '';
              const replyFlag = m.replyToId ? ` ↪${m.replyToId}` : '';
              const attachStr =
                m.attachments.length > 0
                  ? `\n  📎 ${m.attachments.map((a) => a.name).join(', ')}`
                  : '';
              return `[${m.timestamp}] ${m.authorName}${tag}${replyFlag}${editFlag} (id=${m.id})\n  ${m.content || '(empty)'}${attachStr}`;
            })
            .join('\n\n');
          return {
            content: [
              {
                type: 'text' as const,
                text: `Discord history (${messages.length} messages, oldest first):\n\n${formatted}`,
              },
            ],
          };
        } catch {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Timeout waiting for Discord history response.',
              },
            ],
            isError: true,
          };
        }
      },
    ),

    // --- discord_get_channel_info ---
    tool(
      'discord_get_channel_info',
      `Get metadata for the current Discord channel: name, type (guild_text/dm/etc), topic, NSFW flag, parent (category) ID, and guild ID.
Only works when the current chat is a Discord channel.`,
      {},
      async () => {
        if (!ctx.chatJid.startsWith('discord:')) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error: discord_get_channel_info only works in Discord channels. Current chat: ${ctx.chatJid}`,
              },
            ],
            isError: true,
          };
        }
        const requestId = newRequestId();
        try {
          const result = await pollIpcResult(
            TASKS_DIR,
            {
              type: 'discord_get_channel_info',
              chatJid: ctx.chatJid,
              requestId,
              timestamp: new Date().toISOString(),
            },
            'discord_get_channel_info_result',
          );
          if (!result.success) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Error fetching Discord channel info: ${result.error || 'Unknown error'}`,
                },
              ],
              isError: true,
            };
          }
          return {
            content: [
              {
                type: 'text' as const,
                text: `Discord channel info:\n${JSON.stringify(result.channel, null, 2)}`,
              },
            ],
          };
        } catch {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Timeout waiting for Discord channel info response.',
              },
            ],
            isError: true,
          };
        }
      },
    ),

    // --- discord_get_server_info ---
    tool(
      'discord_get_server_info',
      `Get metadata for the Discord server (guild) the current channel belongs to: name, description, owner ID, member count, icon URL.
Returns null if the current chat is a DM (DMs do not belong to a server). Only works when the current chat is a Discord channel.`,
      {},
      async () => {
        if (!ctx.chatJid.startsWith('discord:')) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error: discord_get_server_info only works in Discord channels. Current chat: ${ctx.chatJid}`,
              },
            ],
            isError: true,
          };
        }
        const requestId = newRequestId();
        try {
          const result = await pollIpcResult(
            TASKS_DIR,
            {
              type: 'discord_get_server_info',
              chatJid: ctx.chatJid,
              requestId,
              timestamp: new Date().toISOString(),
            },
            'discord_get_server_info_result',
          );
          if (!result.success) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Error fetching Discord server info: ${result.error || 'Unknown error'}`,
                },
              ],
              isError: true,
            };
          }
          if (result.guild === null) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: 'This is a DM channel — no server (guild) information available.',
                },
              ],
            };
          }
          return {
            content: [
              {
                type: 'text' as const,
                text: `Discord server info:\n${JSON.stringify(result.guild, null, 2)}`,
              },
            ],
          };
        } catch {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Timeout waiting for Discord server info response.',
              },
            ],
            isError: true,
          };
        }
      },
    ),

    // --- Issue management tools (5 tools via main-process IPC) ---
    tool(
      'list_issues',
      'List issues in the current or specified workspace. Use this to find open work, find an issue by title, or track statuses.',
      {
        workspace_jid: z.string().optional().describe('Optional workspace JID. Defaults to the workspace the agent is running in.'),
        status: z.enum(['todo', 'in_progress', 'review', 'done', 'canceled']).optional().describe('Filter by status'),
        priority: z.enum(['low', 'medium', 'high', 'urgent']).optional().describe('Filter by priority'),
        assignee: z.string().optional().describe('Filter by assignee user id'),
        query: z.string().optional().describe('Full-text search across title and description'),
        limit: z.number().int().min(1).max(100).optional().default(20).describe('Max number of results'),
      },
      async (input) => {
        try {
          const result = await ipcCall<{
            issues: Array<{ id: string; title: string; status: string; priority: string; assignee_user_id?: string; created_at: string; updated_at: string }>;
            total: number;
            error?: string;
          }>('issue_list', input);
          if (result.error) throw new Error(result.error);
          return toolJson(result);
        } catch (err) {
          return toolError(err);
        }
      },
    ),

    tool(
      'get_issue',
      'Fetch the full details of a single issue including description, status, priority, runs, and metadata.',
      {
        id: z.string().describe('Issue ID'),
      },
      async (input) => {
        try {
          const result = await ipcCall<{
            issue?: {
              id: string; title: string; description: string; status: string; priority: string;
              assignee_user_id?: string; due_date?: string; workspace_jid: string;
              created_at: string; updated_at: string; closed_at?: string;
              last_run_status?: string;
            };
            error?: string;
          }>('issue_get', input);
          if (result.error || !result.issue) throw new Error(result.error ?? 'Issue not found');
          return toolJson(result.issue);
        } catch (err) {
          return toolError(err);
        }
      },
    ),

    tool(
      'create_issue',
      'Create a new issue in the current or specified workspace. This registers work to be tracked without starting execution immediately (unless start_agent is true).',
      {
        title: z.string().min(1).max(200).describe('Short title summarizing the issue'),
        description: z.string().max(20000).optional().default('').describe('Full description of the issue, context, and requirements'),
        status: z.enum(['todo', 'in_progress', 'review', 'done', 'canceled']).optional().default('todo'),
        priority: z.enum(['low', 'medium', 'high', 'urgent']).optional().default('medium'),
        assignee_user_id: z.string().optional().describe('User id of the person responsible'),
        due_date: z.string().optional().describe('Due date as ISO date string (YYYY-MM-DD)'),
        workspace_jid: z.string().optional().describe('Optional workspace JID. Defaults to the workspace the agent is running in.'),
        start_agent: z.boolean().optional().default(false).describe('If true, also enqueue an agent run for the new issue immediately'),
      },
      async (input) => {
        try {
          const result = await ipcCall<{
            issue?: { id: string; title: string; status: string };
            run?: { id: string; status: string };
            error?: string;
          }>('issue_create', input);
          if (result.error || !result.issue) throw new Error(result.error ?? 'Failed to create issue');
          return toolJson(result);
        } catch (err) {
          return toolError(err);
        }
      },
    ),

    tool(
      'update_issue',
      'Update one or more fields on an existing issue. Provide only the fields you want to change.',
      {
        id: z.string().describe('Issue ID'),
        title: z.string().min(1).max(200).optional(),
        description: z.string().max(20000).optional(),
        status: z.enum(['todo', 'in_progress', 'review', 'done', 'canceled']).optional(),
        priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
        assignee_user_id: z.string().nullable().optional(),
        due_date: z.string().nullable().optional(),
      },
      async (input) => {
        try {
          const result = await ipcCall<{
            issue?: { id: string; title: string; status: string };
            error?: string;
          }>('issue_update', input);
          if (result.error || !result.issue) throw new Error(result.error ?? 'Failed to update issue');
          return toolJson(result.issue);
        } catch (err) {
          return toolError(err);
        }
      },
    ),

    tool(
      'comment_issue',
      'Add a comment to an existing issue. Use this to record progress notes, partial results, or request clarifications from team members. Comments are visible in the issue timeline and are included as context for future agent runs.',
      {
        id: z.string().describe('Issue ID'),
        body: z.string().min(1).max(20000).describe('Markdown comment body'),
      },
      async (input) => {
        try {
          const result = await ipcCall<{
            comment?: { id: string; created_at: string };
            error?: string;
          }>('issue_comment', input);
          if (result.error || !result.comment) throw new Error(result.error ?? 'Failed to add comment');
          return toolJson(result.comment);
        } catch (err) {
          return toolError(err);
        }
      },
    ),

    tool(
      'ask_user',
      'Pause the current run and ask a question to the issue requester. The run will end naturally and resume automatically once the user replies in the issue. Use ONLY for questions you genuinely need answered to make progress (do not use for status updates — use comment_issue for that).',
      {
        question: z.string().min(1).max(2000).describe('Question to ask the user'),
        choices: z.array(z.string()).max(10).optional().describe('Optional list of suggested choices'),
      },
      async ({ question, choices }) => {
        try {
          const runId = process.env.OCTODECK_RUN_ID;
          const issueId = process.env.OCTODECK_ISSUE_ID;
          if (!runId || !issueId) {
            throw new Error('ask_user is only available when running inside an issue agent run');
          }
          const result = await ipcCall<{
            requestId?: string;
            error?: string;
          }>('issue_ask_user', { runId, issueId, question, choices });
          if (result.error || !result.requestId) throw new Error(result.error ?? 'Failed to ask user');
          return toolJson({
            requestId: result.requestId,
            status: 'pending',
            note: 'Question recorded. Stop your current task; the run will resume automatically when the user replies.',
          });
        } catch (err) {
          return toolError(err);
        }
      },
    ),
  ];

  if (ctx.ownerUserId) {
    tools.push(
      tool(
        'cloud_skill_search',
        '搜索当前用户安装在 OctoDeck 云端的 Cloud Skills。适合在 Claude Code 原生 Skill 列表未显示云端 skill 时，用来发现可用 skill。',
        { query: z.string().optional().describe('可选搜索词，匹配 skill id/name/description/packageName') },
        async (args) => {
          try {
            return toolJson(await invokeCloudSkill(ctx, { operation: 'search', query: args.query }));
          } catch (err) {
            return toolError(err);
          }
        },
      ),
      tool(
        'cloud_skill_get',
        '读取当前用户安装在 OctoDeck 云端的 Cloud Skill 的完整 SKILL.md 内容。读取后按其中的指令执行任务。',
        { skill_id: z.string().describe('Cloud Skill ID / directory name') },
        async (args) => {
          try {
            return toolJson(await invokeCloudSkill(ctx, { operation: 'get', skillId: args.skill_id }));
          } catch (err) {
            return toolError(err);
          }
        },
      ),
    );
  }

  // Skill 安装/卸载仅限主容器（与 memory_* 工具一致）
  if (ctx.isHome) {
    tools.push(
      // --- install_skill ---
      tool(
        'install_skill',
        `Install a skill from the skills registry (skills.sh). The skill will be available in future conversations.
Example packages: "anthropic/memory", "anthropic/think", "owner/repo", "owner/repo@skill-name".`,
        {
          package: z
            .string()
            .describe(
              'The skill package to install, format: owner/repo or owner/repo@skill',
            ),
        },
        async (args) => {
          const pkg = args.package.trim();
          if (
            !/^[\w\-]+\/[\w\-.]+(?:[@#][\w\-.\/]+)?$/.test(pkg) &&
            !/^https?:\/\//.test(pkg)
          ) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Invalid package format: "${pkg}". Expected format: owner/repo or owner/repo@skill`,
                },
              ],
              isError: true,
            };
          }

          const requestId = newRequestId();
          try {
            const result = await pollIpcResult(
              TASKS_DIR,
              {
                type: 'install_skill',
                package: pkg,
                requestId,
                groupFolder: ctx.groupFolder,
                timestamp: new Date().toISOString(),
              },
              'install_skill_result',
              120_000,
            );
            if (result.success) {
              const installed =
                ((result.installed as string[]) || []).join(', ') || pkg;
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `Skill installed successfully: ${installed}\n\nNote: The skill will be available in the next conversation (new container/process).`,
                  },
                ],
              };
            } else {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `Failed to install skill "${pkg}": ${result.error || 'Unknown error'}`,
                  },
                ],
                isError: true,
              };
            }
          } catch {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Timeout waiting for skill installation result (120s). The installation may still be in progress.`,
                },
              ],
              isError: true,
            };
          }
        },
      ),

      // --- uninstall_skill ---
      tool(
        'uninstall_skill',
        `Uninstall a user-level skill by its ID. Project-level skills cannot be uninstalled.
Use the skills panel in the UI to find the skill ID (directory name, e.g. "memory", "think").`,
        {
          skill_id: z
            .string()
            .describe(
              'The skill ID to uninstall (the directory name, e.g. "memory", "think")',
            ),
        },
        async (args) => {
          const skillId = args.skill_id.trim();
          if (!skillId || !/^[\w\-]+$/.test(skillId)) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Invalid skill ID: "${skillId}". Must be alphanumeric with hyphens/underscores.`,
                },
              ],
              isError: true,
            };
          }

          const requestId = newRequestId();
          try {
            const result = await pollIpcResult(
              TASKS_DIR,
              {
                type: 'uninstall_skill',
                skillId,
                requestId,
                groupFolder: ctx.groupFolder,
                timestamp: new Date().toISOString(),
              },
              'uninstall_skill_result',
            );
            if (result.success) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `Skill "${skillId}" uninstalled successfully.`,
                  },
                ],
              };
            } else {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `Failed to uninstall skill "${skillId}": ${result.error || 'Unknown error'}`,
                  },
                ],
                isError: true,
              };
            }
          } catch {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Timeout waiting for skill uninstall result.`,
                },
              ],
              isError: true,
            };
          }
        },
      ),
    );
  }

  // --- memory_append --- (only available for home containers, skipped in native Claude mode)
  if (ctx.isHome && !ctx.disableMemoryLayer) {
    tools.push(
      tool(
        'memory_append',
        `\u5c06**\u65f6\u6548\u6027\u8bb0\u5fc6**\u8ffd\u52a0\u5230 memory/YYYY-MM-DD.md\uff08\u72ec\u7acb\u8bb0\u5fc6\u76ee\u5f55\uff0c\u4e0d\u5728\u5de5\u4f5c\u533a\u5185\uff09\u3002
\u4ec5\u8ffd\u52a0\u5199\u5165\uff0c\u4e0d\u4f1a\u8986\u76d6\u5df2\u6709\u5185\u5bb9\u3002

\u4ec5\u7528\u4e8e\u660e\u786e\u53ea\u8ddf\u5f53\u5929/\u77ed\u671f\u6709\u5173\u7684\u4fe1\u606f\uff1a\u4eca\u65e5\u9879\u76ee\u8fdb\u5c55\u3001\u4e34\u65f6\u6280\u672f\u51b3\u7b56\u3001\u5f85\u529e\u4e8b\u9879\u3001\u4f1a\u8bae\u8981\u70b9\u7b49\u3002

**\u91cd\u8981**\uff1a\u4e0b\u6b21\u5bf9\u8bdd\u4ecd\u53ef\u80fd\u7528\u5230\u7684\u4fe1\u606f\uff08\u7528\u6237\u8eab\u4efd\u3001\u504f\u597d\u3001\u5e38\u7528\u9879\u76ee\u3001\u7528\u6237\u8bf4\u201c\u8bb0\u4f4f\u201d\u7684\u5185\u5bb9\uff09\u5e94\u76f4\u63a5\u7528 Edit \u5de5\u5177\u7f16\u8f91 /workspace/global/CLAUDE.md\uff0c\u4e0d\u8981\u7528\u6b64\u5de5\u5177\u3002`,
        {
          content: z
            .string()
            .describe('\u8981\u8ffd\u52a0\u7684\u8bb0\u5fc6\u5185\u5bb9'),
          date: z
            .string()
            .optional()
            .describe(
              '\u76ee\u6807\u65e5\u671f\uff0c\u683c\u5f0f YYYY-MM-DD\uff08\u9ed8\u8ba4\uff1a\u4eca\u5929\uff09',
            ),
        },
        async (args) => {
          const normalizedContent = args.content.replace(/\r\n?/g, '\n').trim();
          if (!normalizedContent) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: '\u5185\u5bb9\u4e0d\u80fd\u4e3a\u7a7a\u3002',
                },
              ],
              isError: true,
            };
          }
          const appendBytes = Buffer.byteLength(normalizedContent, 'utf-8');
          if (appendBytes > MAX_MEMORY_APPEND_SIZE) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `\u5185\u5bb9\u8fc7\u5927\uff1a${appendBytes} \u5b57\u8282\uff08\u4e0a\u9650 ${MAX_MEMORY_APPEND_SIZE}\uff09\u3002`,
                },
              ],
              isError: true,
            };
          }
          const date = (
            args.date ?? new Date().toISOString().split('T')[0]
          ).trim();
          if (!MEMORY_DATE_PATTERN.test(date)) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `\u65e5\u671f\u683c\u5f0f\u65e0\u6548\uff1a\u201c${date}\u201d\uff0c\u8bf7\u4f7f\u7528 YYYY-MM-DD\u3002`,
                },
              ],
              isError: true,
            };
          }
          // 直接写入云端 cloud_memories: session 类型,path = memory/YYYY-MM-DD.md
          try {
            const data = await invokeCloudMemory(ctx, {
              operation: 'append',
              memoryType: 'session',
              groupFolder: ctx.groupFolder,
              path: `memory/${date}.md`,
              content: normalizedContent,
            });
            writeWorkspaceMemoryMirror(ctx, data.memory);
            const revision = data?.memory?.revision;
            return {
              content: [
                {
                  type: 'text' as const,
                  text:
                    `\u5df2\u8ffd\u52a0\u5230\u4e91\u7aef memory/${date}.md\uff08${appendBytes} \u5b57\u8282${
                      revision ? `\uff0crev ${revision}` : ''
                    }\uff09\u3002`,
                },
              ],
            };
          } catch (err) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `\u8ffd\u52a0\u4e91\u7aef\u8bb0\u5fc6\u65f6\u51fa\u9519\uff1a${err instanceof Error ? err.message : String(err)}`,
                },
              ],
              isError: true,
            };
          }
        },
      ),
    );
  }

  if (!ctx.disableMemoryLayer) {
    tools.push(
      tool(
        'workspace_memory_sync_local',
        '将当前 workspace 的云端记忆同步到本地工作区副本 /workspace/memory，用于快捷检索。通常无需手动调用，写入工具会自动同步对应文件。',
        {},
        async () => {
          try {
            const result = await syncWorkspaceMemoryMirror(ctx);
            return toolJson(result);
          } catch (err) {
            return toolError(err);
          }
        },
      ),
    );
  }

  // --- memory_search + memory_get --- (skipped in native Claude mode)
  if (!ctx.disableMemoryLayer) {
    tools.push(
    tool(
      'memory_search',
      `\u5728\u4e91\u7aef\u8bb0\u5fc6\uff08\u5168\u5c40 / \u5f53\u524d\u4f1a\u8bdd / client agent \u955c\u50cf\uff09\u4e2d\u641c\u7d22\u5173\u952e\u8bcd\u3002
\u8fd4\u56de\u8bb0\u5fc6\u8def\u5f84\u4e0e\u4e0a\u4e0b\u6587\u7247\u6bb5\u3002\u8bb0\u5fc6\u6570\u636e\u7edf\u4e00\u5b58\u4e8e\u4e91\u7aef\u6570\u636e\u5e93\uff0c\u4e0d\u518d\u4f9d\u8d56\u672c\u5730\u6587\u4ef6\u3002`,
      {
        query: z
          .string()
          .describe(
            '\u641c\u7d22\u5173\u952e\u8bcd\u6216\u77ed\u8bed\uff08\u4e0d\u533a\u5206\u5927\u5c0f\u5199\uff09',
          ),
        max_results: z
          .number()
          .optional()
          .default(20)
          .describe(
            '\u6700\u5927\u7ed3\u679c\u6570\uff08\u9ed8\u8ba4 20\uff0c\u4e0a\u9650 50\uff09',
          ),
      },
      async (args) => {
        if (!args.query.trim()) {
          return {
            content: [
              {
                type: 'text' as const,
                text: '\u641c\u7d22\u5173\u952e\u8bcd\u4e0d\u80fd\u4e3a\u7a7a\u3002',
              },
            ],
            isError: true,
          };
        }
        const maxResults = Math.min(Math.max(args.max_results ?? 20, 1), 50);
        const queryLower = args.query.toLowerCase();
        try {
          const data = await invokeCloudMemory(ctx, {
            operation: 'search',
            query: args.query,
          });
          const memories: any[] = Array.isArray(data?.memories) ? data.memories : [];
          if (memories.length === 0) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: '\u4e91\u7aef\u672a\u627e\u5230\u8bb0\u5fc6\u6587\u4ef6\u3002',
                },
              ],
            };
          }
          const results: string[] = [];
          for (const memory of memories) {
            if (results.length >= maxResults) break;
            const content: string = typeof memory.content === 'string' ? memory.content : '';
            if (!content) continue;
            const cloudPath = `cloud://${memory.memoryType}/${memory.scopeKey}/${memory.path}`;
            const lines = content.split('\n');
            let lastEnd = -1;
            for (let i = 0; i < lines.length; i++) {
              if (results.length >= maxResults) break;
              if (lines[i].toLowerCase().includes(queryLower)) {
                const start = Math.max(0, i - 1);
                if (start <= lastEnd) continue;
                const end = Math.min(lines.length, i + 2);
                lastEnd = end;
                const snippet = lines.slice(start, end).join('\n');
                results.push(`${cloudPath}:${i + 1}\n${snippet}`);
              }
            }
          }
          if (results.length === 0) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `\u5728 ${memories.length} \u4e2a\u4e91\u7aef\u8bb0\u5fc6\u4e2d\u672a\u627e\u5230\u201c${args.query}\u201d\u7684\u5339\u914d\u3002`,
                },
              ],
            };
          }
          return {
            content: [
              {
                type: 'text' as const,
                text: `\u4e91\u7aef\u627e\u5230 ${results.length} \u6761\u5339\u914d\uff1a\n\n${results.join('\n---\n')}`,
              },
            ],
          };
        } catch (err) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `\u641c\u7d22\u4e91\u7aef\u8bb0\u5fc6\u65f6\u51fa\u9519\uff1a${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            isError: true,
          };
        }
      },
    ),

    // --- memory_get ---
    tool(
      'memory_get',
      `\u8bfb\u53d6\u4e91\u7aef\u8bb0\u5fc6\u3002\u5728 memory_search \u4e4b\u540e\u4f7f\u7528\u4ee5\u83b7\u53d6\u5b8c\u6574\u4e0a\u4e0b\u6587\u3002\u53ef\u4f20\u5165\u5b8c\u6574 cloud:// \u8def\u5f84\uff0c\u6216\u7b80\u5199\u5982 "CLAUDE.md"\uff08\u5f53\u524d\u4f1a\u8bdd\uff09\u3001"[global] CLAUDE.md"\u3001"[memory] 2026-01-15.md"\u3002`,
      {
        file: z
          .string()
          .describe(
            '\u4e91\u7aef\u8bb0\u5fc6\u8def\u5f84\u3002\u53ef\u4f20\u5b8c\u6574 cloud:// \u8def\u5f84\u6216\u7b80\u5199\uff0c\u53ef\u5e26 :\u884c\u53f7',
          ),
        from_line: z
          .number()
          .optional()
          .describe(
            '\u8d77\u59cb\u884c\u53f7\uff08\u4ece 1 \u5f00\u59cb\uff0c\u9ed8\u8ba4\uff1a1\uff09',
          ),
        lines: z
          .number()
          .optional()
          .describe(
            '\u8bfb\u53d6\u884c\u6570\uff08\u9ed8\u8ba4\uff1a\u5168\u90e8\uff0c\u4e0a\u9650\uff1a200\uff09',
          ),
      },
      async (args) => {
        const { pathRef, lineFromRef } = parseMemoryFileReference(args.file);
        // 把简写或 cloud:// 路径解析成 invokeCloudMemory 的参数
        let memoryType: 'global' | 'session' | 'agent' = 'session';
        let memoryPath = pathRef;
        let groupFolder: string | undefined = ctx.groupFolder;
        let deviceLinkId: string | undefined;
        let agentId: string | undefined;
        let displayPath = pathRef;

        if (pathRef.startsWith('cloud://')) {
          const rest = pathRef.slice('cloud://'.length);
          const [type, ...parts] = rest.split('/');
          const scopeKey = parts.shift() ?? '';
          const remainder = parts.join('/');
          if ((type === 'global' || type === 'session' || type === 'agent') && scopeKey && remainder) {
            memoryType = type;
            memoryPath = remainder;
            if (type === 'session' && scopeKey.startsWith('session:')) {
              groupFolder = scopeKey.slice('session:'.length);
            } else if (type === 'agent' && scopeKey.startsWith('agent:')) {
              const [, dev, ag] = scopeKey.split(':');
              deviceLinkId = dev;
              agentId = ag;
              groupFolder = undefined;
            } else if (type === 'global') {
              groupFolder = undefined;
            }
            displayPath = pathRef;
          }
        } else if (pathRef.startsWith('[global] ')) {
          memoryType = 'global';
          memoryPath = pathRef.slice('[global] '.length);
          groupFolder = undefined;
          displayPath = `[global] ${memoryPath}`;
        } else if (pathRef.startsWith('[memory] ')) {
          memoryType = 'session';
          memoryPath = `memory/${pathRef.slice('[memory] '.length)}`;
          displayPath = `[memory] ${pathRef.slice('[memory] '.length)}`;
        } else if (pathRef.startsWith('[conversations] ')) {
          memoryType = 'session';
          memoryPath = `conversations/${pathRef.slice('[conversations] '.length)}`;
          displayPath = `[conversations] ${pathRef.slice('[conversations] '.length)}`;
        }

        try {
          const data = await invokeCloudMemory(ctx, {
            operation: 'get',
            memoryType,
            path: memoryPath,
            groupFolder,
            deviceLinkId,
            agentId,
          });
          const memory = data?.memory;
          if (!memory || typeof memory.content !== 'string') {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `\u4e91\u7aef\u672a\u627e\u5230\u8bb0\u5fc6\uff1a${displayPath}`,
                },
              ],
              isError: true,
            };
          }
          const allLines = memory.content.split('\n');
          const fromLine = Math.max(
            (args.from_line ?? lineFromRef ?? 1) - 1,
            0,
          );
          const maxLines = Math.min(args.lines ?? allLines.length, 200);
          const slice = allLines.slice(fromLine, fromLine + maxLines);
          const header = `${displayPath}\uff08\u7b2c ${fromLine + 1}-${fromLine + slice.length} \u884c\uff0c\u5171 ${allLines.length} \u884c\uff0crev ${memory.revision}\uff09`;
          return {
            content: [
              {
                type: 'text' as const,
                text: `${header}\n\n${slice.join('\n')}`,
              },
            ],
          };
        } catch (err) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `\u8bfb\u53d6\u4e91\u7aef\u8bb0\u5fc6\u65f6\u51fa\u9519\uff1a${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            isError: true,
          };
        }
      },
    ),
  );
  }

  if (isNestedAgentTeamContext(ctx)) {
    return tools.filter((t: any) => !String(t.name ?? '').startsWith('agent_team_'));
  }
  return tools;
}
