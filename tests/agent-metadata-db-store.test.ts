import fs from 'fs';
import os from 'os';
import path from 'path';

import { beforeEach, describe, expect, test, vi } from 'vitest';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'octodeck-agent-metadata-db-'));
const tmpStoreDir = path.join(tmpRoot, 'db');
const tmpGroupsDir = path.join(tmpRoot, 'groups');

vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return {
    ...actual,
    DATA_DIR: tmpRoot,
    STORE_DIR: tmpStoreDir,
    GROUPS_DIR: tmpGroupsDir,
  };
});

const db = await import('../src/db.js');
const Database = (await import('../src/sqlite-compat.js')).default;

function readMetadataValue(key: string): string | undefined {
  const sqlite = new Database(path.join(tmpStoreDir, 'messages.db'));
  try {
    const row = sqlite
      .prepare('SELECT value FROM metadata_store WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return row?.value;
  } finally {
    sqlite.close();
  }
}

describe('agent metadata sqlite storage', () => {
  beforeEach(async () => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.mkdirSync(tmpRoot, { recursive: true });
    await db.initDatabase();
  });

  test('stores Agent Team and agent.md metadata in sqlite', async () => {
    const agentTeams = await import('../src/agent-teams.js');

    const team = agentTeams.createAgentTeam({
      name: 'Research Team',
      goal: '调研一个技术方案',
      shape: 'pipeline',
      description: '负责调研',
      roles: [{ id: 'lead', name: 'Lead', responsibility: '规划并汇总。' }],
      workflow: '先调研，再汇总。',
      successCriteria: ['输出结论'],
      createdByAgentId: 'claude-sdk',
    }, 'user_one');
    const definition = agentTeams.createAgentMdDefinition({
      name: 'Researcher',
      summary: '负责资料调研。',
      content: '# Researcher',
      createdByAgentId: 'claude-sdk',
    }, 'user_one');

    const teamsPayload = JSON.parse(readMetadataValue('agent_teams') || '{}') as {
      teams?: Array<{ id: string; createdByUserId?: string }>;
    };
    const agentMdPayload = JSON.parse(readMetadataValue('agent_md_definitions') || '{}') as {
      definitions?: Array<{ id: string; createdByUserId?: string }>;
    };

    expect(teamsPayload.teams?.[0]).toMatchObject({
      id: team.id,
      createdByUserId: 'user_one',
    });
    expect(agentMdPayload.definitions?.[0]).toMatchObject({
      id: definition.id,
      createdByUserId: 'user_one',
    });
  });

  test('stores custom Agent backend metadata in sqlite', async () => {
    const customLoader = await import('../src/backends/custom-loader.js');

    const backend = customLoader.upsertCustomBackend({
      id: 'test_backend',
      displayName: 'Test Backend',
      binary: '/bin/echo',
      argvTemplate: ['{{prompt}}'],
      outputProtocol: 'plain-text',
      supportsHost: true,
      supportsContainer: false,
      usesProviderPool: false,
      runtime: 'server-side',
    }, 'admin');

    const payload = JSON.parse(readMetadataValue('custom_backends') || '{}') as {
      backends?: Array<{ id: string; runtime?: string }>;
    };

    expect(payload.backends?.[0]).toMatchObject({
      id: backend.id,
      runtime: 'server-side',
    });
  });
});
