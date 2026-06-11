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
  touchIssueAgentRunHeartbeat,
} from '../db.js';
import {
  HEARTBEAT_INTERVAL_MS,
  type HelloFrame,
  type InboundFrame,
} from './protocol.js';
import { syncClientAgentMemory } from '../memory-store.js';
import {
  deliverEvent,
  deliverAgentRunEvent,
  deliverAgentRunResult,
  deliverAgentRunStatus,
  deliverResult,
  deliverStatus,
  failRunsForLink,
} from './run-rpc.js';
import {
  deliverToolEvent,
  deliverToolResult,
  failToolRequestsForLink,
} from './tool-rpc.js';
import { deliverModelResult, failModelRequestsForLink } from './model-rpc.js';
import {
  deliverSkillsResult,
  failSkillsRequestsForLink,
} from './skills-rpc.js';
import {
  deliverAgentDiscoverResult,
  deliverAgentSessionDeleteResult,
  deliverAgentSessionsResult,
  failAgentRuntimeRequestsForLink,
} from './agent-runtime-rpc.js';
import { AgentLinkSession } from './session.js';

export const LATEST_DAEMON_VERSION = 'octodeck-daemon/1.0.23';

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
  agentRuntimeCapabilities?: HelloFrame['agentRuntimeCapabilities'];
  status?: 'idle' | 'busy' | 'draining' | 'offline';
  runningRuns?: NonNullable<import('./protocol.js').PingFrame['runningRuns']>;
  maxConcurrentRuns?: number;
  availableSlots?: number;
  runtimes?: NonNullable<import('./protocol.js').PingFrame['runtimes']>;
}

const sessions = new Map<string, AgentLinkSession>();
const sessionMeta = new Map<string, OnlineLinkInfo>();

function normalizeDaemonVersion(version: string | null | undefined): string {
  return (version ?? '')
    .trim()
    .replace(/^octodeck-daemon\//, '')
    .replace(/^v/, '');
}

function parseDaemonVersion(version: string): number[] | null {
  const base = version.split('-', 1)[0] ?? '';
  if (!base) return null;
  const parts = base.split('.');
  if (parts.length < 1 || parts.length > 3) return null;
  const nums = parts.map((part) => Number.parseInt(part, 10));
  if (nums.some((n, index) => !Number.isFinite(n) || String(n) !== parts[index])) {
    return null;
  }
  while (nums.length < 3) nums.push(0);
  return nums;
}

function isDaemonVersionNewer(latest: string, current: string | null | undefined): boolean {
  const latestNorm = normalizeDaemonVersion(latest);
  const currentNorm = normalizeDaemonVersion(current);
  if (!latestNorm || !currentNorm || latestNorm === currentNorm) return false;
  const latestParts = parseDaemonVersion(latestNorm);
  const currentParts = parseDaemonVersion(currentNorm);
  if (latestParts && currentParts) {
    for (let i = 0; i < latestParts.length; i++) {
      if (latestParts[i] !== currentParts[i]) {
        return latestParts[i] > currentParts[i];
      }
    }
    return false;
  }
  return latestNorm !== currentNorm;
}

function notifyDaemonUpdateIfNeeded(session: AgentLinkSession, currentVersion: string): void {
  if (!isDaemonVersionNewer(LATEST_DAEMON_VERSION, currentVersion)) return;
  const sent = session.send({
    type: 'daemon.update.request',
    id: Date.now(),
    latestVersion: LATEST_DAEMON_VERSION,
    currentVersion,
    reason: 'client_version_outdated',
  });
  if (sent) {
    logger.info(
      { linkId: session.linkId, currentVersion, latestVersion: LATEST_DAEMON_VERSION },
      'agent-link daemon update request sent',
    );
  }
}

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
    agentRuntimeCapabilities: frame.agentRuntimeCapabilities,
    status: 'idle',
    runningRuns: [],
    maxConcurrentRuns: undefined,
    availableSlots: undefined,
    runtimes: buildRuntimeStatuses(
      session.linkId,
      frame.agentClients ?? [],
      frame.agentRuntimeCapabilities ?? [],
      [],
      undefined,
      undefined,
    ),
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
  notifyDaemonUpdateIfNeeded(session, frame.version);
}

/** session 收到非 hello 帧时由 routes 调用。Phase 5.2 会在这里路由 run.* 帧。 */
export function handleFrame(
  session: AgentLinkSession,
  frame: InboundFrame,
): void {
  // Touch DB last_seen at most every 30s
  touchSeenThrottled(session.linkId);

  switch (frame.type) {
    case 'agent.run.status':
    case 'agent.run.event':
    case 'agent.run.result':
    case 'run.status':
    case 'run.event':
    case 'run.result': {
      // P0-7: any frame carrying a runId implicitly proves the run is alive.
      const runId = (frame as { runId?: string }).runId;
      if (runId) {
        try {
          touchIssueAgentRunHeartbeat(runId);
        } catch {
          /* ignore: the run may not be an issue run */
        }
      }
      // fall through to specific handlers below
      break;
    }
    default:
      break;
  }

  switch (frame.type) {
    case 'ping': {
      const meta = sessionMeta.get(session.linkId);
      if (meta) {
        meta.resources = frame.resources;
        meta.status = frame.status ?? meta.status;
        meta.runningRuns = frame.runningRuns ?? meta.runningRuns ?? [];
        meta.maxConcurrentRuns = frame.maxConcurrentRuns;
        meta.availableSlots = frame.availableSlots;
        if (frame.runtimes) {
          meta.runtimes = frame.runtimes;
        } else if (frame.runningRuns && meta.runtimes) {
          // Daemon 未上报按 runtime 拆分的状态，则按 backendId 重新派生，
          // 避免单一 run 把所有 runtime 都标成 busy。
          meta.runtimes = meta.runtimes.map((rt) => {
            const rtRuns = meta.runningRuns!.filter(
              (run) => (run.backendId ?? '') === rt.agentClientId,
            );
            return {
              ...rt,
              status: rt.status === 'offline' ? 'offline' : rtRuns.length > 0 ? 'busy' : 'idle',
              runningRuns: rtRuns,
            };
          });
        }
        sessionMeta.set(session.linkId, meta);
      }
      // P0-7: every active run reported by daemon implicitly proves liveness;
      // refresh issue_agent_runs.last_seen_at so the reconciler does not reap
      // long-running tools that are silent on the stream channel.
      if (frame.runningRuns && frame.runningRuns.length) {
        for (const r of frame.runningRuns) {
          try {
            touchIssueAgentRunHeartbeat(r.runId);
          } catch {
            /* ignore: the run may not be an issue run */
          }
        }
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
    case 'run.status':
      deliverStatus(frame);
      return;
    case 'run.event':
      deliverEvent(frame);
      return;
    case 'run.result':
      deliverResult(frame);
      return;
    case 'agent.run.status':
      deliverAgentRunStatus(frame);
      return;
    case 'agent.run.event':
      deliverAgentRunEvent(frame);
      return;
    case 'agent.run.result':
      deliverAgentRunResult(frame);
      return;
    case 'tool.event':
      deliverToolEvent(frame);
      return;
    case 'tool.result':
      deliverToolResult(frame);
      return;
    case 'memory.sync':
      try {
        syncClientAgentMemory({
          userId: session.userId,
          deviceLinkId: frame.deviceLinkId || session.linkId,
          agentId: frame.agentId,
          path: frame.path,
          content: frame.content,
          source: 'client_sync',
          updatedBy: frame.deviceLinkId || session.linkId,
        });
      } catch (err) {
        logger.warn(
          {
            linkId: session.linkId,
            agentId: frame.agentId,
            path: frame.path,
            err: (err as Error).message,
          },
          'agent-link memory sync failed',
        );
      }
      return;
    case 'models.result':
      deliverModelResult(frame);
      return;
    case 'skills.result':
      deliverSkillsResult(frame);
      return;
    case 'agent.discover.result':
      if (frame.ok) {
        const meta = sessionMeta.get(session.linkId);
        if (meta) {
          meta.runtimes = buildRuntimeStatuses(
            session.linkId,
            frame.agents,
            frame.runtimeCapabilities ?? meta.agentRuntimeCapabilities ?? [],
            meta.runningRuns ?? [],
            meta.maxConcurrentRuns,
            meta.availableSlots,
          );
          meta.agentRuntimeCapabilities =
            frame.runtimeCapabilities ?? meta.agentRuntimeCapabilities;
          sessionMeta.set(session.linkId, meta);
          try {
            recordAgentLinkConnect(session.linkId, {
              capabilities: meta.capabilities,
              agentClients: frame.agents,
              resources: meta.resources,
              os: meta.os,
              arch: meta.arch,
              hostname: meta.hostname,
              clientVersion: meta.clientVersion,
            });
          } catch (err) {
            logger.warn(
              { linkId: session.linkId, err: (err as Error).message },
              'agent-link discover db update failed',
            );
          }
        }
      }
      deliverAgentDiscoverResult(frame);
      return;
    case 'agent.sessions.result':
      deliverAgentSessionsResult(frame);
      return;
    case 'agent.session.delete.result':
      deliverAgentSessionDeleteResult(frame);
      return;
    case 'agent.runtime.status': {
      const meta = sessionMeta.get(session.linkId);
      if (meta) {
        meta.status = frame.status === 'offline' ? 'draining' : meta.status;
        sessionMeta.set(session.linkId, meta);
      }
      logger.info(
        {
          linkId: session.linkId,
          runtimeId: frame.runtimeId,
          status: frame.status,
          crashCount: frame.crashCount,
          message: frame.message,
        },
        'agent runtime status',
      );
      return;
    }
    default:
      return; // hello already handled, ping handled in session
  }
}

function buildRuntimeStatuses(
  linkId: string,
  agentClients: NonNullable<HelloFrame['agentClients']>,
  runtimeCapabilities: NonNullable<HelloFrame['agentRuntimeCapabilities']>,
  runningRuns: NonNullable<import('./protocol.js').PingFrame['runningRuns']>,
  maxConcurrentRuns?: number,
  availableSlots?: number,
): NonNullable<import('./protocol.js').PingFrame['runtimes']> {
  const runsByClient = new Map<string, typeof runningRuns>();
  for (const run of runningRuns) {
    const key = run.backendId ?? '';
    const list = runsByClient.get(key);
    if (list) list.push(run);
    else runsByClient.set(key, [run]);
  }
  return agentClients.map((client) => {
    const clientRuns = runsByClient.get(client.id) ?? [];
    const cap = runtimeCapabilities.find((c) => c.agentId === client.id);
    return {
      runtimeId: `${linkId}:${client.id}`,
      deviceLinkId: linkId,
      agentClientId: client.id,
      displayName: client.displayName,
      provider: client.provider,
      transport: client.transport,
      status: clientRuns.length > 0 ? 'busy' : 'idle',
      runningRuns: clientRuns,
      maxConcurrentRuns: cap?.maxConcurrentRuns ?? maxConcurrentRuns,
      availableSlots: cap?.availableSlots ?? availableSlots,
    };
  });
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

    failRunsForLink(session.linkId, 'link_offline');
    failToolRequestsForLink(session.linkId, 'link_offline');
    failModelRequestsForLink(session.linkId, 'link_offline');
    failSkillsRequestsForLink(session.linkId, 'link_offline');
    failAgentRuntimeRequestsForLink(session.linkId, 'link_offline');
  }
}

export function isOnline(linkId: string): boolean {
  const s = sessions.get(linkId);
  return s != null && s.state === 'open';
}

export function getSession(linkId: string): AgentLinkSession | undefined {
  return sessions.get(linkId);
}

export function requestWorkspaceCleanup(opts: {
  linkId: string;
  workspace: string;
  scope?: 'workspace' | 'session' | 'direct_session' | 'task';
  sessionId?: string;
  taskId?: string;
  taskRunId?: string;
}): boolean {
  const session = sessions.get(opts.linkId);
  if (!session || session.state !== 'open') return false;
  return session.send({
    type: 'workspace.cleanup.request',
    id: 0,
    workspace: opts.workspace,
    scope: opts.scope,
    sessionId: opts.sessionId,
    taskId: opts.taskId,
    taskRunId: opts.taskRunId,
  });
}

export function getOnlineMeta(linkId: string): OnlineLinkInfo | undefined {
  return sessionMeta.get(linkId);
}

export function listOnlineRuntimesByProvider(
  agentClientId: string,
  userId?: string,
): NonNullable<import('./protocol.js').PingFrame['runtimes']> {
  const out: NonNullable<import('./protocol.js').PingFrame['runtimes']> = [];
  for (const meta of sessionMeta.values()) {
    if (userId && meta.userId !== userId) continue;
    const runtimes = meta.runtimes ?? [];
    for (const runtime of runtimes) {
      if (
        runtime.agentClientId === agentClientId &&
        runtime.status !== 'offline'
      ) {
        out.push(runtime);
      }
    }
  }
  return out.sort(
    (a, b) => (a.runningRuns?.length ?? 0) - (b.runningRuns?.length ?? 0),
  );
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
