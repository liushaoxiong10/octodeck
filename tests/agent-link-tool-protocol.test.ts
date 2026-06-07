import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { encodeFrame, parseInboundFrame } from '../src/agent-link/protocol.js';

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
      latestVersion: 'octodeck-daemon/1.0.8',
      currentVersion: 'octodeck-daemon/1.0.3',
      reason: 'client_version_outdated',
    });

    expect(JSON.parse(encoded)).toMatchObject({
      type: 'daemon.update.request',
      latestVersion: 'octodeck-daemon/1.0.8',
      currentVersion: 'octodeck-daemon/1.0.3',
    });
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
