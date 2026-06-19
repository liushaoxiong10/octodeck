import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octodeck-rk-quality-'));
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

const db = await import('../src/db.js');

beforeAll(() => {
  db.initDatabase();
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('repo knowledge search quality metadata', () => {
  test('persists graph edge confidence/runId and returns explainable search hits', () => {
    db.replaceRepoKnowledgeChunks({
      repoId: 'repo_quality',
      userId: 'alice',
      chunks: [
        {
          id: 'chunk_auth_service',
          path: 'src/auth.ts',
          kind: 'symbol',
          name: 'validateToken',
          language: 'ts',
          startLine: 10,
          endLine: 40,
          content: 'export function validateToken() { return "auth token"; }',
          keywords: 'auth token validation security',
        },
        {
          id: 'chunk_session_store',
          path: 'src/session.ts',
          kind: 'file',
          name: 'session store',
          language: 'ts',
          content: 'Session storage used by auth validation.',
          keywords: 'session auth',
        },
      ],
      edges: [
        {
          id: 'edge_auth_session',
          fromPath: 'src/auth.ts',
          toPath: 'src/session.ts',
          edgeKind: 'references',
          source: 'agent:repo-map',
          confidence: 0.82,
          runId: 'rkrun_quality_1',
          metadata: { rationale: 'validateToken reads session state' },
        },
      ],
    });

    const edges = db.listRepoKnowledgeGraphEdges({ repoId: 'repo_quality', userId: 'alice', path: 'src/auth.ts' });
    expect(edges[0]).toMatchObject({
      confidence: 0.82,
      runId: 'rkrun_quality_1',
      source: 'agent:repo-map',
    });

    const hits = db.searchRepoKnowledge({
      repoId: 'repo_quality',
      userId: 'alice',
      query: 'auth validation',
      includeRelated: true,
      limit: 5,
    });

    expect(hits[0].path).toBe('src/auth.ts');
    expect(hits[0].matchedTerms).toEqual(expect.arrayContaining(['auth', 'validation']));
    expect(hits[0].rationale).toEqual(expect.arrayContaining(['name', 'keywords', 'content']));
    expect(hits[0].vectorScore).toBeGreaterThan(0);
    expect(hits[0].metadata?.termVector).toMatchObject({ auth: expect.any(Number), validation: expect.any(Number) });
    expect(hits[0].related?.[0]).toMatchObject({ confidence: 0.82, runId: 'rkrun_quality_1' });
  });

  test('mirrors relevant repo knowledge into issue AgentTask context', () => {
    db.replaceRepoKnowledgeChunks({
      repoId: 'repo_issue_context',
      userId: 'alice',
      chunks: [
        {
          id: 'chunk_checkout_agent',
          path: 'src/checkout/agent.ts',
          kind: 'symbol',
          name: 'checkoutRiskAgent',
          language: 'ts',
          startLine: 12,
          endLine: 48,
          content: 'export function checkoutRiskAgent() { return validatePaymentRisk(); }',
          keywords: 'checkout payment risk validation agent',
        },
      ],
      edges: [],
    });

    db.createIssue({
      id: 'issue_repo_context',
      workspace_jid: 'workspace_repo_context',
      workspace_folder: '/tmp/workspace_repo_context',
      title: 'Fix checkout payment risk validation',
      description: 'The checkout agent should reuse the payment risk validation flow.',
      status: 'todo',
      priority: 'high',
      project_repo_id: 'repo_issue_context',
      created_by: 'alice',
      created_at: '2026-06-12T00:00:00.000Z',
      updated_at: '2026-06-12T00:00:00.000Z',
    });

    db.createIssueAgentRun({
      id: 'irun_repo_context',
      issue_id: 'issue_repo_context',
      workspace_jid: 'workspace_repo_context',
      workspace_folder: '/tmp/workspace_repo_context',
      status: 'queued',
      created_by: 'alice',
      created_at: '2026-06-12T00:00:00.000Z',
    });

    const task = db.getAgentTaskById('agtask_irun_repo_context');
    expect(task?.context?.repoKnowledge).toMatchObject({
      repoId: 'repo_issue_context',
      query: expect.stringContaining('checkout payment risk validation'),
      hits: [
        {
          chunkId: 'chunk_checkout_agent',
          path: 'src/checkout/agent.ts',
          rationale: expect.arrayContaining(['name', 'keywords', 'content']),
          matchedTerms: expect.arrayContaining(['checkout', 'payment', 'risk', 'validation']),
        },
      ],
    });
    expect(task?.context?.repoKnowledge).toMatchObject({
      architectureSummary: expect.stringContaining('1 relevant chunk'),
      riskPoints: expect.arrayContaining([expect.stringContaining('checkoutRiskAgent')]),
    });
  });
});
