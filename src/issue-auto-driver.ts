import * as crypto from 'node:crypto';

import {
  createIssueAgentRun,
  createIssueAgentRunEvent,
  listAutoDrivableIssues,
  updateIssueLastRun,
} from './db.js';
import { runIssueAgent } from './issue-runner.js';
import { logger } from './logger.js';
import type { StreamEvent } from './stream-event.types.js';
import type { WebDeps } from './web-context.js';

const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_BATCH_SIZE = 10;

export class IssueAutoDriver {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(
    private readonly deps: Pick<WebDeps, 'queue'> & {
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
          created_by: issue.created_by,
          created_at: now,
        });
        updateIssueLastRun(issue.id, run.id, 'queued');
        createIssueAgentRunEvent({
          id: `irev_${crypto.randomBytes(8).toString('hex')}`,
          issue_id: issue.id,
          run_id: run.id,
          event_type: 'run_queued',
          title: 'Run queued by auto driver',
          summary: issue.title,
          detail: null,
          payload: { trigger: 'auto_driver', issueId: issue.id },
          created_at: now,
        });
        this.deps.queue.enqueueTask(issue.workspace_jid, `issue:${run.id}`, async () => {
          await runIssueAgent(issue.id, run.id, {
            queue: this.deps.queue,
            broadcastStreamEvent: this.deps.broadcastStreamEvent,
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
