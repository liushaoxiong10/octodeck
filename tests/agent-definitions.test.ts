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

vi.mock('../src/db.js', () => ({
  listCloudSkillsByUser: () => [
    {
      skillId: 'bits-code-guard',
      name: 'Code Guard',
      description: 'Review code changes',
      content: '---\nversion: 1.2.3\nauthor: devinfra\n---\n# Code Guard\n',
      packageName: '@octodeck/code-guard',
      packageSource: 'https://skills.example/code-guard',
      sourceProvider: 'claude',
      installedAt: '2026-06-12T00:01:00.000Z',
      updatedAt: '2026-06-12T00:02:00.000Z',
      files: [{ name: 'SKILL.md', type: 'file', size: 55 }],
    },
  ],
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

  test('列表和详情返回 Agent 依赖的版本化 Skill 清单', async () => {
    const agentsDir = path.join(tmpRoot, '.claude', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, 'reviewer.md'),
      `---
name: Review Agent
description: Reviews diffs
tools:
  - Read
required-skills:
  - bits-code-guard@^1.2.0
  - graphify
---

# Review Agent
`,
      'utf8',
    );

    const listRes = await agentDefinitionsRoutes.request('/', { method: 'GET' });
    const listBody = await listRes.json();
    const agent = listBody.agents.find((item: any) => item.id === 'reviewer');
    expect(agent.requiredSkills).toEqual([
      { id: 'bits-code-guard', version: '^1.2.0', raw: 'bits-code-guard@^1.2.0' },
      { id: 'graphify', version: null, raw: 'graphify' },
    ]);

    const detailRes = await agentDefinitionsRoutes.request('/reviewer', { method: 'GET' });
    const detailBody = await detailRes.json();
    expect(detailBody.agent.requiredSkills).toEqual(agent.requiredSkills);
  });

  test('Registry 快照返回 Agent 版本、可见性、默认模型与 Skill 安装记录', async () => {
    const agentsDir = path.join(tmpRoot, '.claude', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, 'reviewer.md'),
      `---
name: Review Agent
description: Reviews diffs
version: 1.4.0
visibility: team
default-model: claude-sonnet-4
tools:
  - Read
required-skills:
  - bits-code-guard@^1.2.0
  - graphify
---

# Review Agent
`,
      'utf8',
    );

    const res = await agentDefinitionsRoutes.request('/registry', { method: 'GET' });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.registry.summary).toMatchObject({
      totalAgents: 1,
      totalSkillPackages: 1,
      unresolvedSkillDependencies: 1,
    });
    expect(body.registry.agents[0]).toMatchObject({
      id: 'reviewer',
      version: '1.4.0',
      visibility: 'team',
      defaultModel: 'claude-sonnet-4',
      requiredSkills: [
        {
          id: 'bits-code-guard',
          requestedVersion: '^1.2.0',
          installed: true,
          installedVersion: '1.2.3',
          packageId: '@octodeck/code-guard',
        },
        {
          id: 'graphify',
          requestedVersion: null,
          installed: false,
          packageId: null,
        },
      ],
    });
    expect(body.registry.skillPackages[0]).toMatchObject({
      id: '@octodeck/code-guard',
      version: '1.2.3',
      author: 'devinfra',
      installRecords: [{ skillId: 'bits-code-guard', target: 'cloud', provider: 'claude' }],
    });
  });

  test('Agent Definition 更新会生成审批审计记录、保留旧版本并支持回滚', async () => {
    const agentsDir = path.join(tmpRoot, '.claude', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, 'reviewer.md'),
      agentContentWithVersion('Review Agent', '1.0.0'),
      'utf8',
    );

    const updateRes = await agentDefinitionsRoutes.request('/reviewer', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: agentContentWithVersion('Review Agent', '1.1.0') }),
    });

    expect(updateRes.status).toBe(200);
    const governanceRes = await agentDefinitionsRoutes.request('/reviewer/governance', {
      method: 'GET',
    });
    const governanceBody = await governanceRes.json();

    expect(governanceRes.status).toBe(200);
    expect(governanceBody.governance.versions).toHaveLength(1);
    expect(governanceBody.governance.versions[0]).toMatchObject({
      agentId: 'reviewer',
      version: '1.0.0',
      createdBy: 'alice',
      sourceAction: 'update',
    });
    expect(governanceBody.governance.auditEvents[0]).toMatchObject({
      agentId: 'reviewer',
      action: 'update',
      actorUserId: 'alice',
      fromVersion: '1.0.0',
      toVersion: '1.1.0',
      approval: { status: 'approved', approvedBy: 'alice' },
    });

    const versionId = governanceBody.governance.versions[0].id;
    const rollbackRes = await agentDefinitionsRoutes.request('/reviewer/rollback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ versionId }),
    });
    const rollbackBody = await rollbackRes.json();

    expect(rollbackRes.status).toBe(200);
    expect(rollbackBody).toMatchObject({ success: true, restoredVersion: '1.0.0' });

    const detailRes = await agentDefinitionsRoutes.request('/reviewer', { method: 'GET' });
    const detailBody = await detailRes.json();
    expect(detailBody.agent.version).toBe('1.0.0');

    const afterRollbackRes = await agentDefinitionsRoutes.request('/reviewer/governance', {
      method: 'GET',
    });
    const afterRollbackBody = await afterRollbackRes.json();
    expect(afterRollbackBody.governance.auditEvents[0]).toMatchObject({
      action: 'rollback',
      fromVersion: '1.1.0',
      toVersion: '1.0.0',
      rollbackVersionId: versionId,
      approval: { status: 'approved', approvedBy: 'alice' },
    });
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

function agentContentWithVersion(name: string, version: string): string {
  return `---\nname: ${name}\ndescription:\nversion: ${version}\ntools:\n  - Read\n---\n\n# ${name}\n`;
}
