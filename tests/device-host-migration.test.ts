import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = process.cwd();

describe('device-first host migration', () => {
  test('group create schema accepts execution_node so native execution is tied to a device', async () => {
    const { GroupCreateSchema } = await import('../src/schemas.js');

    const parsed = GroupCreateSchema.parse({
      name: 'Device Workspace',
      execution_mode: 'host',
      execution_node: 'cl_1234567890abcdef',
      custom_cwd: '/Users/lsx/code/app/happyclaw',
    });

    expect(parsed.execution_node).toBe('cl_1234567890abcdef');
  });

  test('device routes do not expose an implicit Server Device target', () => {
    const source = readFileSync(join(repoRoot, 'src/routes/agent-link.ts'), 'utf8');

    expect(source).not.toContain('SERVER_DEVICE_ID');
    expect(source).not.toContain('Server Device');
    expect(source).not.toContain('builtin: true');
  });

  test('workspace creation is device-first instead of host-first', () => {
    const source = readFileSync(join(repoRoot, 'web/src/components/chat/CreateContainerDialog.tsx'), 'utf8');

    expect(source).toContain('Device 原生执行');
    expect(source).toContain('execution_node');
    expect(source).toContain('useAgentLinksStore');
    expect(source).not.toContain('宿主机模式');
    expect(source).not.toContain('直接在服务器上执行');
  });

  test('workspace details and tasks show device targets rather than server-local host wording', () => {
    const groupDetail = readFileSync(join(repoRoot, 'web/src/components/groups/GroupDetail.tsx'), 'utf8');
    const taskForm = readFileSync(join(repoRoot, 'web/src/components/tasks/CreateTaskForm.tsx'), 'utf8');
    const groupRoutes = readFileSync(join(repoRoot, 'src/routes/groups.ts'), 'utf8');
    const taskRoutes = readFileSync(join(repoRoot, 'src/routes/tasks.ts'), 'utf8');

    expect(groupDetail).toContain('执行 Device');
    expect(groupDetail).not.toContain('Server Device');
    expect(groupDetail).not.toContain('server-local');
    expect(groupDetail).not.toContain('服务端本地');
    expect(taskForm).toContain('executionNode');
    expect(taskForm).toContain('执行 Device');
    expect(taskForm).not.toContain("useState('server-local')");
    expect(taskForm).not.toContain('宿主机</SelectItem>');
    expect(groupRoutes).not.toContain("validation.data.execution_node ?? 'server-local'");
    expect(taskRoutes).not.toContain("execution_node ?? group.executionNode ?? 'server-local'");
  });

  test('device capabilities replace host capability wording for server-local native tools', () => {
    const capabilities = readFileSync(join(repoRoot, 'src/agent-capabilities.ts'), 'utf8');
    const settings = readFileSync(join(repoRoot, 'web/src/components/settings/SystemSettingsSection.tsx'), 'utf8');

    expect(capabilities).not.toContain('Server Device');
    expect(capabilities).toContain('device native execution');
    expect(settings).toContain('最大并发 Device 原生进程数');
    expect(settings).not.toContain('最大并发宿主机进程数');
  });
});
