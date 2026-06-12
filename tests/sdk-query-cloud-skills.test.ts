import fs from 'fs';
import os from 'os';
import path from 'path';

import { beforeEach, describe, expect, test, vi } from 'vitest';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'octodeck-sdk-query-skills-'));
const tmpDataDir = path.join(tmpRoot, 'data');
const cloudMemoryMockState = vi.hoisted(() => ({ content: '' }));
const queryCalls = vi.hoisted(() => [] as Array<{ args: any; claudeConfigDir?: string }>);
const queryMock = vi.hoisted(() => vi.fn((args: any) => {
  queryCalls.push({ args, claudeConfigDir: process.env.CLAUDE_CONFIG_DIR });
  return (async function* () {
    yield { type: 'result', subtype: 'success', result: 'cloud skill ok' };
  })();
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: vi.fn((config) => config),
  query: queryMock,
  tool: vi.fn((name, description, inputSchema, handler) => ({ name, description, inputSchema, handler })),
}));

vi.mock('../src/memory-store.js', () => ({
  appendCloudMemory: vi.fn(),
  getCloudMemory: vi.fn(() => cloudMemoryMockState.content ? { content: cloudMemoryMockState.content } : null),
  putCloudMemory: vi.fn((args: { content: string }) => {
    cloudMemoryMockState.content = args.content;
    return { content: args.content };
  }),
  searchCloudMemory: vi.fn(() => []),
}));

vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return {
    ...actual,
    DATA_DIR: tmpDataDir,
  };
});

vi.mock('../src/runtime-config.js', () => ({
  buildClaudeEnvLines: () => ['ANTHROPIC_API_KEY=sk-test'],
  getClaudeProviderConfig: () => ({ anthropicModel: 'claude-test' }),
}));

describe('sdkQuery cloud skills', () => {
  beforeEach(() => {
    queryCalls.length = 0;
    cloudMemoryMockState.content = '';
    queryMock.mockClear();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.mkdirSync(tmpDataDir, { recursive: true });
  });

  test('exposes cloud skills via DB-backed MCP tools only', async () => {
    const { sdkQuery } = await import('../src/sdk-query.js');
    await expect(sdkQuery('use cloud skill', { userId: 'alice' })).resolves.toBe('cloud skill ok');

    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryCalls[0].args.options.allowedTools).toEqual([]);
    expect(queryCalls[0].args.options.skills).toBeUndefined();
    expect(queryCalls[0].args.options.settingSources).toBeUndefined();
    expect(queryCalls[0].args.options.mcpServers.octodeck_cloud_tools.tools.map((tool: any) => tool.name)).toEqual(
      expect.arrayContaining(['cloud_skill_search', 'cloud_skill_get']),
    );
    expect(queryCalls[0].claudeConfigDir).toBeUndefined();
  });

  test('injects user cloud global memory into Claude system prompt', async () => {
    const { putCloudMemory } = await import('../src/memory-store.js');
    putCloudMemory({
      userId: 'alice',
      memoryType: 'global',
      path: 'CLAUDE.md',
      content: '用户偏好：始终用中文简洁回答。',
      source: 'test',
      updatedBy: 'alice',
    });

    const { sdkQuery } = await import('../src/sdk-query.js');
    await expect(sdkQuery('hello', { userId: 'alice' })).resolves.toBe('cloud skill ok');

    expect(queryCalls[0].args.options.systemPrompt).toMatchObject({
      type: 'preset',
      preset: 'claude_code',
    });
    expect(queryCalls[0].args.options.systemPrompt.append).toContain('<cloud-global-memory>');
    expect(queryCalls[0].args.options.systemPrompt.append).toContain('用户偏好：始终用中文简洁回答。');
  });
});
