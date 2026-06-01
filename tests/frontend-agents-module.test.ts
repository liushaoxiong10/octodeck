import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { baseNavItems } from '../web/src/components/layout/nav-items.js';

const repoRoot = process.cwd();

describe('frontend agents module', () => {
  test('shows Agent as a top-level entry next to Devices', () => {
    const paths = baseNavItems.map((item) => item.path);
    const agents = baseNavItems.find((item) => item.path === '/agents');

    expect(agents?.label).toBe('Agent');
    expect(paths.indexOf('/agents')).toBeGreaterThan(paths.indexOf('/devices'));
    expect(paths.indexOf('/agents')).toBeLessThan(paths.indexOf('/settings'));
  });

  test('moves backend configuration out of System Settings into AgentsPage', () => {
    const systemSettings = readFileSync(
      join(repoRoot, 'web/src/components/settings/SystemSettingsSection.tsx'),
      'utf8',
    );
    const agentsPage = readFileSync(join(repoRoot, 'web/src/pages/AgentsPage.tsx'), 'utf8');
    const app = readFileSync(join(repoRoot, 'web/src/App.tsx'), 'utf8');

    expect(systemSettings).not.toContain('Agent 后端');
    expect(systemSettings).not.toContain('CustomBackendList');
    expect(agentsPage).toContain('Agent 后端列表');
    expect(agentsPage).toContain("['Instructions', 'Skills', 'Tasks', 'Args', 'ENV', 'Settings']");
    expect(agentsPage).toContain('lg:grid-cols-[minmax(280px,1fr)_minmax(0,2fr)]');
    expect(agentsPage).toContain('role="tablist"');
    expect(agentsPage).toContain('role="tabpanel"');
    expect(agentsPage).toContain('activeModule');
    expect(agentsPage).toContain('handleSetDefaultAgent');
    expect(agentsPage).toContain("api.put<SystemSettings>('/api/config/system'");
    expect(app).toContain('path="/agents"');
  });

  test('custom backend form supports creating an agent on a selected device', () => {
    const form = readFileSync(
      join(repoRoot, 'web/src/components/settings/CustomBackendFormDialog.tsx'),
      'utf8',
    );

    expect(form).toContain('deviceLinkId');
    expect(form).toContain('useAgentLinksStore');
    expect(form).toContain('选择设备');
  });

  test('custom backend form exposes server-side runtime without requiring a device', () => {
    const form = readFileSync(
      join(repoRoot, 'web/src/components/settings/CustomBackendFormDialog.tsx'),
      'utf8',
    );

    expect(form).toContain('Server Side');
    expect(form).toContain("runtime === 'server-side'");
    const deviceValidation = form.indexOf('if (!form.deviceLinkId)');
    const localRuntimeValidation = form.indexOf("if (form.runtime === 'local-device')");
    expect(deviceValidation).toBeGreaterThan(localRuntimeValidation);
    expect(form).toContain("deviceLinkId: form.runtime === 'local-device' ? form.deviceLinkId.trim() : undefined");
    expect(form).toContain("agentClientId: form.runtime === 'local-device' ? form.agentClientId : undefined");
    expect(form).toContain("form.runtime === 'local-device' ? (");
    expect(form).toContain('Server Side Provider');
  });

  test('custom backend form is a single form instead of a step-by-step wizard', () => {
    const form = readFileSync(
      join(repoRoot, 'web/src/components/settings/CustomBackendFormDialog.tsx'),
      'utf8',
    );

    expect(form).toContain('Agent 配置');
    expect(form).toContain('运行位置');
    expect(form).not.toContain('LOCAL_DEVICE_STEPS');
    expect(form).not.toContain('SERVER_SIDE_STEPS');
    expect(form).not.toContain('下一步');
    expect(form).not.toContain('上一步');
  });

  test('promotes model endpoints to a top-level page beside Agent', () => {
    const paths = baseNavItems.map((item) => item.path);
    const modelEndpoints = baseNavItems.find((item) => item.path === '/model-endpoints');
    const app = readFileSync(join(repoRoot, 'web/src/App.tsx'), 'utf8');
    const settings = readFileSync(join(repoRoot, 'web/src/pages/SettingsPage.tsx'), 'utf8');

    expect(modelEndpoints?.label).toBe('模型端点');
    expect(paths.indexOf('/model-endpoints')).toBeGreaterThan(paths.indexOf('/agents'));
    expect(paths.indexOf('/model-endpoints')).toBeLessThan(paths.indexOf('/settings'));
    expect(app).toContain('path="/model-endpoints"');
    expect(settings).not.toContain('Claude 提供商');
  });

  test('provider editor supports fetching models while creating a provider', () => {
    const editor = readFileSync(
      join(repoRoot, 'web/src/components/settings/ProviderEditor.tsx'),
      'utf8',
    );

    expect(editor).toContain("'/api/config/claude/providers/models/fetch'");
    expect(editor).toContain('请填写 Base URL 和 Token 后再拉取模型列表');
    expect(editor).toContain("setModel(data.models?.[0]?.id || model)");
    expect(editor).not.toContain("if (isCreate || !provider) {");
  });

  test('agents page fetches backend CLI skills and renders workspace and CLI groups', () => {
    const agentsPage = readFileSync(join(repoRoot, 'web/src/pages/AgentsPage.tsx'), 'utf8');

    expect(agentsPage).toContain('/skills?cwd=');
    expect(agentsPage).toContain('Workspace Skills');
    expect(agentsPage).toContain('CLI Skills');
    expect(agentsPage).toContain('loadAgentSkills');
    expect(agentsPage).toContain('AgentSkillInfo');
  });
});
