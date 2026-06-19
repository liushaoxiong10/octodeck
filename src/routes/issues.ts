import { Hono, type Context } from 'hono';
import * as crypto from 'node:crypto';

import { IssueAttachmentCreateSchema, IssueCommentCreateSchema, IssueCommentUpdateSchema, IssueCreateSchema, IssuePatchSchema, IssueRunSchema } from '../schemas.js';
import { authMiddleware } from '../middleware/auth.js';
import type { AuthUser, IssueAgentRun, IssueAgentRunEvent, IssueEventType, IssuePriority, IssueStatus, WorkspaceIssue } from '../types.js';
import type { Variables } from '../web-context.js';
import {
  canAccessGroup,
  getWebDeps,
  hasHostExecutionPermission,
  isHostExecutionGroup,
} from '../web-context.js';
import {
  answerIssueAgentRequest,
  clearIssueAgentRunAwaiting,
  createIssue,
  createIssueAttachment,
  createIssueAgentRequest,
  createIssueAgentRun,
  createIssueAgentRunEvent,
  createIssueComment,
  createIssueEvent,
  deleteIssueAttachment,
  deleteIssue,
  getAgentLinkById,
  getAgentTaskScopedTokenById,
  getAgentTaskById,
  getIssueAgentRequestById,
  getIssueAttachmentById,
  getIssueById,
  getIssueCommentById,
  getAllRegisteredGroups,
  getManagedRepoById,
  listAgentLinksByUser,
  getRegisteredGroup,
  getUserHomeGroup,
  listIssueAgentRequests,
  listIssueAgentRuns,
  listIssueAgentRunEvents,
  listIssueAttachments,
  listIssueComments,
  listIssueEvents,
  listIssues,
  logAuthEvent,
  softDeleteIssueComment,
  updateIssue,
  updateIssueAgentRun,
  updateIssueComment,
  updateIssueLastRun,
} from '../db.js';
import { runIssueAgent } from '../issue-runner.js';
import { afterIssueEventCreated } from '../issue-notifier.js';
import { createIssueRunPullRequest, getIssueRunPullRequestStatus } from '../git-provider.js';
import { getSession as getAgentLinkSession, getOnlineMeta as getAgentLinkOnlineMeta, isOnline as isAgentLinkOnline } from '../agent-link/registry.js';
import { requestWorkspaceGitCommit, requestWorkspaceGitStatus } from '../agent-link/agent-runtime-rpc.js';
import type { AgentRunWorkspace, WorkspaceRepoSpec } from '../agent-link/protocol.js';
import { buildRuntimePoolSnapshot, resolveRuntimeSchedulingTarget } from '../runtime-pool.js';
import { resolveAgentRunRuntimeTarget } from '../runtime-scheduler.js';
import {
  buildIssueRunDeliveryState,
  buildIssueRunPullRequestDraft,
  buildIssueRunReviewDraft,
} from '../issue-delivery.js';
import { buildIssueRunReleaseState, type IssueRunPullRequestStatus } from '../issue-release.js';
import { evaluateRunQuality, resolveIssueRunQualityWithReviewChild } from '../quality-evaluator.js';
import {
  evaluateAgentTaskScopedApprovalRequest,
  normalizeRunPermissionRequestPayload,
} from '../permissions.js';
import {
  buildProductionHealthState,
  isProductionHealthSeverity,
  isProductionHealthSignalType,
  type ProductionHealthSignal,
  type ProductionHealthState,
} from '../production-health.js';
import { buildRemediationState, type RemediationSignal, type RemediationState } from '../remediation.js';
import { buildIncidentKnowledge, type IncidentKnowledgeEntry, type IncidentKnowledgeEvent } from '../incident-knowledge.js';
import { buildRunbookReuse, type RunbookReusePayload } from '../runbook-reuse.js';
import { buildFixRunDraft, type FixRunDraftPayload } from '../fix-run-spawner.js';
import { buildFixRunOutcome, type FixRunOutcomePayload, type FixRunOutcomeStatus } from '../fix-run-outcome.js';
import { buildResolutionGate, type ResolutionGatePayload } from '../resolution-gate.js';

const issueRoutes = new Hono<{ Variables: Variables }>();
type IssueRouteContext = Context<{ Variables: Variables }>;

function isAgentLinkExecutionTarget(value: string | undefined | null): boolean {
  return (
    typeof value === 'string' &&
    (/^cl_[0-9a-f]{16}$/.test(value) ||
      /^runtime:cl_[0-9a-f]{16}:[^:]+$/.test(value) ||
      /^cl_[0-9a-f]{16}:[^:]+$/.test(value) ||
      /^provider:[^:]+$/.test(value))
  );
}

function deviceLinkIdFromExecutionTarget(value: string | undefined | null): string | undefined {
  if (typeof value !== 'string') return undefined;
  const direct = /^(cl_[0-9a-f]{16})$/.exec(value);
  if (direct) return direct[1];
  const runtime = /^runtime:(cl_[0-9a-f]{16}):[^:]+$/.exec(value);
  if (runtime) return runtime[1];
  const legacyRuntime = /^(cl_[0-9a-f]{16}):[^:]+$/.exec(value);
  if (legacyRuntime) return legacyRuntime[1];
  return undefined;
}

function parseCsv<T extends string>(value: string | undefined | null): T[] | undefined {
  if (!value) return undefined;
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean) as T[];
  return items.length ? items : undefined;
}

function evaluateIssueRunDeliveryQuality(issue: WorkspaceIssue, run: IssueAgentRun) {
  const runEvents = listIssueAgentRunEvents(run.id);
  const qualityEvaluation = evaluateRunQuality({
    source: 'issue',
    sourceId: issue.id,
    title: issue.title,
    run,
    events: runEvents,
    requests: listIssueAgentRequests(issue.id).filter((request) => request.run_id === run.id),
  });
  const runs = listIssueAgentRuns(issue.id);
  const eventsByRun = Object.fromEntries(runs.map((candidate) => [candidate.id, listIssueAgentRunEvents(candidate.id)]));
  return resolveIssueRunQualityWithReviewChild(qualityEvaluation, {
    parentRunId: run.id,
    runs,
    parentEvents: runEvents,
    eventsByRun,
  });
}

function latestIssueRunCommitFromEvents(runId: string) {
  const latestCommit = [...listIssueAgentRunEvents(runId)]
    .reverse()
    .find((event) => event.event_type === 'git_commit_created');
  const commitPayload = latestCommit?.payload && typeof latestCommit.payload === 'object'
    ? latestCommit.payload
    : null;
  const commitHash = typeof commitPayload?.commit === 'string' && commitPayload.commit.trim()
    ? commitPayload.commit
    : typeof latestCommit?.summary === 'string' && latestCommit.summary.trim()
      ? latestCommit.summary
      : null;
  if (!commitHash) return null;
  const diffSnapshot = commitPayload?.diff && typeof commitPayload.diff === 'object'
    ? commitPayload.diff as Parameters<typeof buildIssueRunPullRequestDraft>[0]['diff']
    : null;
  return {
    commit: commitHash,
    branch: typeof commitPayload?.branch === 'string' ? commitPayload.branch : undefined,
    filesCommitted: typeof commitPayload?.filesCommitted === 'number' ? commitPayload.filesCommitted : undefined,
    diff: diffSnapshot,
  };
}

function buildIssueRunDeliveryPayload(input: {
  issue: WorkspaceIssue;
  run: IssueAgentRun;
  diff: Parameters<typeof buildIssueRunPullRequestDraft>[0]['diff'];
  commit?: Parameters<typeof buildIssueRunPullRequestDraft>[0]['commit'];
  qualityEvaluation: ReturnType<typeof evaluateIssueRunDeliveryQuality>;
}) {
  const pullRequestDraft = buildIssueRunPullRequestDraft({
    issue: input.issue,
    run: input.run,
    diff: input.diff,
    commit: input.commit,
    qualityEvaluation: input.qualityEvaluation,
  });
  const reviewDraft = buildIssueRunReviewDraft({ issue: input.issue, run: input.run, diff: input.diff });
  const deliveryState = buildIssueRunDeliveryState({
    diff: input.diff,
    commit: input.commit,
    pullRequestDraft,
    reviewDraft,
    qualityEvaluation: input.qualityEvaluation,
  });
  return {
    deliveryState,
    pullRequestDraft,
    reviewDraft,
    qualityEvaluation: input.qualityEvaluation,
  };
}

function latestIssueRunPullRequestFromEvents(runId: string) {
  const event = [...listIssueAgentRunEvents(runId)]
    .reverse()
    .find((item) => item.event_type === 'pull_request_created' || item.event_type === 'delivery_pr_created');
  const payload = event?.payload && typeof event.payload === 'object' ? event.payload : null;
  const provider = typeof payload?.provider === 'string' ? payload.provider : 'unknown';
  const url = typeof payload?.url === 'string'
    ? payload.url
    : typeof event?.summary === 'string'
      ? event.summary
      : undefined;
  const number = typeof payload?.number === 'number'
    ? payload.number
    : typeof payload?.number === 'string'
      ? Number(payload.number)
      : undefined;
  const id = payload?.id !== undefined ? String(payload.id) : undefined;
  if (!url && !number && !id) return null;
  return {
    ok: true,
    provider: provider as 'github' | 'gitlab' | 'codebase' | 'unknown',
    url,
    number: Number.isFinite(number) ? number : undefined,
    id,
  };
}

function releaseEventTypeForStage(stage: ReturnType<typeof buildIssueRunReleaseState>['stage']): string | null {
  if (stage === 'checks_pending' || stage === 'pr_created') return 'release_checks_pending';
  if (stage === 'checks_failed') return 'release_checks_failed';
  if (stage === 'review_pending') return 'release_review_pending';
  if (stage === 'merge_ready') return 'release_merge_ready';
  if (stage === 'merged' || stage === 'released') return 'release_completed';
  if (stage === 'rollback_required') return 'release_rollback_required';
  return null;
}

function releaseEventTitleForStage(stage: ReturnType<typeof buildIssueRunReleaseState>['stage']): string {
  if (stage === 'checks_pending' || stage === 'pr_created') return 'Release checks pending';
  if (stage === 'checks_failed') return 'Release checks failed';
  if (stage === 'review_pending') return 'Release review pending';
  if (stage === 'merge_ready') return 'Release merge ready';
  if (stage === 'rollback_required') return 'Release rollback required';
  return 'Release completed';
}

function latestIssueRunPostMergeVerificationFromEvents(runId: string): { ok: boolean; summary?: string | null } | null {
  const event = [...listIssueAgentRunEvents(runId)]
    .reverse()
    .find((item) => item.event_type === 'release_post_merge_verified' || item.event_type === 'release_post_merge_failed');
  if (!event) return null;
  const payload = event.payload && typeof event.payload === 'object' ? event.payload : null;
  const ok = typeof payload?.ok === 'boolean'
    ? payload.ok
    : event.event_type === 'release_post_merge_verified';
  const summary = typeof payload?.summary === 'string'
    ? payload.summary
    : event.summary ?? event.detail ?? null;
  return { ok, summary };
}

async function buildIssueRunReleasePayload(issue: WorkspaceIssue, run: IssueAgentRun) {
  const pullRequest = latestIssueRunPullRequestFromEvents(run.id);
  const postMergeVerification = latestIssueRunPostMergeVerificationFromEvents(run.id);
  let providerStatus: IssueRunPullRequestStatus | null = null;
  if (pullRequest) {
    const status = await getIssueRunPullRequestStatus(
      {
        repositoryUrl: issue.project_git_url,
        url: pullRequest.url,
        number: pullRequest.number,
        id: pullRequest.id,
      },
      {},
    );
    providerStatus = status.ok
      ? status
      : {
          ok: false,
          provider: status.provider,
          url: pullRequest.url,
          number: pullRequest.number,
          id: pullRequest.id,
          state: 'unknown',
          mergeable: null,
          checks: [],
          reviews: [],
          error: status.error,
        };
  }
  const releaseState = buildIssueRunReleaseState({
    deliveryState: {
      stage: pullRequest ? 'delivered' : 'proposal_ready',
      nextAction: pullRequest ? 'none' : 'create_pr_or_mr',
      clean: true,
      hasCommit: true,
      hasPullRequestEntrypoint: Boolean(pullRequest),
      hasReviewComments: true,
      qualityGate: { outcome: 'passed', allowed: true },
      checklist: [],
    },
    pullRequest,
    providerStatus,
    postMergeVerification,
  });
  return { releaseState, pullRequest, providerStatus, postMergeVerification };
}

function latestReleaseStateFromEvents(runId: string): { stage: string; releaseGate: { allowed: boolean; reason?: string } } | null {
  const event = [...listIssueAgentRunEvents(runId)]
    .reverse()
    .find((item) => item.event_type?.startsWith('release_'));
  const payload = event?.payload && typeof event.payload === 'object' ? event.payload : null;
  const releasePayload = payload?.releaseState && typeof payload.releaseState === 'object'
    ? payload.releaseState as Record<string, any>
    : payload && typeof payload.release === 'object' && (payload.release as Record<string, any>).releaseState
      ? (payload.release as Record<string, any>).releaseState as Record<string, any>
      : null;
  const stage = typeof releasePayload?.stage === 'string'
    ? releasePayload.stage
    : event?.event_type === 'release_completed'
      ? 'released'
      : event?.event_type === 'release_rollback_required'
        ? 'rollback_required'
        : undefined;
  if (!stage) return null;
  const gate = releasePayload?.releaseGate && typeof releasePayload.releaseGate === 'object'
    ? releasePayload.releaseGate as Record<string, any>
    : {};
  return {
    stage,
    releaseGate: {
      allowed: typeof gate.allowed === 'boolean' ? gate.allowed : stage === 'released' || stage === 'merged',
      reason: typeof gate.reason === 'string' ? gate.reason : event?.summary ?? undefined,
    },
  };
}

function productionHealthSignalsFromEvents(runId: string): ProductionHealthSignal[] {
  return listIssueAgentRunEvents(runId)
    .filter((event) => event.event_type === 'production_health_signal_received')
    .flatMap((event) => {
      const payload = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, any> : {};
      if (!isProductionHealthSignalType(payload.type)) return [];
      return {
        type: payload.type,
        severity: isProductionHealthSeverity(payload.severity) ? payload.severity : undefined,
        summary: typeof payload.summary === 'string' ? payload.summary : event.summary ?? null,
        detail: typeof payload.detail === 'string' ? payload.detail : event.detail ?? null,
        source: typeof payload.source === 'string' ? payload.source : null,
        observedAt: typeof payload.observedAt === 'string' ? payload.observedAt : event.created_at ?? null,
        payload,
      } as ProductionHealthSignal;
    });
}

function productionEventTypeForStage(stage: ProductionHealthState['stage']): string | null {
  if (stage === 'observing') return 'production_observation_started';
  if (stage === 'healthy') return 'production_healthy';
  if (stage === 'degraded') return 'production_health_degraded';
  if (stage === 'incident_detected') return 'production_incident_detected';
  if (stage === 'mitigation_running') return 'production_mitigation_running';
  if (stage === 'rollback_recommended') return 'production_rollback_recommended';
  if (stage === 'recovered') return 'production_recovered';
  return null;
}

function productionEventTitleForStage(stage: ProductionHealthState['stage']): string {
  if (stage === 'observing') return 'Production observation started';
  if (stage === 'healthy') return 'Production healthy';
  if (stage === 'degraded') return 'Production health degraded';
  if (stage === 'incident_detected') return 'Production incident detected';
  if (stage === 'mitigation_running') return 'Production mitigation running';
  if (stage === 'rollback_recommended') return 'Production rollback recommended';
  if (stage === 'recovered') return 'Production recovered';
  return 'Production health updated';
}

function buildIssueRunProductionHealthPayload(run: IssueAgentRun) {
  const releaseState = latestReleaseStateFromEvents(run.id);
  const signals = productionHealthSignalsFromEvents(run.id);
  const productionHealth = buildProductionHealthState({ releaseState, signals });
  return { productionHealth, releaseState, signals };
}

function remediationSourceForEvent(eventType: string | undefined): RemediationSignal['source'] | null {
  if (!eventType) return null;
  if (eventType.startsWith('quality_')) return 'quality';
  if (eventType.startsWith('delivery_')) return 'delivery';
  if (eventType.startsWith('release_')) return 'release';
  if (eventType.startsWith('production_')) return 'production';
  if (eventType.startsWith('remediation_')) return 'remediation';
  return null;
}

function remediationStageForEvent(eventType: string | undefined, payload: Record<string, any>): string | null {
  if (!eventType) return null;
  if (eventType === 'quality_failed') return 'failed';
  if (eventType === 'quality_passed') return 'passed';
  if (eventType === 'delivery_quality_blocked') return 'blocked_by_quality';
  if (eventType === 'release_checks_failed') return 'checks_failed';
  if (eventType === 'release_rollback_required') return 'rollback_required';
  if (eventType === 'release_completed') return 'completed';
  if (eventType === 'production_health_signal_received') {
    if (payload.type === 'degraded') return 'degraded';
    if (payload.type === 'healthy') return 'healthy';
    if (payload.type === 'incident_detected') return 'incident_detected';
    if (payload.type === 'rollback_recommended') return 'rollback_recommended';
    if (payload.type === 'recovered') return 'recovered';
    return null;
  }
  if (eventType === 'production_health_degraded') return 'degraded';
  if (eventType === 'production_healthy') return 'healthy';
  if (eventType === 'production_incident_detected') return 'incident_detected';
  if (eventType === 'production_rollback_recommended') return 'rollback_recommended';
  if (eventType === 'production_recovered') return 'recovered';
  if (eventType === 'remediation_proposed') return 'proposed';
  if (eventType === 'remediation_waiting_approval') return 'waiting_approval';
  if (eventType === 'remediation_running') return 'running';
  if (eventType === 'remediation_verifying') return 'verifying';
  if (eventType === 'remediation_resolved') return 'resolved';
  if (eventType === 'remediation_failed') return 'failed';
  if (eventType === 'remediation_action_recorded') {
    if (payload.action === 'mark_verifying') return 'verifying';
    if (payload.action === 'mark_resolved') return 'resolved';
    if (payload.action === 'request_rollback') return 'waiting_approval';
    if (payload.action === 'spawn_fix_run') return 'running';
    return 'proposed';
  }
  return null;
}

function remediationSignalsFromEvents(runId: string): RemediationSignal[] {
  return listIssueAgentRunEvents(runId).flatMap((event) => {
    const payload = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, any> : {};
    const source = remediationSourceForEvent(event.event_type);
    const stage = remediationStageForEvent(event.event_type, payload);
    if (!source || !stage) return [];
    return [{
      source,
      stage,
      eventType: event.event_type,
      summary: event.summary ?? null,
      detail: event.detail ?? null,
      observedAt: event.created_at ?? null,
      payload,
    }];
  });
}

function remediationEventTypeForStage(stage: RemediationState['stage']): string | null {
  if (stage === 'proposed') return 'remediation_proposed';
  if (stage === 'waiting_approval') return 'remediation_waiting_approval';
  if (stage === 'running') return 'remediation_running';
  if (stage === 'verifying') return 'remediation_verifying';
  if (stage === 'resolved') return 'remediation_resolved';
  if (stage === 'failed') return 'remediation_failed';
  return null;
}

function remediationEventTitleForStage(stage: RemediationState['stage']): string {
  if (stage === 'proposed') return 'Remediation proposed';
  if (stage === 'waiting_approval') return 'Remediation waiting approval';
  if (stage === 'running') return 'Remediation running';
  if (stage === 'verifying') return 'Remediation verifying';
  if (stage === 'resolved') return 'Remediation resolved';
  if (stage === 'failed') return 'Remediation failed';
  return 'Remediation not needed';
}

function buildIssueRunRemediationPayload(run: IssueAgentRun) {
  const signals = remediationSignalsFromEvents(run.id);
  const remediation = buildRemediationState({ signals });
  return { remediation, signals };
}

function incidentKnowledgeEventsFromRunEvents(runId: string): IncidentKnowledgeEvent[] {
  return listIssueAgentRunEvents(runId).map((event) => ({
    id: event.id,
    eventType: event.event_type,
    title: event.title ?? null,
    summary: event.summary ?? null,
    detail: event.detail ?? null,
    payload: event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : null,
    createdAt: event.created_at,
  }));
}

function buildIssueRunIncidentKnowledgePayload(run: IssueAgentRun) {
  const events = incidentKnowledgeEventsFromRunEvents(run.id);
  const { entry } = buildIncidentKnowledge({ issueId: run.issue_id, runId: run.id, events });
  return { incidentKnowledge: entry, events };
}

function isIncidentKnowledgeEntry(value: unknown): value is IncidentKnowledgeEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.id === 'string'
    && typeof entry.issueId === 'string'
    && typeof entry.runId === 'string'
    && typeof entry.title === 'string'
    && typeof entry.fingerprint === 'string'
    && typeof entry.severity === 'string'
    && typeof entry.status === 'string'
    && Array.isArray(entry.symptoms)
    && Array.isArray(entry.remediationActions)
    && Array.isArray(entry.verificationSignals)
    && Array.isArray(entry.preventionChecklist)
    && Array.isArray(entry.relatedEvents)
    && typeof entry.createdAt === 'string'
    && typeof entry.updatedAt === 'string';
}

function archivedIncidentKnowledgeEntriesForIssue(issueId: string, currentRunId: string): IncidentKnowledgeEntry[] {
  return listIssueAgentRuns(issueId).flatMap((run) => {
    if (run.id === currentRunId) return [];
    return incidentKnowledgeEventsFromRunEvents(run.id).flatMap((event) => {
      if (event.eventType !== 'incident_knowledge_archived') return [];
      const payload = event.payload && typeof event.payload === 'object' ? event.payload : null;
      const direct = payload?.incidentKnowledge;
      const nested = direct && typeof direct === 'object'
        ? (direct as Record<string, unknown>).incidentKnowledge
        : null;
      const entry = direct && typeof direct === 'object' && 'fingerprint' in direct
        ? direct
        : nested;
      return isIncidentKnowledgeEntry(entry) ? [entry] : [];
    });
  });
}

function buildIssueRunRunbookReusePayload(issue: WorkspaceIssue, run: IssueAgentRun): { runbookReuse: RunbookReusePayload } {
  const currentIncident = buildIssueRunIncidentKnowledgePayload(run).incidentKnowledge;
  const archivedIncidents = archivedIncidentKnowledgeEntriesForIssue(issue.id, run.id);
  return {
    runbookReuse: buildRunbookReuse({
      issueId: issue.id,
      runId: run.id,
      currentIncident,
      archivedIncidents,
    }),
  };
}

function buildIssueRunFixRunDraftPayload(issue: WorkspaceIssue, run: IssueAgentRun): FixRunDraftPayload {
  const currentIncident = buildIssueRunIncidentKnowledgePayload(run).incidentKnowledge;
  const { runbookReuse } = buildIssueRunRunbookReusePayload(issue, run);
  return buildFixRunDraft({
    issue: { id: issue.id, title: issue.title, description: issue.description },
    sourceRun: { id: run.id, result: run.result ?? run.error ?? null },
    currentIncident,
    runbookReuse,
  });
}

function spawnedFixRunIdForSource(sourceRunId: string): string | null {
  const event = [...listIssueAgentRunEvents(sourceRunId)]
    .reverse()
    .find((item) => item.event_type === 'fix_run_spawned');
  const payload = event?.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : null;
  return typeof payload?.fixRunId === 'string' ? payload.fixRunId : null;
}

function existingFixRunForSource(issueId: string, sourceRunId: string): IssueAgentRun | null {
  const fixRunId = spawnedFixRunIdForSource(sourceRunId);
  if (!fixRunId) return null;
  return listIssueAgentRuns(issueId).find((run) => run.id === fixRunId) ?? null;
}

function sourceRunForFixRun(issueId: string, fixRun: IssueAgentRun): IssueAgentRun | null {
  if (!fixRun.parent_run_id) return null;
  return listIssueAgentRuns(issueId).find((run) => run.id === fixRun.parent_run_id) ?? null;
}

function fixRunForOutcomeRequest(issueId: string, run: IssueAgentRun): { sourceRun: IssueAgentRun | null; fixRun: IssueAgentRun | null } {
  if (run.parent_run_id) return { sourceRun: sourceRunForFixRun(issueId, run), fixRun: run };
  return { sourceRun: run, fixRun: existingFixRunForSource(issueId, run.id) };
}

function buildIssueRunFixRunOutcomePayload(issue: WorkspaceIssue, run: IssueAgentRun): FixRunOutcomePayload {
  const { sourceRun, fixRun } = fixRunForOutcomeRequest(issue.id, run);
  return buildFixRunOutcome({
    sourceRun,
    fixRun,
    sourceEvents: sourceRun ? listIssueAgentRunEvents(sourceRun.id) : [],
    fixRunEvents: fixRun ? listIssueAgentRunEvents(fixRun.id) : [],
  });
}

function fixRunOutcomeEventType(status: FixRunOutcomeStatus): string {
  if (status === 'resolved') return 'fix_run_resolved';
  if (status === 'failed' || status === 'blocked') return 'fix_run_failed';
  if (status === 'needs_review') return 'fix_run_needs_review';
  return 'fix_run_verifying';
}

function buildIssueRunResolutionGatePayload(issue: WorkspaceIssue, run: IssueAgentRun): ResolutionGatePayload {
  return buildResolutionGate({
    issue: { id: issue.id, title: issue.title, status: issue.status },
    fixRunOutcome: buildIssueRunFixRunOutcomePayload(issue, run),
  });
}

const remediationActions = ['acknowledge', 'mark_verifying', 'mark_resolved', 'spawn_fix_run', 'request_rollback'] as const;
type RemediationAction = typeof remediationActions[number];

function isRemediationAction(value: unknown): value is RemediationAction {
  return typeof value === 'string' && remediationActions.includes(value as RemediationAction);
}

function recordIssueRunDeliveryEventOnce(
  issueId: string,
  runId: string,
  eventType: string,
  title: string,
  summary: string | null,
  detail: string | null,
  payload: Record<string, unknown>,
): void {
  const exists = listIssueAgentRunEvents(runId).some((event) => event.event_type === eventType);
  if (exists) return;
  recordIssueRunEvent(issueId, runId, eventType, title, summary, detail, payload);
}

function ensureIssueAccess(issue: WorkspaceIssue, authUser: AuthUser): boolean {
  const group = getRegisteredGroup(issue.workspace_jid);
  if (!group) return authUser.role === 'admin';
  if (!canAccessGroup({ id: authUser.id, role: authUser.role }, group)) return false;
  if (isHostExecutionGroup(group) && !hasHostExecutionPermission(authUser)) return false;
  return true;
}

function assertIssueRunRuntimeAdmissible(input: {
  authUser: AuthUser;
  executionNode: string | null;
  resolvedLinkId: string | null;
  preferredAgentClientId?: string | null;
}): {
  resolvedExecutionNode: string | null;
  resolvedLinkId: string | null;
  resolvedAgentClientId: string | null;
} {
  if (!input.executionNode) {
    return {
      resolvedExecutionNode: null,
      resolvedLinkId: input.resolvedLinkId,
      resolvedAgentClientId: input.preferredAgentClientId ?? null,
    };
  }
  const links = input.resolvedLinkId
    ? [getAgentLinkById(input.resolvedLinkId)].filter((link): link is NonNullable<ReturnType<typeof getAgentLinkById>> => Boolean(link))
    : listAgentLinksByUser(input.authUser.id);
  const devices = links.map((link) => {
    const online = getAgentLinkOnlineMeta(link.id);
    const linkOnline = isAgentLinkOnline(link.id);
    return {
      id: link.id,
      displayName: link.displayName,
      online: linkOnline,
      status: online?.status ?? (linkOnline ? 'idle' as const : 'offline' as const),
      lastHeartbeatAt: online?.lastHeartbeatAt
        ? new Date(online.lastHeartbeatAt).toISOString()
        : link.lastSeenAt,
      agentClients: link.agentClients ?? [],
      runtimes: online?.runtimes ?? [],
    };
  });
  const runtimePool = buildRuntimePoolSnapshot({
    devices,
    serverBackends: [],
    assignment: { preferredAgentClientId: input.preferredAgentClientId ?? 'claude-code' },
  });
  const runtimePoolDecision = resolveRuntimeSchedulingTarget(runtimePool, input.executionNode);
  const decision = resolveAgentRunRuntimeTarget({
    executionTarget: input.executionNode,
    preferredAgentClientId: input.preferredAgentClientId,
    devices,
    serverBackends: [],
  });
  if (!decision.eligible) {
    throw new Error(
      `Selected runtime is not schedulable: ${decision.blockedReason ?? runtimePoolDecision.blockedReason ?? 'runtime_not_found'}`,
    );
  }
  return {
    resolvedExecutionNode: decision.executionNode ?? input.executionNode,
    resolvedLinkId: decision.deviceLinkId ?? input.resolvedLinkId,
    resolvedAgentClientId: decision.agentClientId ?? input.preferredAgentClientId ?? null,
  };
}

async function validateAndBuildRunInput(
  authUser: AuthUser,
  issue: WorkspaceIssue,
  input: {
    agent_link_id?: string | null;
    agent_client_id?: string | null;
    execution_node?: string | null;
    backend?: string | null;
    selected_skills?: string[] | null;
  } = {},
): Promise<Pick<IssueAgentRun, 'agent_link_id' | 'agent_client_id' | 'execution_node' | 'backend' | 'selected_skills'>> {
  const executionNode =
    input.execution_node ??
    issue.execution_node ??
    (input.agent_link_id || issue.agent_link_id
      ? `runtime:${input.agent_link_id ?? issue.agent_link_id}:${input.agent_client_id ?? issue.agent_client_id ?? 'claude-code'}`
      : null);
  if (executionNode && !isAgentLinkExecutionTarget(executionNode)) {
    throw new Error('Invalid execution_node format');
  }
  const resolvedLinkId = deviceLinkIdFromExecutionTarget(executionNode) ?? input.agent_link_id ?? issue.agent_link_id ?? null;
  if (resolvedLinkId) {
    const link = getAgentLinkById(resolvedLinkId);
    if (!link || link.userId !== authUser.id || link.revokedAt) {
      throw new Error('Selected agent not found');
    }
  }
  if (issue.project_device_link_id && resolvedLinkId && issue.project_device_link_id !== resolvedLinkId) {
    throw new Error('Project device path must run on its bound device');
  }
  const runtimeAdmission = assertIssueRunRuntimeAdmissible({
    authUser,
    executionNode,
    resolvedLinkId,
    preferredAgentClientId: input.agent_client_id ?? issue.agent_client_id,
  });
  return {
    agent_link_id: runtimeAdmission.resolvedLinkId,
    agent_client_id: runtimeAdmission.resolvedAgentClientId ?? input.agent_client_id ?? issue.agent_client_id ?? null,
    execution_node: runtimeAdmission.resolvedExecutionNode,
    backend: input.backend ?? issue.backend ?? null,
    selected_skills: input.selected_skills ?? issue.selected_skills ?? null,
  };
}

function enqueueIssueRun(issueId: string, runId: string): void {
  const deps = getWebDeps();
  if (!deps?.queue) {
    updateIssueAgentRunError(issueId, runId, 'Server not initialized');
    return;
  }
  const issue = getIssueById(issueId);
  if (!issue) return;
  const runChatJid = `${issue.workspace_jid}#issue:${runId}`;
  deps.queue.enqueueTask(runChatJid, `issue:${runId}`, async () => {
    await runIssueAgent(issueId, runId, {
      queue: deps.queue,
      broadcastStreamEvent: deps.broadcastStreamEvent,
    });
  });
}

function updateIssueAgentRunError(issueId: string, runId: string, error: string): void {
  const now = new Date().toISOString();
  updateIssueAgentRun(runId, { status: 'error', error, run_completed_at: now });
  updateIssueLastRun(issueId, runId, 'error');
  recordIssueRunEvent(issueId, runId, 'run_failed', 'Run failed', error, error);
}

function recordIssueRunEvent(
  issueId: string,
  runId: string,
  eventType: string,
  title: string,
  summary?: string | null,
  detail?: string | null,
  payload?: Record<string, unknown> | null,
): void {
  createIssueAgentRunEvent({
    id: `irev_${crypto.randomBytes(8).toString('hex')}`,
    issue_id: issueId,
    run_id: runId,
    event_type: eventType,
    title,
    summary: summary ?? null,
    detail: detail ?? null,
    payload: payload ?? null,
    created_at: new Date().toISOString(),
  });
}

function deriveRepoNameFromGitUrl(gitUrl: string): string {
  try {
    const u = new URL(gitUrl);
    let base = u.pathname.split('/').filter(Boolean).pop() || 'repo';
    if (base.endsWith('.git')) base = base.slice(0, -4);
    return base || 'repo';
  } catch {
    const m = gitUrl.match(/([^/:]+?)(?:\.git)?\/?$/);
    return m?.[1] || 'repo';
  }
}

function buildIssueRunWorkspaceGitStatusPayload(
  issue: WorkspaceIssue,
  run: IssueAgentRun,
): {
  workspace: AgentRunWorkspace;
  workspaceRepos?: WorkspaceRepoSpec[];
  workspaceRepo?: WorkspaceRepoSpec;
} {
  const agentId =
    run.agent_client_id ??
    issue.agent_client_id ??
    run.backend ??
    issue.backend ??
    'claude-code';
  const workspace: AgentRunWorkspace = {
    kind: 'workspace',
    folder: issue.workspace_folder,
    agentId,
    scope: 'task',
    taskId: issue.id,
    taskRunId: run.id,
  };
  const repoBase = {
    groupFolder: issue.workspace_folder,
    agentId,
    scope: 'task' as const,
    taskId: issue.id,
    taskRunId: run.id,
  };
  let workspaceRepo: WorkspaceRepoSpec | undefined;
  if (issue.project_git_url) {
    workspaceRepo = {
      kind: 'git',
      gitUrl: issue.project_git_url,
      name: deriveRepoNameFromGitUrl(issue.project_git_url),
      ...repoBase,
    };
  } else if (issue.project_device_path) {
    workspaceRepo = {
      kind: 'device_path',
      devicePath: issue.project_device_path,
      name: issue.project_device_path.split(/[\\/]/).filter(Boolean).pop() || undefined,
      ...repoBase,
    };
  }
  return {
    workspace,
    ...(workspaceRepo ? { workspaceRepo, workspaceRepos: [workspaceRepo] } : {}),
  };
}

issueRoutes.get('/', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const statuses = parseCsv<IssueStatus>(c.req.query('status'));
  const priorities = parseCsv<IssuePriority>(c.req.query('priority'));
  const showDone = c.req.query('show_done') === 'true' || c.req.query('showDone') === 'true';
  const requestedWorkspaceJid = c.req.query('workspace_jid') || undefined;
  let accessibleWorkspaceJids: string[] | undefined;
  if (requestedWorkspaceJid) {
    const group = getRegisteredGroup(requestedWorkspaceJid);
    if (!group) {
      if (authUser.role !== 'admin') return c.json({ issues: [], total: 0 });
    } else if (
      !canAccessGroup(
        { id: authUser.id, role: authUser.role },
        { ...group, jid: requestedWorkspaceJid },
      ) ||
      (isHostExecutionGroup(group) && !hasHostExecutionPermission(authUser))
    ) {
      return c.json({ issues: [], total: 0 });
    }
  } else if (authUser.role !== 'admin') {
    accessibleWorkspaceJids = Object.entries(getAllRegisteredGroups())
      .filter(([jid, group]) => {
        if (
          !canAccessGroup(
            { id: authUser.id, role: authUser.role },
            { ...group, jid },
          )
        ) {
          return false;
        }
        if (isHostExecutionGroup(group) && !hasHostExecutionPermission(authUser)) {
          return false;
        }
        return true;
      })
      .map(([jid]) => jid);
  }
  const { issues, total } = listIssues({
    workspaceJid: requestedWorkspaceJid,
    workspaceJids: accessibleWorkspaceJids,
    query: c.req.query('q') || undefined,
    statuses,
    priorities,
    assigneeUserId: c.req.query('assignee') || undefined,
    projectRepoId: c.req.query('project') || undefined,
    showDone,
    sort: (c.req.query('sort') as any) || 'updated',
    direction: c.req.query('direction') === 'asc' ? 'asc' : 'desc',
    limit: Number(c.req.query('limit') || 100),
    offset: Number(c.req.query('offset') || 0),
  });
  const visible = issues.filter((issue) => ensureIssueAccess(issue, authUser));
  return c.json({ issues: visible, total: visible.length < issues.length ? visible.length : total });
});

issueRoutes.post('/', authMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const validation = IssueCreateSchema.safeParse(body);
  if (!validation.success) {
    return c.json({ error: 'Invalid request body', details: validation.error.format() }, 400);
  }
  const authUser = c.get('user') as AuthUser;
  let workspaceJid = validation.data.workspace_jid;
  let workspaceFolder = validation.data.workspace_folder;
  if (!workspaceJid || !workspaceFolder) {
    const home = getUserHomeGroup(authUser.id);
    if (!home) return c.json({ error: 'User has no home workspace' }, 400);
    workspaceJid = workspaceJid || home.jid;
    workspaceFolder = workspaceFolder || home.folder;
  }
  const group = getRegisteredGroup(workspaceJid);
  if (!group) return c.json({ error: 'Workspace not found' }, 404);
  if (group.folder !== workspaceFolder) {
    return c.json({ error: 'workspace_folder does not match workspace_jid' }, 400);
  }
  if (!canAccessGroup({ id: authUser.id, role: authUser.role }, group)) {
    return c.json({ error: 'Workspace not found' }, 404);
  }
  if (isHostExecutionGroup(group) && !hasHostExecutionPermission(authUser)) {
    return c.json({ error: 'Insufficient permissions for host execution mode' }, 403);
  }

  let repoFields: Partial<WorkspaceIssue> = {};
  if (validation.data.project_repo_id) {
    const repo = getManagedRepoById(validation.data.project_repo_id);
    if (!repo || repo.createdBy !== authUser.id) return c.json({ error: 'Project not found' }, 400);
    repoFields = {
      project_repo_id: repo.id,
      project_git_url: repo.gitUrl ?? null,
      project_device_path: repo.devicePath ?? null,
      project_device_link_id: repo.deviceLinkId ?? null,
    };
  }

  const now = new Date().toISOString();
  const issue = createIssue({
    id: `iss_${crypto.randomBytes(8).toString('hex')}`,
    workspace_jid: workspaceJid,
    workspace_folder: workspaceFolder,
    title: validation.data.title,
    description: validation.data.description,
    status: validation.data.status,
    priority: validation.data.priority,
    assignee_user_id: validation.data.assignee_user_id ?? null,
    due_date: validation.data.due_date ?? null,
    ...repoFields,
    agent_link_id: validation.data.agent_link_id ?? null,
    agent_client_id: validation.data.agent_client_id ?? null,
    execution_node: validation.data.execution_node ?? null,
    backend: validation.data.backend ?? null,
    selected_skills: validation.data.selected_skills,
    created_by: authUser.id,
    created_at: now,
    updated_at: now,
  });

  const evCreated = createIssueEvent({
    issue_id: issue.id,
    event_type: 'created',
    actor_id: authUser.id,
    actor_type: 'user',
    title: 'Issue created',
    summary: `${issue.status} · ${issue.priority}`,
    detail: { status: issue.status, priority: issue.priority, assignee: issue.assignee_user_id ?? null, due_date: issue.due_date ?? null },
    created_at: now,
  });
  afterIssueEventCreated(evCreated, issue);

  let run: IssueAgentRun | null = null;
  if (validation.data.start_agent) {
    try {
      const runInput = await validateAndBuildRunInput(authUser, issue, validation.data);
      run = createIssueAgentRun({
        id: `irun_${crypto.randomBytes(8).toString('hex')}`,
        issue_id: issue.id,
        workspace_jid: issue.workspace_jid,
        workspace_folder: issue.workspace_folder,
        ...runInput,
        status: 'queued',
        created_by: authUser.id,
        created_at: new Date().toISOString(),
      });
      updateIssueLastRun(issue.id, run.id, 'queued');
      recordIssueRunEvent(issue.id, run.id, 'run_queued', 'Run queued', 'Created from issue creation', null, {
        trigger: 'issue_create',
        issueId: issue.id,
      });
      enqueueIssueRun(issue.id, run.id);
      const evRun = createIssueEvent({
        issue_id: issue.id,
        run_id: run.id,
        event_type: 'run_created',
        actor_id: authUser.id,
        actor_type: 'user',
        title: 'Run enqueued',
        summary: 'Created from issue creation',
        detail: { run_id: run.id, status: run.status, trigger: 'issue_create' },
      });
      afterIssueEventCreated(evRun, issue);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  }

  return c.json({ issue, run });
});

issueRoutes.get('/:id', authMiddleware, async (c) => {
  const issue = getIssueById(c.req.param('id'));
  const authUser = c.get('user') as AuthUser;
  if (!issue || !ensureIssueAccess(issue, authUser)) return c.json({ error: 'Issue not found' }, 404);
  return c.json({ issue });
});

issueRoutes.patch('/:id', authMiddleware, async (c) => {
  const issue = getIssueById(c.req.param('id'));
  const authUser = c.get('user') as AuthUser;
  if (!issue || !ensureIssueAccess(issue, authUser)) return c.json({ error: 'Issue not found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const validation = IssuePatchSchema.safeParse(body);
  if (!validation.success) {
    return c.json({ error: 'Invalid request body', details: validation.error.format() }, 400);
  }
  const patch: Partial<WorkspaceIssue> = { ...validation.data };
  if (validation.data.project_repo_id !== undefined) {
    if (validation.data.project_repo_id) {
      const repo = getManagedRepoById(validation.data.project_repo_id);
      if (!repo || repo.createdBy !== authUser.id) return c.json({ error: 'Project not found' }, 400);
      patch.project_repo_id = repo.id;
      patch.project_git_url = repo.gitUrl ?? null;
      patch.project_device_path = repo.devicePath ?? null;
      patch.project_device_link_id = repo.deviceLinkId ?? null;
    } else {
      patch.project_git_url = null;
      patch.project_device_path = null;
      patch.project_device_link_id = null;
    }
  }
  updateIssue(issue.id, patch);
  const updated = getIssueById(issue.id)!;
  const patchEvents: Array<{ type: IssueEventType; title: string; summary?: string; detail?: Record<string, unknown> }> = [];
  if (issue.title !== updated.title) patchEvents.push({ type: 'title_changed', title: 'Title changed', summary: `${issue.title.slice(0, 80)} → ${updated.title.slice(0, 80)}`, detail: { from: issue.title, to: updated.title } });
  if (issue.description !== updated.description) patchEvents.push({ type: 'description_changed', title: 'Description changed', detail: { from_length: issue.description.length, to_length: updated.description.length } });
  if (issue.status !== updated.status) patchEvents.push({ type: 'status_changed', title: 'Status changed', summary: `${issue.status} → ${updated.status}`, detail: { from: issue.status, to: updated.status } });
  if (issue.priority !== updated.priority) patchEvents.push({ type: 'priority_changed', title: 'Priority changed', summary: `${issue.priority} → ${updated.priority}`, detail: { from: issue.priority, to: updated.priority } });
  if (issue.assignee_user_id !== updated.assignee_user_id) patchEvents.push({ type: 'assignee_changed', title: 'Assignee changed', summary: `${issue.assignee_user_id ?? 'none'} → ${updated.assignee_user_id ?? 'none'}`, detail: { from: issue.assignee_user_id ?? null, to: updated.assignee_user_id ?? null } });
  if (issue.due_date !== updated.due_date) patchEvents.push({ type: 'due_date_changed', title: 'Due date changed', summary: `${issue.due_date ?? 'none'} → ${updated.due_date ?? 'none'}`, detail: { from: issue.due_date ?? null, to: updated.due_date ?? null } });
  if (issue.project_repo_id !== updated.project_repo_id) patchEvents.push({ type: 'project_changed', title: 'Project changed', detail: { from: issue.project_repo_id ?? null, to: updated.project_repo_id ?? null } });
  if (patchEvents.length === 0) patchEvents.push({ type: 'updated', title: 'Issue updated' });
  for (const ev of patchEvents) {
    const event = createIssueEvent({
      issue_id: issue.id,
      event_type: ev.type,
      actor_id: authUser.id,
      actor_type: 'user',
      title: ev.title,
      summary: ev.summary ?? null,
      detail: ev.detail ?? null,
    });
    afterIssueEventCreated(event, updated);
  }
  return c.json({ issue: updated });
});

issueRoutes.delete('/:id', authMiddleware, async (c) => {
  const issue = getIssueById(c.req.param('id'));
  const authUser = c.get('user') as AuthUser;
  if (!issue || !ensureIssueAccess(issue, authUser)) return c.json({ error: 'Issue not found' }, 404);
  deleteIssue(issue.id);
  return c.json({ success: true });
});

issueRoutes.get('/:id/runs', authMiddleware, async (c) => {
  const issue = getIssueById(c.req.param('id'));
  const authUser = c.get('user') as AuthUser;
  if (!issue || !ensureIssueAccess(issue, authUser)) return c.json({ error: 'Issue not found' }, 404);
  return c.json({ runs: listIssueAgentRuns(issue.id) });
});

issueRoutes.get('/:id/runs/:runId/events', authMiddleware, async (c) => {
  const issue = getIssueById(c.req.param('id'));
  const authUser = c.get('user') as AuthUser;
  if (!issue || !ensureIssueAccess(issue, authUser)) return c.json({ error: 'Issue not found' }, 404);
  const run = listIssueAgentRuns(issue.id).find((item) => item.id === c.req.param('runId'));
  if (!run) return c.json({ error: 'Run not found' }, 404);
  return c.json({ events: listIssueAgentRunEvents(run.id) });
});

issueRoutes.get('/:id/runs/:runId/diff', authMiddleware, async (c) => {
  const issue = getIssueById(c.req.param('id'));
  const authUser = c.get('user') as AuthUser;
  if (!issue || !ensureIssueAccess(issue, authUser)) return c.json({ error: 'Issue not found' }, 404);
  const run = listIssueAgentRuns(issue.id).find((item) => item.id === c.req.param('runId'));
  if (!run) return c.json({ error: 'Run not found' }, 404);
  const linkId = run.agent_link_id ?? issue.agent_link_id ?? issue.project_device_link_id ?? null;
  if (!linkId) return c.json({ error: 'Run has no device link for worktree diff' }, 400);
  const session = getAgentLinkSession(linkId);
  if (!session || session.state !== 'open') return c.json({ error: 'Device is offline' }, 409);
  try {
    const payload = buildIssueRunWorkspaceGitStatusPayload(issue, run);
    const result = await requestWorkspaceGitStatus(session, {
      linkId,
      ...payload,
      includeDiffStat: true,
      includePatch: true,
      timeoutMs: 30_000,
    });
    if (!result.ok) {
      return c.json({ error: result.error ?? 'Failed to read worktree diff', diff: result }, 502);
    }
    return c.json({ diff: result });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
});

issueRoutes.post('/:id/runs/:runId/commit', authMiddleware, async (c) => {
  const issue = getIssueById(c.req.param('id'));
  const authUser = c.get('user') as AuthUser;
  if (!issue || !ensureIssueAccess(issue, authUser)) return c.json({ error: 'Issue not found' }, 404);
  const run = listIssueAgentRuns(issue.id).find((item) => item.id === c.req.param('runId'));
  if (!run) return c.json({ error: 'Run not found' }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { message?: string };
  const message = (body.message ?? `chore: ${issue.title}`.slice(0, 240)).trim();
  if (!message) return c.json({ error: 'Commit message is required' }, 400);
  const linkId = run.agent_link_id ?? issue.agent_link_id ?? issue.project_device_link_id ?? null;
  if (!linkId) return c.json({ error: 'Run has no device link for worktree commit' }, 400);
  const session = getAgentLinkSession(linkId);
  if (!session || session.state !== 'open') return c.json({ error: 'Device is offline' }, 409);
  try {
    const payload = buildIssueRunWorkspaceGitStatusPayload(issue, run);
    const preCommitDiff = await requestWorkspaceGitStatus(session, {
      linkId,
      ...payload,
      includeDiffStat: true,
      includePatch: true,
      timeoutMs: 30_000,
    });
    if (!preCommitDiff.ok) {
      return c.json({ error: preCommitDiff.error ?? 'Failed to read worktree diff', diff: preCommitDiff }, 502);
    }
    const qualityEvaluation = evaluateIssueRunDeliveryQuality(issue, run);
    if (qualityEvaluation.outcome === 'failed') {
      const delivery = buildIssueRunDeliveryPayload({
        issue,
        run,
        diff: preCommitDiff,
        commit: latestIssueRunCommitFromEvents(run.id),
        qualityEvaluation,
      });
      recordIssueRunDeliveryEventOnce(
        issue.id,
        run.id,
        'delivery_quality_blocked',
        'Delivery blocked by quality gate',
        qualityEvaluation.failureCategory ?? qualityEvaluation.outcome,
        qualityEvaluation.reasons.join(' · '),
        { deliveryState: delivery.deliveryState, qualityEvaluation, action: 'commit' },
      );
      return c.json({ error: 'Delivery blocked by quality gate', qualityEvaluation, delivery }, 409);
    }
    const result = await requestWorkspaceGitCommit(session, {
      linkId,
      ...payload,
      message,
      timeoutMs: 60_000,
    });
    if (!result.ok) {
      return c.json({ error: result.error ?? 'Failed to commit worktree changes', commit: result }, 502);
    }
    recordIssueRunEvent(
      issue.id,
      run.id,
      'git_commit_created',
      'Git commit created',
      result.commit ?? null,
      message,
      {
        commit: result.commit,
        branch: result.branch,
        filesCommitted: result.filesCommitted,
        diff: {
          branch: preCommitDiff.branch,
          head: preCommitDiff.head,
          clean: preCommitDiff.clean,
          files: preCommitDiff.files,
          diffStat: preCommitDiff.diffStat,
        },
      },
    );
    const event = createIssueEvent({
      issue_id: issue.id,
      run_id: run.id,
      event_type: 'updated',
      actor_id: authUser.id,
      actor_type: 'user',
      title: 'Git commit created',
      summary: result.commit ?? null,
      detail: { message, branch: result.branch, files_committed: result.filesCommitted },
    });
    afterIssueEventCreated(event, issue);
    const delivery = buildIssueRunDeliveryPayload({ issue, run, diff: preCommitDiff, commit: result, qualityEvaluation });
    recordIssueRunDeliveryEventOnce(
      issue.id,
      run.id,
      delivery.deliveryState.stage === 'review_required' ? 'delivery_review_required' : 'delivery_commit_ready',
      delivery.deliveryState.stage === 'review_required' ? 'Delivery review required' : 'Delivery commit ready',
      result.commit ?? null,
      delivery.deliveryState.qualityGate.reason ?? message,
      { deliveryState: delivery.deliveryState, qualityEvaluation },
    );
    return c.json({ commit: result, delivery });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
});

issueRoutes.get('/:id/runs/:runId/delivery', authMiddleware, async (c) => {
  const issue = getIssueById(c.req.param('id'));
  const authUser = c.get('user') as AuthUser;
  if (!issue || !ensureIssueAccess(issue, authUser)) return c.json({ error: 'Issue not found' }, 404);
  const run = listIssueAgentRuns(issue.id).find((item) => item.id === c.req.param('runId'));
  if (!run) return c.json({ error: 'Run not found' }, 404);
  const linkId = run.agent_link_id ?? issue.agent_link_id ?? issue.project_device_link_id ?? null;
  if (!linkId) return c.json({ error: 'Run has no device link for delivery draft' }, 400);
  const session = getAgentLinkSession(linkId);
  if (!session || session.state !== 'open') return c.json({ error: 'Device is offline' }, 409);
  try {
    const payload = buildIssueRunWorkspaceGitStatusPayload(issue, run);
    const diff = await requestWorkspaceGitStatus(session, {
      linkId,
      ...payload,
      includeDiffStat: true,
      includePatch: true,
      timeoutMs: 30_000,
    });
    if (!diff.ok) {
      return c.json({ error: diff.error ?? 'Failed to read worktree diff', diff }, 502);
    }
    const eventCommit = latestIssueRunCommitFromEvents(run.id);
    const commit = eventCommit
      ? {
          ...eventCommit,
          branch: eventCommit.branch ?? diff.branch,
        }
      : null;
    const deliveryDiff = eventCommit?.diff && diff.clean ? eventCommit.diff : diff;
    const qualityEvaluation = evaluateIssueRunDeliveryQuality(issue, run);
    const delivery = buildIssueRunDeliveryPayload({ issue, run, diff: deliveryDiff, commit, qualityEvaluation });
    return c.json({
      delivery,
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
});

issueRoutes.post('/:id/runs/:runId/pull-request', authMiddleware, async (c) => {
  const issue = getIssueById(c.req.param('id'));
  const authUser = c.get('user') as AuthUser;
  if (!issue || !ensureIssueAccess(issue, authUser)) return c.json({ error: 'Issue not found' }, 404);
  const run = listIssueAgentRuns(issue.id).find((item) => item.id === c.req.param('runId'));
  if (!run) return c.json({ error: 'Run not found' }, 404);
  const body = (await c.req.json().catch(() => ({}))) as {
    title?: string;
    body?: string;
    sourceBranch?: string;
    targetBranch?: string;
    repositoryUrl?: string;
  };
  const title = (body.title ?? issue.title).trim();
  const prBody = (body.body ?? '').trim();
  const sourceBranch = (body.sourceBranch ?? '').trim();
  const targetBranch = (body.targetBranch ?? 'main').trim();
  if (!title || !prBody || !sourceBranch || !targetBranch) {
    return c.json({ error: 'PR title, body, sourceBranch, and targetBranch are required' }, 400);
  }
  const qualityEvaluation = evaluateIssueRunDeliveryQuality(issue, run);
  if (qualityEvaluation.outcome !== 'passed') {
    const eventType = qualityEvaluation.outcome === 'failed' ? 'delivery_quality_blocked' : 'delivery_review_required';
    recordIssueRunDeliveryEventOnce(
      issue.id,
      run.id,
      eventType,
      qualityEvaluation.outcome === 'failed' ? 'Delivery blocked by quality gate' : 'Delivery review required before PR/MR',
      qualityEvaluation.failureCategory ?? qualityEvaluation.outcome,
      qualityEvaluation.reasons.join(' · '),
      { evaluation: qualityEvaluation, action: 'pull_request', sourceBranch, targetBranch },
    );
    return c.json({ error: 'Quality gate must pass before creating PR/MR', qualityEvaluation }, 409);
  }
  const recordedCommit = latestIssueRunCommitFromEvents(run.id);
  if (!recordedCommit) {
    const linkId = run.agent_link_id ?? issue.agent_link_id ?? issue.project_device_link_id ?? null;
    const session = linkId ? getAgentLinkSession(linkId) : null;
    let deliveryState: ReturnType<typeof buildIssueRunDeliveryState> | undefined;
    if (linkId && session?.state === 'open') {
      const payload = buildIssueRunWorkspaceGitStatusPayload(issue, run);
      const diff = await requestWorkspaceGitStatus(session, {
        linkId,
        ...payload,
        includeDiffStat: true,
        includePatch: true,
        timeoutMs: 30_000,
      });
      if (diff.ok) {
        deliveryState = buildIssueRunDeliveryPayload({ issue, run, diff, commit: null, qualityEvaluation }).deliveryState;
      }
    }
    return c.json({
      error: 'A recorded git commit is required before creating a PR/MR',
      qualityEvaluation,
      ...(deliveryState ? { deliveryState } : {}),
    }, 409);
  }
  const result = await createIssueRunPullRequest({
    repositoryUrl: body.repositoryUrl ?? issue.project_git_url,
    title,
    body: prBody,
    sourceBranch,
    targetBranch,
  });
  if (!result.ok) {
    recordIssueRunEvent(
      issue.id,
      run.id,
      'pull_request_create_failed',
      'PR/MR creation failed',
      result.error ?? null,
      title,
      { ...result, sourceBranch, targetBranch },
    );
    return c.json({ pullRequest: result });
  }
  recordIssueRunEvent(
    issue.id,
    run.id,
    'pull_request_created',
    result.provider === 'gitlab' ? 'Merge request created' : 'Pull request created',
    result.url ?? null,
    title,
    { ...result, sourceBranch, targetBranch },
  );
  recordIssueRunDeliveryEventOnce(
    issue.id,
    run.id,
    'delivery_pr_created',
    result.provider === 'gitlab' ? 'Delivery merge request created' : 'Delivery pull request created',
    result.url ?? null,
    title,
    { ...result, sourceBranch, targetBranch, qualityEvaluation },
  );
  const event = createIssueEvent({
    issue_id: issue.id,
    run_id: run.id,
    event_type: 'updated',
    actor_id: authUser.id,
    actor_type: 'user',
    title: result.provider === 'gitlab' ? 'Merge request created' : 'Pull request created',
    summary: result.url ?? null,
    detail: { provider: result.provider, url: result.url, number: result.number, sourceBranch, targetBranch },
    reference_id: result.id ?? null,
  });
  afterIssueEventCreated(event, issue);
  return c.json({ pullRequest: result });
});

issueRoutes.get('/:id/runs/:runId/release', authMiddleware, async (c) => {
  const issue = getIssueById(c.req.param('id'));
  const authUser = c.get('user') as AuthUser;
  if (!issue || !ensureIssueAccess(issue, authUser)) return c.json({ error: 'Issue not found' }, 404);
  const run = listIssueAgentRuns(issue.id).find((item) => item.id === c.req.param('runId'));
  if (!run) return c.json({ error: 'Run not found' }, 404);
  try {
    const release = await buildIssueRunReleasePayload(issue, run);
    return c.json({ release });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
});

issueRoutes.post('/:id/runs/:runId/release/refresh', authMiddleware, async (c) => {
  const issue = getIssueById(c.req.param('id'));
  const authUser = c.get('user') as AuthUser;
  if (!issue || !ensureIssueAccess(issue, authUser)) return c.json({ error: 'Issue not found' }, 404);
  const run = listIssueAgentRuns(issue.id).find((item) => item.id === c.req.param('runId'));
  if (!run) return c.json({ error: 'Run not found' }, 404);
  try {
    const release = await buildIssueRunReleasePayload(issue, run);
    const eventType = releaseEventTypeForStage(release.releaseState.stage);
    if (eventType) {
      recordIssueRunDeliveryEventOnce(
        issue.id,
        run.id,
        eventType,
        releaseEventTitleForStage(release.releaseState.stage),
        release.releaseState.releaseGate.reason ?? release.releaseState.stage,
        release.pullRequest?.url ?? null,
        release,
      );
    }
    return c.json({ release });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
});

issueRoutes.get('/:id/runs/:runId/production-health', authMiddleware, async (c) => {
  const issue = getIssueById(c.req.param('id'));
  const authUser = c.get('user') as AuthUser;
  if (!issue || !ensureIssueAccess(issue, authUser)) return c.json({ error: 'Issue not found' }, 404);
  const run = listIssueAgentRuns(issue.id).find((item) => item.id === c.req.param('runId'));
  if (!run) return c.json({ error: 'Run not found' }, 404);
  return c.json(buildIssueRunProductionHealthPayload(run));
});

issueRoutes.post('/:id/runs/:runId/production-health/signals', authMiddleware, async (c) => {
  const issue = getIssueById(c.req.param('id'));
  const authUser = c.get('user') as AuthUser;
  if (!issue || !ensureIssueAccess(issue, authUser)) return c.json({ error: 'Issue not found' }, 404);
  const run = listIssueAgentRuns(issue.id).find((item) => item.id === c.req.param('runId'));
  if (!run) return c.json({ error: 'Run not found' }, 404);
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const signalType = body.type ?? 'healthy';
  if (!isProductionHealthSignalType(signalType)) {
    return c.json({ error: 'Invalid production health signal type' }, 400);
  }
  if (body.severity !== undefined && body.severity !== null && !isProductionHealthSeverity(body.severity)) {
    return c.json({ error: 'Invalid production health signal severity' }, 400);
  }
  const signal: ProductionHealthSignal = {
    type: signalType,
    severity: isProductionHealthSeverity(body.severity) ? body.severity : undefined,
    summary: typeof body.summary === 'string' ? body.summary : null,
    detail: typeof body.detail === 'string' ? body.detail : null,
    source: typeof body.source === 'string' ? body.source : 'manual',
    observedAt: typeof body.observedAt === 'string' ? body.observedAt : new Date().toISOString(),
    payload: body,
  };
  recordIssueRunEvent(
    issue.id,
    run.id,
    'production_health_signal_received',
    'Production health signal received',
    signal.summary ?? signal.type,
    signal.detail ?? null,
    signal as unknown as Record<string, unknown>,
  );
  return c.json(buildIssueRunProductionHealthPayload(run));
});

issueRoutes.post('/:id/runs/:runId/production-health/refresh', authMiddleware, async (c) => {
  const issue = getIssueById(c.req.param('id'));
  const authUser = c.get('user') as AuthUser;
  if (!issue || !ensureIssueAccess(issue, authUser)) return c.json({ error: 'Issue not found' }, 404);
  const run = listIssueAgentRuns(issue.id).find((item) => item.id === c.req.param('runId'));
  if (!run) return c.json({ error: 'Run not found' }, 404);
  const payload = buildIssueRunProductionHealthPayload(run);
  const eventType = productionEventTypeForStage(payload.productionHealth.stage);
  if (eventType) {
    recordIssueRunDeliveryEventOnce(
      issue.id,
      run.id,
      eventType,
      productionEventTitleForStage(payload.productionHealth.stage),
      payload.productionHealth.incident?.summary ?? payload.productionHealth.signals[payload.productionHealth.signals.length - 1]?.summary ?? payload.productionHealth.stage,
      payload.productionHealth.incident?.detail ?? null,
      payload,
    );
  }
  return c.json(payload);
});

issueRoutes.get('/:id/runs/:runId/remediation', authMiddleware, async (c) => {
  const issue = getIssueById(c.req.param('id'));
  const authUser = c.get('user') as AuthUser;
  if (!issue || !ensureIssueAccess(issue, authUser)) return c.json({ error: 'Issue not found' }, 404);
  const run = listIssueAgentRuns(issue.id).find((item) => item.id === c.req.param('runId'));
  if (!run) return c.json({ error: 'Run not found' }, 404);
  return c.json(buildIssueRunRemediationPayload(run));
});

issueRoutes.post('/:id/runs/:runId/remediation/refresh', authMiddleware, async (c) => {
  const issue = getIssueById(c.req.param('id'));
  const authUser = c.get('user') as AuthUser;
  if (!issue || !ensureIssueAccess(issue, authUser)) return c.json({ error: 'Issue not found' }, 404);
  const run = listIssueAgentRuns(issue.id).find((item) => item.id === c.req.param('runId'));
  if (!run) return c.json({ error: 'Run not found' }, 404);
  const payload = buildIssueRunRemediationPayload(run);
  const eventType = remediationEventTypeForStage(payload.remediation.stage);
  if (eventType) {
    recordIssueRunDeliveryEventOnce(
      issue.id,
      run.id,
      eventType,
      remediationEventTitleForStage(payload.remediation.stage),
      payload.remediation.proposal?.reason ?? payload.remediation.stage,
      payload.remediation.proposal?.signalStage ?? null,
      payload,
    );
  }
  return c.json(payload);
});

issueRoutes.post('/:id/runs/:runId/remediation/actions', authMiddleware, async (c) => {
  const issue = getIssueById(c.req.param('id'));
  const authUser = c.get('user') as AuthUser;
  if (!issue || !ensureIssueAccess(issue, authUser)) return c.json({ error: 'Issue not found' }, 404);
  const run = listIssueAgentRuns(issue.id).find((item) => item.id === c.req.param('runId'));
  if (!run) return c.json({ error: 'Run not found' }, 404);
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  if (!isRemediationAction(body.action)) return c.json({ error: 'Invalid remediation action' }, 400);
  const current = buildIssueRunRemediationPayload(run);
  if (current.remediation.approvalRequired && body.action !== 'request_rollback') {
    return c.json({ error: 'Approval is required before recording execution remediation actions' }, 409);
  }
  const approvalRequired = body.action === 'request_rollback';
  const action = {
    action: body.action,
    approvalRequired,
    summary: typeof body.summary === 'string' ? body.summary : null,
    detail: typeof body.detail === 'string' ? body.detail : null,
  };
  recordIssueRunEvent(
    issue.id,
    run.id,
    'remediation_action_recorded',
    'Remediation action recorded',
    action.summary ?? body.action,
    action.detail,
    { ...action, remediation: current.remediation },
  );
  return c.json({ ...buildIssueRunRemediationPayload(run), action });
});

issueRoutes.get('/:id/runs/:runId/runbook-reuse', authMiddleware, async (c) => {
  const issue = getIssueById(c.req.param('id'));
  const authUser = c.get('user') as AuthUser;
  if (!issue || !ensureIssueAccess(issue, authUser)) return c.json({ error: 'Issue not found' }, 404);
  const run = listIssueAgentRuns(issue.id).find((item) => item.id === c.req.param('runId'));
  if (!run) return c.json({ error: 'Run not found' }, 404);
  return c.json(buildIssueRunRunbookReusePayload(issue, run));
});

issueRoutes.post('/:id/runs/:runId/runbook-reuse/apply', authMiddleware, async (c) => {
  const issue = getIssueById(c.req.param('id'));
  const authUser = c.get('user') as AuthUser;
  if (!issue || !ensureIssueAccess(issue, authUser)) return c.json({ error: 'Issue not found' }, 404);
  const run = listIssueAgentRuns(issue.id).find((item) => item.id === c.req.param('runId'));
  if (!run) return c.json({ error: 'Run not found' }, 404);
  const payload = buildIssueRunRunbookReusePayload(issue, run);
  const recommendation = payload.runbookReuse.recommendation;
  if (!recommendation || recommendation.status !== 'reuse_recommended' || recommendation.approvalRequired) {
    return c.json({ error: 'Runbook reuse is not directly applicable', ...payload }, 409);
  }
  recordIssueRunDeliveryEventOnce(
    issue.id,
    run.id,
    'runbook_reuse_applied',
    'Runbook reuse applied',
    recommendation.summary,
    recommendation.detail,
    payload as unknown as Record<string, unknown>,
  );
  return c.json(buildIssueRunRunbookReusePayload(issue, run));
});

issueRoutes.get('/:id/runs/:runId/fix-run-draft', authMiddleware, async (c) => {
  const issue = getIssueById(c.req.param('id'));
  const authUser = c.get('user') as AuthUser;
  if (!issue || !ensureIssueAccess(issue, authUser)) return c.json({ error: 'Issue not found' }, 404);
  const run = listIssueAgentRuns(issue.id).find((item) => item.id === c.req.param('runId'));
  if (!run) return c.json({ error: 'Run not found' }, 404);
  return c.json(buildIssueRunFixRunDraftPayload(issue, run));
});

issueRoutes.post('/:id/runs/:runId/fix-run', authMiddleware, async (c) => {
  const issue = getIssueById(c.req.param('id'));
  const authUser = c.get('user') as AuthUser;
  if (!issue || !ensureIssueAccess(issue, authUser)) return c.json({ error: 'Issue not found' }, 404);
  const run = listIssueAgentRuns(issue.id).find((item) => item.id === c.req.param('runId'));
  if (!run) return c.json({ error: 'Run not found' }, 404);
  const payload = buildIssueRunFixRunDraftPayload(issue, run);
  const draft = payload.fixRunDraft;
  if (draft.status !== 'draft_ready' || draft.approvalRequired) {
    return c.json({ error: 'Fix run draft is not directly spawnable', ...payload }, 409);
  }

  const existing = existingFixRunForSource(issue.id, run.id);
  if (existing) return c.json({ run: existing, ...payload });

  const fixRun = createIssueAgentRun({
    id: `irun_${crypto.randomBytes(8).toString('hex')}`,
    issue_id: issue.id,
    workspace_jid: issue.workspace_jid,
    workspace_folder: issue.workspace_folder,
    agent_link_id: run.agent_link_id ?? issue.agent_link_id ?? null,
    agent_client_id: run.agent_client_id ?? issue.agent_client_id ?? null,
    execution_node: run.execution_node ?? issue.execution_node ?? null,
    backend: run.backend ?? issue.backend ?? null,
    selected_skills: run.selected_skills ?? issue.selected_skills ?? null,
    parent_run_id: run.id,
    status: 'queued',
    created_by: authUser.id,
    created_at: new Date().toISOString(),
  });
  updateIssueLastRun(issue.id, fixRun.id, 'queued');
  recordIssueRunEvent(issue.id, run.id, 'fix_run_spawned', 'Fix run spawned', fixRun.id, draft.sourceFingerprint ?? null, {
    ...payload,
    fixRunId: fixRun.id,
  });
  recordIssueRunEvent(issue.id, fixRun.id, 'run_queued', 'Fix run queued', draft.title, draft.prompt, {
    trigger: 'fix_run_spawner',
    parentRunId: run.id,
    fixRunDraft: draft,
  });
  const event = createIssueEvent({
    issue_id: issue.id,
    run_id: fixRun.id,
    event_type: 'run_created',
    actor_id: authUser.id,
    actor_type: 'user',
    title: 'Fix run enqueued',
    summary: `Spawned from run ${run.id}`,
    detail: { run_id: fixRun.id, parent_run_id: run.id, trigger: 'fix_run_spawner' },
  });
  afterIssueEventCreated(event, issue);
  enqueueIssueRun(issue.id, fixRun.id);
  return c.json({ run: fixRun, ...payload });
});

issueRoutes.get('/:id/runs/:runId/fix-run-outcome', authMiddleware, async (c) => {
  const issue = getIssueById(c.req.param('id'));
  const authUser = c.get('user') as AuthUser;
  if (!issue || !ensureIssueAccess(issue, authUser)) return c.json({ error: 'Issue not found' }, 404);
  const run = listIssueAgentRuns(issue.id).find((item) => item.id === c.req.param('runId'));
  if (!run) return c.json({ error: 'Run not found' }, 404);
  return c.json(buildIssueRunFixRunOutcomePayload(issue, run));
});

issueRoutes.post('/:id/runs/:runId/fix-run-outcome/verify', authMiddleware, async (c) => {
  const issue = getIssueById(c.req.param('id'));
  const authUser = c.get('user') as AuthUser;
  if (!issue || !ensureIssueAccess(issue, authUser)) return c.json({ error: 'Issue not found' }, 404);
  const run = listIssueAgentRuns(issue.id).find((item) => item.id === c.req.param('runId'));
  if (!run) return c.json({ error: 'Run not found' }, 404);
  const payload = buildIssueRunFixRunOutcomePayload(issue, run);
  const outcome = payload.fixRunOutcome;
  const spawnedFixRunId = run.parent_run_id ? null : spawnedFixRunIdForSource(run.id);
  if (spawnedFixRunId && !listIssueAgentRuns(issue.id).some((item) => item.id === spawnedFixRunId)) {
    return c.json({ error: 'Fix run not found', fixRunId: spawnedFixRunId, ...payload }, 404);
  }
  if (outcome.status === 'blocked' && outcome.fixRunId === 'unknown') {
    return c.json({ error: outcome.blockedReason ?? 'Fix run relationship is incomplete', ...payload }, 409);
  }
  const eventRun = listIssueAgentRuns(issue.id).find((item) => item.id === outcome.fixRunId);
  if (!eventRun) return c.json({ error: 'Fix run not found', ...payload }, 404);
  const eventType = fixRunOutcomeEventType(outcome.status);
  recordIssueRunDeliveryEventOnce(
    issue.id,
    outcome.fixRunId,
    eventType,
    outcome.title,
    outcome.summary,
    outcome.detail,
    payload as unknown as Record<string, unknown>,
  );
  return c.json(payload);
});

issueRoutes.get('/:id/runs/:runId/resolution-gate', authMiddleware, async (c) => {
  const issue = getIssueById(c.req.param('id'));
  const authUser = c.get('user') as AuthUser;
  if (!issue || !ensureIssueAccess(issue, authUser)) return c.json({ error: 'Issue not found' }, 404);
  const run = listIssueAgentRuns(issue.id).find((item) => item.id === c.req.param('runId'));
  if (!run) return c.json({ error: 'Run not found' }, 404);
  return c.json(buildIssueRunResolutionGatePayload(issue, run));
});

issueRoutes.post('/:id/runs/:runId/resolution-gate/apply', authMiddleware, async (c) => {
  const issue = getIssueById(c.req.param('id'));
  const authUser = c.get('user') as AuthUser;
  if (!issue || !ensureIssueAccess(issue, authUser)) return c.json({ error: 'Issue not found' }, 404);
  const run = listIssueAgentRuns(issue.id).find((item) => item.id === c.req.param('runId'));
  if (!run) return c.json({ error: 'Run not found' }, 404);
  const payload = buildIssueRunResolutionGatePayload(issue, run);
  const gate = payload.resolutionGate;
  if (gate.status !== 'ready' || gate.approvalRequired) {
    return c.json({ error: 'Resolution gate is not directly applicable', ...payload }, 409);
  }
  const eventRunId = gate.fixRunId ?? run.id;
  recordIssueRunDeliveryEventOnce(issue.id, eventRunId, 'resolution_gate_applied', 'Resolution gate applied', gate.summary, gate.rationale.join(' · '), payload as unknown as Record<string, unknown>);
  const targetStatus: IssueStatus = 'done';
  if (issue.status !== targetStatus) {
    updateIssue(issue.id, { status: targetStatus });
    const updated = getIssueById(issue.id) ?? issue;
    const event = createIssueEvent({
      issue_id: issue.id,
      run_id: eventRunId,
      event_type: 'status_changed',
      actor_id: authUser.id,
      actor_type: 'user',
      title: 'Resolution applied',
      summary: `${issue.status} → ${targetStatus}`,
      detail: { from: issue.status, to: targetStatus, resolutionGate: gate },
    });
    afterIssueEventCreated(event, updated);
  }
  return c.json(payload);
});

issueRoutes.get('/:id/runs/:runId/incident-knowledge', authMiddleware, async (c) => {
  const issue = getIssueById(c.req.param('id'));
  const authUser = c.get('user') as AuthUser;
  if (!issue || !ensureIssueAccess(issue, authUser)) return c.json({ error: 'Issue not found' }, 404);
  const run = listIssueAgentRuns(issue.id).find((item) => item.id === c.req.param('runId'));
  if (!run) return c.json({ error: 'Run not found' }, 404);
  return c.json(buildIssueRunIncidentKnowledgePayload(run));
});

issueRoutes.post('/:id/runs/:runId/incident-knowledge/archive', authMiddleware, async (c) => {
  const issue = getIssueById(c.req.param('id'));
  const authUser = c.get('user') as AuthUser;
  if (!issue || !ensureIssueAccess(issue, authUser)) return c.json({ error: 'Issue not found' }, 404);
  const run = listIssueAgentRuns(issue.id).find((item) => item.id === c.req.param('runId'));
  if (!run) return c.json({ error: 'Run not found' }, 404);
  const payload = buildIssueRunIncidentKnowledgePayload(run);
  if (payload.incidentKnowledge) {
    recordIssueRunDeliveryEventOnce(
      issue.id,
      run.id,
      'incident_knowledge_archived',
      'Incident knowledge archived',
      payload.incidentKnowledge.title,
      payload.incidentKnowledge.fingerprint,
      payload as unknown as Record<string, unknown>,
    );
  }
  return c.json(buildIssueRunIncidentKnowledgePayload(run));
});

issueRoutes.post('/:id/runs/:runId/review', authMiddleware, async (c) => {
  const issue = getIssueById(c.req.param('id'));
  const authUser = c.get('user') as AuthUser;
  if (!issue || !ensureIssueAccess(issue, authUser)) return c.json({ error: 'Issue not found' }, 404);
  const run = listIssueAgentRuns(issue.id).find((item) => item.id === c.req.param('runId'));
  if (!run) return c.json({ error: 'Run not found' }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { reviewPrompt?: string; comments?: unknown[] };
  const reviewPrompt = (body.reviewPrompt ?? '').trim();
  if (!reviewPrompt) return c.json({ error: 'Review prompt is required' }, 400);
  const reviewRun = createIssueAgentRun({
    id: `irun_${crypto.randomBytes(8).toString('hex')}`,
    issue_id: issue.id,
    workspace_jid: issue.workspace_jid,
    workspace_folder: issue.workspace_folder,
    agent_link_id: run.agent_link_id ?? issue.agent_link_id ?? null,
    agent_client_id: run.agent_client_id ?? issue.agent_client_id ?? null,
    execution_node: run.execution_node ?? issue.execution_node ?? null,
    backend: run.backend ?? issue.backend ?? null,
    selected_skills: run.selected_skills ?? issue.selected_skills ?? null,
    parent_run_id: run.id,
    status: 'queued',
    created_by: authUser.id,
    created_at: new Date().toISOString(),
  });
  recordIssueRunEvent(issue.id, run.id, 'review_agent_run_created', 'Review Agent run created', reviewRun.id, null, {
    reviewRunId: reviewRun.id,
    comments: Array.isArray(body.comments) ? body.comments.length : 0,
  });
  recordIssueRunEvent(issue.id, reviewRun.id, 'run_queued', 'Review run queued', 'Review Agent', reviewPrompt, {
    trigger: 'review_agent',
    parentRunId: run.id,
  });
  const event = createIssueEvent({
    issue_id: issue.id,
    run_id: reviewRun.id,
    event_type: 'run_created',
    actor_id: authUser.id,
    actor_type: 'user',
    title: 'Review Agent run enqueued',
    summary: `Reviewing run ${run.id}`,
    detail: { run_id: reviewRun.id, parent_run_id: run.id },
  });
  afterIssueEventCreated(event, issue);
  enqueueIssueRun(issue.id, reviewRun.id);
  return c.json({ run: reviewRun });
});

issueRoutes.get('/:id/events', authMiddleware, async (c) => {
  const issue = getIssueById(c.req.param('id'));
  const authUser = c.get('user') as AuthUser;
  if (!issue || !ensureIssueAccess(issue, authUser)) return c.json({ error: 'Issue not found' }, 404);
  const sinceId = c.req.query('since_id') || undefined;
  const sinceAt = c.req.query('since_at') || undefined;
  const runId = c.req.query('run_id') || undefined;
  const events = listIssueEvents(issue.id, { sinceId, sinceAt, runId });
  return c.json({ events });
});

issueRoutes.get('/:id/attachments', authMiddleware, async (c) => {
  const issue = getIssueById(c.req.param('id'));
  const authUser = c.get('user') as AuthUser;
  if (!issue || !ensureIssueAccess(issue, authUser)) return c.json({ error: 'Issue not found' }, 404);
  return c.json({ attachments: listIssueAttachments(issue.id) });
});

issueRoutes.post('/:id/attachments', authMiddleware, async (c) => {
  const issue = getIssueById(c.req.param('id'));
  const authUser = c.get('user') as AuthUser;
  if (!issue || !ensureIssueAccess(issue, authUser)) return c.json({ error: 'Issue not found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const validation = IssueAttachmentCreateSchema.safeParse(body);
  if (!validation.success) {
    return c.json({ error: 'Invalid request body', details: validation.error.format() }, 400);
  }
  const attachment = createIssueAttachment({
    id: `iatt_${crypto.randomBytes(8).toString('hex')}`,
    issue_id: issue.id,
    filename: validation.data.filename,
    mime_type: validation.data.mime_type,
    size_bytes: validation.data.size_bytes,
    data_url: validation.data.data_url,
    created_by: authUser.id,
  });
  const evAttach = createIssueEvent({
    issue_id: issue.id,
    event_type: 'attachment_added',
    actor_id: authUser.id,
    actor_type: 'user',
    title: 'Attachment added',
    summary: attachment.filename,
    detail: { attachment_id: attachment.id, filename: attachment.filename, size_bytes: attachment.size_bytes },
    reference_id: attachment.id,
  });
  afterIssueEventCreated(evAttach, issue);
  return c.json({ attachment });
});

issueRoutes.delete('/:id/attachments/:attachmentId', authMiddleware, async (c) => {
  const issue = getIssueById(c.req.param('id'));
  const authUser = c.get('user') as AuthUser;
  if (!issue || !ensureIssueAccess(issue, authUser)) return c.json({ error: 'Issue not found' }, 404);
  const attachment = getIssueAttachmentById(c.req.param('attachmentId'));
  if (!attachment || attachment.issue_id !== issue.id) return c.json({ error: 'Attachment not found' }, 404);
  deleteIssueAttachment(attachment.id);
  const evDetach = createIssueEvent({
    issue_id: issue.id,
    event_type: 'attachment_removed',
    actor_id: authUser.id,
    actor_type: 'user',
    title: 'Attachment removed',
    summary: attachment.filename,
    detail: { attachment_id: attachment.id, filename: attachment.filename },
    reference_id: attachment.id,
  });
  afterIssueEventCreated(evDetach, issue);
  return c.json({ success: true });
});

issueRoutes.post('/:id/run', authMiddleware, async (c) => {
  const issue = getIssueById(c.req.param('id'));
  const authUser = c.get('user') as AuthUser;
  if (!issue || !ensureIssueAccess(issue, authUser)) return c.json({ error: 'Issue not found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const validation = IssueRunSchema.safeParse(body);
  if (!validation.success) {
    return c.json({ error: 'Invalid request body', details: validation.error.format() }, 400);
  }
  try {
    const runInput = await validateAndBuildRunInput(authUser, issue, validation.data);
    const run = createIssueAgentRun({
      id: `irun_${crypto.randomBytes(8).toString('hex')}`,
      issue_id: issue.id,
      workspace_jid: issue.workspace_jid,
      workspace_folder: issue.workspace_folder,
      ...runInput,
      status: 'queued',
      created_by: authUser.id,
      created_at: new Date().toISOString(),
    });
    updateIssueLastRun(issue.id, run.id, 'queued');
    recordIssueRunEvent(issue.id, run.id, 'run_queued', 'Run queued', 'Started manually', null, {
      trigger: 'manual',
      issueId: issue.id,
    });
    enqueueIssueRun(issue.id, run.id);
    const evRun = createIssueEvent({
      issue_id: issue.id,
      run_id: run.id,
      event_type: 'run_created',
      actor_id: authUser.id,
      actor_type: 'user',
      title: 'Run enqueued',
      summary: 'Run created manually',
      detail: { run_id: run.id, status: run.status },
    });
    afterIssueEventCreated(evRun, issue);
    return c.json({ run });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

issueRoutes.post('/:id/runs/:runId/cancel', authMiddleware, async (c) => {
  const issue = getIssueById(c.req.param('id'));
  const authUser = c.get('user') as AuthUser;
  if (!issue || !ensureIssueAccess(issue, authUser)) return c.json({ error: 'Issue not found' }, 404);

  const run = listIssueAgentRuns(issue.id).find((item) => item.id === c.req.param('runId'));
  if (!run) return c.json({ error: 'Run not found' }, 404);
  if (run.status === 'success' || run.status === 'error' || run.status === 'canceled') {
    return c.json({ run });
  }

  const now = new Date().toISOString();
  const deps = getWebDeps();
  if (deps?.queue) {
    try {
      await deps.queue.cancelTaskRun(`${issue.workspace_jid}#issue:${run.id}`, run.id);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  }

  updateIssueAgentRun(run.id, {
    status: 'canceled',
    error: 'Canceled by user',
    run_completed_at: now,
  });
  updateIssueLastRun(issue.id, run.id, 'canceled');
  recordIssueRunEvent(issue.id, run.id, 'run_canceled', 'Run canceled', 'Canceled by user', null, {
    userId: authUser.id,
  });
  const evCancel = createIssueEvent({
    issue_id: issue.id,
    run_id: run.id,
    event_type: 'run_status_changed',
    actor_id: authUser.id,
    actor_type: 'user',
    title: 'Run canceled',
    summary: `${run.status} → canceled`,
    detail: { from: run.status, to: 'canceled', run_id: run.id, reason: 'user_cancel' },
  });
  afterIssueEventCreated(evCancel, issue);
  const updatedRun = listIssueAgentRuns(issue.id).find((item) => item.id === run.id) ?? run;
  return c.json({ run: updatedRun });
});

issueRoutes.get('/:id/runs/:runId/repo-knowledge', authMiddleware, async (c) => {
  const issue = getIssueById(c.req.param('id'));
  const authUser = c.get('user') as AuthUser;
  if (!issue || !ensureIssueAccess(issue, authUser)) return c.json({ error: 'Issue not found' }, 404);
  const run = listIssueAgentRuns(issue.id).find((item) => item.id === c.req.param('runId'));
  if (!run) return c.json({ error: 'Run not found' }, 404);
  const task = getAgentTaskById(`agtask_${run.id}`);
  const context = task?.context && typeof task.context === 'object'
    ? (task.context as Record<string, unknown>)
    : {};
  const repoKnowledge = context.repoKnowledge && typeof context.repoKnowledge === 'object'
    ? (context.repoKnowledge as Record<string, unknown>)
    : null;
  return c.json({ repoKnowledge });
});

// --- Agent requests (P1/P2) ---

issueRoutes.get('/:id/requests', authMiddleware, async (c) => {
  const issue = getIssueById(c.req.param('id'));
  const authUser = c.get('user') as AuthUser;
  if (!issue || !ensureIssueAccess(issue, authUser)) return c.json({ error: 'Issue not found' }, 404);
  const statusParam = c.req.query('status');
  const status =
    statusParam === 'pending' ||
    statusParam === 'answered' ||
    statusParam === 'expired' ||
    statusParam === 'canceled'
      ? statusParam
      : undefined;
  const requests = listIssueAgentRequests(issue.id, { status });
  return c.json({ requests });
});

issueRoutes.get('/:id/approval-requests', authMiddleware, async (c) => {
  const issue = getIssueById(c.req.param('id'));
  const authUser = c.get('user') as AuthUser;
  if (!issue || !ensureIssueAccess(issue, authUser)) return c.json({ error: 'Issue not found' }, 404);
  const statusParam = c.req.query('status');
  const status =
    statusParam === 'pending' ||
    statusParam === 'answered' ||
    statusParam === 'expired' ||
    statusParam === 'canceled'
      ? statusParam
      : undefined;
  const requests = listIssueAgentRequests(issue.id, { status }).filter((request) => request.kind === 'permission');
  return c.json({ approvalRequests: requests, requests });
});

const handleIssueAgentRequestDecision = async (c: IssueRouteContext) => {
  const issueId = c.req.param('id');
  const runId = c.req.param('runId');
  if (!issueId || !runId) return c.json({ error: 'Invalid request path' }, 400);
  const issue = getIssueById(issueId);
  const authUser = c.get('user') as AuthUser;
  if (!issue || !ensureIssueAccess(issue, authUser)) return c.json({ error: 'Issue not found' }, 404);

  const run = listIssueAgentRuns(issue.id).find((item) => item.id === runId);
  if (!run) return c.json({ error: 'Run not found' }, 404);

  const body = (await c.req.json().catch(() => ({}))) as {
    request_id?: string;
    decision?: string;
    message?: string;
    answer?: string;
  };
  const requestId = body.request_id ?? c.req.param('requestId');
  if (!requestId || (body.decision !== 'approve' && body.decision !== 'reject' && body.decision !== 'reply')) {
    return c.json({ error: 'Invalid request body' }, 400);
  }
  const reqRow = getIssueAgentRequestById(requestId);
  if (!reqRow || reqRow.issue_id !== issue.id || reqRow.run_id !== run.id) {
    return c.json({ error: 'Request not found' }, 404);
  }
  if (reqRow.status !== 'pending') {
    return c.json({ error: `Request already ${reqRow.status}` }, 409);
  }

  if (reqRow.kind === 'permission') {
    const { tokenId } = normalizeRunPermissionRequestPayload(reqRow.payload);
    const scopedToken = tokenId ? getAgentTaskScopedTokenById(tokenId) : undefined;
    if (body.decision === 'approve') {
      if (!scopedToken) {
        logAuthEvent({
          event_type: 'agent_task_token_rejected',
          username: authUser.id,
          actor_username: authUser.id,
          details: {
            source: 'permission_decision',
            taskId: `agtask_${run.id}`,
            requestId: reqRow.id,
            reason: tokenId ? 'token_not_found' : 'token_id_missing',
          },
        });
        return c.json({ error: 'Permission request is missing a valid task-scoped token' }, 403);
      }
      if (scopedToken.revoked_at || new Date(scopedToken.expires_at).getTime() <= Date.now()) {
        const reason = scopedToken.revoked_at ? 'token_revoked' : 'token_expired';
        logAuthEvent({
          event_type: 'agent_task_token_rejected',
          username: scopedToken.actor_user_id ?? authUser.id,
          actor_username: authUser.id,
          details: {
            source: 'permission_decision',
            tokenId: scopedToken.id,
            taskId: scopedToken.task_id,
            requestId: reqRow.id,
            reason,
          },
        });
        return c.json({ error: 'Permission request task-scoped token is no longer valid', reason }, 403);
      }
      const approvalCheck = evaluateAgentTaskScopedApprovalRequest(scopedToken, {
        task_id: `agtask_${run.id}`,
        agent_link_id: run.agent_link_id ?? issue.agent_link_id ?? null,
        agent_client_id: run.agent_client_id ?? issue.agent_client_id ?? null,
        workspace_folder: run.workspace_folder ?? issue.workspace_folder,
        repo_id: issue.project_repo_id ?? null,
        payload: reqRow.payload,
      });
      if (!approvalCheck.ok) {
        logAuthEvent({
          event_type: 'agent_task_token_rejected',
          username: scopedToken.actor_user_id ?? authUser.id,
          actor_username: authUser.id,
          details: {
            source: 'permission_decision',
            tokenId: scopedToken.id,
            taskId: scopedToken.task_id,
            requestId: reqRow.id,
            operation: approvalCheck.request?.operation ?? null,
            decision: approvalCheck.evaluation.decision,
            reason: approvalCheck.evaluation.reason,
          },
        });
        return c.json(
          {
            error: 'Permission request is outside task-scoped token policy',
            evaluation: approvalCheck.evaluation,
          },
          403,
        );
      }
      logAuthEvent({
        event_type: 'agent_task_token_used',
        username: scopedToken.actor_user_id ?? authUser.id,
        actor_username: authUser.id,
        details: {
          source: 'permission_decision',
          tokenId: scopedToken.id,
          taskId: scopedToken.task_id,
          requestId: reqRow.id,
          operation: approvalCheck.request?.operation ?? null,
          decision: 'approve',
          reason: approvalCheck.evaluation.reason,
        },
      });
    } else if (body.decision === 'reject') {
      logAuthEvent({
        event_type: 'agent_task_token_rejected',
        username: scopedToken?.actor_user_id ?? authUser.id,
        actor_username: authUser.id,
        details: {
          source: 'permission_decision',
          tokenId: scopedToken?.id ?? tokenId ?? null,
          taskId: scopedToken?.task_id ?? `agtask_${run.id}`,
          requestId: reqRow.id,
          reason: 'user_rejected',
        },
      });
    }
  }

  const now = new Date().toISOString();
  const updated = answerIssueAgentRequest(reqRow.id, {
    decision: body.decision,
    answer: body.answer ?? body.message ?? null,
    answered_by: authUser.id,
    now,
  });
  if (!updated) return c.json({ error: 'Failed to record decision' }, 500);

  if (reqRow.kind === 'permission' && reqRow.payload?.orchestrationPolicy === true) {
    if (body.decision === 'approve') {
      clearIssueAgentRunAwaiting(run.id);
      updateIssueAgentRun(run.id, { status: 'queued' });
      updateIssueLastRun(issue.id, run.id, 'queued');
      if (issue.status === 'waiting_for_human') {
        updateIssue(issue.id, { status: 'in_progress' });
      }
      enqueueIssueRun(issue.id, run.id);
    } else if (body.decision === 'reject') {
      clearIssueAgentRunAwaiting(run.id);
      updateIssueAgentRun(run.id, { status: 'canceled', error: 'Orchestration approval rejected' });
      updateIssueLastRun(issue.id, run.id, 'canceled');
    }
  } else {

    // Permission decisions also need to be sent back to the daemon so the agent
    // process can resume immediately. Clarification answers are picked up by the
    // IssueAutoDriver on the next tick (it inherits session_id and prompt-injects
    // the Q&A).
    if (reqRow.kind === 'permission') {
    const linkId = run.agent_link_id ?? issue.agent_link_id ?? null;
    const session = linkId ? getAgentLinkSession(linkId) : undefined;
    const meta = linkId ? getAgentLinkOnlineMeta(linkId) : undefined;
    const capable =
      !meta?.capabilities ||
      meta.capabilities.length === 0 ||
      meta.capabilities.includes('permission.decision') ||
      meta.capabilities.includes('permission_decision');
    if (session && reqRow.correlation_id) {
      try {
        session.send({
          type: 'agent.permission.decision',
          runId: run.id,
          requestId: reqRow.correlation_id,
          decision: body.decision === 'approve' ? 'approve' : 'reject',
          message: body.message,
        });
        if (!capable) {
          // Best-effort: older daemons might silently ignore; surface a hint
          // in the timeline so operators know to upgrade the daemon.
          afterIssueEventCreated(
            createIssueEvent({
              issue_id: issue.id,
              run_id: run.id,
              event_type: 'agent_request_answered',
              actor_id: authUser.id,
              actor_type: 'system',
              title: 'Daemon capability missing',
              summary: 'Daemon did not advertise permission_decision capability; decision sent best-effort',
              payload: { requestId: reqRow.id, capabilities: meta?.capabilities ?? [] },
            }),
            issue,
          );
        }
      } catch (err) {
        return c.json(
          { error: `Failed to forward decision to daemon: ${err instanceof Error ? err.message : String(err)}` },
          502,
        );
      }
    }
    // Resume the run state so the heartbeat/audit pipeline treats it as live.
    clearIssueAgentRunAwaiting(run.id);
    updateIssueAgentRun(run.id, { status: 'running' });
    if (issue.status === 'waiting_for_human') {
      updateIssue(issue.id, { status: 'in_progress' });
    }
    }
  }

  const evAns = createIssueEvent({
    issue_id: issue.id,
    run_id: run.id,
    event_type: 'agent_request_answered',
    actor_id: authUser.id,
    actor_type: 'user',
    title:
      reqRow.kind === 'permission'
        ? `Permission ${body.decision === 'approve' ? 'approved' : 'rejected'}`
        : 'Clarification answered',
    summary: (body.message ?? body.answer ?? '').slice(0, 240) || null,
    payload: {
      requestId: reqRow.id,
      kind: reqRow.kind,
      decision: body.decision,
    },
    reference_id: reqRow.id,
  });
  afterIssueEventCreated(evAns, issue);
  const deps = getWebDeps();
  deps?.broadcastIssueRequest?.(issue.workspace_jid, issue.id, updated, 'issue_request_answered');

  const updatedRun = listIssueAgentRuns(issue.id).find((item) => item.id === run.id) ?? run;
  return c.json({ request: updated, run: updatedRun });
};

issueRoutes.post('/:id/runs/:runId/decision', authMiddleware, handleIssueAgentRequestDecision);
issueRoutes.post('/:id/runs/:runId/approval-requests/:requestId/decision', authMiddleware, handleIssueAgentRequestDecision);

// --- Comments ---

issueRoutes.get('/:id/comments', authMiddleware, async (c) => {
  const issue = getIssueById(c.req.param('id'));
  const authUser = c.get('user') as AuthUser;
  if (!issue || !ensureIssueAccess(issue, authUser)) return c.json({ error: 'Issue not found' }, 404);
  const sinceAt = c.req.query('since_at') || undefined;
  const includeDeleted = c.req.query('include_deleted') === 'true';
  const comments = listIssueComments(issue.id, { sinceAt, includeDeleted: !!includeDeleted });
  return c.json({ comments });
});

issueRoutes.post('/:id/comments', authMiddleware, async (c) => {
  const issue = getIssueById(c.req.param('id'));
  const authUser = c.get('user') as AuthUser;
  if (!issue || !ensureIssueAccess(issue, authUser)) return c.json({ error: 'Issue not found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const validation = IssueCommentCreateSchema.safeParse(body);
  if (!validation.success) {
    return c.json({ error: 'Invalid request body', details: validation.error.format() }, 400);
  }
  const comment = createIssueComment({
    issue_id: issue.id,
    workspace_jid: issue.workspace_jid,
    body: validation.data.body,
    created_by: authUser.id,
    source_type: 'user',
  });
  const evComment = createIssueEvent({
    issue_id: issue.id,
    event_type: 'comment_created',
    actor_id: authUser.id,
    actor_type: 'user',
    title: 'Comment added',
    summary: comment.body.length > 160 ? comment.body.slice(0, 160) + '...' : comment.body,
    detail: { comment_id: comment.id, body_length: comment.body.length },
    reference_id: comment.id,
  });
  afterIssueEventCreated(evComment, issue);

  // P2-2: if the issue is waiting on a clarification request from the agent,
  // treat the comment as the answer so the IssueAutoDriver picks it up on the
  // next tick (it consumes the answered request and queues a resume run).
  if (issue.status === 'waiting_for_human') {
    const pending = listIssueAgentRequests(issue.id, { status: 'pending' });
    const clar = pending.find((r) => r.kind === 'clarification');
    if (clar) {
      const now = new Date().toISOString();
      const answered = answerIssueAgentRequest(clar.id, {
        decision: 'reply',
        answer: comment.body,
        answered_by: authUser.id,
        now,
      });
      if (answered) {
        const evAns = createIssueEvent({
          issue_id: issue.id,
          run_id: clar.run_id,
          event_type: 'agent_request_answered',
          actor_id: authUser.id,
          actor_type: 'user',
          title: 'Clarification answered via comment',
          summary: comment.body.slice(0, 240),
          payload: { requestId: clar.id, kind: 'clarification', via: 'comment' },
          reference_id: clar.id,
        });
        afterIssueEventCreated(evAns, issue);
        const deps = getWebDeps();
        deps?.broadcastIssueRequest?.(issue.workspace_jid, issue.id, answered, 'issue_request_answered');
      }
    }
  }

  return c.json({ comment }, 201);
});

issueRoutes.patch('/:id/comments/:commentId', authMiddleware, async (c) => {
  const issue = getIssueById(c.req.param('id'));
  const authUser = c.get('user') as AuthUser;
  if (!issue || !ensureIssueAccess(issue, authUser)) return c.json({ error: 'Issue not found' }, 404);
  const comment = getIssueCommentById(c.req.param('commentId'));
  if (!comment || comment.issue_id !== issue.id) return c.json({ error: 'Comment not found' }, 404);
  if (comment.created_by && comment.created_by !== authUser.id && authUser.role !== 'admin') {
    return c.json({ error: 'Forbidden' }, 403);
  }
  if (comment.source_type !== 'user') return c.json({ error: 'Cannot edit non-user comments' }, 400);
  const body = await c.req.json().catch(() => ({}));
  const validation = IssueCommentUpdateSchema.safeParse(body);
  if (!validation.success) {
    return c.json({ error: 'Invalid request body', details: validation.error.format() }, 400);
  }
  const updated = updateIssueComment(comment.id, validation.data.body);
  if (updated) {
    const evUpd = createIssueEvent({
      issue_id: issue.id,
      event_type: 'comment_updated',
      actor_id: authUser.id,
      actor_type: 'user',
      title: 'Comment edited',
      detail: { comment_id: updated.id, body_length: updated.body.length },
      reference_id: updated.id,
    });
    afterIssueEventCreated(evUpd, issue);
  }
  return c.json({ comment: updated });
});

issueRoutes.delete('/:id/comments/:commentId', authMiddleware, async (c) => {
  const issue = getIssueById(c.req.param('id'));
  const authUser = c.get('user') as AuthUser;
  if (!issue || !ensureIssueAccess(issue, authUser)) return c.json({ error: 'Issue not found' }, 404);
  const comment = getIssueCommentById(c.req.param('commentId'));
  if (!comment || comment.issue_id !== issue.id) return c.json({ error: 'Comment not found' }, 404);
  if (comment.created_by && comment.created_by !== authUser.id && authUser.role !== 'admin') {
    return c.json({ error: 'Forbidden' }, 403);
  }
  if (comment.source_type !== 'user') return c.json({ error: 'Cannot delete non-user comments' }, 400);
  softDeleteIssueComment(comment.id);
  const evDel = createIssueEvent({
    issue_id: issue.id,
    event_type: 'comment_deleted',
    actor_id: authUser.id,
    actor_type: 'user',
    title: 'Comment deleted',
    detail: { comment_id: comment.id },
    reference_id: comment.id,
  });
  afterIssueEventCreated(evDel, issue);
  return c.json({ success: true });
});

export default issueRoutes;
