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
  disconnectLink,
  getSession,
  getOnlineMeta,
  handleFrame,
  handleHello,
  isOnline,
  onIncomingSession,
  unregisterSession,
} from '../agent-link/registry.js';
import { AgentLinkSession } from '../agent-link/session.js';
import { requestProviderModels } from '../agent-link/model-rpc.js';
import { requestProviderSkills } from '../agent-link/skills-rpc.js';
import type { AuthUser } from '../types.js';
import { listCustomBackends } from '../backends/custom-loader.js';

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
  const result = links.map((l) => ({
    ...(() => {
      const online = getOnlineMeta(l.id);
      return { resources: online?.resources ?? l.resources ?? null };
    })(),
    id: l.id,
    displayName: l.displayName,
    capabilities: l.capabilities,
    agentClients: l.agentClients ?? [],
    os: l.os ?? null,
    arch: l.arch ?? null,
    hostname: l.hostname ?? null,
    clientVersion: l.clientVersion ?? null,
    lastConnectedAt: l.lastConnectedAt ?? null,
    lastSeenAt: l.lastSeenAt ?? null,
    createdAt: l.createdAt,
    online: isOnline(l.id),
    builtin: false,
  }));
  return c.json({ links: result });
});

agentLinkRoutes.post('/', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const body = (await c.req.json().catch(() => ({}))) as { displayName?: unknown };
  const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
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
  const workspaces = Object.entries(getAllRegisteredGroups())
    .filter(([, group]) => group.deviceLinkId === id || group.executionNode === id)
    .map(([jid, group]) => ({ jid, name: group.name, folder: group.folder }));
  const repos = listManagedReposByUser(user.id)
    .filter((repo) => repo.deviceLinkId === id)
    .map((repo) => ({ id: repo.id, name: repo.name, kind: repo.kind }));
  const tasks = getAllTasks()
    .filter((task) => task.execution_node === id)
    .map((task) => ({ id: task.id, prompt: task.prompt, status: task.status }));

  if (agents.length > 0 || workspaces.length > 0 || repos.length > 0 || tasks.length > 0) {
    return c.json(
      {
        error: '该设备存在关联的 Agent/工作区/Repo/任务，请先删除或切换这些关联后再删除设备',
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

agentLinkRoutes.get('/:id/providers/:providerId/models', authMiddleware, async (c) => {
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
      return c.json({ error: result.error || '模型查询失败', models: [] }, 502);
    }
    return c.json({ models: result.models, durationMs: result.durationMs });
  } catch (err) {
    const msg = err instanceof Error ? err.message : '模型查询失败';
    logger.warn({ err, linkId: id, providerId }, 'agent-link model discovery failed');
    return c.json({ error: msg }, 504);
  }
});

agentLinkRoutes.get('/:id/providers/:providerId/skills', authMiddleware, async (c) => {
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
      return c.json({ error: result.error || 'Skills 查询失败', workspaceSkills: [], cliSkills: [] }, 502);
    }
    return c.json({
      workspaceSkills: result.workspaceSkills,
      cliSkills: result.cliSkills,
      durationMs: result.durationMs,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Skills 查询失败';
    logger.warn({ err, linkId: id, providerId }, 'agent-link skills discovery failed');
    return c.json({ error: msg }, 504);
  }
});

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
  if (!token || typeof token !== 'string' || token.length < 16 || token.length > 256) {
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
  logger.info({ linkId, userId, remoteIp }, 'agent-link ws connected, awaiting hello');

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
