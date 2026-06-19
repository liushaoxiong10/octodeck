import type {
  AgentTask,
  IssueAgentRequest,
  IssueAgentRun,
  IssueAgentRunEvent,
  ScheduledTask,
  TaskRunLog,
  WorkspaceIssue,
} from './types.js';
import {
  evaluateRunQuality,
  resolveIssueRunQualityWithReviewChild,
  type QualityEvaluation,
} from './quality-evaluator.js';
import { buildQualityScorecards, type QualityScorecards } from './quality-scorecards.js';

export type OrchestrationControlSource = 'issue' | 'task' | 'agent_team';
export type OrchestrationControlEventType =
  | 'policy_evaluated'
  | 'auto_executed'
  | 'approval_requested'
  | 'approval_approved'
  | 'approval_rejected'
  | 'blocked'
  | 'manual_review'
  | 'runtime_recovered'
  | 'quality_passed'
  | 'quality_failed'
  | 'quality_needs_review'
  | 'delivery_blocked'
  | 'delivery_review_required'
  | 'delivery_ready'
  | 'delivery_completed'
  | 'release_pending'
  | 'release_blocked'
  | 'release_ready'
  | 'release_completed'
  | 'release_rollback_required'
  | 'production_observing'
  | 'production_healthy'
  | 'production_degraded'
  | 'production_incident'
  | 'production_mitigation_running'
  | 'production_recovered'
  | 'production_rollback_recommended'
  | 'remediation_proposed'
  | 'remediation_waiting_approval'
  | 'remediation_running'
  | 'remediation_verifying'
  | 'remediation_resolved'
  | 'remediation_failed'
  | 'incident_detected'
  | 'incident_archived'
  | 'incident_resolved'
  | 'incident_reusable'
  | 'runbook_reuse_recommended'
  | 'runbook_reuse_applied'
  | 'runbook_reuse_blocked'
  | 'fix_run_proposed'
  | 'fix_run_spawned'
  | 'fix_run_blocked'
  | 'fix_run_verifying'
  | 'fix_run_resolved'
  | 'fix_run_failed'
  | 'fix_run_needs_review'
  | 'resolution_ready'
  | 'resolution_applied'
  | 'resolution_blocked'
  | 'resolution_needs_review'
  | 'run_waiting'
  | 'run_started'
  | 'run_completed'
  | 'run_failed';

export interface OrchestrationControlEvent {
  id: string;
  source: OrchestrationControlSource;
  sourceId: string;
  runId?: string | null;
  requestId?: string | null;
  type: OrchestrationControlEventType;
  title: string;
  summary?: string | null;
  detail?: string | null;
  status?: string | null;
  riskLevel?: string | null;
  enforcementAction?: string | null;
  createdAt: string;
  href: string;
  payload?: Record<string, unknown> | null;
}

export interface OrchestrationControlSummary {
  total: number;
  autoExecuted: number;
  waitingApproval: number;
  blocked: number;
  manualReview: number;
  recovered: number;
  failed: number;
}

export interface OrchestrationControlSnapshot {
  summary: OrchestrationControlSummary;
  quality: QualityScorecards;
  events: OrchestrationControlEvent[];
}

interface AgentTeamRunLike {
  id: string;
  prompt?: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface BuildOrchestrationControlSnapshotInput {
  issues: Partial<WorkspaceIssue>[];
  issueRunsByIssue: Record<string, Partial<IssueAgentRun>[]>;
  issueEventsByRun: Record<string, Partial<IssueAgentRunEvent>[]>;
  issueRequestsByIssue: Record<string, Partial<IssueAgentRequest>[]>;
  tasks: Partial<ScheduledTask>[];
  taskLogsByTask: Record<string, Partial<TaskRunLog>[]>;
  agentTasks: Partial<AgentTask>[];
  agentTeamRuns: AgentTeamRunLike[];
  agentTeamApprovalsByRun: Record<string, Array<Record<string, unknown>>>;
  limit?: number;
  timeline?: { source: OrchestrationControlSource; sourceId: string };
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function decisionFromContext(context: unknown): Record<string, unknown> | null {
  const object = asObject(context);
  return asObject(object?.decision);
}

function enforcementActionFromContext(context: unknown): string | null {
  const object = asObject(context);
  return stringValue(object?.enforcementAction) ?? stringValue(decisionFromContext(context)?.enforcementAction);
}

function riskLevelFromContext(context: unknown): string | null {
  return stringValue(decisionFromContext(context)?.riskLevel);
}

function eventTypeFromAgentTask(task: Partial<AgentTask>): OrchestrationControlEventType {
  const action = enforcementActionFromContext(task.context);
  if (action === 'request_approval' || task.status === 'waiting_approval') return 'approval_requested';
  if (action === 'block' || task.status === 'skipped') return 'blocked';
  if (action === 'manual_review' || task.status === 'paused') return 'manual_review';
  if (task.status === 'error' || task.status === 'lost') return 'run_failed';
  if (task.status === 'success') return 'run_completed';
  if (task.status === 'running') return 'run_started';
  return 'auto_executed';
}

function issueHref(issueId: string): string {
  return `/issues/detail/${encodeURIComponent(issueId)}`;
}

function taskHref(taskId: string): string {
  return `/tasks?task=${encodeURIComponent(taskId)}`;
}

function teamHref(runId: string): string {
  return `/agents?runId=${encodeURIComponent(runId)}`;
}

function countSummary(events: OrchestrationControlEvent[]): OrchestrationControlSummary {
  return {
    total: events.length,
    autoExecuted: events.filter((event) => event.type === 'auto_executed' || event.type === 'run_started' || event.type === 'run_completed' || event.type === 'fix_run_spawned').length,
    waitingApproval: events.filter((event) => event.type === 'approval_requested' || event.type === 'remediation_waiting_approval' || runbookApprovalRequired(event)).length,
    blocked: events.filter((event) => event.type === 'blocked' || event.type === 'delivery_blocked' || event.type === 'release_blocked' || event.type === 'release_rollback_required' || event.type === 'production_incident' || event.type === 'production_rollback_recommended' || event.type === 'remediation_waiting_approval' || event.type === 'remediation_failed' || event.type === 'incident_detected' || event.type === 'incident_archived' || event.type === 'runbook_reuse_blocked' || event.type === 'fix_run_blocked' || event.type === 'fix_run_failed' || event.type === 'resolution_blocked').length,
    manualReview: events.filter((event) => event.type === 'manual_review' || event.type === 'runbook_reuse_recommended' || event.type === 'runbook_reuse_applied' || event.type === 'fix_run_proposed' || event.type === 'fix_run_spawned' || event.type === 'fix_run_verifying' || event.type === 'fix_run_needs_review' || event.type === 'resolution_ready' || event.type === 'resolution_needs_review').length,
    recovered: events.filter((event) => event.type === 'runtime_recovered' || event.type === 'production_recovered' || event.type === 'remediation_resolved' || event.type === 'incident_resolved' || event.type === 'fix_run_resolved' || event.type === 'resolution_applied').length,
    failed: events.filter((event) => event.type === 'run_failed' || event.type === 'quality_failed' || event.type === 'release_rollback_required' || event.type === 'production_incident' || event.type === 'production_rollback_recommended' || event.type === 'remediation_failed' || event.type === 'fix_run_failed' || event.type === 'incident_archived' && event.status === 'failed' || event.status === 'error' || event.status === 'failed').length,
  };
}

function runbookReuseFromPayload(payload: Record<string, unknown> | null): Record<string, unknown> | null {
  return asObject(payload?.runbookReuse);
}

function runbookReuseRecommendationFromPayload(payload: Record<string, unknown> | null): Record<string, unknown> | null {
  return asObject(runbookReuseFromPayload(payload)?.recommendation);
}

function fixRunDraftFromPayload(payload: Record<string, unknown> | null): Record<string, unknown> | null {
  return asObject(payload?.fixRunDraft);
}

function fixRunOutcomeFromPayload(payload: Record<string, unknown> | null): Record<string, unknown> | null {
  return asObject(payload?.fixRunOutcome);
}

function resolutionGateFromPayload(payload: Record<string, unknown> | null): Record<string, unknown> | null {
  return asObject(payload?.resolutionGate);
}

function runbookApprovalRequired(event: OrchestrationControlEvent): boolean {
  return event.type === 'runbook_reuse_recommended'
    && runbookReuseRecommendationFromPayload(event.payload ?? null)?.approvalRequired === true;
}

function qualityEventType(evaluation: QualityEvaluation): OrchestrationControlEventType {
  if (evaluation.outcome === 'passed') return 'quality_passed';
  if (evaluation.outcome === 'failed') return 'quality_failed';
  return 'quality_needs_review';
}

function shouldEmitQualityEvent(evaluation: QualityEvaluation): boolean {
  return evaluation.outcome === 'failed' || evaluation.outcome === 'needs_review' || evaluation.outcome === 'partial' || evaluation.outcome === 'inconclusive';
}

function deliveryEventType(eventType: string | undefined): OrchestrationControlEventType | null {
  if (eventType === 'delivery_quality_blocked') return 'delivery_blocked';
  if (eventType === 'delivery_review_required') return 'delivery_review_required';
  if (eventType === 'delivery_commit_ready' || eventType === 'delivery_pr_ready') return 'delivery_ready';
  if (eventType === 'delivery_pr_created') return 'delivery_completed';
  return null;
}

function releaseEventType(eventType: string | undefined): OrchestrationControlEventType | null {
  if (eventType === 'release_checks_pending') return 'release_pending';
  if (eventType === 'release_checks_failed' || eventType === 'release_review_pending') return 'release_blocked';
  if (eventType === 'release_merge_ready') return 'release_ready';
  if (eventType === 'release_completed') return 'release_completed';
  if (eventType === 'release_rollback_required') return 'release_rollback_required';
  return null;
}

function productionEventType(eventType: string | undefined): OrchestrationControlEventType | null {
  if (eventType === 'production_observation_started') return 'production_observing';
  if (eventType === 'production_healthy') return 'production_healthy';
  if (eventType === 'production_health_degraded') return 'production_degraded';
  if (eventType === 'production_incident_detected') return 'production_incident';
  if (eventType === 'production_mitigation_running') return 'production_mitigation_running';
  if (eventType === 'production_recovered') return 'production_recovered';
  if (eventType === 'production_rollback_recommended') return 'production_rollback_recommended';
  return null;
}

function remediationEventType(eventType: string | undefined): OrchestrationControlEventType | null {
  if (eventType === 'remediation_proposed') return 'remediation_proposed';
  if (eventType === 'remediation_waiting_approval') return 'remediation_waiting_approval';
  if (eventType === 'remediation_running') return 'remediation_running';
  if (eventType === 'remediation_verifying') return 'remediation_verifying';
  if (eventType === 'remediation_resolved') return 'remediation_resolved';
  if (eventType === 'remediation_failed') return 'remediation_failed';
  return null;
}

function incidentKnowledgeFromPayload(payload: Record<string, unknown> | null): Record<string, unknown> | null {
  const value = asObject(payload?.incidentKnowledge);
  return value ?? asObject(asObject(payload?.incidentKnowledgePayload)?.incidentKnowledge);
}

function incidentKnowledgeEventType(eventType: string | undefined, payload: Record<string, unknown> | null): OrchestrationControlEventType | null {
  if (eventType !== 'incident_knowledge_archived') return null;
  const incident = incidentKnowledgeFromPayload(payload);
  const status = stringValue(incident?.status);
  if (status === 'resolved') return 'incident_resolved';
  if (status === 'reusable') return 'incident_reusable';
  return 'incident_archived';
}

function runbookReuseEventType(eventType: string | undefined, payload: Record<string, unknown> | null): OrchestrationControlEventType | null {
  if (eventType === 'runbook_reuse_recommended') return 'runbook_reuse_recommended';
  if (eventType === 'runbook_reuse_blocked') return 'runbook_reuse_blocked';
  if (eventType !== 'runbook_reuse_applied') return null;
  const recommendation = runbookReuseRecommendationFromPayload(payload);
  const status = stringValue(recommendation?.status);
  if (status === 'not_reusable') return 'runbook_reuse_blocked';
  if (recommendation?.approvalRequired === true || status === 'approval_required' || status === 'candidate_found') return 'runbook_reuse_recommended';
  if (status === 'reuse_recommended' && recommendation?.approvalRequired === false) return 'runbook_reuse_applied';
  return null;
}

function fixRunEventType(eventType: string | undefined): OrchestrationControlEventType | null {
  if (eventType === 'fix_run_proposed') return 'fix_run_proposed';
  if (eventType === 'fix_run_spawned') return 'fix_run_spawned';
  if (eventType === 'fix_run_blocked') return 'fix_run_blocked';
  if (eventType === 'fix_run_verifying') return 'fix_run_verifying';
  if (eventType === 'fix_run_resolved') return 'fix_run_resolved';
  if (eventType === 'fix_run_failed') return 'fix_run_failed';
  if (eventType === 'fix_run_needs_review') return 'fix_run_needs_review';
  return null;
}

function resolutionEventType(eventType: string | undefined, payload: Record<string, unknown> | null): OrchestrationControlEventType | null {
  if (eventType === 'resolution_gate_applied') return 'resolution_applied';
  if (eventType !== 'resolution_gate_ready') return null;
  const gate = resolutionGateFromPayload(payload);
  const status = stringValue(gate?.status);
  if (status === 'ready') return 'resolution_ready';
  if (status === 'approval_required') return 'resolution_needs_review';
  if (status === 'needs_review') return 'resolution_needs_review';
  return 'resolution_blocked';
}

export function buildOrchestrationControlSnapshot(
  input: BuildOrchestrationControlSnapshotInput,
): OrchestrationControlSnapshot {
  const events: OrchestrationControlEvent[] = [];
  const qualityEvaluations = buildOrchestrationQualityEvaluations(input);
  const issuesById = new Map(input.issues.flatMap((issue) => issue.id ? [[issue.id, issue]] : []));
  const tasksById = new Map(input.tasks.flatMap((task) => task.id ? [[task.id, task]] : []));

  for (const issue of input.issues) {
    if (!issue.id) continue;
    for (const run of input.issueRunsByIssue[issue.id] ?? []) {
      if (!run.id) continue;
      const issueRunEvents = input.issueEventsByRun[run.id] ?? [];
      if (run.status === 'success' || run.status === 'error' || run.status === 'canceled' || run.status === 'lost') {
        const evaluation = qualityEvaluations.find((item) => item.source === 'issue' && item.sourceId === issue.id && item.runId === run.id);
        if (evaluation && shouldEmitQualityEvent(evaluation)) {
          events.push({
            id: `quality:${evaluation.id}`,
            source: 'issue',
            sourceId: issue.id,
            runId: run.id,
            type: qualityEventType(evaluation),
            title: evaluation.outcome === 'failed' ? 'Quality gate failed' : 'Quality review required',
            summary: issue.title ?? run.id,
            detail: evaluation.reasons.join(' · '),
            status: evaluation.outcome,
            enforcementAction: evaluation.outcome,
            createdAt: evaluation.createdAt,
            href: issueHref(issue.id),
            payload: { evaluation },
          });
        }
      }
      for (const event of issueRunEvents) {
        if (event.event_type !== 'runtime_self_healed' || !event.id) continue;
        const payload = asObject(event.payload);
        events.push({
          id: `issue-event:${event.id}`,
          source: 'issue',
          sourceId: issue.id,
          runId: run.id,
          type: 'runtime_recovered',
          title: event.title ?? 'Runtime target self-healed',
          summary: event.summary ?? issue.title ?? null,
          detail: event.detail ?? null,
          status: run.status ?? null,
          enforcementAction: stringValue(payload?.strategy),
          createdAt: event.created_at ?? run.created_at ?? issue.updated_at ?? new Date(0).toISOString(),
          href: issueHref(issue.id),
          payload,
        });
      }
      for (const event of issueRunEvents) {
        const payload = asObject(event.payload);
        const incidentKnowledge = incidentKnowledgeFromPayload(payload);
        const runbookRecommendation = runbookReuseRecommendationFromPayload(payload);
        const fixRunDraft = fixRunDraftFromPayload(payload);
        const fixRunOutcome = fixRunOutcomeFromPayload(payload);
        const resolutionGate = resolutionGateFromPayload(payload);
        const type = deliveryEventType(event.event_type) ?? releaseEventType(event.event_type) ?? productionEventType(event.event_type) ?? remediationEventType(event.event_type) ?? incidentKnowledgeEventType(event.event_type, payload) ?? runbookReuseEventType(event.event_type, payload) ?? fixRunEventType(event.event_type) ?? resolutionEventType(event.event_type, payload);
        if (!type || !event.id) continue;
        events.push({
          id: `issue-event:${event.id}`,
          source: 'issue',
          sourceId: issue.id,
          runId: run.id,
          type,
          title: event.title ?? (type.startsWith('release_') ? 'Release event' : 'Delivery event'),
          summary: event.summary ?? issue.title ?? null,
          detail: event.detail ?? null,
          status: stringValue(resolutionGate?.status) ?? stringValue(fixRunOutcome?.status) ?? stringValue(fixRunDraft?.status) ?? stringValue(runbookRecommendation?.status) ?? stringValue(incidentKnowledge?.status) ?? run.status ?? null,
          riskLevel: stringValue(resolutionGate?.riskLevel) ?? stringValue(fixRunOutcome?.riskLevel) ?? stringValue(fixRunDraft?.riskLevel) ?? stringValue(runbookRecommendation?.riskLevel) ?? stringValue(incidentKnowledge?.severity),
          enforcementAction: type,
          createdAt: event.created_at ?? run.created_at ?? issue.updated_at ?? new Date(0).toISOString(),
          href: issueHref(issue.id),
          payload,
        });
      }
      if (run.status === 'awaiting_input') {
        events.push({
          id: `issue-run:${run.id}`,
          source: 'issue',
          sourceId: issue.id,
          runId: run.id,
          type: 'run_waiting',
          title: 'Issue run waiting for input',
          summary: issue.title ?? run.id,
          status: run.status,
          createdAt: run.created_at ?? issue.updated_at ?? issue.created_at ?? new Date(0).toISOString(),
          href: issueHref(issue.id),
          payload: { run },
        });
      }
    }

    for (const request of input.issueRequestsByIssue[issue.id] ?? []) {
      if (!request.id || request.kind !== 'permission') continue;
      const type: OrchestrationControlEventType = request.status === 'answered'
        ? request.decision === 'reject' ? 'approval_rejected' : 'approval_approved'
        : 'approval_requested';
      const payload = asObject(request.payload);
      const decision = asObject(payload?.decision);
      events.push({
        id: `issue-request:${request.id}`,
        source: 'issue',
        sourceId: issue.id,
        runId: request.run_id,
        requestId: request.id,
        type,
        title: request.title ?? 'Issue approval required',
        summary: request.summary ?? issue.title ?? null,
        detail: request.detail ?? null,
        status: request.status,
        riskLevel: stringValue(decision?.riskLevel),
        enforcementAction: stringValue(decision?.enforcementAction),
        createdAt: request.created_at ?? issue.updated_at ?? new Date(0).toISOString(),
        href: issueHref(issue.id),
        payload: payload ?? null,
      });
    }
  }

  for (const task of input.tasks) {
    if (!task.id) continue;
    for (const log of input.taskLogsByTask[task.id] ?? []) {
      const text = log.error ?? log.result ?? '';
      if (!/^Blocked:|^Approval required:|^Manual review required:/i.test(text)) continue;
      const type: OrchestrationControlEventType = text.startsWith('Blocked:') ? 'blocked' : text.startsWith('Approval required:') ? 'approval_requested' : 'manual_review';
      events.push({
        id: `task-log:${task.id}:${log.run_at ?? events.length}`,
        source: 'task',
        sourceId: task.id,
        type,
        title: type === 'blocked' ? 'Scheduled task blocked by policy' : type === 'approval_requested' ? 'Scheduled task requires approval' : 'Scheduled task requires manual review',
        summary: task.prompt ?? null,
        detail: text,
        status: log.status,
        createdAt: log.run_at ?? task.created_at ?? new Date(0).toISOString(),
        href: taskHref(task.id),
        payload: { log },
      });
    }
  }

  for (const agentTask of input.agentTasks) {
    const context = asObject(agentTask.context);
    if (context?.orchestrationPolicy !== true) continue;
    const sourceType = agentTask.source_type === 'issue_run' ? 'issue' : agentTask.source_type === 'scheduled_task' ? 'task' : 'agent_team';
    const sourceId = agentTask.source_ref;
    if (!sourceId) continue;
    const type = eventTypeFromAgentTask(agentTask);
    const issue = sourceType === 'issue' ? issuesById.get(sourceId) : undefined;
    const task = sourceType === 'task' ? tasksById.get(sourceId) : undefined;
    events.push({
      id: `agent-task:${agentTask.id ?? sourceId}`,
      source: sourceType,
      sourceId,
      runId: agentTask.run_ref ?? null,
      type,
      title: type === 'blocked' ? 'Policy blocked execution' : type === 'approval_requested' ? 'Policy requested approval' : 'Policy action recorded',
      summary: issue?.title ?? task?.prompt ?? sourceId,
      detail: agentTask.error ?? agentTask.result ?? null,
      status: agentTask.status ?? null,
      riskLevel: riskLevelFromContext(agentTask.context),
      enforcementAction: enforcementActionFromContext(agentTask.context),
      createdAt: agentTask.updated_at ?? agentTask.created_at ?? new Date(0).toISOString(),
      href: sourceType === 'issue' ? issueHref(sourceId) : sourceType === 'task' ? taskHref(sourceId) : teamHref(agentTask.run_ref ?? sourceId),
      payload: context,
    });
  }

  for (const run of input.agentTeamRuns) {
    if (!run.id) continue;
    if (run.status === 'waiting_approval') {
      events.push({
        id: `agent-team-run:${run.id}`,
        source: 'agent_team',
        sourceId: run.id,
        runId: run.id,
        type: 'approval_requested',
        title: 'Agent Team waiting for approval',
        summary: run.prompt ?? null,
        status: run.status,
        createdAt: run.updatedAt ?? run.createdAt ?? new Date(0).toISOString(),
        href: teamHref(run.id),
        payload: { run },
      });
    }
    for (const approval of input.agentTeamApprovalsByRun[run.id] ?? []) {
      const approvalId = stringValue(approval.id) ?? `${run.id}:${events.length}`;
      const status = stringValue(approval.status) ?? 'pending';
      events.push({
        id: `agent-team-approval:${approvalId}`,
        source: 'agent_team',
        sourceId: run.id,
        runId: run.id,
        requestId: approvalId,
        type: status === 'approved' ? 'approval_approved' : status === 'rejected' ? 'approval_rejected' : 'approval_requested',
        title: stringValue(approval.title) ?? 'Agent Team approval required',
        summary: stringValue(approval.description) ?? run.prompt ?? null,
        status,
        riskLevel: stringValue(approval.riskLevel),
        createdAt: stringValue(approval.resolvedAt) ?? stringValue(approval.createdAt) ?? run.updatedAt ?? new Date(0).toISOString(),
        href: teamHref(run.id),
        payload: approval,
      });
    }
  }

  const filtered = input.timeline
    ? events.filter((event) => event.source === input.timeline?.source && event.sourceId === input.timeline?.sourceId)
    : events;
  const sorted = filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
  const limited = sorted.slice(0, limit);
  const scopedQualityEvaluations = input.timeline
    ? qualityEvaluations.filter((evaluation) => evaluation.source === input.timeline?.source && evaluation.sourceId === input.timeline?.sourceId)
    : qualityEvaluations;
  return { summary: countSummary(sorted), quality: buildQualityScorecards(scopedQualityEvaluations), events: limited };
}

export function buildOrchestrationQualityEvaluations(
  input: BuildOrchestrationControlSnapshotInput,
): QualityEvaluation[] {
  const evaluations: QualityEvaluation[] = [];
  for (const issue of input.issues) {
    if (!issue.id) continue;
    for (const run of input.issueRunsByIssue[issue.id] ?? []) {
      if (!run.id) continue;
      if (run.status !== 'success' && run.status !== 'error' && run.status !== 'canceled' && run.status !== 'lost') continue;
      const baseEvaluation = evaluateRunQuality({
        source: 'issue',
        sourceId: issue.id,
        title: issue.title ?? run.id,
        run,
        events: input.issueEventsByRun[run.id] ?? [],
        requests: (input.issueRequestsByIssue[issue.id] ?? []).filter((request) => request.run_id === run.id),
      });
      evaluations.push(resolveIssueRunQualityWithReviewChild(baseEvaluation, {
        parentRunId: run.id,
        runs: input.issueRunsByIssue[issue.id] ?? [],
        parentEvents: input.issueEventsByRun[run.id] ?? [],
        eventsByRun: input.issueEventsByRun,
      }));
    }
  }

  for (const task of input.tasks) {
    if (!task.id) continue;
    for (const log of input.taskLogsByTask[task.id] ?? []) {
      evaluations.push(evaluateRunQuality({
        source: 'task',
        sourceId: task.id,
        title: task.prompt ?? task.id,
        taskLog: log,
      }));
    }
  }

  for (const agentTask of input.agentTasks) {
    if (agentTask.source_type === 'issue_run') continue;
    if (agentTask.status !== 'success' && agentTask.status !== 'error' && agentTask.status !== 'lost' && agentTask.status !== 'canceled') continue;
    evaluations.push(evaluateRunQuality({
      source: agentTask.source_type === 'scheduled_task' ? 'task' : 'agent_team',
      sourceId: agentTask.source_ref ?? agentTask.id ?? 'unknown',
      title: agentTask.source_ref ?? agentTask.id ?? null,
      agentTask,
    }));
  }

  return evaluations;
}
