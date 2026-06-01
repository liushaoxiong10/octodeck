/**
 * AgentLinkRegistry — process-wide map of online octodeck-daemon sessions.
 *
 * 单例。`Map<linkId, AgentLinkSession>`。
 * 同 linkId 重复连接时主动踢掉旧 session（防 token 泄露后 attacker 抢线）。
 *
 * Phase 5.1 仅暴露：register / get / list / closeAll；
 * Phase 5.2 会扩 run.* 路由（按 runId 找 controller）。
 */
import { logger } from '../logger.js';
import {
  recordAgentLinkResources,
  recordAgentLinkConnect,
  touchAgentLinkSeen,
} from '../db.js';
import {
  HEARTBEAT_INTERVAL_MS,
  type HelloFrame,
  type InboundFrame,
} from './protocol.js';
import {
  deliverEvent,
  deliverResult,
  failRunsForLink,
} from './run-rpc.js';
import {
  deliverToolEvent,
  deliverToolResult,
  failToolRequestsForLink,
} from './tool-rpc.js';
import {
  deliverModelResult,
  failModelRequestsForLink,
} from './model-rpc.js';
import {
  deliverSkillsResult,
  failSkillsRequestsForLink,
} from './skills-rpc.js';
import { AgentLinkSession } from './session.js';

export interface OnlineLinkInfo {
  linkId: string;
  userId: string;
  remoteIp: string;
  connectedAt: number;
  capabilities: string[];
  os?: string;
  arch?: string;
  hostname?: string;
  clientVersion?: string;
  resources?: HelloFrame['resources'];
}

const sessions = new Map<string, AgentLinkSession>();
const sessionMeta = new Map<string, OnlineLinkInfo>();

let serverVersion = '0.0.0';
export function setServerVersion(v: string): void {
  serverVersion = v;
}

/** New ws upgrade — server.ts 调用。已经鉴权通过的连接才进来。 */
export function onIncomingSession(session: AgentLinkSession): void {
  // Boot existing session for same linkId.
  const existing = sessions.get(session.linkId);
  if (existing) {
    logger.info(
      { linkId: session.linkId },
      'agent-link replaced by new connection',
    );
    existing.sendError('link_replaced', 'replaced by new session', true);
    existing.close('link_replaced');
  }
  sessions.set(session.linkId, session);
}

/** session 收到 hello 后由 routes 调用。 */
export function handleHello(
  session: AgentLinkSession,
  frame: HelloFrame,
  displayName: string,
): void {
  const meta: OnlineLinkInfo = {
    linkId: session.linkId,
    userId: session.userId,
    remoteIp: session.remoteIp,
    connectedAt: session.connectedAt,
    capabilities: frame.capabilities,
    os: frame.os,
    arch: frame.arch,
    hostname: frame.hostname,
    clientVersion: frame.version,
    resources: frame.resources,
  };
  sessionMeta.set(session.linkId, meta);

  try {
    recordAgentLinkConnect(session.linkId, {
      capabilities: frame.capabilities,
      agentClients: frame.agentClients,
      resources: frame.resources,
      os: frame.os,
      arch: frame.arch,
      hostname: frame.hostname,
      clientVersion: frame.version,
    });
  } catch (err) {
    logger.warn(
      { linkId: session.linkId, err: (err as Error).message },
      'agent-link recordConnect db update failed',
    );
  }

  session.send({
    type: 'hello_ack',
    id: frame.id,
    clientId: session.linkId,
    displayName,
    serverVersion,
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
  });
}

/** session 收到非 hello 帧时由 routes 调用。Phase 5.2 会在这里路由 run.* 帧。 */
export function handleFrame(
  session: AgentLinkSession,
  frame: InboundFrame,
): void {
  // Touch DB last_seen at most every 30s
  touchSeenThrottled(session.linkId);

  switch (frame.type) {
    case 'ping': {
      const meta = sessionMeta.get(session.linkId);
      if (meta) {
        meta.resources = frame.resources;
        sessionMeta.set(session.linkId, meta);
      }
      if (frame.resources) {
        try {
          recordAgentLinkResources(session.linkId, frame.resources);
        } catch (err) {
          logger.warn(
            { linkId: session.linkId, err: (err as Error).message },
            'agent-link recordResources db update failed',
          );
        }
      }
      return;
    }
    case 'error':
      logger.warn(
        {
          linkId: session.linkId,
          code: frame.code,
          message: frame.message,
          fatal: frame.fatal,
        },
        'agent-link error frame',
      );
      if (frame.fatal) session.close(`peer_fatal:${frame.code}`);
      return;
    case 'run.event':
      deliverEvent(frame);
      return;
    case 'run.result':
      deliverResult(frame);
      return;
    case 'tool.event':
      deliverToolEvent(frame);
      return;
    case 'tool.result':
      deliverToolResult(frame);
      return;
    case 'models.result':
      deliverModelResult(frame);
      return;
    case 'skills.result':
      deliverSkillsResult(frame);
      return;
    default:
      return; // hello already handled, ping handled in session
  }
}

const lastSeenWrite = new Map<string, number>();
function touchSeenThrottled(linkId: string): void {
  const now = Date.now();
  const last = lastSeenWrite.get(linkId) ?? 0;
  if (now - last < 30_000) return;
  lastSeenWrite.set(linkId, now);
  try {
    touchAgentLinkSeen(linkId);
  } catch {
    /* ignore */
  }
}

/** session.onClose 回调时调用。 */
export function unregisterSession(session: AgentLinkSession): void {
  // Only remove if it's still the registered one (might have been replaced)
  if (sessions.get(session.linkId) === session) {
    sessions.delete(session.linkId);
    sessionMeta.delete(session.linkId);
    lastSeenWrite.delete(session.linkId);
  }
  failRunsForLink(session.linkId, 'link_offline');
  failToolRequestsForLink(session.linkId, 'link_offline');
  failModelRequestsForLink(session.linkId, 'link_offline');
  failSkillsRequestsForLink(session.linkId, 'link_offline');
}

export function isOnline(linkId: string): boolean {
  const s = sessions.get(linkId);
  return s != null && s.state === 'open';
}

export function getSession(linkId: string): AgentLinkSession | undefined {
  return sessions.get(linkId);
}

export function getOnlineMeta(linkId: string): OnlineLinkInfo | undefined {
  return sessionMeta.get(linkId);
}

export function listOnlineByUser(userId: string): OnlineLinkInfo[] {
  const out: OnlineLinkInfo[] = [];
  for (const meta of sessionMeta.values()) {
    if (meta.userId === userId) out.push(meta);
  }
  return out;
}

export function closeAllSessions(reason: string): void {
  for (const s of sessions.values()) {
    s.sendError('server_shutdown', reason, true);
    s.close('server_shutdown');
  }
  sessions.clear();
  sessionMeta.clear();
  lastSeenWrite.clear();
}

/** Force-disconnect a single link (revoke / admin kick). */
export function disconnectLink(linkId: string, reason: string): boolean {
  const s = sessions.get(linkId);
  if (!s) return false;
  s.sendError('link_revoked', reason, true);
  s.close(reason);
  return true;
}
