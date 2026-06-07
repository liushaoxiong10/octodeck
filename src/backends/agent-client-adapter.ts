import type { CustomBackendDef } from './dynamic.js';

export interface DiscoveredAgentClient {
  id: 'claude-code' | 'codex' | 'traecli' | string;
  displayName: string;
  binary: string;
  version?: string;
  transport?: 'stdio' | 'acp' | 'a2a' | 'http' | string;
  permissionModes?: string[];
  capabilities?: string[];
}

export interface DeviceWithAgentClients {
  id: string;
  agentClients?: DiscoveredAgentClient[];
}

export function resolveDeviceAgentClient(
  device: DeviceWithAgentClients | undefined,
  agentClientId: string,
): DiscoveredAgentClient {
  if (!device) {
    throw new Error('设备不存在或已移除');
  }
  const client = (device.agentClients ?? []).find(
    (c) => c.id === agentClientId,
  );
  if (!client) {
    throw new Error(
      `未在设备 ${device.id} 上发现 Agent client: ${agentClientId}`,
    );
  }
  return client;
}

export function buildAgentBackendFromClient(input: {
  id: string;
  displayName: string;
  deviceLinkId: string;
  agentClientId: string;
  discoveredClient: DiscoveredAgentClient;
  timeoutMs?: number;
  maxOutputBytes?: number;
  runtime?: 'local-device' | 'server-side';
  model?: string;
  providerId?: string | null;
  workdirMode?: 'auto' | 'custom';
  workdir?: string;
  agentMdId?: string | null;
}): CustomBackendDef {
  const template = templateForAgentClient(input.discoveredClient.id);
  return {
    id: input.id,
    displayName: input.displayName,
    binary: input.discoveredClient.binary,
    argvTemplate: template.argvTemplate,
    supportsNativeSessions: template.supportsNativeSessions,
    sessionArgvTemplate: template.sessionArgvTemplate,
    resumeArgvTemplate: template.resumeArgvTemplate,
    outputProtocol: template.outputProtocol,
    supportsHost: true,
    supportsContainer: false,
    usesProviderPool: false,
    timeoutMs: input.timeoutMs,
    maxOutputBytes: input.maxOutputBytes,
    runtime: input.runtime,
    model: input.model,
    providerId: input.providerId,
    workdirMode: input.workdirMode,
    workdir: input.workdir,
    deviceLinkId: input.deviceLinkId,
    agentClientId: input.agentClientId,
    agentMdId: input.agentMdId,
  };
}

export function normalizeAgentClientBackendDef(
  def: CustomBackendDef,
): CustomBackendDef {
  if (!def.agentClientId) return { ...def };
  try {
    const template = templateForAgentClient(def.agentClientId);
    return {
      ...def,
      argvTemplate: template.argvTemplate,
      supportsNativeSessions: template.supportsNativeSessions,
      sessionArgvTemplate: template.sessionArgvTemplate,
      resumeArgvTemplate: template.resumeArgvTemplate,
      outputProtocol: template.outputProtocol,
    };
  } catch {
    return { ...def };
  }
}

function templateForAgentClient(
  id: string,
): Pick<
  CustomBackendDef,
  | 'argvTemplate'
  | 'outputProtocol'
  | 'supportsNativeSessions'
  | 'sessionArgvTemplate'
  | 'resumeArgvTemplate'
> {
  switch (id) {
    case 'claude-acp':
    case 'claude-code':
      return {
        argvTemplate: [
          '-p',
          '{prompt}',
          '--model',
          '{model}',
          '--output-format',
          'stream-json',
          '--dangerously-skip-permissions',
          '--mcp-config',
          '__OCTODECK_AGENT_TEAM_MCP_CONFIG__',
        ],
        outputProtocol: 'jsonline-stream-json',
        supportsNativeSessions: true,
        sessionArgvTemplate: ['--resume={sessionId}'],
      };
    case 'codex-acp':
    case 'codex':
      return {
        argvTemplate: [
          'exec',
          '--json',
          '--skip-git-repo-check',
          '-m',
          '{model}',
          '{prompt}',
        ],
        outputProtocol: 'jsonline-stream-json',
        supportsNativeSessions: true,
        resumeArgvTemplate: [
          'exec',
          'resume',
          '--json',
          '--skip-git-repo-check',
          '-m',
          '{model}',
          '{sessionId}',
          '{prompt}',
        ],
      };
    case 'traecli-acp':
    case 'traecli':
      return {
        argvTemplate: [
          '-p',
          '{prompt}',
          '-c',
          'model.name={model}',
          '--output-format=stream-json',
          '--include-partial-messages',
          '-y',
          '__OCTODECK_AGENT_TEAM_MCP_PROJECT_CONFIG__',
        ],
        outputProtocol: 'jsonline-stream-json',
        supportsNativeSessions: true,
        sessionArgvTemplate: ['--resume={sessionId}'],
      };
    default:
      throw new Error(`不支持的 Agent client: ${id}`);
  }
}
