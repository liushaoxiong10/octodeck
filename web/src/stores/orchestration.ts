import { create } from 'zustand';

import { api } from '../api/client';

export type OrchestrationSource = 'issue' | 'task';
export type OrchestrationRiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type OrchestrationMode = 'auto' | 'approval_required' | 'manual' | 'blocked';

export interface OrchestrationDecision {
  eligible: boolean;
  mode: OrchestrationMode;
  enforcementAction: 'execute' | 'request_approval' | 'manual_review' | 'block';
  targetAgentId?: string;
  targetRuntimeId?: string;
  requiredSkillIds: string[];
  permissionScopes: string[];
  riskLevel: OrchestrationRiskLevel;
  reasons: string[];
  blockers: string[];
  approvalRequired: boolean;
}

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
  | 'incident_reusable'
  | 'incident_archived'
  | 'incident_resolved'
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

export type QualityOutcome = 'passed' | 'failed' | 'partial' | 'needs_review' | 'inconclusive';
export type QualityConfidence = 'low' | 'medium' | 'high';

export interface QualityEvidence {
  kind: 'verification' | 'runtime_recovery' | 'approval' | 'status' | 'code_change' | 'error' | 'policy';
  label: string;
  detail?: string | null;
}

export interface QualityEvaluation {
  id: string;
  source: OrchestrationControlSource;
  sourceId: string;
  runId?: string | null;
  title?: string | null;
  outcome: QualityOutcome;
  confidence: QualityConfidence;
  score: number;
  failureCategory: string | null;
  needsReview: boolean;
  evidence: QualityEvidence[];
  reasons: string[];
  runtimeId?: string | null;
  agentClientId?: string | null;
  policyMode?: string | null;
  createdAt: string;
}

export interface ReliabilityScorecardRow {
  id: string;
  total: number;
  passed: number;
  failed: number;
  needsReview: number;
  averageScore: number;
  reliability: number;
  failureCategories: Record<string, number>;
}

export interface QualityScorecards {
  summary: {
    total: number;
    passed: number;
    failed: number;
    needsReview: number;
    inconclusive: number;
    partial: number;
    averageScore: number;
    passRate: number;
  };
  runtimes: ReliabilityScorecardRow[];
  agents: ReliabilityScorecardRow[];
  policies: ReliabilityScorecardRow[];
  insights: string[];
}

export interface OrchestrationControlSnapshot {
  summary: OrchestrationControlSummary;
  quality: QualityScorecards;
  events: OrchestrationControlEvent[];
}

interface OrchestrationState {
  previews: Record<string, OrchestrationDecision>;
  control: OrchestrationControlSnapshot | null;
  controlLoading: boolean;
  loading: Record<string, boolean>;
  error: string | null;
  loadPreview: (input: { source: OrchestrationSource; id: string }) => Promise<OrchestrationDecision | null>;
  loadControl: (input?: { source?: OrchestrationControlSource; id?: string; limit?: number }) => Promise<OrchestrationControlSnapshot | null>;
  reEvaluate: (input: { source: OrchestrationSource; id: string }) => Promise<OrchestrationDecision | null>;
}

function previewKey(source: OrchestrationSource, id: string): string {
  return `${source}:${id}`;
}

export const useOrchestrationStore = create<OrchestrationState>((set) => ({
  previews: {},
  control: null,
  controlLoading: false,
  loading: {},
  error: null,
  loadPreview: async ({ source, id }) => {
    const key = previewKey(source, id);
    set((state) => ({ loading: { ...state.loading, [key]: true }, error: null }));
    try {
      const params = new URLSearchParams({ source, id });
      const data = await api.get<{ decision: OrchestrationDecision }>(`/api/orchestration/preview?${params.toString()}`);
      set((state) => ({
        previews: { ...state.previews, [key]: data.decision },
        loading: { ...state.loading, [key]: false },
      }));
      return data.decision;
    } catch (err) {
      set((state) => ({
        loading: { ...state.loading, [key]: false },
        error: err instanceof Error ? err.message : String(err),
      }));
      return null;
    }
  },
  loadControl: async (input = {}) => {
    set({ controlLoading: true, error: null });
    try {
      const params = new URLSearchParams();
      if (input.source) params.set('source', input.source);
      if (input.id) params.set('id', input.id);
      if (input.limit) params.set('limit', String(input.limit));
      const suffix = params.toString() ? `?${params.toString()}` : '';
      const data = await api.get<OrchestrationControlSnapshot>(`/api/orchestration/events${suffix}`);
      set({ control: data, controlLoading: false });
      return data;
    } catch (err) {
      set({ controlLoading: false, error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },
  reEvaluate: async ({ source, id }) => {
    try {
      const data = await api.post<{ decision: OrchestrationDecision; sideEffect: 'none'; evaluatedAt: string }>('/api/orchestration/re-evaluate', { source, id });
      const key = previewKey(source, id);
      set((state) => ({ previews: { ...state.previews, [key]: data.decision }, error: null }));
      return data.decision;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },
}));

export function getOrchestrationPreviewKey(source: OrchestrationSource, id: string): string {
  return previewKey(source, id);
}
