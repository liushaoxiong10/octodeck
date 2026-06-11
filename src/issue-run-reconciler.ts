import {
  createIssueEvent,
  expireIssueAgentRequests,
  findStaleRunningRuns,
  getIssueAgentRunById,
  getIssueById,
  markIssueAgentRunLost,
  updateIssue,
  updateIssueAgentRun,
  updateIssueLastRun,
} from './db.js';
import { afterIssueEventCreated } from './issue-notifier.js';
import { logger } from './logger.js';
import type { WebDeps } from './web-context.js';

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_STALE_MS = 90_000;

/**
 * Periodic reconciler for `issue_agent_runs`:
 *   1. Marks runs whose heartbeat (last_seen_at) has been silent past
 *      `staleMs` as `lost`, and rolls back the issue to `todo` so the
 *      `IssueAutoDriver` will resume them with the inherited session_id.
 *   2. Expires `issue_agent_requests` past their `expires_at`. The owning run
 *      is failed and the parent issue is rolled back to `todo`.
 */
export class IssueRunReconciler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(
    private readonly deps: Pick<WebDeps, 'broadcastIssueRequest'>,
    private readonly opts: { intervalMs?: number; staleMs?: number } = {},
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(
      () => void this.tick(),
      this.opts.intervalMs ?? DEFAULT_INTERVAL_MS,
    );
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = new Date().toISOString();
      const staleMs = this.opts.staleMs ?? DEFAULT_STALE_MS;

      // 1) Reap stale running runs.
      const stale = findStaleRunningRuns(now, staleMs);
      for (const run of stale) {
        try {
          markIssueAgentRunLost(run.id, 'heartbeat_timeout');
          updateIssueLastRun(run.issue_id, run.id, 'lost');
          const issue = getIssueById(run.issue_id);
          if (issue?.status === 'in_progress' || issue?.status === 'waiting_for_human') {
            updateIssue(run.issue_id, { status: 'todo' });
          }
          const ev = createIssueEvent({
            issue_id: run.issue_id,
            run_id: run.id,
            event_type: 'run_lost',
            actor_type: 'system',
            title: 'Agent run lost',
            summary: 'Heartbeat timeout — daemon stopped reporting',
            payload: {
              runId: run.id,
              lastSeenAt: run.last_seen_at,
              staleMs,
            },
          });
          if (issue) afterIssueEventCreated(ev, issue);
          logger.warn(
            { runId: run.id, issueId: run.issue_id, lastSeenAt: run.last_seen_at },
            'Issue agent run marked lost',
          );
        } catch (err) {
          logger.error({ err, runId: run.id }, 'Failed to mark issue run as lost');
        }
      }

      // 2) Expire pending agent requests past their TTL.
      const expired = expireIssueAgentRequests(now);
      for (const req of expired) {
        try {
          const run = getIssueAgentRunById(req.run_id);
          if (run && (run.status === 'awaiting_input' || run.status === 'paused')) {
            updateIssueAgentRun(req.run_id, {
              status: 'error',
              error: 'awaiting_input timeout',
              awaiting_kind: null,
              awaiting_payload_id: null,
              run_completed_at: now,
            });
            updateIssueLastRun(req.issue_id, req.run_id, 'error');
          }
          const issue = getIssueById(req.issue_id);
          if (issue?.status === 'waiting_for_human') {
            updateIssue(req.issue_id, { status: 'todo' });
          }
          const ev = createIssueEvent({
            issue_id: req.issue_id,
            run_id: req.run_id,
            event_type: 'agent_request_expired',
            actor_type: 'system',
            title: 'Agent request expired',
            summary: req.kind === 'permission' ? 'Permission request timed out' : 'Clarification request timed out',
            payload: { requestId: req.id, kind: req.kind },
          });
          if (issue) {
            afterIssueEventCreated(ev, issue);
            this.deps.broadcastIssueRequest?.(
              issue.workspace_jid,
              issue.id,
              { ...req, status: 'expired' },
              'issue_request_expired',
            );
          }
          logger.warn(
            { requestId: req.id, runId: req.run_id, kind: req.kind },
            'Issue agent request expired',
          );
        } catch (err) {
          logger.error({ err, requestId: req.id }, 'Failed to expire issue agent request');
        }
      }

      if (stale.length > 0 || expired.length > 0) {
        logger.info(
          { stale: stale.length, expired: expired.length },
          'Issue run reconciler reaped state',
        );
      }
    } catch (err) {
      logger.error({ err }, 'Issue run reconciler tick failed');
    } finally {
      this.ticking = false;
    }
  }
}
