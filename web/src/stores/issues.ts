import { create } from 'zustand';
import { api, type ApiError } from '../api/client';

export type IssueStatus = 'todo' | 'in_progress' | 'waiting_for_human' | 'review' | 'done' | 'canceled';
export type IssuePriority = 'low' | 'medium' | 'high' | 'urgent';
export type IssueViewMode = 'board' | 'list';
export type IssueSortField = 'status' | 'updated' | 'created' | 'priority' | 'due_date';

export interface WorkspaceIssue {
  id: string;
  workspace_jid: string;
  workspace_folder: string;
  title: string;
  description: string;
  status: IssueStatus;
  priority: IssuePriority;
  assignee_user_id?: string | null;
  due_date?: string | null;
  project_repo_id?: string | null;
  project_git_url?: string | null;
  project_device_path?: string | null;
  project_device_link_id?: string | null;
  agent_link_id?: string | null;
  agent_client_id?: string | null;
  execution_node?: string | null;
  backend?: string | null;
  selected_skills?: string[] | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  last_run_id?: string | null;
  last_run_status?: string | null;
  last_run_at?: string | null;
}

export interface IssueAgentRun {
  id: string;
  issue_id: string;
  status:
    | 'queued'
    | 'running'
    | 'awaiting_input'
    | 'paused'
    | 'success'
    | 'error'
    | 'canceled'
    | 'lost';
  result?: string | null;
  error?: string | null;
  session_id?: string | null;
  parent_run_id?: string | null;
  awaiting_kind?: 'permission' | 'clarification' | null;
  awaiting_payload_id?: string | null;
  last_seen_at?: string | null;
  heartbeat_deadline_at?: string | null;
  created_at: string;
  run_started_at?: string | null;
  run_completed_at?: string | null;
}

export interface AgentTaskLedgerRow {
  id: string;
  source_type: 'issue_run' | 'scheduled_task' | 'agent_team_run' | 'agent_team_task';
  source_ref: string;
  run_ref?: string | null;
  status: 'queued' | 'running' | 'awaiting_input' | 'waiting_approval' | 'paused' | 'success' | 'error' | 'canceled' | 'lost' | 'skipped';
  workspace_jid?: string | null;
  workspace_folder?: string | null;
  actor_user_id?: string | null;
  agent_link_id?: string | null;
  agent_client_id?: string | null;
  execution_node?: string | null;
  backend?: string | null;
  result?: string | null;
  error?: string | null;
  context?: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  started_at?: string | null;
  completed_at?: string | null;
}

export interface IssueAgentRequest {
  id: string;
  issue_id: string;
  run_id: string;
  kind: 'permission' | 'clarification';
  correlation_id?: string | null;
  title?: string | null;
  summary?: string | null;
  detail?: string | null;
  payload?: Record<string, unknown> | null;
  status: 'pending' | 'answered' | 'expired' | 'canceled';
  decision?: 'approve' | 'reject' | 'reply' | null;
  answer?: string | null;
  answered_at?: string | null;
  answered_by?: string | null;
  consumed_at?: string | null;
  expires_at?: string | null;
  created_at: string;
}

export interface IssueAgentRunEvent {
  id: string;
  issue_id: string;
  run_id: string;
  event_type: string;
  title?: string | null;
  summary?: string | null;
  detail?: string | null;
  payload?: Record<string, unknown> | null;
  created_at: string;
}

export interface IssueRunDiffFile {
  path: string;
  status: string;
  additions?: number;
  deletions?: number;
  patch?: string;
}

export interface IssueRunDiff {
  ok: boolean;
  workspacePath?: string;
  branch?: string;
  head?: string;
  clean: boolean;
  files: IssueRunDiffFile[];
  diffStat?: string;
  error?: string | null;
  durationMs: number;
}

export interface IssueRunCommit {
  ok: boolean;
  workspacePath?: string;
  branch?: string;
  commit?: string;
  clean: boolean;
  filesCommitted: number;
  error?: string | null;
  durationMs: number;
}

export interface IssueRunDeliveryDraft {
  deliveryState: {
    stage: 'no_changes' | 'blocked_by_quality' | 'review_required' | 'diff_ready' | 'commit_ready' | 'proposal_ready' | 'delivered';
    nextAction: 'inspect_diff' | 'commit_changes' | 'create_pr_or_mr' | 'none';
    clean: boolean;
    hasCommit: boolean;
    hasPullRequestEntrypoint: boolean;
    hasReviewComments: boolean;
    qualityGate: {
      outcome: 'passed' | 'failed' | 'partial' | 'needs_review' | 'inconclusive' | 'not_evaluated';
      allowed: boolean;
      score?: number;
      failureCategory?: string | null;
      reason?: string;
    };
    checklist: Array<{
      id: 'quality' | 'diff' | 'commit' | 'pull_request' | 'review';
      label: string;
      status: 'pending' | 'ready' | 'blocked';
      detail?: string;
    }>;
  };
  pullRequestDraft: {
    title: string;
    body: string;
    sourceBranch: string;
    targetBranch: string;
    changedFiles: string[];
    provider?: 'github' | 'gitlab' | 'codebase' | 'unknown';
    repositoryUrl?: string;
    createUrl?: string;
  };
  reviewDraft: {
    reviewPrompt: string;
    comments: Array<{
      filePath: string;
      line?: number;
      severity: 'low' | 'medium' | 'high' | 'critical';
      confidence: 'low' | 'medium' | 'high';
      category: 'correctness' | 'security' | 'performance' | 'maintainability' | 'review_required';
      body: string;
    }>;
  };
  qualityEvaluation?: {
    id: string;
    outcome: 'passed' | 'failed' | 'partial' | 'needs_review' | 'inconclusive';
    confidence: 'low' | 'medium' | 'high';
    score: number;
    failureCategory: string | null;
    needsReview: boolean;
    reasons: string[];
  };
}

export interface IssueRunPullRequestResult {
  ok: boolean;
  provider: 'github' | 'gitlab' | 'codebase' | 'unknown';
  url?: string;
  number?: number;
  id?: string;
  error?: string;
  createdAt?: string;
}

export interface IssueRunReleaseDraft {
  releaseState: {
    stage:
      | 'not_started'
      | 'pr_created'
      | 'checks_pending'
      | 'checks_failed'
      | 'review_pending'
      | 'merge_ready'
      | 'merged'
      | 'post_merge_verifying'
      | 'released'
      | 'rollback_required';
    nextAction:
      | 'create_pr_or_mr'
      | 'wait_for_checks'
      | 'fix_checks'
      | 'request_review'
      | 'merge_pr_or_mr'
      | 'verify_release'
      | 'inspect_release'
      | 'none';
    mergeable: boolean;
    pullRequest: {
      provider: 'github' | 'gitlab' | 'codebase' | 'unknown';
      url?: string;
      number?: number;
      state?: string;
    } | null;
    checks: {
      total: number;
      pending: number;
      failed: number;
      passed: number;
      items: Array<{
        name: string;
        status: 'queued' | 'in_progress' | 'completed' | 'unknown';
        conclusion?: 'success' | 'failure' | 'cancelled' | 'skipped' | 'neutral' | 'timed_out' | 'unknown' | null;
        url?: string;
      }>;
    };
    review: {
      required: boolean;
      approved: boolean;
      changesRequested: boolean;
      items: Array<{
        reviewer?: string;
        state: 'approved' | 'changes_requested' | 'commented' | 'pending' | 'unknown';
        url?: string;
      }>;
    };
    releaseGate: {
      allowed: boolean;
      reason?: string;
    };
    checklist: Array<{
      id: 'pull_request' | 'checks' | 'review' | 'mergeability' | 'post_merge';
      label: string;
      status: 'pending' | 'ready' | 'blocked';
      detail?: string;
    }>;
  };
  pullRequest: IssueRunPullRequestResult | null;
  providerStatus: {
    ok: boolean;
    provider: 'github' | 'gitlab' | 'codebase' | 'unknown';
    url?: string;
    number?: number;
    id?: string;
    state?: 'open' | 'closed' | 'merged' | 'unknown';
    mergeable?: boolean | null;
    checks: IssueRunReleaseDraft['releaseState']['checks']['items'];
    reviews: IssueRunReleaseDraft['releaseState']['review']['items'];
    mergedAt?: string | null;
    headSha?: string | null;
    targetBranch?: string | null;
    error?: string;
  } | null;
}

export interface IssueRunProductionHealthSignal {
  type: 'healthy' | 'degraded' | 'incident' | 'mitigation_running' | 'rollback_recommended' | 'recovered';
  severity?: 'info' | 'warning' | 'critical';
  summary?: string | null;
  detail?: string | null;
  source?: string | null;
  observedAt?: string | null;
  payload?: Record<string, unknown> | null;
}

export interface IssueRunProductionHealthDraft {
  productionHealth: {
    stage: 'not_observed' | 'observing' | 'healthy' | 'degraded' | 'incident_detected' | 'mitigation_running' | 'rollback_recommended' | 'recovered';
    healthy: boolean;
    severity: 'info' | 'warning' | 'critical';
    nextAction: 'wait_for_release' | 'collect_health_signal' | 'investigate_degradation' | 'mitigate_incident' | 'rollback_release' | 'none';
    incident: {
      summary?: string | null;
      detail?: string | null;
      rollbackRecommended: boolean;
    } | null;
    signals: IssueRunProductionHealthSignal[];
    checklist: Array<{
      id: 'release' | 'signals' | 'incident' | 'rollback' | 'recovery';
      label: string;
      status: 'pending' | 'ready' | 'blocked';
      detail?: string;
    }>;
  };
  releaseState: { stage: string; releaseGate?: { allowed?: boolean; reason?: string } } | null;
  signals: IssueRunProductionHealthSignal[];
}

export interface IssueRunRemediationAction {
  action: 'acknowledge' | 'mark_verifying' | 'mark_resolved' | 'spawn_fix_run' | 'request_rollback';
  approvalRequired?: boolean;
  summary?: string | null;
  detail?: string | null;
}

export interface IssueRunRemediationDraft {
  remediation: {
    stage: 'not_needed' | 'proposed' | 'waiting_approval' | 'running' | 'verifying' | 'resolved' | 'failed';
    recommendedAction: 'rerun_checks' | 'spawn_fix_run' | 'request_rollback' | 'verify_recovery' | 'none';
    riskLevel: 'low' | 'medium' | 'high' | 'critical';
    approvalRequired: boolean;
    proposal: { reason: string; source: string; signalStage: string } | null;
    checklist: Array<{
      id: 'detection' | 'proposal' | 'approval' | 'execution' | 'resolution';
      label: string;
      status: 'pending' | 'ready' | 'blocked';
      detail?: string;
    }>;
  };
  signals: Array<{
    source: 'quality' | 'delivery' | 'release' | 'production' | 'remediation';
    stage: string;
    eventType?: string | null;
    summary?: string | null;
    detail?: string | null;
    observedAt?: string | null;
  }>;
  action?: IssueRunRemediationAction;
}

export type IssueRunIncidentKnowledgeStatus = 'none' | 'open' | 'mitigating' | 'resolved' | 'failed';
export type IssueRunIncidentKnowledgeSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface IssueRunIncidentKnowledgeRemediationAction {
  action: string;
  summary: string;
  detail?: string | null;
  observedAt: string;
}

export interface IssueRunIncidentKnowledgeVerificationSignal {
  eventType: string;
  summary: string;
  observedAt: string;
}

export interface IssueRunIncidentKnowledgeEntry {
  id?: string;
  runId?: string | null;
  issueId?: string | null;
  fingerprint?: string | null;
  title?: string | null;
  status?: IssueRunIncidentKnowledgeStatus | string | null;
  severity?: IssueRunIncidentKnowledgeSeverity | string | null;
  summary?: string | null;
  detail?: string | null;
  symptoms?: string[] | null;
  remediationActions?: IssueRunIncidentKnowledgeRemediationAction[] | null;
  verificationSignals?: IssueRunIncidentKnowledgeVerificationSignal[] | null;
  preventionChecklist?: string[] | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  archivedAt?: string | null;
  archived?: boolean | null;
  payload?: Record<string, unknown> | null;
}

export interface IssueRunIncidentKnowledgeEvent {
  id?: string;
  eventType?: string | null;
  type?: 'incident_detected' | 'incident_reusable' | 'incident_archived' | 'incident_resolved' | string;
  title?: string | null;
  summary?: string | null;
  detail?: string | null;
  createdAt?: string | null;
  payload?: Record<string, unknown> | null;
}

export interface IssueRunIncidentKnowledgeDraft {
  incidentKnowledge: IssueRunIncidentKnowledgeEntry | null;
  events: IssueRunIncidentKnowledgeEvent[];
}

export type IssueRunRunbookReuseStatus = 'none' | 'candidate_found' | 'reuse_recommended' | 'approval_required' | 'not_reusable';
export type IssueRunRunbookReuseAction = 'reuse_remediation_actions' | 'request_rollback' | 'verify_recovery' | 'spawn_fix_run' | 'collect_more_signals' | 'none';

export interface IssueRunRunbookReuseDraft {
  runbookReuse: {
    recommendation: {
      status: IssueRunRunbookReuseStatus;
      action: IssueRunRunbookReuseAction;
      riskLevel: 'low' | 'medium' | 'high' | 'critical';
      confidence: 'low' | 'medium' | 'high';
      approvalRequired: boolean;
      summary: string;
      detail: string;
      sourceFingerprint?: string;
    } | null;
    matches: Array<{
      id: string;
      issueId: string;
      runId: string;
      fingerprint: string;
      title: string;
      status: IssueRunIncidentKnowledgeStatus | string;
      severity: IssueRunIncidentKnowledgeSeverity | string;
      score: number;
      confidence: 'low' | 'medium' | 'high';
      reusable: boolean;
      rationale: string[];
      remediationActions: IssueRunIncidentKnowledgeRemediationAction[];
      verificationSignals: IssueRunIncidentKnowledgeVerificationSignal[];
    }>;
    reusableActions: IssueRunIncidentKnowledgeRemediationAction[];
    checklist: Array<{ id: string; label: string; status: 'pending' | 'ready' | 'blocked'; detail?: string }>;
  };
}

export type IssueRunFixRunDraftStatus = 'none' | 'draft_ready' | 'approval_required' | 'blocked';

export interface IssueRunFixRunDraft {
  fixRunDraft: {
    status: IssueRunFixRunDraftStatus;
    title: string;
    prompt: string;
    rationale: string[];
    sourceRunId: string;
    sourceFingerprint?: string;
    remediationActions: IssueRunIncidentKnowledgeRemediationAction[];
    verificationChecklist: string[];
    riskLevel: 'low' | 'medium' | 'high' | 'critical';
    approvalRequired: boolean;
    blockedReason?: string;
  };
  run?: IssueAgentRun;
}

export type IssueRunFixRunOutcomeStatus = 'pending' | 'verifying' | 'resolved' | 'failed' | 'needs_review' | 'blocked';

export interface IssueRunFixRunOutcome {
  fixRunOutcome: {
    status: IssueRunFixRunOutcomeStatus;
    title: string;
    summary: string;
    detail: string;
    sourceRunId: string;
    fixRunId: string;
    riskLevel: string;
    resolvedSignals: string[];
    failedSignals: string[];
    verificationChecklist: string[];
    nextAction: string;
    blockedReason?: string;
  };
}

export type IssueRunResolutionGateStatus = 'ready' | 'approval_required' | 'blocked' | 'needs_review';

export interface IssueRunResolutionGate {
  resolutionGate: {
    status: IssueRunResolutionGateStatus;
    title: string;
    summary: string;
    recommendedIssueStatus: 'done' | 'review' | 'in_progress';
    archiveIncident: boolean;
    promoteRunbook: boolean;
    approvalRequired: boolean;
    sourceRunId?: string;
    fixRunId?: string;
    riskLevel: string;
    rationale: string[];
    checklist: string[];
    blockedReason?: string;
  };
}

export interface IssueRunRepoKnowledgeHit {
  chunkId: string;
  path: string;
  kind: string;
  name?: string | null;
  language?: string | null;
  startLine?: number | null;
  endLine?: number | null;
  score?: number;
  snippet?: string;
  matchedTerms?: string[];
  rationale?: string[];
  related?: Array<{
    id: string;
    fromPath: string;
    toPath?: string | null;
    edgeKind: string;
    source: string;
    confidence?: number | null;
    runId?: string | null;
  }>;
}

export interface IssueRunRepoKnowledgeExplanation {
  repoId: string;
  query: string;
  injectedAt?: string;
  architectureSummary?: string;
  riskPoints?: string[];
  hits: IssueRunRepoKnowledgeHit[];
}

export interface IssueAttachment {
  id: string;
  issue_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  data_url: string;
  created_by: string;
  created_at: string;
}

// --- Comment system ---
export type IssueCommentSourceType = 'user' | 'agent' | 'system';

export interface IssueComment {
  id: string;
  issue_id: string;
  workspace_jid: string;
  body: string;
  created_by: string | null;
  source_type: IssueCommentSourceType;
  source_meta?: Record<string, unknown> | null;
  created_at: string;
  updated_at?: string | null;
  deleted_at?: string | null;
}

// --- Generalized event timeline ---
export type IssueEventType =
  | 'created' | 'updated' | 'title_changed' | 'description_changed'
  | 'status_changed' | 'priority_changed' | 'assignee_changed' | 'due_date_changed'
  | 'project_changed' | 'agent_changed' | 'skills_changed'
  | 'comment_created' | 'comment_updated' | 'comment_deleted'
  | 'attachment_added' | 'attachment_removed'
  | 'run_created' | 'run_status_changed' | 'run_started' | 'run_succeeded'
  | 'run_failed' | 'run_canceled' | 'run_event' | 'run_delta' | 'run_result'
  | 'run_lost' | 'agent_request_created' | 'agent_request_answered' | 'agent_request_expired';

export interface IssueEvent {
  id: string;
  issue_id: string;
  run_id?: string | null;
  event_type: IssueEventType;
  actor_id?: string | null;
  actor_type: 'user' | 'agent' | 'system';
  title?: string | null;
  summary?: string | null;
  detail?: Record<string, unknown> | null;
  payload?: Record<string, unknown> | null;
  reference_id?: string | null;
  created_at: string;
}

export interface IssueFilters {
  statuses: IssueStatus[];
  priorities: IssuePriority[];
  project?: string;
  assignee?: string;
  showDone: boolean;
}

export interface IssueDisplayOptions {
  priority: boolean;
  assignee: boolean;
  description: boolean;
  dueDate: boolean;
}

export interface CreateIssueInput {
  workspace_jid?: string;
  workspace_folder?: string;
  title: string;
  description: string;
  status: IssueStatus;
  priority: IssuePriority;
  assignee_user_id?: string | null;
  due_date?: string | null;
  project_repo_id?: string | null;
  agent_link_id?: string | null;
  agent_client_id?: string | null;
  execution_node?: string | null;
  backend?: string | null;
  selected_skills?: string[];
  start_agent?: boolean;
  create_more?: boolean;
}

interface IssuesState {
  issues: WorkspaceIssue[];
  total: number;
  loading: boolean;
  error: string | null;
  query: string;
  view: IssueViewMode;
  filters: IssueFilters;
  order: { field: IssueSortField; direction: 'asc' | 'desc' };
  display: IssueDisplayOptions;
  runsByIssue: Record<string, IssueAgentRun[]>;
  runEventsByRun: Record<string, IssueAgentRunEvent[]>;
  runDiffsByRun: Record<string, IssueRunDiff>;
  runDeliveryDraftsByRun: Record<string, IssueRunDeliveryDraft>;
  runReleaseDraftsByRun: Record<string, IssueRunReleaseDraft>;
  runProductionHealthByRun: Record<string, IssueRunProductionHealthDraft>;
  runRemediationByRun: Record<string, IssueRunRemediationDraft>;
  runIncidentKnowledgeByRun: Record<string, IssueRunIncidentKnowledgeDraft | null>;
  runbookReuseByRun: Record<string, IssueRunRunbookReuseDraft | null>;
  fixRunDraftsByRun: Record<string, IssueRunFixRunDraft | null>;
  fixRunOutcomesByRun: Record<string, IssueRunFixRunOutcome | null>;
  resolutionGatesByRun: Record<string, IssueRunResolutionGate | null>;
  pullRequestResultsByRun: Record<string, IssueRunPullRequestResult>;
  runRepoKnowledgeByRun: Record<string, IssueRunRepoKnowledgeExplanation | null>;
  agentTasksByIssue: Record<string, AgentTaskLedgerRow[]>;
  attachmentsByIssue: Record<string, IssueAttachment[]>;
  // Single-issue detail cache
  issueById: Record<string, WorkspaceIssue>;
  // Timeline events by issue id
  eventsByIssue: Record<string, IssueEvent[]>;
  // Comments by issue id
  commentsByIssue: Record<string, IssueComment[]>;
  // Pending / answered agent requests (permission / clarification) by issue id
  requestsByIssue: Record<string, IssueAgentRequest[]>;
  setQuery: (query: string) => void;
  setView: (view: IssueViewMode) => void;
  setFilters: (filters: Partial<IssueFilters>) => void;
  setOrder: (order: Partial<IssuesState['order']>) => void;
  setDisplay: (display: Partial<IssueDisplayOptions>) => void;
  loadIssues: () => Promise<void>;
  createIssue: (input: CreateIssueInput) => Promise<WorkspaceIssue | null>;
  updateIssue: (id: string, patch: Partial<WorkspaceIssue>) => Promise<WorkspaceIssue | null>;
  deleteIssue: (id: string) => Promise<void>;
  runIssueAgent: (id: string) => Promise<IssueAgentRun | null>;
  loadIssueRuns: (id: string) => Promise<IssueAgentRun[]>;
  loadIssueRunEvents: (issueId: string, runId: string) => Promise<IssueAgentRunEvent[]>;
  loadIssueRunDiff: (issueId: string, runId: string) => Promise<IssueRunDiff | null>;
  commitIssueRun: (issueId: string, runId: string, message: string) => Promise<IssueRunCommit | null>;
  loadIssueRunDelivery: (issueId: string, runId: string) => Promise<IssueRunDeliveryDraft | null>;
  loadIssueRunRelease: (issueId: string, runId: string) => Promise<IssueRunReleaseDraft | null>;
  refreshIssueRunRelease: (issueId: string, runId: string) => Promise<IssueRunReleaseDraft | null>;
  loadIssueRunProductionHealth: (issueId: string, runId: string) => Promise<IssueRunProductionHealthDraft | null>;
  refreshIssueRunProductionHealth: (issueId: string, runId: string) => Promise<IssueRunProductionHealthDraft | null>;
  recordIssueRunProductionHealthSignal: (issueId: string, runId: string, signal: IssueRunProductionHealthSignal) => Promise<IssueRunProductionHealthDraft | null>;
  loadIssueRunRemediation: (issueId: string, runId: string) => Promise<IssueRunRemediationDraft | null>;
  refreshIssueRunRemediation: (issueId: string, runId: string) => Promise<IssueRunRemediationDraft | null>;
  recordIssueRunRemediationAction: (issueId: string, runId: string, action: IssueRunRemediationAction) => Promise<IssueRunRemediationDraft | null>;
  loadIssueRunIncidentKnowledge: (issueId: string, runId: string) => Promise<IssueRunIncidentKnowledgeDraft | null>;
  archiveIssueRunIncidentKnowledge: (issueId: string, runId: string) => Promise<IssueRunIncidentKnowledgeDraft | null>;
  loadIssueRunRunbookReuse: (issueId: string, runId: string) => Promise<IssueRunRunbookReuseDraft | null>;
  applyIssueRunRunbookReuse: (issueId: string, runId: string) => Promise<IssueRunRunbookReuseDraft | null>;
  loadIssueRunFixRunDraft: (issueId: string, runId: string) => Promise<IssueRunFixRunDraft | null>;
  spawnIssueRunFixRun: (issueId: string, runId: string) => Promise<IssueRunFixRunDraft | null>;
  loadIssueRunFixRunOutcome: (issueId: string, runId: string) => Promise<IssueRunFixRunOutcome | null>;
  verifyIssueRunFixRunOutcome: (issueId: string, runId: string) => Promise<IssueRunFixRunOutcome | null>;
  loadIssueRunResolutionGate: (issueId: string, runId: string) => Promise<IssueRunResolutionGate | null>;
  applyIssueRunResolutionGate: (issueId: string, runId: string) => Promise<IssueRunResolutionGate | null>;
  createIssueRunPullRequest: (issueId: string, runId: string, draft: IssueRunDeliveryDraft['pullRequestDraft']) => Promise<IssueRunPullRequestResult | null>;
  runIssueReviewAgent: (issueId: string, runId: string, draft: IssueRunDeliveryDraft['reviewDraft']) => Promise<IssueAgentRun | null>;
  loadIssueRunRepoKnowledge: (issueId: string, runId: string) => Promise<IssueRunRepoKnowledgeExplanation | null>;
  loadAgentTasksForIssue: (issueId: string) => Promise<AgentTaskLedgerRow[]>;
  cancelIssueRun: (issueId: string, runId: string) => Promise<IssueAgentRun | null>;
  loadIssueAttachments: (id: string) => Promise<IssueAttachment[]>;
  uploadIssueAttachment: (id: string, input: Omit<IssueAttachment, 'id' | 'issue_id' | 'created_by' | 'created_at'>) => Promise<IssueAttachment | null>;
  deleteIssueAttachment: (issueId: string, attachmentId: string) => Promise<void>;
  loadIssueById: (id: string) => Promise<WorkspaceIssue | null>;
  loadIssueEvents: (id: string, filters?: { sinceId?: string; sinceAt?: string; runId?: string }) => Promise<IssueEvent[]>;
  prependIssueEvent: (id: string, event: IssueEvent) => void;
  loadIssueComments: (id: string, filters?: { sinceAt?: string; includeDeleted?: boolean }) => Promise<IssueComment[]>;
  createIssueComment: (id: string, body: string) => Promise<IssueComment | null>;
  updateIssueComment: (issueId: string, commentId: string, body: string) => Promise<IssueComment | null>;
  deleteIssueComment: (issueId: string, commentId: string) => Promise<void>;
  // Agent requests
  loadIssueRequests: (id: string, opts?: { status?: IssueAgentRequest['status'] }) => Promise<IssueAgentRequest[]>;
  answerIssueRequest: (
    issueId: string,
    runId: string,
    requestId: string,
    payload: { decision: 'approve' | 'reject' | 'reply'; message?: string; answer?: string },
  ) => Promise<IssueAgentRequest | null>;
  upsertIssueRequest: (issueId: string, request: IssueAgentRequest) => void;
}

const defaultFilters: IssueFilters = {
  statuses: [],
  priorities: [],
  showDone: false,
};

const defaultDisplay: IssueDisplayOptions = {
  priority: true,
  assignee: true,
  description: true,
  dueDate: true,
};

function loadDisplay(): IssueDisplayOptions {
  try {
    const raw = localStorage.getItem('octodeck.issue.display');
    return raw ? { ...defaultDisplay, ...JSON.parse(raw) } : defaultDisplay;
  } catch {
    return defaultDisplay;
  }
}

function loadView(): IssueViewMode {
  return localStorage.getItem('octodeck.issue.view') === 'list' ? 'list' : 'board';
}

export const useIssuesStore = create<IssuesState>((set, get) => ({
  issues: [],
  total: 0,
  loading: false,
  error: null,
  query: '',
  view: loadView(),
  filters: defaultFilters,
  order: { field: 'updated', direction: 'desc' },
  display: loadDisplay(),
  runsByIssue: {},
  runEventsByRun: {},
  runDiffsByRun: {},
  runDeliveryDraftsByRun: {},
  runReleaseDraftsByRun: {},
  runProductionHealthByRun: {},
  runRemediationByRun: {},
  runIncidentKnowledgeByRun: {},
  runbookReuseByRun: {},
  fixRunDraftsByRun: {},
  fixRunOutcomesByRun: {},
  resolutionGatesByRun: {},
  pullRequestResultsByRun: {},
  runRepoKnowledgeByRun: {},
  agentTasksByIssue: {},
  attachmentsByIssue: {},
  issueById: {},
  eventsByIssue: {},
  commentsByIssue: {},
  requestsByIssue: {},

  setQuery: (query) => set({ query }),
  setView: (view) => {
    localStorage.setItem('octodeck.issue.view', view);
    set({ view });
  },
  setFilters: (filters) => set((state) => ({ filters: { ...state.filters, ...filters } })),
  setOrder: (order) => set((state) => ({ order: { ...state.order, ...order } })),
  setDisplay: (display) =>
    set((state) => {
      const next = { ...state.display, ...display };
      localStorage.setItem('octodeck.issue.display', JSON.stringify(next));
      return { display: next };
    }),

  loadIssues: async () => {
    const { query, filters, order } = get();
    set({ loading: true, error: null });
    try {
      const params = new URLSearchParams();
      if (query.trim()) params.set('q', query.trim());
      if (filters.statuses.length) params.set('status', filters.statuses.join(','));
      if (filters.priorities.length) params.set('priority', filters.priorities.join(','));
      if (filters.project) params.set('project', filters.project);
      if (filters.assignee) params.set('assignee', filters.assignee);
      if (filters.showDone) params.set('show_done', 'true');
      params.set('sort', order.field);
      params.set('direction', order.direction);
      const data = await api.get<{ issues: WorkspaceIssue[]; total: number }>(`/api/issues?${params.toString()}`);
      const cache: Record<string, WorkspaceIssue> = {};
      for (const issue of data.issues) cache[issue.id] = issue;
      set({ issues: data.issues, total: data.total, loading: false, issueById: { ...get().issueById, ...cache } });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  createIssue: async (input) => {
    try {
      const data = await api.post<{ issue: WorkspaceIssue }>('/api/issues', input);
      await get().loadIssues();
      return data.issue;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  updateIssue: async (id, patch) => {
    try {
      const data = await api.patch<{ issue: WorkspaceIssue }>(`/api/issues/${encodeURIComponent(id)}`, patch);
      set((state) => ({
        issues: state.issues.map((issue) => (issue.id === id ? data.issue : issue)),
        issueById: { ...state.issueById, [id]: data.issue },
        error: null,
      }));
      return data.issue;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  deleteIssue: async (id) => {
    try {
      await api.delete(`/api/issues/${encodeURIComponent(id)}`);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
    set((state) => {
      const { [id]: _removedIssue, ...issueById } = state.issueById;
      const { [id]: _removedRuns, ...runsByIssue } = state.runsByIssue;
      const nextRunDiffsByRun = { ...state.runDiffsByRun };
      const nextRunDeliveryDraftsByRun = { ...state.runDeliveryDraftsByRun };
      const nextRunReleaseDraftsByRun = { ...state.runReleaseDraftsByRun };
      const nextRunProductionHealthByRun = { ...state.runProductionHealthByRun };
      const nextRunRemediationByRun = { ...state.runRemediationByRun };
      const nextRunIncidentKnowledgeByRun = { ...state.runIncidentKnowledgeByRun };
      const nextRunbookReuseByRun = { ...state.runbookReuseByRun };
      const nextFixRunDraftsByRun = { ...state.fixRunDraftsByRun };
      const nextFixRunOutcomesByRun = { ...state.fixRunOutcomesByRun };
      const nextResolutionGatesByRun = { ...state.resolutionGatesByRun };
      const nextPullRequestResultsByRun = { ...state.pullRequestResultsByRun };
      const nextRunRepoKnowledgeByRun = { ...state.runRepoKnowledgeByRun };
      for (const run of _removedRuns ?? []) delete nextRunDiffsByRun[run.id];
      for (const run of _removedRuns ?? []) delete nextRunDeliveryDraftsByRun[run.id];
      for (const run of _removedRuns ?? []) delete nextRunReleaseDraftsByRun[run.id];
      for (const run of _removedRuns ?? []) delete nextRunProductionHealthByRun[run.id];
      for (const run of _removedRuns ?? []) delete nextRunRemediationByRun[run.id];
      for (const run of _removedRuns ?? []) delete nextRunIncidentKnowledgeByRun[run.id];
      for (const run of _removedRuns ?? []) delete nextRunbookReuseByRun[run.id];
      for (const run of _removedRuns ?? []) delete nextFixRunDraftsByRun[run.id];
      for (const run of _removedRuns ?? []) delete nextFixRunOutcomesByRun[run.id];
      for (const run of _removedRuns ?? []) delete nextResolutionGatesByRun[run.id];
      for (const run of _removedRuns ?? []) delete nextPullRequestResultsByRun[run.id];
      for (const run of _removedRuns ?? []) delete nextRunRepoKnowledgeByRun[run.id];
      const { [id]: _removedAttachments, ...attachmentsByIssue } = state.attachmentsByIssue;
      const { [id]: _removedAgentTasks, ...agentTasksByIssue } = state.agentTasksByIssue;
      const { [id]: _removedEvents, ...eventsByIssue } = state.eventsByIssue;
      const { [id]: _removedComments, ...commentsByIssue } = state.commentsByIssue;
      const { [id]: _removedRequests, ...requestsByIssue } = state.requestsByIssue;
      return {
        issues: state.issues.filter((issue) => issue.id !== id),
        total: Math.max(0, state.total - 1),
        issueById,
        runsByIssue,
        runDiffsByRun: nextRunDiffsByRun,
        runDeliveryDraftsByRun: nextRunDeliveryDraftsByRun,
        runReleaseDraftsByRun: nextRunReleaseDraftsByRun,
        runProductionHealthByRun: nextRunProductionHealthByRun,
        runRemediationByRun: nextRunRemediationByRun,
        runIncidentKnowledgeByRun: nextRunIncidentKnowledgeByRun,
        runbookReuseByRun: nextRunbookReuseByRun,
        fixRunDraftsByRun: nextFixRunDraftsByRun,
        fixRunOutcomesByRun: nextFixRunOutcomesByRun,
        resolutionGatesByRun: nextResolutionGatesByRun,
        pullRequestResultsByRun: nextPullRequestResultsByRun,
        runRepoKnowledgeByRun: nextRunRepoKnowledgeByRun,
        agentTasksByIssue,
        attachmentsByIssue,
        eventsByIssue,
        commentsByIssue,
        requestsByIssue,
      };
    });
  },

  runIssueAgent: async (id) => {
    try {
      const data = await api.post<{ run: IssueAgentRun }>(`/api/issues/${encodeURIComponent(id)}/run`, {});
      await get().loadIssues();
      await get().loadIssueRuns(id);
      await get().loadIssueEvents(id);
      return data.run;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  loadIssueRuns: async (id) => {
    try {
      const data = await api.get<{ runs: IssueAgentRun[] }>(`/api/issues/${encodeURIComponent(id)}/runs`);
      set((state) => ({ runsByIssue: { ...state.runsByIssue, [id]: data.runs } }));
      return data.runs;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return [];
    }
  },

  loadIssueRunEvents: async (issueId, runId) => {
    try {
      const data = await api.get<{ events: IssueAgentRunEvent[] }>(`/api/issues/${encodeURIComponent(issueId)}/runs/${encodeURIComponent(runId)}/events`);
      set((state) => ({ runEventsByRun: { ...state.runEventsByRun, [runId]: data.events } }));
      return data.events;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return [];
    }
  },

  loadIssueRunDiff: async (issueId, runId) => {
    try {
      const data = await api.get<{ diff: IssueRunDiff }>(`/api/issues/${encodeURIComponent(issueId)}/runs/${encodeURIComponent(runId)}/diff`);
      set((state) => ({ runDiffsByRun: { ...state.runDiffsByRun, [runId]: data.diff } }));
      return data.diff;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  commitIssueRun: async (issueId, runId, message) => {
    try {
      const data = await api.post<{ commit: IssueRunCommit; delivery?: IssueRunDeliveryDraft }>(
        `/api/issues/${encodeURIComponent(issueId)}/runs/${encodeURIComponent(runId)}/commit`,
        { message },
      );
      if (data.delivery) {
        set((state) => ({
          runDeliveryDraftsByRun: { ...state.runDeliveryDraftsByRun, [runId]: data.delivery! },
        }));
      }
      await get().loadIssueEvents(issueId);
      await get().loadIssueRunDiff(issueId, runId);
      return data.commit;
    } catch (err) {
      const apiError = err as ApiError;
      const delivery = apiError?.body?.delivery as IssueRunDeliveryDraft | undefined;
      if (delivery) {
        set((state) => ({
          error: apiError.message ?? 'Delivery blocked by quality gate',
          runDeliveryDraftsByRun: { ...state.runDeliveryDraftsByRun, [runId]: delivery },
        }));
      } else {
        set({ error: err instanceof Error ? err.message : apiError?.message ?? String(err) });
      }
      return null;
    }
  },

  loadIssueRunDelivery: async (issueId, runId) => {
    try {
      const data = await api.get<{ delivery: IssueRunDeliveryDraft }>(
        `/api/issues/${encodeURIComponent(issueId)}/runs/${encodeURIComponent(runId)}/delivery`,
      );
      set((state) => ({
        runDeliveryDraftsByRun: { ...state.runDeliveryDraftsByRun, [runId]: data.delivery },
      }));
      return data.delivery;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  loadIssueRunRelease: async (issueId, runId) => {
    try {
      const data = await api.get<{ release: IssueRunReleaseDraft }>(
        `/api/issues/${encodeURIComponent(issueId)}/runs/${encodeURIComponent(runId)}/release`,
      );
      set((state) => ({
        runReleaseDraftsByRun: { ...state.runReleaseDraftsByRun, [runId]: data.release },
      }));
      return data.release;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  refreshIssueRunRelease: async (issueId, runId) => {
    try {
      const data = await api.post<{ release: IssueRunReleaseDraft }>(
        `/api/issues/${encodeURIComponent(issueId)}/runs/${encodeURIComponent(runId)}/release/refresh`,
        {},
      );
      set((state) => ({
        runReleaseDraftsByRun: { ...state.runReleaseDraftsByRun, [runId]: data.release },
      }));
      await get().loadIssueEvents(issueId);
      await get().loadIssueRunEvents(issueId, runId);
      return data.release;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  loadIssueRunProductionHealth: async (issueId, runId) => {
    try {
      const data = await api.get<IssueRunProductionHealthDraft>(
        `/api/issues/${encodeURIComponent(issueId)}/runs/${encodeURIComponent(runId)}/production-health`,
      );
      set((state) => ({
        runProductionHealthByRun: { ...state.runProductionHealthByRun, [runId]: data },
      }));
      return data;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  refreshIssueRunProductionHealth: async (issueId, runId) => {
    try {
      const data = await api.post<IssueRunProductionHealthDraft>(
        `/api/issues/${encodeURIComponent(issueId)}/runs/${encodeURIComponent(runId)}/production-health/refresh`,
        {},
      );
      set((state) => ({
        runProductionHealthByRun: { ...state.runProductionHealthByRun, [runId]: data },
      }));
      await get().loadIssueEvents(issueId);
      await get().loadIssueRunEvents(issueId, runId);
      return data;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  recordIssueRunProductionHealthSignal: async (issueId, runId, signal) => {
    try {
      const data = await api.post<IssueRunProductionHealthDraft>(
        `/api/issues/${encodeURIComponent(issueId)}/runs/${encodeURIComponent(runId)}/production-health/signals`,
        signal,
      );
      set((state) => ({
        runProductionHealthByRun: { ...state.runProductionHealthByRun, [runId]: data },
      }));
      await get().loadIssueEvents(issueId);
      await get().loadIssueRunEvents(issueId, runId);
      return data;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  loadIssueRunRemediation: async (issueId, runId) => {
    try {
      const data = await api.get<IssueRunRemediationDraft>(
        `/api/issues/${encodeURIComponent(issueId)}/runs/${encodeURIComponent(runId)}/remediation`,
      );
      set((state) => ({
        runRemediationByRun: { ...state.runRemediationByRun, [runId]: data },
      }));
      return data;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  refreshIssueRunRemediation: async (issueId, runId) => {
    try {
      const data = await api.post<IssueRunRemediationDraft>(
        `/api/issues/${encodeURIComponent(issueId)}/runs/${encodeURIComponent(runId)}/remediation/refresh`,
        {},
      );
      set((state) => ({
        runRemediationByRun: { ...state.runRemediationByRun, [runId]: data },
      }));
      await get().loadIssueEvents(issueId);
      await get().loadIssueRunEvents(issueId, runId);
      return data;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  recordIssueRunRemediationAction: async (issueId, runId, action) => {
    try {
      const data = await api.post<IssueRunRemediationDraft>(
        `/api/issues/${encodeURIComponent(issueId)}/runs/${encodeURIComponent(runId)}/remediation/actions`,
        action,
      );
      set((state) => ({
        runRemediationByRun: { ...state.runRemediationByRun, [runId]: data },
      }));
      await get().loadIssueEvents(issueId);
      await get().loadIssueRunEvents(issueId, runId);
      return data;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  loadIssueRunIncidentKnowledge: async (issueId, runId) => {
    try {
      const data = await api.get<IssueRunIncidentKnowledgeDraft>(
        `/api/issues/${encodeURIComponent(issueId)}/runs/${encodeURIComponent(runId)}/incident-knowledge`,
      );
      set((state) => ({
        runIncidentKnowledgeByRun: { ...state.runIncidentKnowledgeByRun, [runId]: data },
      }));
      return data;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  archiveIssueRunIncidentKnowledge: async (issueId, runId) => {
    try {
      const data = await api.post<IssueRunIncidentKnowledgeDraft>(
        `/api/issues/${encodeURIComponent(issueId)}/runs/${encodeURIComponent(runId)}/incident-knowledge/archive`,
        {},
      );
      set((state) => ({
        runIncidentKnowledgeByRun: { ...state.runIncidentKnowledgeByRun, [runId]: data },
      }));
      await get().loadIssueEvents(issueId);
      await get().loadIssueRunEvents(issueId, runId);
      return data;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  loadIssueRunRunbookReuse: async (issueId, runId) => {
    try {
      const data = await api.get<IssueRunRunbookReuseDraft>(
        `/api/issues/${encodeURIComponent(issueId)}/runs/${encodeURIComponent(runId)}/runbook-reuse`,
      );
      set((state) => ({
        runbookReuseByRun: { ...state.runbookReuseByRun, [runId]: data },
      }));
      return data;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  applyIssueRunRunbookReuse: async (issueId, runId) => {
    try {
      const data = await api.post<IssueRunRunbookReuseDraft>(
        `/api/issues/${encodeURIComponent(issueId)}/runs/${encodeURIComponent(runId)}/runbook-reuse/apply`,
        {},
      );
      set((state) => ({
        runbookReuseByRun: { ...state.runbookReuseByRun, [runId]: data },
      }));
      await get().loadIssueEvents(issueId);
      await get().loadIssueRunEvents(issueId, runId);
      return data;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  loadIssueRunFixRunDraft: async (issueId, runId) => {
    try {
      const data = await api.get<IssueRunFixRunDraft>(
        `/api/issues/${encodeURIComponent(issueId)}/runs/${encodeURIComponent(runId)}/fix-run-draft`,
      );
      set((state) => ({
        fixRunDraftsByRun: { ...state.fixRunDraftsByRun, [runId]: data },
      }));
      return data;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  spawnIssueRunFixRun: async (issueId, runId) => {
    try {
      const data = await api.post<IssueRunFixRunDraft>(
        `/api/issues/${encodeURIComponent(issueId)}/runs/${encodeURIComponent(runId)}/fix-run`,
        {},
      );
      set((state) => ({
        fixRunDraftsByRun: { ...state.fixRunDraftsByRun, [runId]: data },
      }));
      await get().loadIssueRuns(issueId);
      await get().loadIssueEvents(issueId);
      await get().loadIssueRunEvents(issueId, runId);
      return data;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  loadIssueRunFixRunOutcome: async (issueId, runId) => {
    try {
      const data = await api.get<IssueRunFixRunOutcome>(
        `/api/issues/${encodeURIComponent(issueId)}/runs/${encodeURIComponent(runId)}/fix-run-outcome`,
      );
      set((state) => ({
        fixRunOutcomesByRun: { ...state.fixRunOutcomesByRun, [runId]: data },
      }));
      return data;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  verifyIssueRunFixRunOutcome: async (issueId, runId) => {
    try {
      const data = await api.post<IssueRunFixRunOutcome>(
        `/api/issues/${encodeURIComponent(issueId)}/runs/${encodeURIComponent(runId)}/fix-run-outcome/verify`,
        {},
      );
      const resolutionGatesByRun = { ...get().resolutionGatesByRun };
      delete resolutionGatesByRun[runId];
      set((state) => ({
        fixRunOutcomesByRun: { ...state.fixRunOutcomesByRun, [runId]: data },
        resolutionGatesByRun,
      }));
      await get().loadIssueEvents(issueId);
      await get().loadIssueRunEvents(issueId, runId);
      return data;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  loadIssueRunResolutionGate: async (issueId, runId) => {
    try {
      const data = await api.get<IssueRunResolutionGate>(
        `/api/issues/${encodeURIComponent(issueId)}/runs/${encodeURIComponent(runId)}/resolution-gate`,
      );
      set((state) => ({
        resolutionGatesByRun: { ...state.resolutionGatesByRun, [runId]: data },
      }));
      return data;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  applyIssueRunResolutionGate: async (issueId, runId) => {
    try {
      const data = await api.post<IssueRunResolutionGate>(
        `/api/issues/${encodeURIComponent(issueId)}/runs/${encodeURIComponent(runId)}/resolution-gate/apply`,
        {},
      );
      set((state) => ({
        resolutionGatesByRun: { ...state.resolutionGatesByRun, [runId]: data },
      }));
      await get().loadIssueById(issueId);
      await get().loadIssueEvents(issueId);
      await get().loadIssueRunEvents(issueId, runId);
      return data;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  createIssueRunPullRequest: async (issueId, runId, draft) => {
    try {
      const data = await api.post<{ pullRequest: IssueRunPullRequestResult }>(
        `/api/issues/${encodeURIComponent(issueId)}/runs/${encodeURIComponent(runId)}/pull-request`,
        {
          title: draft.title,
          body: draft.body,
          sourceBranch: draft.sourceBranch,
          targetBranch: draft.targetBranch,
          repositoryUrl: draft.repositoryUrl,
        },
      );
      set((state) => ({
        pullRequestResultsByRun: { ...state.pullRequestResultsByRun, [runId]: data.pullRequest },
      }));
      await get().loadIssueEvents(issueId);
      await get().loadIssueRunEvents(issueId, runId);
      return data.pullRequest;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  runIssueReviewAgent: async (issueId, runId, draft) => {
    try {
      const data = await api.post<{ run: IssueAgentRun }>(
        `/api/issues/${encodeURIComponent(issueId)}/runs/${encodeURIComponent(runId)}/review`,
        { reviewPrompt: draft.reviewPrompt, comments: draft.comments },
      );
      await get().loadIssueRuns(issueId);
      await get().loadIssueEvents(issueId);
      return data.run;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  loadIssueRunRepoKnowledge: async (issueId, runId) => {
    try {
      const data = await api.get<{ repoKnowledge: IssueRunRepoKnowledgeExplanation | null }>(
        `/api/issues/${encodeURIComponent(issueId)}/runs/${encodeURIComponent(runId)}/repo-knowledge`,
      );
      set((state) => ({
        runRepoKnowledgeByRun: { ...state.runRepoKnowledgeByRun, [runId]: data.repoKnowledge },
      }));
      return data.repoKnowledge;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  loadAgentTasksForIssue: async (issueId) => {
    try {
      const data = await api.get<{ tasks: AgentTaskLedgerRow[] }>(
        `/api/tasks/agent-runs?source_type=issue_run&source_ref=${encodeURIComponent(issueId)}`,
      );
      set((state) => ({
        agentTasksByIssue: { ...state.agentTasksByIssue, [issueId]: data.tasks ?? [] },
      }));
      return data.tasks ?? [];
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return [];
    }
  },

  cancelIssueRun: async (issueId, runId) => {
    try {
      const data = await api.post<{ run: IssueAgentRun }>(`/api/issues/${encodeURIComponent(issueId)}/runs/${encodeURIComponent(runId)}/cancel`, {});
      await get().loadIssues();
      await get().loadIssueRuns(issueId);
      return data.run;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  loadIssueAttachments: async (id) => {
    try {
      const data = await api.get<{ attachments: IssueAttachment[] }>(`/api/issues/${encodeURIComponent(id)}/attachments`);
      set((state) => ({ attachmentsByIssue: { ...state.attachmentsByIssue, [id]: data.attachments } }));
      return data.attachments;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return [];
    }
  },

  uploadIssueAttachment: async (id, input) => {
    try {
      const data = await api.post<{ attachment: IssueAttachment }>(`/api/issues/${encodeURIComponent(id)}/attachments`, input);
      set((state) => ({
        attachmentsByIssue: {
          ...state.attachmentsByIssue,
          [id]: [data.attachment, ...(state.attachmentsByIssue[id] ?? [])],
        },
      }));
      return data.attachment;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  deleteIssueAttachment: async (issueId, attachmentId) => {
    await api.delete(`/api/issues/${encodeURIComponent(issueId)}/attachments/${encodeURIComponent(attachmentId)}`);
    set((state) => ({
      attachmentsByIssue: {
        ...state.attachmentsByIssue,
        [issueId]: (state.attachmentsByIssue[issueId] ?? []).filter((item) => item.id !== attachmentId),
      },
    }));
  },

  loadIssueById: async (id) => {
    try {
      const data = await api.get<{ issue: WorkspaceIssue }>(`/api/issues/${encodeURIComponent(id)}`);
      set((state) => {
        const issueExists = state.issues.some((i) => i.id === id);
        return {
          issueById: { ...state.issueById, [id]: data.issue },
          issues: issueExists
            ? state.issues.map((issue) => (issue.id === id ? data.issue : issue))
            : state.issues,
        };
      });
      return data.issue;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  loadIssueEvents: async (id, filters) => {
    try {
      const params = new URLSearchParams();
      if (filters?.sinceId) params.set('since_id', filters.sinceId);
      if (filters?.sinceAt) params.set('since_at', filters.sinceAt);
      if (filters?.runId) params.set('run_id', filters.runId);
      const qs = params.toString();
      const data = await api.get<{ events: IssueEvent[] }>(
        `/api/issues/${encodeURIComponent(id)}/events${qs ? `?${qs}` : ''}`,
      );
      set((state) => {
        const existing = state.eventsByIssue[id] ?? [];
        const map = new Map<string, IssueEvent>();
        for (const ev of existing) map.set(ev.id, ev);
        for (const ev of data.events) map.set(ev.id, ev);
        const merged = Array.from(map.values()).sort(
          (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
        );
        return { eventsByIssue: { ...state.eventsByIssue, [id]: merged } };
      });
      return data.events;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return [];
    }
  },

  prependIssueEvent: (id, event) => {
    set((state) => {
      const existing = state.eventsByIssue[id] ?? [];
      if (existing.some((ev) => ev.id === event.id)) return state;
      return {
        eventsByIssue: {
          ...state.eventsByIssue,
          [id]: [event, ...existing],
        },
      };
    });
  },

  loadIssueComments: async (id, filters) => {
    try {
      const params = new URLSearchParams();
      if (filters?.sinceAt) params.set('since_at', filters.sinceAt);
      if (filters?.includeDeleted) params.set('include_deleted', 'true');
      const qs = params.toString();
      const data = await api.get<{ comments: IssueComment[] }>(
        `/api/issues/${encodeURIComponent(id)}/comments${qs ? `?${qs}` : ''}`,
      );
      set((state) => ({
        commentsByIssue: { ...state.commentsByIssue, [id]: data.comments },
      }));
      return data.comments;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return [];
    }
  },

  createIssueComment: async (id, body) => {
    try {
      const data = await api.post<{ comment: IssueComment }>(
        `/api/issues/${encodeURIComponent(id)}/comments`,
        { body },
      );
      set((state) => ({
        commentsByIssue: {
          ...state.commentsByIssue,
          [id]: [...(state.commentsByIssue[id] ?? []), data.comment],
        },
      }));
      await get().loadIssueEvents(id);
      return data.comment;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  updateIssueComment: async (issueId, commentId, body) => {
    try {
      const data = await api.patch<{ comment: IssueComment }>(
        `/api/issues/${encodeURIComponent(issueId)}/comments/${encodeURIComponent(commentId)}`,
        { body },
      );
      set((state) => ({
        commentsByIssue: {
          ...state.commentsByIssue,
          [issueId]: (state.commentsByIssue[issueId] ?? []).map((c) =>
            c.id === commentId ? data.comment : c,
          ),
        },
      }));
      await get().loadIssueEvents(issueId);
      return data.comment;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  deleteIssueComment: async (issueId, commentId) => {
    await api.delete(
      `/api/issues/${encodeURIComponent(issueId)}/comments/${encodeURIComponent(commentId)}`,
    );
    set((state) => ({
      commentsByIssue: {
        ...state.commentsByIssue,
        [issueId]: (state.commentsByIssue[issueId] ?? []).filter((c) => c.id !== commentId),
      },
    }));
    await get().loadIssueEvents(issueId);
  },

  loadIssueRequests: async (id, opts = {}) => {
    try {
      const url = new URL(
        `/api/issues/${encodeURIComponent(id)}/requests`,
        window.location.origin,
      );
      if (opts.status) url.searchParams.set('status', opts.status);
      const data = await api.get<{ requests: IssueAgentRequest[] }>(
        url.pathname + url.search,
      );
      set((state) => ({
        requestsByIssue: { ...state.requestsByIssue, [id]: data.requests },
      }));
      return data.requests;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return [];
    }
  },

  answerIssueRequest: async (issueId, runId, requestId, payload) => {
    try {
      const data = await api.post<{ request: IssueAgentRequest }>(
        `/api/issues/${encodeURIComponent(issueId)}/runs/${encodeURIComponent(runId)}/decision`,
        { request_id: requestId, ...payload },
      );
      get().upsertIssueRequest(issueId, data.request);
      await get().loadIssueRuns(issueId);
      return data.request;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  upsertIssueRequest: (issueId, request) => {
    set((state) => {
      const existing = state.requestsByIssue[issueId] ?? [];
      const filtered = existing.filter((r) => r.id !== request.id);
      return {
        requestsByIssue: {
          ...state.requestsByIssue,
          [issueId]: [request, ...filtered],
        },
      };
    });
  },
}));
