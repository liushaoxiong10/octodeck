/**
 * Lightweight Claude Agent SDK wrapper for simple text-in → text-out queries.
 * Replaces all `claude --print` CLI calls so authentication uses the
 * provider configured in the settings page (ANTHROPIC_API_KEY / OAuth / Base URL).
 */

import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { DATA_DIR } from './config.js';
import { buildClaudeEnvLines, getClaudeProviderConfig } from './runtime-config.js';
import { logger } from './logger.js';
import { appendCloudMemory, getCloudMemory, putCloudMemory, searchCloudMemory } from './memory-store.js';

// Mutex: process.env mutation is not re-entrant. Serialize concurrent calls
// to prevent overlapping env writes from corrupting each other.
let envLock: Promise<void> = Promise.resolve();

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
  const cloudSkillConfigDir = opts?.userId
    ? prepareCloudSkillConfigDir(opts.userId)
    : null;

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
  if (cloudSkillConfigDir) {
    savedEnv.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = cloudSkillConfigDir;
  }

  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeout);

  try {
    const model = opts?.model || config.anthropicModel || undefined;
    const cloudMemoryMcp = opts?.userId && typeof createSdkMcpServer === 'function' && typeof tool === 'function'
      ? createSdkMcpServer({
          name: 'octodeck-cloud-memory',
          version: '1.0.0',
          tools: createCloudMemoryTools(opts.userId),
        })
      : null;

    let result = '';
    const conversation = query({
      prompt,
      options: {
        ...(model && { model }),
        maxTurns: 1,
        allowedTools: cloudSkillConfigDir ? ['Skill'] : [],
        permissionMode: 'bypassPermissions' as const,
        allowDangerouslySkipPermissions: true,
        ...(cloudSkillConfigDir
          ? {
              settingSources: ['project', 'user'] as const,
              skills: 'all' as const,
            }
          : {}),
        ...(cloudMemoryMcp ? { mcpServers: { octodeck_cloud_memory: cloudMemoryMcp } } : {}),
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
    logger.warn({ err: (err as Error).message?.slice(0, 200) }, 'sdkQuery failed');
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

function createCloudMemoryTools(userId: string) {
  return [
    tool('cloud_memory_search', '搜索云端数据库记忆。', {
      query: z.string(),
      memory_type: z.enum(['global', 'session', 'agent']).optional(),
    }, async (args) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(searchCloudMemory({ userId, query: args.query, memoryType: args.memory_type }), null, 2) }],
    })),
    tool('cloud_memory_get', '读取云端数据库记忆。', {
      memory_type: z.enum(['global', 'session', 'agent']),
      path: z.string(),
      group_folder: z.string().optional(),
      device_link_id: z.string().optional(),
      agent_id: z.string().optional(),
    }, async (args) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(getCloudMemory({
        userId,
        memoryType: args.memory_type,
        path: args.path,
        groupFolder: args.group_folder,
        deviceLinkId: args.device_link_id,
        agentId: args.agent_id,
      }) ?? null, null, 2) }],
    })),
    tool('cloud_memory_append', '追加写入云端权威记忆，仅支持 global/session。', {
      memory_type: z.enum(['global', 'session']),
      path: z.string(),
      content: z.string(),
      group_folder: z.string().optional(),
    }, async (args) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(appendCloudMemory({
        userId,
        memoryType: args.memory_type,
        path: args.path,
        content: args.content,
        groupFolder: args.group_folder,
        source: 'cloud_sdk',
        updatedBy: userId,
      }), null, 2) }],
    })),
    tool('cloud_memory_update', '覆盖更新云端权威记忆，仅支持 global/session。', {
      memory_type: z.enum(['global', 'session']),
      path: z.string(),
      content: z.string(),
      group_folder: z.string().optional(),
      expected_revision: z.number().optional(),
    }, async (args) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(putCloudMemory({
        userId,
        memoryType: args.memory_type,
        path: args.path,
        content: args.content,
        groupFolder: args.group_folder,
        expectedRevision: args.expected_revision,
        source: 'cloud_sdk',
        updatedBy: userId,
      }), null, 2) }],
    })),
  ];
}

function prepareCloudSkillConfigDir(userId: string): string | null {
  if (!/^[\w-]+$/.test(userId)) return null;
  const userSkillsDir = path.join(DATA_DIR, 'skills', userId);
  if (!fs.existsSync(userSkillsDir)) return null;

  const configDir = path.join(DATA_DIR, 'sdk-query', userId, '.claude');
  const skillsDir = path.join(configDir, 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });

  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      fs.rmSync(path.join(skillsDir, entry.name), { recursive: true, force: true });
    }
  }

  for (const entry of fs.readdirSync(userSkillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const source = path.join(userSkillsDir, entry.name);
    const target = path.join(skillsDir, entry.name);
    try {
      fs.symlinkSync(source, target);
    } catch {
      // Fallback for filesystems that disallow symlinks.
      fs.cpSync(source, target, { recursive: true });
    }
  }

  return configDir;
}
