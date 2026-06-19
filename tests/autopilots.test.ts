import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octodeck-autopilots-'));
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return {
    ...actual,
    DATA_DIR: tmpDir,
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
      permissions: ['manage_system_config'],
    });
    return next();
  },
  systemConfigMiddleware: async (_c: any, next: any) => next(),
}));

vi.mock('../src/issue-notifier.js', () => ({
  afterIssueEventCreated: () => {},
}));

const db = await import('../src/db.js');
const webContext = await import('../src/web-context.js');
const autopilotModule = await import('../src/routes/autopilots.js');
const autopilotRoutes = autopilotModule.default;

beforeAll(() => {
  db.initDatabase();
  db.setRegisteredGroup('web:main', {
    name: 'Main',
    folder: 'main',
    added_at: '2026-06-12T00:00:00.000Z',
    created_by: 'alice',
    is_home: true,
    executionMode: 'container',
  });
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('autopilot MVP routes', () => {
  test('exposes built-in Autopilot templates and installs one as an active autopilot', async () => {
    const templatesRes = await autopilotRoutes.request('/templates', { method: 'GET' });
    const templatesBody = await templatesRes.json();

    expect(templatesRes.status).toBe(200);
    expect(templatesBody.templates.map((template: any) => template.id)).toEqual([
      'daily-repo-health-check',
      'weekly-dependency-todo-scan',
      'webhook-code-review',
    ]);
    expect(templatesBody.templates[0]).toMatchObject({
      triggerType: 'schedule',
      actionType: 'create_issue',
    });

    const installRes = await autopilotRoutes.request(
      '/templates/daily-repo-health-check/install',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Repo Health Check' }),
      },
    );
    const installed = await installRes.json();

    expect(installRes.status).toBe(200);
    expect(installed.autopilot.name).toBe('Repo Health Check');
    expect(installed.autopilot.trigger).toMatchObject({
      type: 'schedule',
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
    });
    expect(installed.autopilot.trigger.next_run).toEqual(expect.any(String));
    expect(installed.autopilot.action).toMatchObject({
      type: 'create_issue',
      issue: {
        title: 'Daily repo health check',
        priority: 'medium',
      },
    });
  });

  test('schedule trigger records next_run and due scheduler automatically creates issue', async () => {
    const res = await autopilotRoutes.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Scheduled triage',
        trigger: {
          type: 'schedule',
          schedule_type: 'once',
          schedule_value: '2026-06-12T00:00:00.000Z',
        },
        action: {
          type: 'create_issue',
          issue: { title: 'Scheduled work', description: 'Created by due autopilot' },
        },
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.autopilot.trigger).toMatchObject({
      type: 'schedule',
      schedule_type: 'once',
      schedule_value: '2026-06-12T00:00:00.000Z',
      next_run: '2026-06-12T00:00:00.000Z',
    });

    const due = await autopilotModule.runDueAutopilots({
      now: '2026-06-12T00:00:01.000Z',
    });

    expect(due).toHaveLength(1);
    expect(due[0].run.status).toBe('success');
    expect(due[0].run.trigger_type).toBe('schedule');
    expect(due[0].run.payload).toEqual({ scheduledAt: '2026-06-12T00:00:00.000Z' });
    expect(due[0].issue?.title).toBe('Scheduled work');
    expect(due[0].autopilot.trigger).toMatchObject({ next_run: null });
  });

  test('due scheduler records skipped run with skip reason when previous run is still active', async () => {
    const createRes = await autopilotRoutes.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Non-overlap schedule',
        trigger: {
          type: 'schedule',
          schedule_type: 'once',
          schedule_value: '2026-06-12T00:02:00.000Z',
        },
        action: {
          type: 'create_issue',
          issue: { title: 'Should be skipped while running' },
        },
      }),
    });
    const created = await createRes.json();
    db.createAutopilotRun({
      id: 'aprun_existing_running',
      autopilot_id: created.autopilot.id,
      trigger_type: 'schedule',
      status: 'running',
      retry_of: null,
      attempt: 1,
      payload: { scheduledAt: '2026-06-12T00:01:00.000Z' },
      result: null,
      error: null,
      created_by: 'alice',
      created_at: '2026-06-12T00:01:00.000Z',
      completed_at: null,
    });

    const due = await autopilotModule.runDueAutopilots({
      now: '2026-06-12T00:02:01.000Z',
    });

    expect(due).toHaveLength(1);
    expect(due[0].run.status).toBe('skipped');
    expect(due[0].run.skip_reason).toBe('previous run still running');
    expect(due[0].run.payload).toEqual({ scheduledAt: '2026-06-12T00:02:00.000Z' });
    expect(due[0].issue).toBeUndefined();
    expect(due[0].autopilot.trigger).toMatchObject({ next_run: null });

    const runsRes = await autopilotRoutes.request(`/${created.autopilot.id}/runs`);
    const runs = await runsRes.json();
    expect(runs.runs[0]).toMatchObject({
      status: 'skipped',
      skip_reason: 'previous run still running',
    });
  });

  test('webhook trigger requires configured token on the dedicated webhook endpoint', async () => {
    const createRes = await autopilotRoutes.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Secure webhook',
        trigger: { type: 'webhook', token: 'secret-token' },
        action: {
          type: 'create_issue',
          issue: { title: 'Webhook task' },
        },
      }),
    });
    const created = await createRes.json();

    const bad = await autopilotRoutes.request(`/${created.autopilot.id}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Autopilot-Token': 'wrong' },
      body: JSON.stringify({ source: 'bad' }),
    });
    expect(bad.status).toBe(401);

    const good = await autopilotRoutes.request(`/${created.autopilot.id}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Autopilot-Token': 'secret-token' },
      body: JSON.stringify({ source: 'good' }),
    });
    const body = await good.json();
    expect(good.status).toBe(200);
    expect(body.run.trigger_type).toBe('webhook');
    expect(body.run.payload).toEqual({ source: 'good' });
  });

  test('api trigger requires configured token on the dedicated api endpoint', async () => {
    const createRes = await autopilotRoutes.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'External API trigger',
        trigger: { type: 'api', token: 'api-secret' },
        action: {
          type: 'create_issue',
          issue: { title: 'API task', description: 'Created by API trigger' },
        },
      }),
    });
    const created = await createRes.json();

    const bad = await autopilotRoutes.request(`/${created.autopilot.id}/api`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong' },
      body: JSON.stringify({ source: 'bad' }),
    });
    expect(bad.status).toBe(401);

    const good = await autopilotRoutes.request(`/${created.autopilot.id}/api`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer api-secret' },
      body: JSON.stringify({ source: 'external-system' }),
    });
    const body = await good.json();

    expect(good.status).toBe(200);
    expect(body.run.trigger_type).toBe('api');
    expect(body.run.payload).toEqual({ source: 'external-system' });
    expect(body.issue.title).toBe('API task');
  });

  test('creates and lists autopilots with manual create_issue action', async () => {
    const createRes = await autopilotRoutes.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Daily triage',
        trigger: { type: 'manual' },
        action: {
          type: 'create_issue',
          issue: {
            title: 'Triage inbox',
            description: 'Classify fresh bug reports',
            priority: 'high',
          },
        },
      }),
    });
    const created = await createRes.json();

    expect(createRes.status).toBe(200);
    expect(created.autopilot.id).toMatch(/^ap_/);
    expect(created.autopilot.trigger).toEqual({ type: 'manual' });
    expect(created.autopilot.action.type).toBe('create_issue');

    const listRes = await autopilotRoutes.request('/');
    const listed = await listRes.json();
    expect(listRes.status).toBe(200);
    expect(listed.autopilots.map((item: any) => item.id)).toContain(created.autopilot.id);
  });

  test('triggering create_issue records an autopilot run and creates the issue', async () => {
    const createRes = await autopilotRoutes.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Webhook triage',
        trigger: { type: 'webhook', token: 'wh_123' },
        action: {
          type: 'create_issue',
          issue: {
            title: 'Investigate webhook payload',
            description: 'Created by webhook autopilot',
            priority: 'urgent',
          },
        },
      }),
    });
    const created = await createRes.json();

    const triggerRes = await autopilotRoutes.request(`/${created.autopilot.id}/trigger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trigger_type: 'webhook', payload: { source: 'test' } }),
    });
    const triggered = await triggerRes.json();

    expect(triggerRes.status).toBe(200);
    expect(triggered.run.status).toBe('success');
    expect(triggered.run.trigger_type).toBe('webhook');
    expect(triggered.run.result.issueId).toBe(triggered.issue.id);
    expect(triggered.issue.title).toBe('Investigate webhook payload');
    expect(triggered.issue.priority).toBe('urgent');

    const runsRes = await autopilotRoutes.request(`/${created.autopilot.id}/runs`);
    const runs = await runsRes.json();
    expect(runs.runs[0].id).toBe(triggered.run.id);
    expect(runs.runs[0].payload).toEqual({ source: 'test' });
  });

  test('run_agent action creates an issue and queues an issue agent run', async () => {
    const createRes = await autopilotRoutes.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'API fixer',
        trigger: { type: 'api' },
        action: {
          type: 'run_agent',
          issue: {
            title: 'Fix flaky API test',
            description: 'Let the agent investigate',
          },
          run: {
            agent_client_id: 'claude-code',
            execution_node: 'provider:claude-code',
            selected_skills: ['bits-code-guard'],
          },
        },
      }),
    });
    const created = await createRes.json();

    const triggerRes = await autopilotRoutes.request(`/${created.autopilot.id}/trigger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trigger_type: 'api' }),
    });
    const triggered = await triggerRes.json();

    expect(triggerRes.status).toBe(400);
    expect(triggered.run.status).toBe('error');
    expect(triggered.error).toBe('Server not initialized');
    expect(triggered.run.result).toBeNull();
  });

  test('failed autopilot runs can be retried with lineage and incremented attempt', async () => {
    const createRes = await autopilotRoutes.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Retry API fixer',
        trigger: { type: 'api' },
        action: {
          type: 'run_agent',
          issue: {
            title: 'Retry flaky API test',
            description: 'The retry should preserve payload lineage',
          },
          run: {
            agent_client_id: 'claude-code',
            execution_node: 'provider:claude-code',
          },
        },
      }),
    });
    const created = await createRes.json();

    const firstRes = await autopilotRoutes.request(`/${created.autopilot.id}/trigger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trigger_type: 'api', payload: { source: 'first-attempt' } }),
    });
    const first = await firstRes.json();
    expect(first.run).toMatchObject({ status: 'error', attempt: 1, retry_of: null });

    const retryRes = await autopilotRoutes.request(
      `/${created.autopilot.id}/runs/${first.run.id}/retry`,
      { method: 'POST' },
    );
    const retry = await retryRes.json();

    expect(retryRes.status).toBe(400);
    expect(retry.run).toMatchObject({
      status: 'error',
      trigger_type: 'api',
      retry_of: first.run.id,
      attempt: 2,
      payload: { source: 'first-attempt' },
    });
    expect(retry.error).toBe('Server not initialized');

    const runsRes = await autopilotRoutes.request(`/${created.autopilot.id}/runs`);
    const runs = await runsRes.json();
    expect(runs.runs[0]).toMatchObject({
      id: retry.run.id,
      retry_of: first.run.id,
      attempt: 2,
    });
  });

  test('broadcasts standard autopilot events when runs finish', async () => {
    const events: any[] = [];
    webContext.setWebDeps({
      broadcastOctoDeckEvent: (event: any, allowedUserIds?: Set<string> | null) => {
        events.push({ event, allowedUserIds: allowedUserIds ? [...allowedUserIds] : allowedUserIds });
      },
    } as any);

    const createRes = await autopilotRoutes.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Realtime autopilot',
        trigger: { type: 'manual' },
        action: {
          type: 'create_issue',
          issue: { title: 'Broadcasted issue' },
        },
      }),
    });
    const created = await createRes.json();

    const triggerRes = await autopilotRoutes.request(`/${created.autopilot.id}/trigger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trigger_type: 'manual', payload: { source: 'realtime-test' } }),
    });
    const triggered = await triggerRes.json();

    expect(triggerRes.status).toBe(200);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        allowedUserIds: ['alice'],
        event: expect.objectContaining({
          type: 'autopilot.run.success',
          domain: 'autopilot',
          action: 'success',
          userId: 'alice',
          runId: triggered.run.id,
          correlationId: created.autopilot.id,
          payload: expect.objectContaining({
            autopilotId: created.autopilot.id,
            run: expect.objectContaining({ id: triggered.run.id, status: 'success' }),
          }),
        }),
      }),
    ]));
  });
});
