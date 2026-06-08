import fs from 'fs';
import os from 'os';
import path from 'path';

import { beforeEach, describe, expect, test, vi } from 'vitest';

const tmpDataDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'octodeck-agent-team-templates-'),
);

vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return {
    ...actual,
    DATA_DIR: tmpDataDir,
  };
});

vi.mock('../src/middleware/auth.js', () => ({
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

const templates = await import('../src/agent-team-templates.js');
const agentTeamRoutes = (await import('../src/routes/agent-teams.js')).default;

beforeEach(() => {
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDataDir, { recursive: true });
});

describe('agent team templates', () => {
  test('lists readonly built-in templates', () => {
    const listed = templates.listAgentTeamTemplates();

    expect(listed.some((template) => template.id === 'feature-delivery-v1')).toBe(true);
    expect(listed[0]).not.toHaveProperty('team');
  });

  test('gets a built-in template by id', () => {
    const template = templates.getAgentTeamTemplate('feature-delivery-v1');

    expect(template).toBeTruthy();
    expect(template?.name).toContain('Feature Delivery');
    expect(template?.team.workflowSteps?.length).toBeGreaterThan(1);
    expect(templates.getAgentTeamTemplate('missing-template')).toBeNull();
  });

  test('creates agent team input from template with goal override', () => {
    const input = templates.createAgentTeamInputFromTemplate('feature-delivery-v1', {
      goal: '实现通知中心',
      createdByAgentId: 'claude-sdk',
    });

    expect(input.name).toContain('Feature Delivery');
    expect(input.goal).toBe('实现通知中心');
    expect(input.workflowSteps?.length).toBeGreaterThan(1);
    expect(input.createdByAgentId).toBe('claude-sdk');
  });

  test('creates copied agent team input without mutating template state', () => {
    const first = templates.createAgentTeamInputFromTemplate('feature-delivery-v1', {
      goal: '第一次创建',
      createdByAgentId: 'claude-sdk',
    });
    first.roles[0].name = 'Mutated Role';
    first.workflowSteps?.push({ id: 'extra', type: 'role', roleId: 'lead' });

    const second = templates.createAgentTeamInputFromTemplate('feature-delivery-v1', {
      goal: '第二次创建',
      createdByAgentId: 'claude-sdk',
    });

    expect(second.roles[0].name).toBe('Lead');
    expect(second.workflowSteps?.map((step) => step.id)).not.toContain('extra');
  });

  test('exposes template list and detail routes', async () => {
    const listResponse = await agentTeamRoutes.request('/templates');
    const listBody = await listResponse.json() as { templates: Array<{ id: string }> };

    expect(listResponse.status).toBe(200);
    expect(listBody.templates.some((template) => template.id === 'feature-delivery-v1')).toBe(true);

    const detailResponse = await agentTeamRoutes.request('/templates/feature-delivery-v1');
    const detailBody = await detailResponse.json() as { template: { id: string; team: { name: string } } };

    expect(detailResponse.status).toBe(200);
    expect(detailBody.template.id).toBe('feature-delivery-v1');
    expect(detailBody.template.team.name).toContain('Feature Delivery');
  });

  test('creates a copied team for the authenticated user from a template route', async () => {
    const response = await agentTeamRoutes.request('/templates/feature-delivery-v1/teams', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: '实现通知中心', createdByAgentId: 'claude-sdk' }),
    });
    const body = await response.json() as { team: { id: string; goal: string; createdByUserId?: string; workflowSteps?: unknown[] } };

    expect(response.status).toBe(201);
    expect(body.team.id).toMatch(/^team_[0-9a-f]{12}$/);
    expect(body.team.goal).toBe('实现通知中心');
    expect(body.team.createdByUserId).toBe('alice');
    expect(body.team.workflowSteps?.length).toBeGreaterThan(1);
  });

  test('allows template team payload through the generic team create route', async () => {
    const input = templates.createAgentTeamInputFromTemplate('feature-delivery-v1', {
      goal: '实现通知中心',
      createdByAgentId: 'claude-sdk',
    });

    const response = await agentTeamRoutes.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const body = await response.json() as { workflowSteps?: Array<{ type: string }>; error?: string };

    expect(response.status).toBe(201);
    expect(body.error).toBeUndefined();
    expect(body.workflowSteps?.some((step) => step.type === 'verify')).toBe(true);
  });

  test('rejects blank goals when creating a team from a template route', async () => {
    const response = await agentTeamRoutes.request('/templates/feature-delivery-v1/teams', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: '   ', createdByAgentId: 'claude-sdk' }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'goal is required' });
  });
});
