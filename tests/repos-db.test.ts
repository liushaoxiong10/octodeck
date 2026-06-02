import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octodeck-repos-db-'));
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

vi.mock('../src/config.js', async () => ({
  STORE_DIR: tmpStoreDir,
  GROUPS_DIR: tmpGroupsDir,
}));

const db = await import('../src/db.js');

beforeAll(() => {
  db.initDatabase();
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('managed repos db', () => {
  test('creates and lists managed git repos by owner', () => {
    const repo = db.createManagedRepo({
      name: 'HappyClaw',
      kind: 'git',
      gitUrl: 'https://github.com/liushaoxiong10/happyclaw.git',
      createdBy: 'user-a',
    });

    expect(repo.id).toMatch(/^repo_/);
    expect(repo.kind).toBe('git');
    expect(repo.gitUrl).toBe('https://github.com/liushaoxiong10/happyclaw.git');

    expect(db.listManagedReposByUser('user-a')).toHaveLength(1);
    expect(db.listManagedReposByUser('user-b')).toHaveLength(0);
  });

  test('stores repo_id on registered groups', () => {
    const repo = db.createManagedRepo({
      name: 'Device Project',
      kind: 'device_path',
      devicePath: '/Users/me/code/project',
      deviceLinkId: 'cl_1234567890abcdef',
      createdBy: 'user-a',
    });

    db.setRegisteredGroup('web:repo-test', {
      name: 'Repo Workspace',
      folder: 'repo-workspace',
      added_at: new Date().toISOString(),
      executionMode: 'host',
      executionNode: 'cl_1234567890abcdef',
      repoId: repo.id,
    });

    expect(db.getRegisteredGroup('web:repo-test')?.repoId).toBe(repo.id);
  });

  test('stores explicit runtime profile and device agent fields on registered groups', () => {
    db.setRegisteredGroup('web:runtime-profile-test', {
      name: 'Runtime Profile Workspace',
      folder: 'runtime-profile-workspace',
      added_at: new Date().toISOString(),
      runtimeProfile: 'device-cli-agent',
      deviceLinkId: 'cl_1234567890abcdef',
      agentClientId: 'claude-code',
      backend: 'mac-claude-code',
    });

    const group = db.getRegisteredGroup('web:runtime-profile-test');
    expect(group?.runtimeProfile).toBe('device-cli-agent');
    expect(group?.deviceLinkId).toBe('cl_1234567890abcdef');
    expect(group?.agentClientId).toBe('claude-code');
  });
});
