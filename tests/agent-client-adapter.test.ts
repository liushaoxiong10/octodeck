import { describe, expect, test } from 'vitest';

import { buildAgentBackendFromClient, normalizeAgentClientBackendDef, resolveDeviceAgentClient } from '../src/backends/agent-client-adapter.js';

describe('agent client adapter', () => {
  test('builds backend config from discovered codex client without user supplied binary or argv', () => {
    const def = buildAgentBackendFromClient({
      id: 'mac-codex',
      displayName: 'Mac Codex',
      deviceLinkId: 'cl_1234567890abcdef',
      agentClientId: 'codex',
      discoveredClient: {
        id: 'codex',
        displayName: 'Codex CLI',
        binary: '/opt/homebrew/bin/codex',
      },
    });

    expect(def).toMatchObject({
      id: 'mac-codex',
      displayName: 'Mac Codex',
      binary: '/opt/homebrew/bin/codex',
      outputProtocol: 'jsonline-stream-json',
      supportsNativeSessions: true,
      resumeArgvTemplate: ['exec', 'resume', '--json', '--skip-git-repo-check', '-m', '{model}', '{sessionId}', '{prompt}'],
      deviceLinkId: 'cl_1234567890abcdef',
      agentClientId: 'codex',
    });
    expect(def.argvTemplate.join('\n')).toContain('{prompt}');
  });

  test('injects daemon Agent Team MCP config for Claude Code clients', () => {
    const def = buildAgentBackendFromClient({
      id: 'mac-claude',
      displayName: 'Mac Claude',
      deviceLinkId: 'cl_1234567890abcdef',
      agentClientId: 'claude-code',
      discoveredClient: {
        id: 'claude-code',
        displayName: 'Claude Code',
        binary: '/opt/homebrew/bin/claude',
        capabilities: ['mcp'],
      },
      model: 'sonnet',
    });

    expect(def.argvTemplate).toEqual([
      '-p',
      '{prompt}',
      '--model',
      '{model}',
      '--output-format',
      'stream-json',
      '--dangerously-skip-permissions',
      '--mcp-config',
      '__OCTODECK_AGENT_TEAM_MCP_CONFIG__',
    ]);
    expect(def.sessionArgvTemplate).toEqual(['--resume={sessionId}']);
  });

  test('passes selected model through discovered client argv template', () => {
    const def = buildAgentBackendFromClient({
      id: 'mac-codex',
      displayName: 'Mac Codex',
      deviceLinkId: 'cl_1234567890abcdef',
      agentClientId: 'codex',
      discoveredClient: {
        id: 'codex',
        displayName: 'Codex CLI',
        binary: '/opt/homebrew/bin/codex',
      },
      model: 'gpt-5-codex',
    });

    expect(def.model).toBe('gpt-5-codex');
    expect(def.argvTemplate).toContain('{model}');
    expect(def.resumeArgvTemplate).toContain('{model}');
    expect(def.resumeArgvTemplate).toContain('{sessionId}');
  });

  test('normalizes persisted Codex backend to native exec resume template', () => {
    const def = normalizeAgentClientBackendDef({
      id: 'mac-codex',
      displayName: 'Mac Codex',
      binary: '/opt/homebrew/bin/codex',
      argvTemplate: ['exec', '--skip-git-repo-check', '-m', '{model}', '{prompt}'],
      outputProtocol: 'plain-text',
      supportsHost: true,
      supportsContainer: false,
      usesProviderPool: false,
      supportsNativeSessions: false,
      runtime: 'local-device',
      model: 'gpt-5-codex',
      deviceLinkId: 'cl_1234567890abcdef',
      agentClientId: 'codex',
    });

    expect(def.supportsNativeSessions).toBe(true);
    expect(def.argvTemplate).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '-m',
      '{model}',
      '{prompt}',
    ]);
    expect(def.resumeArgvTemplate).toEqual([
      'exec',
      'resume',
      '--json',
      '--skip-git-repo-check',
      '-m',
      '{model}',
      '{sessionId}',
      '{prompt}',
    ]);
  });

  test('uses TraeCLI documented print mode and model config override', () => {
    const def = buildAgentBackendFromClient({
      id: 'device-traecli',
      displayName: 'Device TraeCLI',
      deviceLinkId: 'cl_1234567890abcdef',
      agentClientId: 'traecli',
      discoveredClient: {
        id: 'traecli',
        displayName: 'TraeCLI',
        binary: '/Users/me/.local/bin/traecli',
      },
      model: 'GPT-5.4',
    });

    expect(def.outputProtocol).toBe('jsonline-stream-json');
    expect(def.supportsNativeSessions).toBe(true);
    expect(def.sessionArgvTemplate).toEqual(['--resume={sessionId}']);
    expect(def.argvTemplate).toEqual([
      '-p',
      '{prompt}',
      '-c',
      'model.name={model}',
      '--output-format=stream-json',
      '--include-partial-messages',
      '-y',
      '__OCTODECK_AGENT_TEAM_MCP_PROJECT_CONFIG__',
    ]);
  });

  test('normalizes persisted TraeCLI backend using legacy --model argv', () => {
    const def = normalizeAgentClientBackendDef({
      id: 'device-traecli',
      displayName: 'Device TraeCLI',
      binary: '/Users/me/.local/bin/traecli',
      argvTemplate: ['-p', '{prompt}', '--model', '{model}'],
      outputProtocol: 'plain-text',
      supportsHost: true,
      supportsContainer: false,
      usesProviderPool: false,
      runtime: 'local-device',
      model: 'GPT-5.5',
      deviceLinkId: 'cl_1234567890abcdef',
      agentClientId: 'traecli',
    });

    expect(def.argvTemplate).toEqual([
      '-p',
      '{prompt}',
      '-c',
      'model.name={model}',
      '--output-format=stream-json',
      '--include-partial-messages',
      '-y',
      '__OCTODECK_AGENT_TEAM_MCP_PROJECT_CONFIG__',
    ]);
    expect(def.outputProtocol).toBe('jsonline-stream-json');
    expect(def.supportsNativeSessions).toBe(true);
    expect(def.sessionArgvTemplate).toEqual(['--resume={sessionId}']);
  });

  test('rejects clients not reported by the selected device', () => {
    expect(() =>
      resolveDeviceAgentClient(
        {
          id: 'cl_1234567890abcdef',
          agentClients: [{ id: 'claude-code', displayName: 'Claude Code', binary: '/usr/local/bin/claude' }],
        },
        'codex',
      ),
    ).toThrow('未在设备 cl_1234567890abcdef 上发现 Agent client: codex');
  });
});
