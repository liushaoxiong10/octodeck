import type { CustomBackendDef } from './dynamic.js';
import {
  templateForAgentClient,
  transportForAgentClient,
} from './agent-client-families.js';

export interface DiscoveredAgentClient {
  id: 'claude-code' | 'codex' | 'traecli' | string;
  displayName: string;
  binary: string;
  version?: string;
  family?: 'claude' | 'codex' | 'traecli' | 'traex' | string;
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
  permissionMode?: string | null;
  providerId?: string | null;
  workdirMode?: 'auto' | 'custom';
  workdir?: string;
  agentMdId?: string | null;
}): CustomBackendDef {
  if (
    input.permissionMode &&
    input.discoveredClient.permissionModes?.length &&
    !input.discoveredClient.permissionModes.includes(input.permissionMode)
  ) {
    throw new Error(
      `Agent client ${input.discoveredClient.id} 不支持权限模式: ${input.permissionMode}`,
    );
  }
  const template = templateForAgentClient(
    input.discoveredClient.id,
    input.discoveredClient.family,
  );
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
    permissionMode: input.permissionMode,
    providerId: input.providerId,
    workdirMode: input.workdirMode,
    workdir: input.workdir,
    deviceLinkId: input.deviceLinkId,
    agentClientId: input.agentClientId,
    agentClientTransport:
      input.discoveredClient.transport ??
      transportForAgentClient(
        input.discoveredClient.id,
        input.discoveredClient.family,
      ) ??
      null,
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
      agentClientTransport:
        def.agentClientTransport ??
        transportForAgentClient(def.agentClientId) ??
        null,
    };
  } catch {
    return { ...def };
  }
}
