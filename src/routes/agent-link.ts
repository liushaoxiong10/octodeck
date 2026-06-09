// Device routes — REST CRUD for octodeck-daemon client tokens + ws upgrade handler.
// The transport/protocol is still called Agent Link internally for backwards
// compatibility, but the user-facing management surface is Devices.
//
// REST endpoints (all session-cookie auth, scoped to the calling user):
//   GET    /api/devices                 list user's devices + online status
//   POST   /api/devices                 create device, returns one-time plain token
//   POST   /api/devices/:id/rotate      regenerate token, returns one-time plain token
//   DELETE /api/devices/:id             revoke device + kick its ws session
// Legacy aliases under /api/agent-link remain mounted by web.ts.
//
// The ws upgrade for path /api/agent-link/ws is handled outside Hono — see
// `handleAgentLinkUpgrade` exported below; web.ts hooks it into the shared
// HTTP `upgrade` event.
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { Hono } from 'hono';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { WebSocketServer } from 'ws';

import {
  createAgentLink,
  getAllRegisteredGroups,
  getAllTasks,
  getAgentLinkById,
  listAgentLinkAuthCandidates,
  listAgentLinksByUser,
  listManagedReposByUser,
  revokeAgentLink,
  rotateAgentLinkToken,
} from '../db.js';
import { logger } from '../logger.js';
import { authMiddleware } from '../middleware/auth.js';
import type { Variables } from '../web-context.js';
import {
  canAccessGroup,
  hasHostExecutionPermission,
  isHostExecutionGroup,
} from '../web-context.js';
import {
  disconnectLink,
  getSession,
  getOnlineMeta,
  handleFrame,
  handleHello,
  isOnline,
  LATEST_DAEMON_VERSION,
  onIncomingSession,
  unregisterSession,
} from '../agent-link/registry.js';
import { AgentLinkSession } from '../agent-link/session.js';
import { requestProviderModels } from '../agent-link/model-rpc.js';
import { requestProviderSkills } from '../agent-link/skills-rpc.js';
import {
  requestAgentDiscover,
  requestAgentSessionDelete,
  requestAgentSessions,
} from '../agent-link/agent-runtime-rpc.js';
import type { AuthUser } from '../types.js';
import { listCustomBackends } from '../backends/custom-loader.js';
import { handleAgentTeamLinkToolRequest } from './agent-teams.js';

const DAEMON_UPDATE_COMMAND =
  '~/.octodeck/daemon/bin/octodeck-daemon update -config ~/.octodeck/daemon/config.json';
const DAEMON_UNINSTALL_COMMAND =
  '~/.octodeck/daemon/bin/octodeck-daemon uninstall';

function normalizeDaemonVersion(version: string | null | undefined): string {
  return (version ?? '')
    .trim()
    .replace(/^v/, '')
    .replace(/^octodeck-daemon\//, '');
}

function isDaemonUpdateAvailable(current: string | null | undefined): boolean {
  const currentNorm = normalizeDaemonVersion(current);
  const latestNorm = normalizeDaemonVersion(LATEST_DAEMON_VERSION);
  return !!currentNorm && !!latestNorm && currentNorm !== latestNorm;
}

const BCRYPT_ROUNDS = 10;
const TOKEN_BYTES = 32; // 64 hex chars
const MAX_LINKS_PER_USER = 16;

const agentLinkRoutes = new Hono<{ Variables: Variables }>();

function newLinkId(): string {
  return 'cl_' + crypto.randomBytes(8).toString('hex');
}
function newPlainToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

agentLinkRoutes.get('/', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const links = listAgentLinksByUser(user.id);
  const result = links.map((l) => {
    const online = getOnlineMeta(l.id);
    const linkOnline = isOnline(l.id);
    return {
      resources: online?.resources ?? l.resources ?? null,
      id: l.id,
      displayName: l.displayName,
      capabilities: l.capabilities,
      agentClients: l.agentClients ?? [],
      os: l.os ?? null,
      arch: l.arch ?? null,
      hostname: l.hostname ?? null,
      clientVersion: l.clientVersion ?? null,
      latestVersion: LATEST_DAEMON_VERSION,
      updateAvailable: isDaemonUpdateAvailable(l.clientVersion),
      updateCommand: DAEMON_UPDATE_COMMAND,
      uninstallCommand: DAEMON_UNINSTALL_COMMAND,
      lastConnectedAt: l.lastConnectedAt ?? null,
      lastSeenAt: l.lastSeenAt ?? null,
      status: online?.status ?? (linkOnline ? 'idle' : 'offline'),
      runningRuns: online?.runningRuns ?? [],
      maxConcurrentRuns: online?.maxConcurrentRuns ?? null,
      availableSlots: online?.availableSlots ?? null,
      runtimes: online?.runtimes ?? [],
      createdAt: l.createdAt,
      online: linkOnline,
      builtin: false,
    };
  });
  return c.json({ links: result });
});

agentLinkRoutes.post('/', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const body = (await c.req.json().catch(() => ({}))) as {
    displayName?: unknown;
  };
  const displayName =
    typeof body.displayName === 'string' ? body.displayName.trim() : '';
  if (!displayName || displayName.length > 64) {
    return c.json({ error: 'displayName 必填（≤64 字符）' }, 400);
  }

  const existing = listAgentLinksByUser(user.id);
  if (existing.length >= MAX_LINKS_PER_USER) {
    return c.json(
      { error: `每个用户最多 ${MAX_LINKS_PER_USER} 台设备，请先移除旧设备` },
      400,
    );
  }

  const id = newLinkId();
  const token = newPlainToken();
  const tokenHash = await bcrypt.hash(token, BCRYPT_ROUNDS);
  createAgentLink({ id, userId: user.id, displayName, tokenHash });
  logger.info({ userId: user.id, linkId: id }, 'agent-link created');
  return c.json({ id, displayName, token });
});

agentLinkRoutes.post('/:id/rotate', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const id = c.req.param('id');
  const link = getAgentLinkById(id);
  if (!link || link.userId !== user.id || link.revokedAt) {
    return c.json({ error: '设备不存在或已移除' }, 404);
  }
  const token = newPlainToken();
  const tokenHash = await bcrypt.hash(token, BCRYPT_ROUNDS);
  const ok = rotateAgentLinkToken(id, user.id, tokenHash);
  if (!ok) return c.json({ error: 'rotate 失败' }, 500);
  // Force the existing ws to disconnect (token changed → old session no longer valid)
  disconnectLink(id, 'token_rotated');
  logger.info({ userId: user.id, linkId: id }, 'agent-link rotated');
  return c.json({ id, token });
});

agentLinkRoutes.delete('/:id', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const id = c.req.param('id');
  const link = getAgentLinkById(id);
  if (!link || link.userId !== user.id || link.revokedAt) {
    return c.json({ error: '设备不存在或已移除' }, 404);
  }

  const agents = listCustomBackends()
    .filter((backend) => backend.deviceLinkId === id)
    .map((backend) => ({ id: backend.id, displayName: backend.displayName }));
  const allGroups = getAllRegisteredGroups();
  const workspaces = Object.entries(allGroups)
    .filter(
      ([jid, group]) =>
        (group.deviceLinkId === id || group.executionNode === id) &&
        canAccessGroup({ id: user.id, role: user.role }, { ...group, jid }) &&
        (!isHostExecutionGroup(group) || hasHostExecutionPermission(user)),
    )
    .map(([jid, group]) => ({ jid, name: group.name, folder: group.folder }));
  const repos = listManagedReposByUser(user.id)
    .filter((repo) => repo.deviceLinkId === id)
    .map((repo) => ({ id: repo.id, name: repo.name, kind: repo.kind }));
  const tasks = getAllTasks()
    .filter((task) => {
      if (task.execution_node !== id) return false;
      const group = allGroups[task.chat_jid];
      if (!group) return user.role === 'admin';
      return (
        canAccessGroup(
          { id: user.id, role: user.role },
          { ...group, jid: task.chat_jid },
        ) &&
        (!isHostExecutionGroup(group) || hasHostExecutionPermission(user))
      );
    })
    .map((task) => ({ id: task.id, prompt: task.prompt, status: task.status }));

  if (
    agents.length > 0 ||
    workspaces.length > 0 ||
    repos.length > 0 ||
    tasks.length > 0
  ) {
    return c.json(
      {
        error:
          '该设备存在关联的 Agent/工作区/Repo/任务，请先删除或切换这些关联后再删除设备',
        agents,
        workspaces,
        repos,
        tasks,
      },
      409,
    );
  }
  const ok = revokeAgentLink(id, user.id);
  if (!ok) return c.json({ error: '设备不存在或已移除' }, 404);
  disconnectLink(id, 'revoked');
  logger.info({ userId: user.id, linkId: id }, 'agent-link revoked');
  return c.json({ ok: true });
});

agentLinkRoutes.post('/agent-team-tool', async (c) => {
  const tokenHeader = c.req.header('x-link-token') || '';
  if (!tokenHeader || tokenHeader.length < 16 || tokenHeader.length > 256) {
    return c.json({ error: 'missing_token' }, 401);
  }

  let matchedUserId: string | null = null;
  for (const candidate of listAgentLinkAuthCandidates()) {
    try {
      if (await bcrypt.compare(tokenHeader, candidate.tokenHash)) {
        matchedUserId = candidate.userId;
        break;
      }
    } catch (err) {
      logger.warn(
        { linkId: candidate.id, err: (err as Error).message },
        'agent-link agent team tool bcrypt compare failed',
      );
    }
  }
  if (!matchedUserId) return c.json({ error: 'invalid_token' }, 401);

  const body = await c.req.json().catch(() => ({}));
  return handleAgentTeamLinkToolRequest(c, matchedUserId, body);
});

agentLinkRoutes.get(
  '/:id/providers/:providerId/models',
  authMiddleware,
  async (c) => {
    const user = c.get('user') as AuthUser;
    const id = c.req.param('id');
    const providerId = c.req.param('providerId');
    const link = getAgentLinkById(id);
    if (!link || link.userId !== user.id || link.revokedAt) {
      return c.json({ error: '设备不存在或已移除' }, 404);
    }
    if (!(link.agentClients ?? []).some((client) => client.id === providerId)) {
      return c.json({ error: `设备未上报 provider: ${providerId}` }, 404);
    }
    const session = getSession(id);
    if (!session || session.state !== 'open') {
      return c.json({ error: '设备离线' }, 409);
    }
    try {
      const result = await requestProviderModels(session, {
        linkId: id,
        providerId,
        timeoutMs: 15_000,
      });
      if (!result.ok) {
        return c.json(
          { error: result.error || '模型查询失败', models: [] },
          502,
        );
      }
      return c.json({ models: result.models, durationMs: result.durationMs });
    } catch (err) {
      const msg = err instanceof Error ? err.message : '模型查询失败';
      logger.warn(
        { err, linkId: id, providerId },
        'agent-link model discovery failed',
      );
      return c.json({ error: msg }, 504);
    }
  },
);

agentLinkRoutes.post('/:id/agents/discover', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const id = c.req.param('id');
  const link = getAgentLinkById(id);
  if (!link || link.userId !== user.id || link.revokedAt) {
    return c.json({ error: '设备不存在或已移除' }, 404);
  }
  const session = getSession(id);
  if (!session || session.state !== 'open') {
    return c.json({ error: '设备离线' }, 409);
  }
  try {
    const result = await requestAgentDiscover(session, {
      linkId: id,
      timeoutMs: 15_000,
    });
    if (!result.ok) {
      return c.json(
        { error: result.error || 'Agent discover 失败', agents: [] },
        502,
      );
    }
    return c.json({ agents: result.agents, durationMs: result.durationMs });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Agent discover 失败';
    logger.warn({ err, linkId: id }, 'agent runtime discover failed');
    return c.json({ error: msg }, 504);
  }
});

agentLinkRoutes.get('/:id/agents/sessions', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const id = c.req.param('id');
  const link = getAgentLinkById(id);
  if (!link || link.userId !== user.id || link.revokedAt) {
    return c.json({ error: '设备不存在或已移除' }, 404);
  }
  const session = getSession(id);
  if (!session || session.state !== 'open') {
    return c.json({ error: '设备离线' }, 409);
  }
  try {
    const agentId = c.req.query('agentId')?.trim() || undefined;
    const workspace = c.req.query('workspace')?.trim() || undefined;
    const result = await requestAgentSessions(session, {
      linkId: id,
      agentId,
      workspace,
      timeoutMs: 15_000,
    });
    if (!result.ok) {
      return c.json(
        { error: result.error || 'Agent sessions 查询失败', sessions: [] },
        502,
      );
    }
    return c.json({ sessions: result.sessions, durationMs: result.durationMs });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Agent sessions 查询失败';
    logger.warn({ err, linkId: id }, 'agent runtime sessions failed');
    return c.json({ error: msg }, 504);
  }
});

agentLinkRoutes.delete(
  '/:id/agents/:agentId/sessions/:sessionId',
  authMiddleware,
  async (c) => {
    const user = c.get('user') as AuthUser;
    const id = c.req.param('id');
    const agentId = c.req.param('agentId');
    const sessionId = c.req.param('sessionId');
    const workspace = c.req.query('workspace')?.trim() || '';
    const link = getAgentLinkById(id);
    if (!link || link.userId !== user.id || link.revokedAt) {
      return c.json({ error: '设备不存在或已移除' }, 404);
    }
    if (!workspace) {
      return c.json({ error: 'workspace query 必填' }, 400);
    }
    const session = getSession(id);
    if (!session || session.state !== 'open') {
      return c.json({ error: '设备离线' }, 409);
    }
    try {
      const result = await requestAgentSessionDelete(session, {
        linkId: id,
        agentId,
        workspace,
        sessionId,
        timeoutMs: 15_000,
      });
      if (!result.ok) {
        return c.json(
          { error: result.error || 'Agent session 删除失败', deleted: false },
          502,
        );
      }
      return c.json({ deleted: result.deleted, durationMs: result.durationMs });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Agent session 删除失败';
      logger.warn(
        { err, linkId: id, agentId, sessionId },
        'agent runtime delete session failed',
      );
      return c.json({ error: msg }, 504);
    }
  },
);

agentLinkRoutes.post(
  '/:id/agents/runs/:runId/permissions/:requestId/decision',
  authMiddleware,
  async (c) => {
    const user = c.get('user') as AuthUser;
    const id = c.req.param('id');
    const runId = c.req.param('runId');
    const requestId = c.req.param('requestId');
    const link = getAgentLinkById(id);
    if (!link || link.userId !== user.id || link.revokedAt) {
      return c.json({ error: '设备不存在或已移除' }, 404);
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      decision?: unknown;
      message?: unknown;
    };
    const decision =
      body.decision === 'reject'
        ? 'reject'
        : body.decision === 'approve'
          ? 'approve'
          : null;
    if (!decision) {
      return c.json({ error: 'decision 必须是 approve 或 reject' }, 400);
    }
    const session = getSession(id);
    if (!session || session.state !== 'open') {
      return c.json({ error: '设备离线' }, 409);
    }
    const ok = session.send({
      type: 'agent.permission.decision',
      runId,
      requestId,
      decision,
      ...(typeof body.message === 'string'
        ? { message: body.message.slice(0, 1024) }
        : {}),
    });
    if (!ok) return c.json({ error: '发送 decision 失败' }, 502);
    return c.json({ ok: true });
  },
);

agentLinkRoutes.get(
  '/:id/providers/:providerId/skills',
  authMiddleware,
  async (c) => {
    const user = c.get('user') as AuthUser;
    const id = c.req.param('id');
    const providerId = c.req.param('providerId');
    const link = getAgentLinkById(id);
    if (!link || link.userId !== user.id || link.revokedAt) {
      return c.json({ error: '设备不存在或已移除' }, 404);
    }
    if (!(link.agentClients ?? []).some((client) => client.id === providerId)) {
      return c.json({ error: `设备未上报 provider: ${providerId}` }, 404);
    }
    const session = getSession(id);
    if (!session || session.state !== 'open') {
      return c.json({ error: '设备离线' }, 409);
    }
    try {
      const cwd = c.req.query('cwd')?.trim() || undefined;
      const result = await requestProviderSkills(session, {
        linkId: id,
        providerId,
        cwd,
        timeoutMs: 15_000,
      });
      if (!result.ok) {
        return c.json(
          {
            error: result.error || 'Skills 查询失败',
            workspaceSkills: [],
            cliSkills: [],
          },
          502,
        );
      }
      return c.json({
        workspaceSkills: result.workspaceSkills,
        cliSkills: result.cliSkills,
        durationMs: result.durationMs,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Skills 查询失败';
      logger.warn(
        { err, linkId: id, providerId },
        'agent-link skills discovery failed',
      );
      return c.json({ error: msg }, 504);
    }
  },
);

export default agentLinkRoutes;

// ─── WebSocket upgrade ──────────────────────────────────────────────

const wss = new WebSocketServer({ noServer: true });

interface UpgradeRequest extends IncomingMessage {
  __agentLinkId?: string;
  __agentLinkUserId?: string;
}

/**
 * 校验 X-Link-Token 并通过 wss.handleUpgrade 升级。
 * 由 web.ts 在路径匹配 /api/agent-link/ws 时调用。
 */
export async function handleAgentLinkUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): Promise<void> {
  const tokenHeader = request.headers['x-link-token'];
  const token = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
  if (
    !token ||
    typeof token !== 'string' ||
    token.length < 16 ||
    token.length > 256
  ) {
    rejectUpgrade(socket, 401, 'missing_token');
    return;
  }

  const candidates = listAgentLinkAuthCandidates();
  let matchedLinkId: string | null = null;
  let matchedUserId: string | null = null;
  for (const c of candidates) {
    try {
      if (await bcrypt.compare(token, c.tokenHash)) {
        matchedLinkId = c.id;
        matchedUserId = c.userId;
        break;
      }
    } catch (err) {
      logger.warn(
        { linkId: c.id, err: (err as Error).message },
        'agent-link bcrypt compare failed',
      );
    }
  }

  if (!matchedLinkId || !matchedUserId) {
    rejectUpgrade(socket, 401, 'invalid_token');
    return;
  }

  (request as UpgradeRequest).__agentLinkId = matchedLinkId;
  (request as UpgradeRequest).__agentLinkUserId = matchedUserId;
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
}

function rejectUpgrade(socket: Duplex, code: number, reason: string): void {
  try {
    const statusText = code === 401 ? 'Unauthorized' : 'Bad Request';
    socket.write(
      `HTTP/1.1 ${code} ${statusText}\r\n` +
        `Content-Length: ${reason.length}\r\n` +
        `Content-Type: text/plain\r\n\r\n` +
        reason,
    );
  } catch {
    /* ignore */
  }
  try {
    socket.destroy();
  } catch {
    /* ignore */
  }
}

wss.on('connection', (ws, request: IncomingMessage) => {
  const r = request as UpgradeRequest;
  const linkId = r.__agentLinkId;
  const userId = r.__agentLinkUserId;
  if (!linkId || !userId) {
    try {
      ws.close(1008, 'unauthorized');
    } catch {
      /* ignore */
    }
    return;
  }

  const link = getAgentLinkById(linkId);
  if (!link || link.revokedAt) {
    try {
      ws.close(1008, 'revoked');
    } catch {
      /* ignore */
    }
    return;
  }

  const remoteIp = extractRemoteIp(request);
  logger.info(
    { linkId, userId, remoteIp },
    'agent-link ws connected, awaiting hello',
  );

  const session = new AgentLinkSession({
    ws,
    remoteIp,
    linkId,
    userId,
    onHello: (s, frame) => {
      handleHello(s, frame, link.displayName);
    },
    onFrame: (s, frame) => {
      handleFrame(s, frame);
    },
    onClose: (s, reason) => {
      logger.info(
        { linkId: s.linkId, reason, durationMs: Date.now() - s.connectedAt },
        'agent-link ws closed',
      );
      unregisterSession(s);
    },
  });
  onIncomingSession(session);
});

function extractRemoteIp(req: IncomingMessage): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0].trim();
  }
  return req.socket.remoteAddress ?? 'unknown';
}
