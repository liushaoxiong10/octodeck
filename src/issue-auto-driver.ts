import * as crypto from 'node:crypto';

import {
  consumeIssueAgentRequest,
  createIssueAgentRun,
  createIssueAgentRunEvent,
  listAutoDrivableIssues,
  listIssueAgentRequests,
  listIssueAgentRuns,
  updateIssue,
  updateIssueLastRun,
} from './db.js';
import { runIssueAgent } from './issue-runner.js';
import { logger } from './logger.js';
import type { StreamEvent } from './stream-event.types.js';
import type { WebDeps } from './web-context.js';

const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_BATCH_SIZE = 10;

type RunTrigger =
  | 'auto_driver'
  | 'lost_resume'
  | 'permission_resume'
  | 'clarification_resume';

export class IssueAutoDriver {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(
    private readonly deps: Pick<WebDeps, 'queue' | 'broadcastIssueRequest'> & {
      broadcastStreamEvent?: (chatJid: string, event: StreamEvent) => void;
    },
    private readonly opts: { intervalMs?: number; batchSize?: number } = {},
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs ?? DEFAULT_INTERVAL_MS);
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
      const issues = listAutoDrivableIssues(this.opts.batchSize ?? DEFAULT_BATCH_SIZE);
      for (const issue of issues) {
        const now = new Date().toISOString();

        // P2-3: inherit context (session_id / parent_run_id) from the previous
        // run, so that lost_resume / permission_resume / clarification_resume
        // continue with the same conversation rather than restarting cold.
        const lastRun = listIssueAgentRuns(issue.id)[0] ?? null;
        let trigger: RunTrigger = 'auto_driver';
        let inheritedSessionId: string | null = null;
        let parentRunId: string | null = null;
        let consumeRequestId: string | null = null;

        if (lastRun) {
          inheritedSessionId = lastRun.session_id ?? null;
          parentRunId = lastRun.id;
          if (lastRun.status === 'lost') {
            trigger = 'lost_resume';
          } else if (lastRun.status === 'awaiting_input') {
            const answered = listIssueAgentRequests(issue.id, {
              status: 'answered',
              runId: lastRun.id,
            }).find((r) => !r.consumed_at);
            if (answered) {
              trigger =
                answered.kind === 'permission' ? 'permission_resume' : 'clarification_resume';
              consumeRequestId = answered.id;
            }
          }
        }

        const run = createIssueAgentRun({
          id: `irun_${crypto.randomBytes(8).toString('hex')}`,
          issue_id: issue.id,
          workspace_jid: issue.workspace_jid,
          workspace_folder: issue.workspace_folder,
          agent_link_id: issue.agent_link_id ?? null,
          agent_client_id: issue.agent_client_id ?? null,
          execution_node: issue.execution_node ?? null,
          backend: issue.backend ?? null,
          selected_skills: issue.selected_skills ?? null,
          status: 'queued',
          session_id: inheritedSessionId,
          parent_run_id: parentRunId,
          created_by: issue.created_by,
          created_at: now,
        });
        updateIssueLastRun(issue.id, run.id, 'queued');
        if (consumeRequestId) consumeIssueAgentRequest(consumeRequestId, now);
        if (issue.status === 'waiting_for_human') {
          updateIssue(issue.id, { status: 'in_progress' });
        }
        createIssueAgentRunEvent({
          id: `irev_${crypto.randomBytes(8).toString('hex')}`,
          issue_id: issue.id,
          run_id: run.id,
          event_type: 'run_queued',
          title: `Run queued (${trigger})`,
          summary: issue.title,
          detail: null,
          payload: {
            trigger,
            issueId: issue.id,
            parentRunId,
            inheritedSessionId,
          },
          created_at: now,
        });
        this.deps.queue.enqueueTask(issue.workspace_jid, `issue:${run.id}`, async () => {
          await runIssueAgent(issue.id, run.id, {
            queue: this.deps.queue,
            broadcastStreamEvent: this.deps.broadcastStreamEvent,
            broadcastIssueRequest: this.deps.broadcastIssueRequest,
          });
        });
      }
      if (issues.length > 0) {
        logger.info({ count: issues.length }, 'Issue auto driver queued runs');
      }
    } catch (err) {
      logger.error({ err }, 'Issue auto driver tick failed');
    } finally {
      this.ticking = false;
    }
  }
}
