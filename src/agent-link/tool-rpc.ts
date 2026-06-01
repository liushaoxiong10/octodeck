import crypto from 'crypto';

import { logger } from '../logger.js';
import type { AgentLinkSession } from './session.js';
import type { ToolEventFrame, ToolResultFrame } from './protocol.js';

export interface RemoteToolInvokeOptions {
  linkId: string;
  toolName: string;
  input: unknown;
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  onEvent?: (frame: ToolEventFrame) => void;
}

export interface RemoteToolResult {
  ok: boolean;
  result: unknown | null;
  error: string | null;
  durationMs: number;
}

interface PendingToolRequest {
  linkId: string;
  requestId: string;
  resolve: (result: RemoteToolResult) => void;
  reject: (err: Error) => void;
  onEvent?: (frame: ToolEventFrame) => void;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, PendingToolRequest>();

export function invokeRemoteTool(
  session: AgentLinkSession,
  opts: RemoteToolInvokeOptions,
): Promise<RemoteToolResult> {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      try {
        session.send({ type: 'tool.cancel', requestId, reason: 'timeout' });
      } catch {
        /* ignore */
      }
      reject(new Error('tool_timeout'));
    }, opts.timeoutMs);

    pending.set(requestId, {
      linkId: opts.linkId,
      requestId,
      resolve,
      reject,
      onEvent: opts.onEvent,
      timer,
    });

    const ok = session.send({
      type: 'tool.request',
      id: 0,
      requestId,
      toolName: opts.toolName,
      input: opts.input,
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs,
      maxOutputBytes: opts.maxOutputBytes,
    });
    if (!ok) {
      clearTimeout(timer);
      pending.delete(requestId);
      reject(new Error('send_failed'));
    }
  });
}

export function deliverToolEvent(frame: ToolEventFrame): void {
  const req = pending.get(frame.requestId);
  if (!req) {
    logger.debug({ requestId: frame.requestId }, 'tool-rpc: drop event for unknown request');
    return;
  }
  try {
    req.onEvent?.(frame);
  } catch (err) {
    logger.warn({ requestId: frame.requestId, err }, 'tool-rpc event handler failed');
  }
}

export function deliverToolResult(frame: ToolResultFrame): void {
  const req = pending.get(frame.requestId);
  if (!req) {
    logger.debug({ requestId: frame.requestId }, 'tool-rpc: drop result for unknown request');
    return;
  }
  pending.delete(frame.requestId);
  clearTimeout(req.timer);
  req.resolve({
    ok: frame.ok,
    result: frame.result,
    error: frame.error,
    durationMs: frame.durationMs,
  });
}

export function failToolRequestsForLink(linkId: string, reason: string): void {
  for (const [requestId, req] of pending) {
    if (req.linkId !== linkId) continue;
    pending.delete(requestId);
    clearTimeout(req.timer);
    req.reject(new Error(reason));
  }
}
