import crypto from 'crypto';

import { logger } from '../logger.js';
import type { AgentLinkSession } from './session.js';
import type { ModelInfo, ModelsResultFrame } from './protocol.js';

export interface ModelDiscoveryOptions {
  linkId: string;
  providerId: string;
  timeoutMs: number;
}

export interface ModelDiscoveryResult {
  ok: boolean;
  models: ModelInfo[];
  error: string | null;
  durationMs: number;
}

interface PendingModelRequest {
  linkId: string;
  requestId: string;
  resolve: (result: ModelDiscoveryResult) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, PendingModelRequest>();

export function requestProviderModels(
  session: AgentLinkSession,
  opts: ModelDiscoveryOptions,
): Promise<ModelDiscoveryResult> {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error('models_timeout'));
    }, opts.timeoutMs);

    pending.set(requestId, {
      linkId: opts.linkId,
      requestId,
      resolve,
      reject,
      timer,
    });

    const ok = session.send({
      type: 'models.request',
      id: 0,
      requestId,
      providerId: opts.providerId,
    });
    if (!ok) {
      clearTimeout(timer);
      pending.delete(requestId);
      reject(new Error('send_failed'));
    }
  });
}

export function deliverModelResult(frame: ModelsResultFrame): void {
  const req = pending.get(frame.requestId);
  if (!req) {
    logger.debug(
      { requestId: frame.requestId },
      'model-rpc: drop result for unknown request',
    );
    return;
  }
  pending.delete(frame.requestId);
  clearTimeout(req.timer);
  req.resolve({
    ok: frame.ok,
    models: frame.models,
    error: frame.error,
    durationMs: frame.durationMs,
  });
}

export function failModelRequestsForLink(linkId: string, reason: string): void {
  for (const [requestId, req] of pending) {
    if (req.linkId !== linkId) continue;
    pending.delete(requestId);
    clearTimeout(req.timer);
    req.reject(new Error(reason));
  }
}
