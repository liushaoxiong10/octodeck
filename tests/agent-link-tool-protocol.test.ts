import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AgentRunRequestFrame, encodeFrame, parseInboundFrame } from '../src/agent-link/protocol.js';

const repoRoot = process.cwd();

describe('agent-link tool protocol', () => {
  test('accepts tool.event frames from octodeck-daemon', () => {
    const parsed = parseInboundFrame(
      JSON.stringify({
        type: 'tool.event',
        requestId: 'tool-1',
        stream: 'stdout',
        data: 'hello\n',
      }),
    );

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.frame.type).toBe('tool.event');
      expect(parsed.frame.requestId).toBe('tool-1');
    }
  });

  test('accepts tool.result frames from octodeck-daemon', () => {
    const parsed = parseInboundFrame(
      JSON.stringify({
        type: 'tool.result',
        requestId: 'tool-1',
        ok: true,
        result: { content: 'hello' },
        error: null,
        durationMs: 12,
      }),
    );

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.frame.type).toBe('tool.result');
      expect(parsed.frame.ok).toBe(true);
      expect(parsed.frame.result).toEqual({ content: 'hello' });
    }
  });

  test('accepts memory.sync frames from octodeck-daemon', () => {
    const parsed = parseInboundFrame(
      JSON.stringify({
        type: 'memory.sync',
        deviceLinkId: 'cl_1234567890abcdef',
        agentId: 'claude-code',
        path: 'CLAUDE.md',
        content: '# Local Agent Memory',
        mtime: '2026-06-02T00:00:00Z',
        contentHash: 'sha256:abc123',
      }),
    );

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.frame.type).toBe('memory.sync');
      expect(parsed.frame.deviceLinkId).toBe('cl_1234567890abcdef');
      expect(parsed.frame.agentId).toBe('claude-code');
      expect(parsed.frame.path).toBe('CLAUDE.md');
      expect(parsed.frame.content).toBe('# Local Agent Memory');
    }
  });

  test('encodes tool.request frames sent to octodeck-daemon', () => {
    const encoded = encodeFrame({
      type: 'tool.request',
      id: 7,
      requestId: 'tool-1',
      toolName: 'Read',
      input: { file_path: '/tmp/a.txt' },
      cwd: '/tmp',
      timeoutMs: 1000,
      maxOutputBytes: 4096,
    });

    expect(JSON.parse(encoded)).toMatchObject({
      type: 'tool.request',
      requestId: 'tool-1',
      toolName: 'Read',
    });
  });

  test('encodes daemon update requests sent to octodeck-daemon', () => {
    const encoded = encodeFrame({
      type: 'daemon.update.request',
      id: 8,
      latestVersion: 'octodeck-daemon/1.0.13',
      currentVersion: 'octodeck-daemon/1.0.3',
      reason: 'client_version_outdated',
    });

    expect(JSON.parse(encoded)).toMatchObject({
      type: 'daemon.update.request',
      latestVersion: 'octodeck-daemon/1.0.13',
      currentVersion: 'octodeck-daemon/1.0.3',
    });
  });

  test('encodes workspace git status requests sent to octodeck-daemon', () => {
    const encoded = encodeFrame({
      type: 'workspace.git.status.request',
      id: 9,
      requestId: 'git-status-1',
      workspace: {
        kind: 'workspace',
        folder: 'demo',
        agentId: 'claude-code',
        scope: 'session',
        scopeId: 'issue-run-1',
      },
      workspaceRepos: [
        {
          kind: 'git',
          gitUrl: 'https://example.com/acme/demo.git',
          groupFolder: 'demo',
          name: 'demo',
          agentId: 'claude-code',
          scope: 'session',
          scopeId: 'issue-run-1',
        },
      ],
      includeDiffStat: true,
    });

    expect(JSON.parse(encoded)).toMatchObject({
      type: 'workspace.git.status.request',
      requestId: 'git-status-1',
      workspaceRepos: [{ kind: 'git', name: 'demo' }],
      includeDiffStat: true,
    });
  });

  test('accepts workspace git status result frames from octodeck-daemon', () => {
    const parsed = parseInboundFrame(
      JSON.stringify({
        type: 'workspace.git.status.result',
        requestId: 'git-status-1',
        ok: true,
        workspacePath: '/Users/alice/.octodeck/workspace/demo/sessions/issue-run-1/demo',
        branch: 'octodeck/demo',
        head: 'abc1234',
        clean: false,
        files: [
          {
            path: 'src/app.ts',
            status: 'modified',
            additions: 4,
            deletions: 1,
            patch: '@@ -1 +1 @@\n-old\n+new',
          },
          { path: 'src/new.ts', status: 'untracked' },
        ],
        diffStat: ' src/app.ts | 5 ++++-',
        error: null,
        durationMs: 15,
      }),
    );

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.frame.type).toBe('workspace.git.status.result');
      expect(parsed.frame.clean).toBe(false);
      expect(parsed.frame.files[0]).toMatchObject({ path: 'src/app.ts', additions: 4 });
      expect(parsed.frame.files[0].patch).toContain('+new');
    }
  });

  test('encodes workspace git commit requests sent to octodeck-daemon', () => {
    const encoded = encodeFrame({
      type: 'workspace.git.commit.request',
      id: 10,
      requestId: 'git-commit-1',
      workspace: {
        kind: 'workspace',
        folder: 'demo',
        agentId: 'claude-code',
        scope: 'task',
        taskId: 'iss_1',
        taskRunId: 'irun_1',
      },
      workspaceRepo: {
        kind: 'git',
        gitUrl: 'https://example.com/acme/demo.git',
        groupFolder: 'demo',
        name: 'demo',
        agentId: 'claude-code',
        scope: 'task',
        taskId: 'iss_1',
        taskRunId: 'irun_1',
      },
      message: 'fix: update app',
    });

    expect(JSON.parse(encoded)).toMatchObject({
      type: 'workspace.git.commit.request',
      requestId: 'git-commit-1',
      message: 'fix: update app',
      workspaceRepo: { kind: 'git', name: 'demo' },
    });
  });

  test('encodes task-scoped token and run permission policy in agent run requests', () => {
    const parsed = AgentRunRequestFrame.parse({
      type: 'agent.run.request',
      id: 11,
      runId: 'irun_1',
      agentId: 'claude-code',
      workspace: { kind: 'workspace', folder: 'main', scope: 'task', taskId: 'iss_1', taskRunId: 'irun_1' },
      input: { prompt: 'work on issue' },
      timeoutMs: 60_000,
      maxOutputBytes: 65_536,
      policy: {
        model: 'claude-sonnet-4',
        taskScopedToken: 'ott_test_token',
        runPermissionPolicy: {
          filesystem: 'workspace',
          workspaceFolder: 'main',
          repoId: 'repo_1',
          network: 'disabled',
          secrets: 'none',
          shell: 'approval',
          git: 'push_approval',
        },
      },
    });
    const encoded = encodeFrame(parsed);

    expect(JSON.parse(encoded)).toMatchObject({
      type: 'agent.run.request',
      runId: 'irun_1',
      policy: {
        taskScopedToken: 'ott_test_token',
        runPermissionPolicy: {
          workspaceFolder: 'main',
          git: 'push_approval',
        },
      },
    });
  });

  test('accepts workspace git commit result frames from octodeck-daemon', () => {
    const parsed = parseInboundFrame(
      JSON.stringify({
        type: 'workspace.git.commit.result',
        requestId: 'git-commit-1',
        ok: true,
        workspacePath: '/tmp/demo',
        branch: 'main',
        commit: 'abc1234',
        clean: true,
        filesCommitted: 2,
        error: null,
        durationMs: 22,
      }),
    );

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.frame.type).toBe('workspace.git.commit.result');
      expect(parsed.frame.commit).toBe('abc1234');
      expect(parsed.frame.filesCommitted).toBe(2);
    }
  });

  test('accepts hello and ping resource snapshots from octodeck-daemon', () => {
    const hello = parseInboundFrame(
      JSON.stringify({
        type: 'hello',
        id: 1,
        version: 'octodeck-daemon/0.1.0',
        capabilities: ['run.host-cli'],
        resources: {
          cpuCount: 10,
          cpuUsedPercent: 12,
          load1: 1.2,
          load5: 1.4,
          load15: 1.8,
          memoryTotalBytes: 34359738368,
          memoryUsedBytes: 17179869184,
          memoryUsedPercent: 50,
          diskTotalBytes: 1000000000,
          diskUsedBytes: 250000000,
          diskUsedPercent: 25,
          collectedAt: '2026-05-30T00:00:00Z',
        },
        agentClients: [
          {
            id: 'claude-code',
            displayName: 'Claude Code',
            binary: '/usr/local/bin/claude',
            permissionModes: ['default', 'acceptEdits', 'bypassPermissions'],
            capabilities: ['stream-json', 'mcp', 'permissions'],
          },
        ],
      }),
    );
    expect(hello.ok).toBe(true);
    if (hello.ok) {
      expect(hello.frame.type).toBe('hello');
      expect(hello.frame.resources?.cpuCount).toBe(10);
      expect(hello.frame.resources?.cpuUsedPercent).toBe(12);
      expect(hello.frame.resources?.memoryUsedPercent).toBe(50);
      expect(hello.frame.agentClients?.[0]?.permissionModes).toContain('acceptEdits');
      expect(hello.frame.agentClients?.[0]?.capabilities).toContain('stream-json');
    }

    const ping = parseInboundFrame(
      JSON.stringify({
        type: 'ping',
        id: 2,
        resources: {
          cpuCount: 10,
          cpuUsedPercent: 22,
          load1: 2.2,
          load5: 2.4,
          load15: 2.8,
          memoryTotalBytes: 34359738368,
          memoryUsedBytes: 21474836480,
          memoryUsedPercent: 62.5,
          diskTotalBytes: 1000000000,
          diskUsedBytes: 400000000,
          diskUsedPercent: 40,
          collectedAt: '2026-05-30T00:00:30Z',
        },
      }),
    );
    expect(ping.ok).toBe(true);
    if (ping.ok) {
      expect(ping.frame.type).toBe('ping');
      expect(ping.frame.resources?.cpuUsedPercent).toBe(22);
      expect(ping.frame.resources?.diskUsedPercent).toBe(40);
    }
  });

  test('routes ping frames to the registry so resource snapshots are persisted', () => {
    const source = readFileSync(join(repoRoot, 'src/agent-link/session.ts'), 'utf8');

    expect(source).not.toContain("if (frame.type === 'ping') return;");
    expect(source).toContain('ping carries resource snapshots');
  });
});
