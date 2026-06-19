import type { AgentLinkSession } from './agent-link/session.js';
import type { RegisteredGroup } from './types.js';
import { logger } from './logger.js';
import {
  getSession as getAgentLinkSession,
} from './agent-link/registry.js';
import {
  requestAgentSessionDelete,
  type AgentSessionDeleteResult,
} from './agent-link/agent-runtime-rpc.js';

function deviceLinkIdFromExecutionTarget(
  value: string | undefined,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const direct = /^(cl_[0-9a-f]{16})$/.exec(value);
  if (direct) return direct[1];
  const runtime = /^runtime:(cl_[0-9a-f]{16}):[^:]+$/.exec(value);
  if (runtime) return runtime[1];
  const legacyRuntime = /^(cl_[0-9a-f]{16}):[^:]+$/.exec(value);
  if (legacyRuntime) return legacyRuntime[1];
  return undefined;
}

function agentClientIdFromExecutionTarget(
  value: string | undefined,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const runtime = /^runtime:cl_[0-9a-f]{16}:([^:]+)$/.exec(value);
  if (runtime) return runtime[1];
  const legacyRuntime = /^cl_[0-9a-f]{16}:([^:]+)$/.exec(value);
  if (legacyRuntime) return legacyRuntime[1];
  const provider = /^provider:([^:]+)$/.exec(value);
  if (provider) return provider[1];
  return undefined;
}

function uniqueNonEmpty(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.map((value) => value?.trim()).filter((value): value is string => !!value)));
}

export async function cleanupDeletedConversationAgentDaemonSessions(
  input: {
    group: RegisteredGroup;
    agentId: string;
    providerSessionId?: string;
    workspaceSessionId?: string;
    getRuntimeSession?: (linkId: string) => AgentLinkSession | undefined;
    requestDelete?: (
      session: AgentLinkSession,
      opts: {
        linkId: string;
        agentId: string;
        workspace: string;
        sessionId: string;
        timeoutMs: number;
      },
    ) => Promise<AgentSessionDeleteResult>;
  },
): Promise<void> {
  const linkId =
    input.group.deviceLinkId ||
    deviceLinkIdFromExecutionTarget(input.group.executionNode);
  const agentClientId =
    input.group.agentClientId ||
    agentClientIdFromExecutionTarget(input.group.executionNode);
  if (!linkId || !agentClientId) return;

  const session =
    (input.getRuntimeSession ?? getAgentLinkSession)(linkId);
  if (!session || session.state !== 'open') {
    logger.info(
      { linkId, agentClientId, workspace: input.group.folder, agentId: input.agentId },
      'Skip daemon conversation session cleanup: agent link is offline',
    );
    return;
  }

  const requestDelete = input.requestDelete ?? requestAgentSessionDelete;
  for (const sessionId of uniqueNonEmpty([
    input.providerSessionId,
    input.workspaceSessionId,
  ])) {
    try {
      const result = await requestDelete(session, {
        linkId,
        agentId: agentClientId,
        workspace: input.group.folder,
        sessionId,
        timeoutMs: 15_000,
      });
      if (!result.ok) {
        logger.warn(
          {
            linkId,
            agentClientId,
            workspace: input.group.folder,
            deletedAgentId: input.agentId,
            sessionId,
            error: result.error,
          },
          'Daemon conversation session cleanup failed',
        );
      }
    } catch (err) {
      logger.warn(
        {
          linkId,
          agentClientId,
          workspace: input.group.folder,
          deletedAgentId: input.agentId,
          sessionId,
          err,
        },
        'Daemon conversation session cleanup failed',
      );
    }
  }
}
