/**
 * Single octodeck-daemon ws connection wrapper.
 *
 * 职责：
 *   - 帧编解码（透传给 protocol.ts）
 *   - 发送队列（背压时缓冲，超过 sendBacklogMax 主动 close）
 *   - hello 超时
 *   - 心跳超时
 *   - close hook（让 registry 反注册）
 *
 * 不做：
 *   - 重连（client 端的事）
 *   - 业务级 RPC 路由（registry / run-rpc 的事）
 */
import type { WebSocket } from 'ws';

import { logger } from '../logger.js';
import {
  AGENT_LINK_MAX_FRAME_BYTES,
  encodeFrame,
  HELLO_TIMEOUT_MS,
  HEARTBEAT_TIMEOUT_MS,
  parseInboundFrame,
  type ErrorFrame,
  type HelloFrame,
  type InboundFrame,
  type OutboundFrame,
} from './protocol.js';

export type SessionState = 'awaiting_hello' | 'open' | 'closing' | 'closed';

export interface SessionOptions {
  ws: WebSocket;
  remoteIp: string;
  /** ws 握手已经匹配到的 link id（bcrypt.compare 已通过）。 */
  linkId: string;
  userId: string;
  onHello: (
    session: AgentLinkSession,
    frame: HelloFrame,
  ) => void | Promise<void>;
  onFrame: (
    session: AgentLinkSession,
    frame: InboundFrame,
  ) => void | Promise<void>;
  onClose: (session: AgentLinkSession, reason: string) => void;
}

const SEND_BACKLOG_MAX = 256;

export class AgentLinkSession {
  state: SessionState = 'awaiting_hello';
  readonly linkId: string;
  readonly userId: string;
  readonly remoteIp: string;
  readonly connectedAt: number = Date.now();

  private readonly ws: WebSocket;
  private readonly onHello: SessionOptions['onHello'];
  private readonly onFrame: SessionOptions['onFrame'];
  private readonly onCloseCb: SessionOptions['onClose'];

  private helloTimer: NodeJS.Timeout | null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastSeen = Date.now();

  constructor(opts: SessionOptions) {
    this.ws = opts.ws;
    this.linkId = opts.linkId;
    this.userId = opts.userId;
    this.remoteIp = opts.remoteIp;
    this.onHello = opts.onHello;
    this.onFrame = opts.onFrame;
    this.onCloseCb = opts.onClose;

    this.helloTimer = setTimeout(() => {
      if (this.state === 'awaiting_hello') {
        this.sendError('hello_timeout', 'no hello frame within 5s', true);
        this.close('hello_timeout');
      }
    }, HELLO_TIMEOUT_MS);

    this.ws.on('message', (data) => this.handleMessage(data));
    this.ws.on('close', (code, buf) => {
      this.cleanup(`ws_close:${code}:${buf?.toString() || ''}`);
    });
    this.ws.on('error', (err) => {
      logger.warn(
        { linkId: this.linkId, err: err.message },
        'agent-link ws error',
      );
      this.cleanup(`ws_error:${err.message}`);
    });
  }

  private handleMessage(data: unknown): void {
    if (this.state === 'closed' || this.state === 'closing') return;
    const text =
      typeof data === 'string'
        ? data
        : Buffer.isBuffer(data)
          ? data.toString('utf8')
          : String(data);

    const byteLength = Buffer.byteLength(text, 'utf8');
    if (byteLength > AGENT_LINK_MAX_FRAME_BYTES) {
      logger.warn(
        {
          linkId: this.linkId,
          byteLength,
          maxBytes: AGENT_LINK_MAX_FRAME_BYTES,
        },
        'agent-link inbound frame too large',
      );
      this.sendError('protocol_violation', 'frame too large', true);
      this.close('frame_too_large');
      return;
    }

    const parsed = parseInboundFrame(text);
    if (!parsed.ok) {
      logger.warn(
        { linkId: this.linkId, err: parsed.error },
        'agent-link frame parse failed',
      );
      this.sendError('protocol_violation', parsed.error, true);
      this.close('parse_error');
      return;
    }

    this.lastSeen = Date.now();
    const frame = parsed.frame;

    if (this.state === 'awaiting_hello') {
      if (frame.type !== 'hello') {
        this.sendError('protocol_violation', 'expected hello frame', true);
        this.close('no_hello');
        return;
      }
      if (this.helloTimer) {
        clearTimeout(this.helloTimer);
        this.helloTimer = null;
      }
      this.state = 'open';
      this.startHeartbeatWatchdog();
      void this.onHello(this, frame);
      return;
    }

    // ping carries resource snapshots, so route it through the registry too.
    void this.onFrame(this, frame);
  }

  private startHeartbeatWatchdog(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      const idle = Date.now() - this.lastSeen;
      if (idle > HEARTBEAT_TIMEOUT_MS) {
        logger.warn(
          { linkId: this.linkId, idleMs: idle },
          'agent-link heartbeat timeout, closing',
        );
        this.sendError('heartbeat_timeout', 'no frames received', true);
        this.close('heartbeat_timeout');
      }
    }, 15_000);
  }

  send(frame: OutboundFrame): boolean {
    if (this.state === 'closed' || this.state === 'closing') return false;
    if (this.ws.bufferedAmount > SEND_BACKLOG_MAX * 1024) {
      logger.warn(
        { linkId: this.linkId, buffered: this.ws.bufferedAmount },
        'agent-link send backlog exceeded, closing',
      );
      this.close('backlog_exceeded');
      return false;
    }
    try {
      this.ws.send(encodeFrame(frame));
      return true;
    } catch (err) {
      logger.warn(
        { linkId: this.linkId, err: (err as Error).message },
        'agent-link send failed',
      );
      this.close('send_failed');
      return false;
    }
  }

  sendError(code: string, message: string, fatal = false): void {
    const frame: ErrorFrame = { type: 'error', code, message, fatal };
    this.send(frame);
  }

  close(reason: string): void {
    if (this.state === 'closed' || this.state === 'closing') return;
    this.state = 'closing';
    try {
      this.ws.close(1000, reason.slice(0, 120));
    } catch {
      try {
        this.ws.terminate();
      } catch {
        /* ignore */
      }
    }
    // give close handler a tick to fire; cleanup is idempotent
    setTimeout(() => this.cleanup(reason), 100);
  }

  private cleanup(reason: string): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    if (this.helloTimer) {
      clearTimeout(this.helloTimer);
      this.helloTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    try {
      this.onCloseCb(this, reason);
    } catch (err) {
      logger.error(
        { linkId: this.linkId, err: (err as Error).message },
        'agent-link onClose handler threw',
      );
    }
  }
}
