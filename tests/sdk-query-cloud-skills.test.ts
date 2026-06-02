import fs from 'fs';
import os from 'os';
import path from 'path';

import { beforeEach, describe, expect, test, vi } from 'vitest';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'octodeck-sdk-query-skills-'));
const tmpDataDir = path.join(tmpRoot, 'data');
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
    queryMock.mockClear();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.mkdirSync(tmpDataDir, { recursive: true });
  });

  test('exposes server-side user skills to Claude SDK Skill tool', async () => {
    const skillDir = path.join(tmpDataDir, 'skills', 'alice', 'cloud-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: Cloud Skill\n---\n# Cloud Skill\n');

    const { sdkQuery } = await import('../src/sdk-query.js');
    await expect(sdkQuery('use cloud skill', { userId: 'alice' })).resolves.toBe('cloud skill ok');

    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryCalls[0].args.options).toMatchObject({
      skills: 'all',
      allowedTools: ['Skill'],
      settingSources: ['project', 'user'],
    });
    const configDir = queryCalls[0].claudeConfigDir;
    expect(configDir).toBe(path.join(tmpDataDir, 'sdk-query', 'alice', '.claude'));
    expect(fs.readlinkSync(path.join(configDir!, 'skills', 'cloud-skill'))).toBe(skillDir);
  });
});
