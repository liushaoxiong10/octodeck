import fs from 'fs';
import os from 'os';
import path from 'path';

import { beforeEach, describe, expect, test, vi } from 'vitest';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'octodeck-agent-definitions-'));

vi.spyOn(os, 'homedir').mockReturnValue(tmpRoot);

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
  systemConfigMiddleware: async (_c: any, next: any) => next(),
}));

vi.mock('../src/logger.js', () => ({
  logger: {
    warn: () => {},
  },
}));

const agentDefinitionsRoutes = (await import('../src/routes/agent-definitions.js')).default;

describe('POST /api/agent-definitions', () => {
  beforeEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.mkdirSync(tmpRoot, { recursive: true });
  });

  test('新增 Agent 时自动生成唯一 ID，重复名称不会冲突', async () => {
    const first = await createAgent('Code Reviewer');
    const second = await createAgent('Code Reviewer');

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.id).toMatch(/^agent-[a-z0-9]{8}$/);
    expect(second.body.id).toMatch(/^agent-[a-z0-9]{8}$/);
    expect(second.body.id).not.toBe(first.body.id);
    expect(fs.existsSync(path.join(tmpRoot, '.claude', 'agents', `${first.body.id}.md`))).toBe(true);
    expect(fs.existsSync(path.join(tmpRoot, '.claude', 'agents', `${second.body.id}.md`))).toBe(true);
  });

  test('忽略请求中的 id 字段，不能由客户端指定或修改 Agent ID', async () => {
    const res = await agentDefinitionsRoutes.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'custom-id',
        name: 'Custom ID Attempt',
        content: agentContent('Custom ID Attempt'),
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.id).not.toBe('custom-id');
    expect(body.id).toMatch(/^agent-[a-z0-9]{8}$/);
    expect(fs.existsSync(path.join(tmpRoot, '.claude', 'agents', 'custom-id.md'))).toBe(false);
    expect(fs.existsSync(path.join(tmpRoot, '.claude', 'agents', `${body.id}.md`))).toBe(true);
  });
});

async function createAgent(name: string): Promise<{ status: number; body: any }> {
  const res = await agentDefinitionsRoutes.request('/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, content: agentContent(name) }),
  });
  return { status: res.status, body: await res.json() };
}

function agentContent(name: string): string {
  return `---\nname: ${name}\ndescription:\ntools:\n  - Read\n---\n\n# ${name}\n`;
}
