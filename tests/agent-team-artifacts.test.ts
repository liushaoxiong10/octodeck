import fs from 'fs';
import os from 'os';
import path from 'path';

import { beforeEach, describe, expect, test, vi } from 'vitest';

const tmpRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'octodeck-agent-team-artifacts-'),
);
const tmpStoreDir = path.join(tmpRoot, 'store');

vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return {
    ...actual,
    DATA_DIR: tmpRoot,
    STORE_DIR: tmpStoreDir,
  };
});

const db = await import('../src/db.js');

describe('agent team artifact persistence', () => {
  beforeEach(async () => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.mkdirSync(tmpStoreDir, { recursive: true });
    await db.initDatabase();
  });

  test('records multiple artifact versions for the same key', () => {
    db.recordAgentTeamRun({
      id: 'run_1',
      teamId: 'team_1',
      userId: 'alice',
      prompt: 'persist artifacts',
      status: 'running',
      traceId: 'trace_1',
      workflowShape: 'pipeline',
      roleAssignments: {},
    });

    db.recordAgentTeamArtifact({
      id: 'artifact_1',
      runId: 'run_1',
      key: 'plan',
      version: 1,
      contentType: 'text/markdown',
      value: 'first',
      sourceStepId: 'plan',
      sourceTaskId: 'task_1',
      sourceRoleId: 'planner',
      visibility: 'run',
    });
    db.recordAgentTeamArtifact({
      id: 'artifact_2',
      runId: 'run_1',
      key: 'plan',
      version: 2,
      contentType: 'text/markdown',
      value: 'second',
      sourceStepId: 'plan_retry',
      sourceTaskId: 'task_2',
      sourceRoleId: 'planner',
      parentArtifactIds: ['artifact_1'],
      visibility: 'run',
    });

    expect(db.listAgentTeamArtifacts('run_1').map((artifact) => artifact.id)).toEqual([
      'artifact_1',
      'artifact_2',
    ]);
    expect(db.getAgentTeamArtifact('artifact_2', 'run_1')?.parentArtifactIds).toEqual([
      'artifact_1',
    ]);
  });
});
