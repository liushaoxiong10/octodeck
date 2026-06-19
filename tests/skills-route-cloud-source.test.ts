import fs from 'fs';
import os from 'os';
import path from 'path';

import { beforeEach, describe, expect, test, vi } from 'vitest';

const getAgentLinkByIdMock = vi.hoisted(() => vi.fn());
const listCloudSkillsByUserMock = vi.hoisted(() => vi.fn(() => []));
const getSessionMock = vi.hoisted(() => vi.fn());
const invokeRemoteToolMock = vi.hoisted(() => vi.fn());
const getCustomBackendMock = vi.hoisted(() => vi.fn());
const upsertCloudSkillMock = vi.hoisted(() => vi.fn());
const execFileMock = vi.hoisted(() => vi.fn());

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'octodeck-skills-route-'));
const tmpDataDir = path.join(tmpRoot, 'data');
const tmpExternalDir = path.join(tmpRoot, 'external');

vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return {
    ...actual,
    DATA_DIR: tmpDataDir,
  };
});

vi.mock('../src/runtime-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/runtime-config.js')>();
  return {
    ...actual,
    getEffectiveExternalDir: () => tmpExternalDir,
  };
});

vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', {
      id: 'alice',
      username: 'alice',
      role: 'admin',
      permissions: ['manage_system_config'],
    });
    return next();
  },
}));

vi.mock('../src/db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/db.js')>();
  return {
    ...actual,
    getAgentLinkById: getAgentLinkByIdMock,
    listCloudSkillsByUser: listCloudSkillsByUserMock,
    getCloudSkill: () => undefined,
    setCloudSkillEnabled: () => false,
    deleteCloudSkill: () => false,
    upsertCloudSkill: upsertCloudSkillMock,
  };
});

vi.mock('child_process', () => ({
  execFile: execFileMock,
}));

vi.mock('../src/agent-link/registry.js', () => ({
  getSession: getSessionMock,
}));

vi.mock('../src/agent-link/tool-rpc.js', () => ({
  invokeRemoteTool: invokeRemoteToolMock,
}));

vi.mock('../src/backends/custom-loader.js', () => ({
  getCustomBackend: getCustomBackendMock,
}));

const skillsRoutes = (await import('../src/routes/skills.js')).default;

describe('GET /api/skills cloud source handling', () => {
  beforeEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.mkdirSync(tmpRoot, { recursive: true });
    getAgentLinkByIdMock.mockReset();
    listCloudSkillsByUserMock.mockReset();
    listCloudSkillsByUserMock.mockReturnValue([]);
    getSessionMock.mockReset();
    invokeRemoteToolMock.mockReset();
    getCustomBackendMock.mockReset();
    upsertCloudSkillMock.mockReset();
    execFileMock.mockReset();
  });

  test('lists DB-backed cloud skills and does not scan host local/system skills', async () => {
    writeSkill(path.join(tmpDataDir, 'skills', 'alice', 'user-skill'), 'User Skill');
    writeSkill(path.join(tmpExternalDir, 'skills', 'host-skill'), 'Host System Skill');
    listCloudSkillsByUserMock.mockReturnValue([
      {
        id: 'cloud_skill_1',
        userId: 'alice',
        skillId: 'cloud-db-skill',
        name: 'Cloud DB Skill',
        description: 'From DB',
        content: '---\nname: Cloud DB Skill\n---\n# Cloud DB Skill',
        enabled: true,
        packageName: 'owner/repo@cloud-db-skill',
        packageSource: 'skills.sh',
        sourceProvider: 'claude',
        installedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        files: [],
      },
    ]);

    const listRes = await skillsRoutes.request('/', { method: 'GET' });
    const listBody = await listRes.json();

    expect(listRes.status).toBe(200);
    expect(listBody.skills.map((skill: any) => skill.id)).toContain('cloud-db-skill');
    expect(listBody.skills.map((skill: any) => skill.id)).not.toContain('user-skill');
    expect(listBody.skills.map((skill: any) => skill.id)).not.toContain('host-skill');

    const detailRes = await skillsRoutes.request('/host-skill', { method: 'GET' });
    expect(detailRes.status).toBe(404);
  });

  test('installs device-global skills in daemon tmp runtime area', async () => {
    getAgentLinkByIdMock.mockReturnValue({
      id: 'cl_1234567890abcdef',
      userId: 'alice',
      revokedAt: null,
    });
    getSessionMock.mockReturnValue({ state: 'open', send: vi.fn() });
    invokeRemoteToolMock.mockResolvedValue({
      ok: true,
      result: { stdout: '', stderr: '' },
      error: null,
      durationMs: 12,
    });

    const res = await skillsRoutes.request('/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        package: 'owner/repo@demo-skill',
        target: 'device',
        deviceLinkId: 'cl_1234567890abcdef',
      }),
    });

    expect(res.status).toBe(200);
    expect(invokeRemoteToolMock).toHaveBeenCalledTimes(1);
    expect(invokeRemoteToolMock.mock.calls[0][1]).toMatchObject({
      linkId: 'cl_1234567890abcdef',
      toolName: 'Bash',
      cwd: 'octodeck-tmp://skills-install',
    });
  });

  test('installs device-global skills through the selected provider native directory', async () => {
    getAgentLinkByIdMock.mockReturnValue({
      id: 'cl_1234567890abcdef',
      userId: 'alice',
      revokedAt: null,
    });
    getSessionMock.mockReturnValue({ state: 'open', send: vi.fn() });
    invokeRemoteToolMock.mockResolvedValue({
      ok: true,
      result: { stdout: 'demo-skill\n', stderr: '' },
      error: null,
      durationMs: 12,
    });

    const res = await skillsRoutes.request('/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        package: 'owner/repo@demo-skill',
        target: 'device',
        deviceLinkId: 'cl_1234567890abcdef',
        sourceProvider: 'codex',
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.installed).toEqual(['demo-skill']);
    const command = invokeRemoteToolMock.mock.calls[0][1].input.command as string;
    expect(command).toContain('-a codex');
    expect(command).toContain('$tmp_home/.codex/skills');
    expect(command).toContain('~/.codex/skills');
    expect(command).not.toContain('$tmp_home/.claude/skills');
  });

  test('installs skill into selected agent workspace on its bound device', async () => {
    getCustomBackendMock.mockReturnValue({
      id: 'agent-abc',
      displayName: 'Agent ABC',
      deviceLinkId: 'cl_1234567890abcdef',
      workdirMode: 'auto',
    });
    getAgentLinkByIdMock.mockReturnValue({
      id: 'cl_1234567890abcdef',
      userId: 'alice',
      revokedAt: null,
    });
    getSessionMock.mockReturnValue({ state: 'open', send: vi.fn() });
    invokeRemoteToolMock.mockResolvedValue({
      ok: true,
      result: { stdout: 'demo-skill\n', stderr: '' },
      error: null,
      durationMs: 12,
    });

    const res = await skillsRoutes.request('/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        package: 'owner/repo@demo-skill',
        target: 'device-agent-workspace',
        agentId: 'agent-abc',
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.installed).toEqual(['demo-skill']);
    expect(invokeRemoteToolMock).toHaveBeenCalledTimes(1);
    expect(invokeRemoteToolMock.mock.calls[0][1]).toMatchObject({
      linkId: 'cl_1234567890abcdef',
      toolName: 'Bash',
      cwd: 'octodeck-workspace://agent-abc',
    });
    expect(invokeRemoteToolMock.mock.calls[0][1].input.command).toContain('./skills');
  });

  test('installs workspace skills through the selected provider native workspace directory', async () => {
    getCustomBackendMock.mockReturnValue({
      id: 'agent-opencode',
      displayName: 'Agent OpenCode',
      deviceLinkId: 'cl_1234567890abcdef',
      workdirMode: 'auto',
    });
    getAgentLinkByIdMock.mockReturnValue({
      id: 'cl_1234567890abcdef',
      userId: 'alice',
      revokedAt: null,
    });
    getSessionMock.mockReturnValue({ state: 'open', send: vi.fn() });
    invokeRemoteToolMock.mockResolvedValue({
      ok: true,
      result: { stdout: 'demo-skill\n', stderr: '' },
      error: null,
      durationMs: 12,
    });

    const res = await skillsRoutes.request('/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        package: 'owner/repo@demo-skill',
        target: 'device-agent-workspace',
        agentId: 'agent-opencode',
        sourceProvider: 'opencode',
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.installed).toEqual(['demo-skill']);
    const command = invokeRemoteToolMock.mock.calls[0][1].input.command as string;
    expect(command).toContain('-a opencode');
    expect(command).toContain('$tmp_home/.opencode/skills');
    expect(command).toContain('./.opencode/skills');
    expect(command).not.toContain('$tmp_home/.claude/skills');
  });

  test.each([
    { sourceProvider: 'claude', providerDir: '.claude', adapter: 'claude-code' },
    { sourceProvider: 'codex', providerDir: '.codex', adapter: 'codex' },
    { sourceProvider: 'traecli', providerDir: '.trae', adapter: 'traecli' },
    { sourceProvider: 'opencode', providerDir: '.opencode', adapter: 'opencode' },
  ])(
    'installs cloud skill packages through $sourceProvider native skills directory',
    async ({ sourceProvider, providerDir, adapter }) => {
      execFileMock.mockImplementation(
        (
          _file: string,
          args: string[],
          options: { env?: NodeJS.ProcessEnv },
          callback: (error: Error | null, stdout: string, stderr: string) => void,
        ) => {
          expect(args).toEqual([
            '-y',
            'skills',
            'add',
            'owner/repo@demo-skill',
            '--global',
            '--yes',
            '-a',
            adapter,
          ]);
          const home = options.env?.HOME;
          expect(home).toBeTruthy();
          writeSkill(path.join(home!, providerDir, 'skills', 'demo-skill'), 'Demo Skill');
          callback(null, '', '');
        },
      );

      const res = await skillsRoutes.request('/install', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          package: 'owner/repo@demo-skill',
          sourceProvider,
        }),
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.installed).toEqual(['demo-skill']);
      expect(upsertCloudSkillMock).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'alice',
          skillId: 'demo-skill',
          packageName: 'owner/repo@demo-skill',
          packageSource: 'skills.sh',
          sourceProvider,
        }),
      );
    },
  );
});

function writeSkill(dir: string, name: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} description\n---\n# ${name}\n`,
  );
}
