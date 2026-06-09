/**
 * Issue event notification dispatcher.
 *
 * Call `afterIssueEventCreated()` right after every `createIssueEvent()` at
 * every mutation site. This module:
 *   1. Broadcasts the event to connected Web clients (real-time timeline update)
 *   2. Dispatches external IM notifications for important event types (deduped)
 */

import {
  getIssueById,
  getRegisteredGroup,
  isIssueEventNotified,
  markIssueEventNotified,
} from './db.js';
import { getWebDeps } from './web-context.js';
import { imManager } from './im-manager.js';
import { logger } from './logger.js';
import type { IssueEvent, WorkspaceIssue } from './types.js';

// --- Notification rules ------------------------------------------------------
// Event types that trigger external IM notifications.
// Timeline events (stream:*, run_delta, etc.) are intentionally skipped to avoid spam.
const NOTIFY_EVENT_TYPES: ReadonlySet<IssueEvent['event_type']> = new Set([
  // Status transitions
  'status_changed',     // → notify only if to=done|canceled|in_progress|review (NOT all)
  'priority_changed',   // → only if to=urgent
  // Comments (user only; system/agent comments don't re-notify)
  'comment_created',
  // Agent run results
  'run_created',        // enqueued (spammy by default — skip unless detail.notify=true)
  'run_failed',         // error
  'run_succeeded',      // success with result
  'run_canceled',
]);

// Which status transitions should actually notify (filtering status_changed noise)
const NOTIFY_STATUS_TO: ReadonlySet<string> = new Set([
  'in_progress', 'review', 'done', 'canceled',
]);
// Priority transitions → only urgent triggers notification
const NOTIFY_PRIORITY_TO: ReadonlySet<string> = new Set(['urgent']);

function shouldNotify(event: IssueEvent): boolean {
  if (!NOTIFY_EVENT_TYPES.has(event.event_type)) return false;

  if (event.event_type === 'status_changed') {
    const to = typeof event.detail?.to === 'string' ? event.detail.to : null;
    if (!to || !NOTIFY_STATUS_TO.has(to)) return false;
  }

  if (event.event_type === 'priority_changed') {
    const to = typeof event.detail?.to === 'string' ? event.detail.to : null;
    if (!to || !NOTIFY_PRIORITY_TO.has(to)) return false;
  }

  if (event.event_type === 'comment_created') {
    // Only notify for user-originated comments; agent/system comments auto-created in-context
    if (event.actor_type !== 'user') return false;
  }

  if (event.event_type === 'run_created') {
    // Too spammy for default; skip unless explicitly requested via payload.flag
    if (!(event.detail && (event.detail as any).notify === true)) return false;
  }

  return true;
}

// --- Notification targets ---------------------------------------------------
// Collect user_ids who should be notified about this event for the given issue:
//   - issue.created_by (original reporter)
//   - issue.assignee_user_id (person assigned)
//   - workspace registered_group.created_by (workspace owner), if different
function collectTargetUserIds(issue: WorkspaceIssue, event: IssueEvent): string[] {
  const ids = new Set<string>();
  if (issue.created_by) ids.add(issue.created_by);
  if (issue.assignee_user_id) ids.add(issue.assignee_user_id);
  const group = getRegisteredGroup(issue.workspace_jid);
  if (group?.created_by) ids.add(group.created_by);

  // Don't notify the actor about their own action (e.g. person who posted a comment)
  if (event.actor_id && event.actor_type === 'user') {
    ids.delete(event.actor_id);
  }
  return Array.from(ids);
}

// --- Notification formatting ------------------------------------------------
function buildNotificationMessage(
  event: IssueEvent,
  issue: WorkspaceIssue,
  hostBaseUrl?: string,
): { title: string; body: string; deepLink: string } {
  const shortId = issue.id.startsWith('iss_') ? `#${issue.id.slice(4)}` : issue.id;
  const deepLink = hostBaseUrl
    ? `${hostBaseUrl.replace(/\/$/, '')}/issues/detail/${encodeURIComponent(issue.id)}`
    : `/issues/detail/${encodeURIComponent(issue.id)}`;
  const title = `[Issue ${shortId}] ${issue.title}`;

  let body = '';
  switch (event.event_type) {
    case 'status_changed': {
      const from = typeof event.detail?.from === 'string' ? event.detail.from : '?';
      const to = typeof event.detail?.to === 'string' ? event.detail.to : '?';
      const cause = typeof event.detail?.cause === 'string' ? ` (${event.detail.cause})` : '';
      body = `状态变更：${from} → ${to}${cause}`;
      if (event.actor_id) body += ` · by ${event.actor_id}`;
      break;
    }
    case 'priority_changed': {
      const from = typeof event.detail?.from === 'string' ? event.detail.from : '?';
      const to = typeof event.detail?.to === 'string' ? event.detail.to : '?';
      body = `优先级变更：${from} → ${to}`;
      if (event.actor_id) body += ` · by ${event.actor_id}`;
      break;
    }
    case 'comment_created': {
      const actor = event.actor_id ?? 'unknown';
      const summary = event.summary ?? '(new comment)';
      body = `@${actor} 评论：${summary.length > 200 ? summary.slice(0, 200) + '…' : summary}`;
      break;
    }
    case 'run_succeeded': {
      const summary = event.summary ?? 'Agent run completed';
      body = `Agent 运行成功：${summary.length > 240 ? summary.slice(0, 240) + '…' : summary}`;
      break;
    }
    case 'run_failed': {
      const summary = event.summary ?? 'Agent run failed';
      body = `Agent 运行失败：${summary.length > 240 ? summary.slice(0, 240) + '…' : summary}`;
      break;
    }
    case 'run_canceled': {
      body = 'Agent 运行已被取消';
      break;
    }
    default:
      body = event.summary ?? event.title ?? 'updated';
  }

  return { title, body, deepLink };
}

// --- WebSocket broadcast ----------------------------------------------------
function broadcastIssueEvent(event: IssueEvent, issue: WorkspaceIssue): void {
  const deps = getWebDeps();
  if (!deps?.broadcastIssueEvent) return;
  try {
    deps.broadcastIssueEvent(
      issue.workspace_jid,
      issue.id,
      event,
      event.run_id ?? null,
    );
  } catch (err) {
    logger.warn({ err, eventId: event.id }, 'Failed to broadcast issue_event via WS');
  }
}

// --- IM notification --------------------------------------------------------
// Resolves each target user_id → their home workspace jid → IM channels.
// Sends via imManager.notifyUser, deduped by (event.id, target).
async function sendIMNotifications(
  event: IssueEvent,
  issue: WorkspaceIssue,
  userIds: string[],
): Promise<void> {
  if (userIds.length === 0) return;
  const hostBase = process.env.APP_BASE_URL || process.env.WEB_BASE_URL;
  const { title, body, deepLink } = buildNotificationMessage(event, issue, hostBase);

  for (const userId of userIds) {
    if (isIssueEventNotified(event.id, 'web', userId)) continue;
    try {
      await imManager.notifyUser(userId, {
        title,
        body,
        link: deepLink,
        source: 'issue',
        referenceId: issue.id,
      });
      // Mark notified on the web channel key to prevent re-fire across restarts.
      markIssueEventNotified(event.id, 'web', userId);
    } catch (err) {
      logger.warn({ err, userId, eventId: event.id }, 'Failed to send issue IM notification');
    }
  }
}

// --- Main entry point -------------------------------------------------------
/**
 * Call this right after `createIssueEvent()` at every mutation site.
 * Safe to call multiple times (dedup for IM; WS broadcast is lightweight).
 *
 * Returns `true` if external IM notifications were dispatched.
 */
export async function afterIssueEventCreated(
  event: IssueEvent,
  issueOverride?: WorkspaceIssue,
): Promise<boolean> {
  const issue = issueOverride ?? getIssueById(event.issue_id);
  if (!issue) return false;

  // 1. Always broadcast timeline update to Web (real-time)
  broadcastIssueEvent(event, issue);

  // 2. External notifications (IM + dedup + filter rules)
  if (!shouldNotify(event)) return false;

  const targets = collectTargetUserIds(issue, event);
  if (targets.length === 0) return false;

  try {
    await sendIMNotifications(event, issue, targets);
    return true;
  } catch (err) {
    logger.error({ err, eventId: event.id }, 'Issue notification dispatch failed');
    return false;
  }
}
