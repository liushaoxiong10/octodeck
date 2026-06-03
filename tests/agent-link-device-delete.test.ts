import fs from 'fs';
import os from 'os';
import path from 'path';

import { beforeEach, describe, expect, test, vi } from 'vitest';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'octodeck-agent-link-delete-'));
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

vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', {
      id: 'alice',
      username: 'alice',
      role: 'admin',
      permissions: ['manage_system_config', 'host_execution'],
    });
    return next();
  },
  systemConfigMiddleware: async (_c: any, next: any) => next(),
}));

vi.mock('../src/logger.js', () => ({
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  },
}));

const db = await import('../src/db.js');
const customLoader = await import('../src/backends/custom-loader.js');
const agentLinkRoutes = (await import('../src/routes/agent-link.js')).default;

describe('DELETE /api/devices/:id', () => {
  beforeEach(async () => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.mkdirSync(tmpRoot, { recursive: true });
    await db.initDatabase();
    customLoader.loadCustomBackendsFromDisk();
  });

  test('拒绝删除仍被自定义 Agent 关联的设备', async () => {
    const deviceId = 'cl_1234567890abcdef';
    seedUserAndDevice(deviceId);
    customLoader.upsertCustomBackend({
      id: 'mac-codex',
      displayName: 'Mac Codex',
      binary: 'codex',
      argvTemplate: ['exec', '{prompt}'],
      outputProtocol: 'plain-text',
      supportsHost: true,
      supportsContainer: false,
      usesProviderPool: false,
      runtime: 'local-device',
      deviceLinkId: deviceId,
      agentClientId: 'codex',
    }, 'alice');

    const res = await agentLinkRoutes.request(`/${deviceId}`, { method: 'DELETE' });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toContain('关联的 Agent');
    expect(body.agents).toEqual([
      { id: 'mac-codex', displayName: 'Mac Codex' },
    ]);
    expect(db.getAgentLinkById(deviceId)?.revokedAt).toBeUndefined();
  });

  test('拒绝删除仍被工作区关联的设备', async () => {
    const deviceId = 'cl_1234567890abcdef';
    seedUserAndDevice(deviceId);
    db.setRegisteredGroup('web:workspace', {
      name: 'Device Workspace',
      folder: 'device-workspace',
      added_at: new Date().toISOString(),
      created_by: 'alice',
      runtimeProfile: 'device-cli-agent',
      executionMode: 'host',
      deviceLinkId: deviceId,
      executionNode: deviceId,
      agentClientId: 'codex',
    });

    const res = await agentLinkRoutes.request(`/${deviceId}`, { method: 'DELETE' });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.workspaces).toEqual([
      { jid: 'web:workspace', name: 'Device Workspace', folder: 'device-workspace' },
    ]);
    expect(db.getAgentLinkById(deviceId)?.revokedAt).toBeUndefined();
  });

  test('拒绝删除仍被 Repo 关联的设备', async () => {
    const deviceId = 'cl_1234567890abcdef';
    seedUserAndDevice(deviceId);
    const repo = db.createManagedRepo({
      name: 'Local Project',
      kind: 'device_path',
      devicePath: '/Users/alice/project',
      deviceLinkId: deviceId,
      createdBy: 'alice',
    });

    const res = await agentLinkRoutes.request(`/${deviceId}`, { method: 'DELETE' });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.repos).toEqual([
      { id: repo.id, name: 'Local Project', kind: 'device_path' },
    ]);
    expect(db.getAgentLinkById(deviceId)?.revokedAt).toBeUndefined();
  });

  test('拒绝删除仍被定时任务关联的设备', async () => {
    const deviceId = 'cl_1234567890abcdef';
    seedUserAndDevice(deviceId);
    db.createTask({
      id: 'task-device',
      group_folder: 'device-workspace',
      chat_jid: 'web:workspace',
      prompt: 'run on device',
      schedule_type: 'once',
      schedule_value: new Date(Date.now() + 60_000).toISOString(),
      context_mode: 'group',
      execution_type: 'agent',
      execution_mode: 'host',
      execution_node: deviceId,
      script_command: null,
      next_run: new Date(Date.now() + 60_000).toISOString(),
      status: 'active',
      created_at: new Date().toISOString(),
      created_by: 'alice',
      notify_channels: null,
    });

    const res = await agentLinkRoutes.request(`/${deviceId}`, { method: 'DELETE' });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.tasks).toEqual([
      { id: 'task-device', prompt: 'run on device', status: 'active' },
    ]);
    expect(db.getAgentLinkById(deviceId)?.revokedAt).toBeUndefined();
  });
});

function seedUserAndDevice(deviceId: string): void {
  const now = new Date().toISOString();
  db.createUser({
    id: 'alice',
    username: 'alice',
    password_hash: 'hash',
    display_name: 'Alice',
    role: 'admin',
    status: 'active',
    created_at: now,
    updated_at: now,
  });
  db.createAgentLink({
    id: deviceId,
    userId: 'alice',
    displayName: 'MacBook',
    tokenHash: 'hash',
  });
}
