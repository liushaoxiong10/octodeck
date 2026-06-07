import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { baseNavItems, filterNavItems } from '../web/src/components/layout/nav-items.js';

const repoRoot = process.cwd();

describe('frontend devices navigation', () => {
  test('shows Devices as a top-level sidebar entry before Settings', () => {
    const paths = baseNavItems.map((item) => item.path);

    expect(paths).toContain('/devices');
    expect(paths.indexOf('/devices')).toBeLessThan(paths.indexOf('/settings'));

    const devices = baseNavItems.find((item) => item.path === '/devices');
    expect(devices?.label).toBe('设备');
  });

  test('keeps Devices visible when billing is disabled', () => {
    const paths = filterNavItems(false).map((item) => item.path);

    expect(paths).toContain('/devices');
    expect(paths).not.toContain('/billing');
  });

  test('does not keep the old Agent Links settings entry in top-level navigation', () => {
    const paths = baseNavItems.map((item) => item.path);
    const labels = baseNavItems.map((item) => item.label);

    expect(paths).not.toContain('/settings?tab=agent-links');
    expect(labels).not.toContain('Agent Links');
  });

  test('removes the legacy Agent Links tab from Settings sources', () => {
    const settingsSources = [
      'web/src/pages/SettingsPage.tsx',
      'web/src/components/settings/SettingsNav.tsx',
      'web/src/components/settings/types.ts',
    ].map((relativePath) => readFileSync(join(repoRoot, relativePath), 'utf8'));

    for (const source of settingsSources) {
      expect(source).not.toContain('agent-links');
      expect(source).not.toContain('Agent Links');
    }
  });

  test('devices page uses master-detail layout and expected detail sections', () => {
    const source = readFileSync(
      join(repoRoot, 'web/src/components/settings/AgentLinksSection.tsx'),
      'utf8',
    );

    expect(source).toContain('lg:grid-cols-3');
    expect(source).toContain('lg:col-span-1');
    expect(source).toContain('lg:col-span-2');
    for (const label of [
      'Device 列表',
      'Devices',
      'Serving Agents',
      'Runtimes',
      '运行与会话',
      '基础信息',
      'capabilities',
      'Providers',
      'Permission modes',
      '资源状态',
      'CPU',
      'Memory',
      'Disk',
      'role="progressbar"',
      'octodeck-daemon',
    ]) {
      expect(source).toContain(label);
    }
    expect(source).not.toContain('Load 1m');
    expect(source).not.toContain('Load 5m');
    expect(source).not.toContain('Load 15m');
  });
});
