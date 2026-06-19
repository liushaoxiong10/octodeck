import { Hono } from 'hono';

import { listCustomBackends } from '../backends/custom-loader.js';
import { listAgentLinksByUser, listCloudSkillsByUser } from '../db.js';
import { getOnlineMeta, isOnline } from '../agent-link/registry.js';
import { buildTeamAgentRegistrySnapshot } from '../agent-registry.js';
import { buildRuntimePoolSnapshot } from '../runtime-pool.js';
import { authMiddleware } from '../middleware/auth.js';
import type { AuthUser } from '../types.js';
import type { Variables } from '../web-context.js';
import { discoverAgents } from './agent-definitions.js';

const DEFAULT_USER_RUNTIME_MAX_CONCURRENT_RUNS = 4;

const registryRoutes = new Hono<{ Variables: Variables }>();

export function buildRegistryGovernanceSnapshot(user: AuthUser) {
  const devices = listAgentLinksByUser(user.id).map((link) => {
    const online = getOnlineMeta(link.id);
    const linkOnline = isOnline(link.id);
    return {
      id: link.id,
      displayName: link.displayName,
      online: linkOnline,
      status: online?.status ?? (linkOnline ? 'idle' as const : 'offline' as const),
      lastHeartbeatAt: online?.lastHeartbeatAt
        ? new Date(online.lastHeartbeatAt).toISOString()
        : link.lastSeenAt,
      agentClients: link.agentClients ?? [],
      runtimes: online?.runtimes ?? [],
    };
  });
  const serverBackends = listCustomBackends()
    .filter((backend) => backend.runtime === 'server-side')
    .map((backend) => ({
      id: backend.id,
      displayName: backend.displayName,
      runtime: backend.runtime,
      providerId: backend.providerId,
    }));
  const runtimePool = buildRuntimePoolSnapshot({
    devices,
    serverBackends,
    quota: {
      userId: user.id,
      maxConcurrentRuns: DEFAULT_USER_RUNTIME_MAX_CONCURRENT_RUNS,
    },
    assignment: { preferredAgentClientId: 'claude-code' },
  });
  const registry = buildTeamAgentRegistrySnapshot({
    agents: discoverAgents(),
    skills: listCloudSkillsByUser(user.id),
    runtimes: runtimePool.runtimes.map((runtime) => ({
      runtimeId: runtime.runtimeId,
      kind: runtime.kind,
      displayName: runtime.displayName,
      agentClientId: runtime.agentClientId,
      provider: runtime.provider,
      transport: runtime.transport,
      status: runtime.status,
      health: runtime.health,
      capabilities: [
        runtime.kind,
        runtime.provider ?? '',
        runtime.transport ?? '',
        runtime.agentClientId,
        'repo',
        'terminal',
        runtime.provider ? 'network' : '',
      ],
      availableSlots: runtime.availableSlots,
      updatedAt: runtime.lastHeartbeatAt,
    })),
  });
  const capabilityCatalog = registry.capabilityCatalog;

  return { registry: { ...registry, capabilityCatalog }, runtimePool };
}

registryRoutes.get('/', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  return c.json(buildRegistryGovernanceSnapshot(user));
});

export default registryRoutes;
