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

  test('devices runtime table exposes provider transport and slot capacity fields', () => {
    const componentSource = readFileSync(
      join(repoRoot, 'web/src/components/settings/AgentLinksSection.tsx'),
      'utf8',
    );
    const storeSource = readFileSync(
      join(repoRoot, 'web/src/stores/agentLinks.ts'),
      'utf8',
    );

    expect(storeSource).toContain('provider?: string');
    expect(storeSource).toContain("transport?: 'stdio' | 'acp' | 'a2a' | 'http'");
    expect(componentSource).toContain('Provider / Transport');
    expect(componentSource).toContain('Slots');
    expect(componentSource).toContain('runtime?.availableSlots');
    expect(componentSource).toContain('runtime?.maxConcurrentRuns');
  });

  test('devices page exposes runtime pool capacity snapshot', () => {
    const pageSource = readFileSync(
      join(repoRoot, 'web/src/pages/DevicesPage.tsx'),
      'utf8',
    );
    const storeSource = readFileSync(
      join(repoRoot, 'web/src/stores/agentLinks.ts'),
      'utf8',
    );
    const routeSource = readFileSync(
      join(repoRoot, 'src/routes/agent-link.ts'),
      'utf8',
    );

    expect(routeSource).toContain("agentLinkRoutes.get('/runtime-pool'");
    expect(routeSource).toContain('buildRuntimePoolSnapshot');
    expect(storeSource).toContain('RuntimePoolSnapshot');
    expect(storeSource).toContain('loadRuntimePool');
    expect(storeSource).toContain('/api/devices/runtime-pool');
    expect(pageSource).toContain('RuntimePoolPanel');
    expect(pageSource).toContain('Runtime Pool');
    expect(pageSource).toContain('availableSlots');
  });

  test('devices page exposes runtime quota and admissible scheduling state', () => {
    const pageSource = readFileSync(
      join(repoRoot, 'web/src/pages/DevicesPage.tsx'),
      'utf8',
    );
    const storeSource = readFileSync(
      join(repoRoot, 'web/src/stores/agentLinks.ts'),
      'utf8',
    );

    expect(storeSource).toContain('admissibleSlots');
    expect(storeSource).toContain('quota_exhausted');
    expect(storeSource).toContain('remainingRuns');
    expect(pageSource).toContain('Admissible');
    expect(pageSource).toContain('Quota');
    expect(pageSource).toContain('runtime.scheduling');
  });

  test('devices page exposes runtime heartbeat health state', () => {
    const pageSource = readFileSync(
      join(repoRoot, 'web/src/pages/DevicesPage.tsx'),
      'utf8',
    );
    const storeSource = readFileSync(
      join(repoRoot, 'web/src/stores/agentLinks.ts'),
      'utf8',
    );
    const routeSource = readFileSync(
      join(repoRoot, 'src/routes/agent-link.ts'),
      'utf8',
    );

    expect(routeSource).toContain('lastHeartbeatAt');
    expect(storeSource).toContain('degradedRuntimes');
    expect(storeSource).toContain('heartbeatAgeMs');
    expect(storeSource).toContain('runtime_degraded');
    expect(pageSource).toContain('Degraded');
    expect(pageSource).toContain('Heartbeat');
  });

  test('devices page exposes runtime assignment recommendation', () => {
    const pageSource = readFileSync(
      join(repoRoot, 'web/src/pages/DevicesPage.tsx'),
      'utf8',
    );
    const storeSource = readFileSync(
      join(repoRoot, 'web/src/stores/agentLinks.ts'),
      'utf8',
    );
    const routeSource = readFileSync(
      join(repoRoot, 'src/routes/agent-link.ts'),
      'utf8',
    );

    expect(routeSource).toContain('preferredAgentClientId');
    expect(storeSource).toContain('recommendedRuntimeId');
    expect(storeSource).toContain('executionNode');
    expect(pageSource).toContain('Recommended');
    expect(pageSource).toContain('assignment?.recommendedRuntimeId');
  });

  test('runtime pool dashboard is a top-level capacity page', () => {
    const appSource = readFileSync(join(repoRoot, 'web/src/App.tsx'), 'utf8');
    const navSource = readFileSync(join(repoRoot, 'web/src/components/layout/nav-items.ts'), 'utf8');
    const pageSource = readFileSync(join(repoRoot, 'web/src/pages/RuntimePoolPage.tsx'), 'utf8');
    const paths = baseNavItems.map((item) => item.path);

    expect(paths).toContain('/runtimes');
    expect(paths.indexOf('/runtimes')).toBeGreaterThan(paths.indexOf('/devices'));
    expect(paths.indexOf('/runtimes')).toBeLessThan(paths.indexOf('/agents'));
    expect(navSource).toContain("label: 'Runtime'");
    expect(appSource).toContain('RuntimePoolPage');
    expect(appSource).toContain('path="/runtimes"');
    expect(pageSource).toContain('Runtime 资源池');
    expect(pageSource).toContain('blockedReason');
    expect(pageSource).toContain('recommendedRuntimeId');
    expect(pageSource).toContain('setHealthFilter');
  });

  test('scheduled tasks use runtime pool admission before persisting host execution targets', () => {
    const routeSource = readFileSync(join(repoRoot, 'src/routes/tasks.ts'), 'utf8');

    expect(routeSource).toContain('buildRuntimePoolSnapshot');
    expect(routeSource).toContain('resolveRuntimeSchedulingTarget');
    expect(routeSource).toContain('assertTaskRuntimeAdmissible');
    expect(routeSource).toContain('taskRuntimeAdmission.resolvedExecutionNode');
    expect(routeSource).toContain('Selected task runtime is not schedulable');
  });

  test('stage 12 centralizes Issue and Task runtime scheduling through runtime-scheduler', () => {
    const schedulerSource = readFileSync(join(repoRoot, 'src/runtime-scheduler.ts'), 'utf8');
    const issueRoutes = readFileSync(join(repoRoot, 'src/routes/issues.ts'), 'utf8');
    const taskRoutes = readFileSync(join(repoRoot, 'src/routes/tasks.ts'), 'utf8');

    expect(schedulerSource).toContain('resolveAgentRunRuntimeTarget');
    expect(schedulerSource).toContain('includeServerBackends');
    expect(schedulerSource).toContain('schedulingReason');
    expect(issueRoutes).toContain('resolveAgentRunRuntimeTarget');
    expect(taskRoutes).toContain('resolveAgentRunRuntimeTarget');
  });

  test('approval request aliases expose permission requests with product naming', () => {
    const issueRoutes = readFileSync(join(repoRoot, 'src/routes/issues.ts'), 'utf8');

    expect(issueRoutes).toContain("/:id/approval-requests");
    expect(issueRoutes).toContain("/:id/runs/:runId/approval-requests/:requestId/decision");
    expect(issueRoutes).toContain("kind === 'permission'");
  });

  test('runtime pool dashboard exposes run drill-down and pending approval context', () => {
    const pageSource = readFileSync(join(repoRoot, 'web/src/pages/RuntimePoolPage.tsx'), 'utf8');

    expect(pageSource).toContain('pending approvals');
    expect(pageSource).toContain('runningRuns');
    expect(pageSource).toContain('runId');
    expect(pageSource).toContain('Issue / Task / Agent Team');
  });

  test('stage 13 exposes a global approval center API and realtime governance wiring', () => {
    const webSource = readFileSync(join(repoRoot, 'src/web.ts'), 'utf8');
    const approvalRouteSource = readFileSync(join(repoRoot, 'src/routes/approval-requests.ts'), 'utf8');
    const appLayout = readFileSync(join(repoRoot, 'web/src/components/layout/AppLayout.tsx'), 'utf8');

    expect(webSource).toContain("app.route('/api/approval-requests'");
    expect(approvalRouteSource).toContain("approvalRoutes.get('/'");
    expect(approvalRouteSource).toContain("source: 'issue'");
    expect(approvalRouteSource).toContain("source: 'agent_team'");
    expect(approvalRouteSource).toContain('decisionUrl');
    expect(appLayout).toContain('loadApprovalRequests');
    expect(appLayout).toContain("octodeck_event:approval");
  });

  test('stage 13 notification inbox links pending approvals back to source workflows', () => {
    const notificationsStore = readFileSync(join(repoRoot, 'web/src/stores/notifications.ts'), 'utf8');
    const notificationInbox = readFileSync(join(repoRoot, 'web/src/components/layout/NotificationInbox.tsx'), 'utf8');
    const eventTypes = readFileSync(join(repoRoot, 'shared/octodeck-event.ts'), 'utf8');

    expect(eventTypes).toContain('href?: string');
    expect(eventTypes).toContain('decisionUrl?: string');
    expect(notificationsStore).toContain('loadApprovalRequests');
    expect(notificationsStore).toContain('/api/approval-requests');
    expect(notificationInbox).toContain('href={item.href');
    expect(notificationInbox).toContain('Approval Inbox');
  });

  test('issue approval decisions reject expired or revoked task-scoped tokens', () => {
    const issueRoutes = readFileSync(join(repoRoot, 'src/routes/issues.ts'), 'utf8');

    expect(issueRoutes).toContain('token_revoked');
    expect(issueRoutes).toContain('token_expired');
    expect(issueRoutes).toContain('Permission request task-scoped token is no longer valid');
    expect(issueRoutes).toContain('new Date(scopedToken.expires_at).getTime() <= Date.now()');
  });

  test('devices online status refreshes from the standard device event bridge instead of page polling', () => {
    const componentSource = readFileSync(
      join(repoRoot, 'web/src/components/settings/AgentLinksSection.tsx'),
      'utf8',
    );
    const pageSource = readFileSync(
      join(repoRoot, 'web/src/pages/DevicesPage.tsx'),
      'utf8',
    );
    const appLayout = readFileSync(
      join(repoRoot, 'web/src/components/layout/AppLayout.tsx'),
      'utf8',
    );

    expect(appLayout).toContain("wsManager.on('octodeck_event:device'");
    expect(appLayout).toContain('useAgentLinksStore.getState().load()');
    expect(appLayout).toContain('useAgentLinksStore.getState().loadRuntimePool()');
    expect(appLayout).toContain('useCustomBackendsStore.getState().load()');
    expect(componentSource).not.toContain('Periodic refresh to keep online status fresh');
    expect(componentSource).not.toContain('setInterval(() =>');
    expect(componentSource).not.toContain('clearInterval(t)');
    expect(pageSource).toContain('在线状态由实时设备事件更新，可作为执行节点');
    expect(pageSource).not.toContain('在线状态自动刷新');
  });

  test('stage 14 exposes unified Agent / Skill Registry governance API and page', () => {
    const webSource = readFileSync(join(repoRoot, 'src/web.ts'), 'utf8');
    const registryRoute = readFileSync(join(repoRoot, 'src/routes/registry.ts'), 'utf8');
    const navSource = readFileSync(join(repoRoot, 'web/src/components/layout/nav-items.ts'), 'utf8');
    const appSource = readFileSync(join(repoRoot, 'web/src/App.tsx'), 'utf8');
    const storeSource = readFileSync(join(repoRoot, 'web/src/stores/registry.ts'), 'utf8');
    const pageSource = readFileSync(join(repoRoot, 'web/src/pages/RegistryPage.tsx'), 'utf8');
    const paths = baseNavItems.map((item) => item.path);

    expect(webSource).toContain("app.route('/api/registry'");
    expect(registryRoute).toContain('buildTeamAgentRegistrySnapshot');
    expect(registryRoute).toContain('buildRuntimePoolSnapshot');
    expect(registryRoute).toContain('capabilityCatalog');
    expect(paths).toContain('/registry');
    expect(paths.indexOf('/registry')).toBeGreaterThan(paths.indexOf('/agents'));
    expect(paths.indexOf('/registry')).toBeLessThan(paths.indexOf('/skills'));
    expect(navSource).toContain("label: 'Registry'");
    expect(appSource).toContain('RegistryPage');
    expect(appSource).toContain('path="/registry"');
    expect(storeSource).toContain('/api/registry');
    expect(storeSource).toContain('permissionScopes');
    expect(storeSource).toContain('compatibleRuntimeIds');
    expect(pageSource).toContain('Agent / Skill Registry');
    expect(pageSource).toContain('permissionScopes');
    expect(pageSource).toContain('runtimeCompatibility');
    expect(pageSource).toContain('Stage 14 · Registry Governance');
  });

  test('stage 15 exposes orchestration preview API and Issue / Task preview cards', () => {
    const webSource = readFileSync(join(repoRoot, 'src/web.ts'), 'utf8');
    const routeSource = readFileSync(join(repoRoot, 'src/routes/orchestration.ts'), 'utf8');
    const policySource = readFileSync(join(repoRoot, 'src/orchestration-policy.ts'), 'utf8');
    const issueDetail = readFileSync(join(repoRoot, 'web/src/pages/IssueDetailPage.tsx'), 'utf8');
    const taskDetail = readFileSync(join(repoRoot, 'web/src/components/tasks/TaskDetail.tsx'), 'utf8');
    const storeSource = readFileSync(join(repoRoot, 'web/src/stores/orchestration.ts'), 'utf8');

    expect(webSource).toContain("app.route('/api/orchestration'");
    expect(routeSource).toContain("orchestrationRoutes.get('/preview'");
    expect(routeSource).toContain('evaluateOrchestrationPolicy');
    expect(routeSource).toContain('source=issue');
    expect(routeSource).toContain('source=task');
    expect(policySource).toContain('OrchestrationDecision');
    expect(policySource).toContain("mode: 'auto' | 'approval_required' | 'manual' | 'blocked'");
    expect(policySource).toContain('approvalRequired');
    expect(storeSource).toContain('/api/orchestration/preview');
    expect(storeSource).toContain('loadPreview');
    expect(issueDetail).toContain('Orchestration Preview');
    expect(issueDetail).toContain("source: 'issue'");
    expect(issueDetail).toContain('approvalRequired');
    expect(taskDetail).toContain('Orchestration Preview');
    expect(taskDetail).toContain("source: 'task'");
    expect(taskDetail).toContain('targetRuntimeId');
  });
});
