import crypto from 'crypto';

import { logger } from '../logger.js';
import type { AgentLinkSession } from './session.js';
import type { SkillInfo, SkillsResultFrame } from './protocol.js';

export interface SkillsDiscoveryOptions {
  linkId: string;
  providerId: string;
  cwd?: string;
  timeoutMs: number;
}

export interface SkillsDiscoveryResult {
  ok: boolean;
  workspaceSkills: SkillInfo[];
  cliSkills: SkillInfo[];
  error: string | null;
  durationMs: number;
}

interface PendingSkillsRequest {
  linkId: string;
  requestId: string;
  resolve: (result: SkillsDiscoveryResult) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, PendingSkillsRequest>();

export function requestProviderSkills(
  session: AgentLinkSession,
  opts: SkillsDiscoveryOptions,
): Promise<SkillsDiscoveryResult> {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error('skills_timeout'));
    }, opts.timeoutMs);

    pending.set(requestId, {
      linkId: opts.linkId,
      requestId,
      resolve,
      reject,
      timer,
    });

    const ok = session.send({
      type: 'skills.request',
      id: 0,
      requestId,
      providerId: opts.providerId,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    });
    if (!ok) {
      clearTimeout(timer);
      pending.delete(requestId);
      reject(new Error('send_failed'));
    }
  });
}

export function deliverSkillsResult(frame: SkillsResultFrame): void {
  const req = pending.get(frame.requestId);
  if (!req) {
    logger.debug(
      { requestId: frame.requestId },
      'skills-rpc: drop result for unknown request',
    );
    return;
  }
  pending.delete(frame.requestId);
  clearTimeout(req.timer);
  req.resolve({
    ok: frame.ok,
    workspaceSkills: frame.workspaceSkills,
    cliSkills: frame.cliSkills,
    error: frame.error,
    durationMs: frame.durationMs,
  });
}

export function failSkillsRequestsForLink(
  linkId: string,
  reason: string,
): void {
  for (const [requestId, req] of pending) {
    if (req.linkId !== linkId) continue;
    pending.delete(requestId);
    clearTimeout(req.timer);
    req.reject(new Error(reason));
  }
}
