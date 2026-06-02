import fs from 'fs';
import os from 'os';
import path from 'path';

import { beforeEach, describe, expect, test, vi } from 'vitest';

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

const skillsRoutes = (await import('../src/routes/skills.js')).default;

describe('GET /api/skills cloud source handling', () => {
  beforeEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.mkdirSync(tmpRoot, { recursive: true });
  });

  test('does not scan host local/system skills from the external local library', async () => {
    writeSkill(path.join(tmpDataDir, 'skills', 'alice', 'user-skill'), 'User Skill');
    writeSkill(path.join(tmpExternalDir, 'skills', 'host-skill'), 'Host System Skill');

    const listRes = await skillsRoutes.request('/', { method: 'GET' });
    const listBody = await listRes.json();

    expect(listRes.status).toBe(200);
    expect(listBody.skills.map((skill: any) => skill.id)).toContain('user-skill');
    expect(listBody.skills.map((skill: any) => skill.id)).not.toContain('host-skill');

    const detailRes = await skillsRoutes.request('/host-skill', { method: 'GET' });
    expect(detailRes.status).toBe(404);
  });
});

function writeSkill(dir: string, name: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} description\n---\n# ${name}\n`,
  );
}
