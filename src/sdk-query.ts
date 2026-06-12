/**
 * Lightweight Claude Agent SDK wrapper for simple text-in → text-out queries.
 * Replaces all `claude --print` CLI calls so authentication uses the
 * provider configured in the settings page (ANTHROPIC_API_KEY / OAuth / Base URL).
 */

import {
  createSdkMcpServer,
  query,
  tool,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  buildClaudeEnvLines,
  getClaudeProviderConfig,
} from './runtime-config.js';
import { logger } from './logger.js';
import {
  appendCloudMemory,
  getCloudMemory,
  putCloudMemory,
  searchCloudMemory,
} from './memory-store.js';
import { getCloudSkill, listCloudSkillsByUser } from './db.js';

// Mutex: process.env mutation is not re-entrant. Serialize concurrent calls
// to prevent overlapping env writes from corrupting each other.
let envLock: Promise<void> = Promise.resolve();

function loadCloudGlobalMemoryForSystemPrompt(userId: string | undefined): string {
  if (!userId) return '';
  try {
    return getCloudMemory({
      userId,
      memoryType: 'global',
      path: 'CLAUDE.md',
    })?.content?.trim() ?? '';
  } catch (err) {
    logger.warn(
      { err: (err as Error).message?.slice(0, 200), userId },
      'sdkQuery failed to load cloud global memory',
    );
    return '';
  }
}

/**
 * Send a prompt to Claude and return the plain-text response.
 * Uses the provider configured in the web settings (not a separate CLI install).
 *
 * @param prompt  The user prompt text
 * @param opts.model   Override model (defaults to provider config)
 * @param opts.timeout Timeout in ms (default 60 000)
 * @returns The assistant's text response, or null on failure
 */
export async function sdkQuery(
  prompt: string,
  opts?: { model?: string; timeout?: number; userId?: string },
): Promise<string | null> {
  // Chain on the lock so only one sdkQuery touches process.env at a time
  let release: () => void;
  const acquired = new Promise<void>((r) => (release = r));
  const prevLock = envLock;
  envLock = acquired;
  await prevLock;

  const timeout = opts?.timeout ?? 60_000;
  // Inject provider credentials into process.env for the SDK
  const config = getClaudeProviderConfig();
  const envLines = buildClaudeEnvLines(config);
  const savedEnv: Record<string, string | undefined> = {};
  for (const line of envLines) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeout);

  try {
    const model = opts?.model || config.anthropicModel || undefined;
    const cloudGlobalMemory = loadCloudGlobalMemoryForSystemPrompt(opts?.userId);
    const systemPromptAppend = cloudGlobalMemory
      ? `<cloud-global-memory>\n以下是该用户在 OctoDeck 云端的全局记忆 (cloud://global/global:${opts?.userId ?? ''}/CLAUDE.md)。请将其作为长期记忆参考,在适当时遵循其中的偏好与约定。\n\n${cloudGlobalMemory}\n</cloud-global-memory>`
      : '';
    const cloudToolsMcp =
      opts?.userId &&
      typeof createSdkMcpServer === 'function' &&
      typeof tool === 'function'
        ? createSdkMcpServer({
            name: 'octodeck-cloud-tools',
            version: '1.0.0',
            tools: [
              ...createCloudMemoryTools(opts.userId),
              ...createCloudSkillTools(opts.userId),
            ],
          })
        : null;

    let result = '';
    const conversation = query({
      prompt,
      options: {
        ...(model && { model }),
        maxTurns: 1,
        allowedTools: [],
        permissionMode: 'bypassPermissions' as const,
        allowDangerouslySkipPermissions: true,
        ...(systemPromptAppend
          ? { systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: systemPromptAppend } }
          : {}),
        ...(cloudToolsMcp
          ? { mcpServers: { octodeck_cloud_tools: cloudToolsMcp } }
          : {}),
        abortController,
      },
    });

    for await (const event of conversation) {
      if (event.type === 'result' && event.subtype === 'success') {
        result = event.result;
      }
    }

    return result.trim() || null;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message?.slice(0, 200) },
      'sdkQuery failed',
    );
    return null;
  } finally {
    clearTimeout(timer);
    // Restore original env
    for (const [key, original] of Object.entries(savedEnv)) {
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
    release!();
  }
}

function createCloudSkillTools(userId: string) {
  return [
    tool(
      'cloud_skill_search',
      '搜索云端数据库中的 Cloud Skills。',
      { query: z.string().optional() },
      async (args) => ({
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              listCloudSkillsByUser(userId)
                .filter((skill) => skill.enabled)
                .filter((skill) => {
                  const query = args.query?.trim().toLowerCase();
                  return (
                    !query ||
                    skill.skillId.toLowerCase().includes(query) ||
                    skill.name.toLowerCase().includes(query) ||
                    skill.description.toLowerCase().includes(query) ||
                    (skill.packageName ?? '').toLowerCase().includes(query)
                  );
                })
                .map((skill) => ({
                  id: skill.skillId,
                  name: skill.name,
                  description: skill.description,
                  packageName: skill.packageName,
                  sourceProvider: skill.sourceProvider,
                })),
              null,
              2,
            ),
          },
        ],
      }),
    ),
    tool(
      'cloud_skill_get',
      '读取云端数据库中指定 Cloud Skill 的 SKILL.md 内容。',
      { skill_id: z.string() },
      async (args) => ({
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(getCloudSkill(userId, args.skill_id) ?? null, null, 2),
          },
        ],
      }),
    ),
  ];
}

function createCloudMemoryTools(userId: string) {
  return [
    tool(
      'cloud_memory_search',
      '搜索云端数据库记忆。',
      {
        query: z.string(),
        memory_type: z.enum(['global', 'session', 'agent']).optional(),
      },
      async (args) => ({
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              searchCloudMemory({
                userId,
                query: args.query,
                memoryType: args.memory_type,
              }),
              null,
              2,
            ),
          },
        ],
      }),
    ),
    tool(
      'cloud_memory_get',
      '读取云端数据库记忆。',
      {
        memory_type: z.enum(['global', 'session', 'agent']),
        path: z.string(),
        group_folder: z.string().optional(),
        device_link_id: z.string().optional(),
        agent_id: z.string().optional(),
      },
      async (args) => ({
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              getCloudMemory({
                userId,
                memoryType: args.memory_type,
                path: args.path,
                groupFolder: args.group_folder,
                deviceLinkId: args.device_link_id,
                agentId: args.agent_id,
              }) ?? null,
              null,
              2,
            ),
          },
        ],
      }),
    ),
    tool(
      'cloud_memory_append',
      '追加写入云端权威记忆，仅支持 global/session。',
      {
        memory_type: z.enum(['global', 'session']),
        path: z.string(),
        content: z.string(),
        group_folder: z.string().optional(),
      },
      async (args) => ({
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              appendCloudMemory({
                userId,
                memoryType: args.memory_type,
                path: args.path,
                content: args.content,
                groupFolder: args.group_folder,
                source: 'cloud_sdk',
                updatedBy: userId,
              }),
              null,
              2,
            ),
          },
        ],
      }),
    ),
    tool(
      'cloud_memory_update',
      '覆盖更新云端权威记忆，仅支持 global/session。',
      {
        memory_type: z.enum(['global', 'session']),
        path: z.string(),
        content: z.string(),
        group_folder: z.string().optional(),
        expected_revision: z.number().optional(),
      },
      async (args) => ({
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              putCloudMemory({
                userId,
                memoryType: args.memory_type,
                path: args.path,
                content: args.content,
                groupFolder: args.group_folder,
                expectedRevision: args.expected_revision,
                source: 'cloud_sdk',
                updatedBy: userId,
              }),
              null,
              2,
            ),
          },
        ],
      }),
    ),
  ];
}
