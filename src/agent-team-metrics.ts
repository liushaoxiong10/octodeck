import type { AgentTeamRunView } from './db.js';

export interface AgentTeamMetricTask {
  status?: unknown;
}

export interface AgentTeamMetricApproval {
  createdAt?: unknown;
  resolvedAt?: unknown;
}

export interface AgentTeamMetricsInput {
  runs: AgentTeamRunView[];
  tasks: AgentTeamMetricTask[];
  approvals: AgentTeamMetricApproval[];
}

export interface AgentTeamMetricsSummary {
  totalRuns: number;
  successfulRuns: number;
  failedRuns: number;
  cancelledRuns: number;
  activeRuns: number;
  successRate: number;
  averageDurationMs: number | null;
  failedTaskCount: number;
  approvalLatency: {
    resolvedCount: number;
    averageMs: number | null;
  };
}

function elapsedMs(start?: unknown, end?: unknown): number | null {
  if (typeof start !== 'string' || typeof end !== 'string') return null;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  const elapsed = endMs - startMs;
  return elapsed >= 0 ? elapsed : null;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function summarizeAgentTeamMetrics(
  input: AgentTeamMetricsInput,
): AgentTeamMetricsSummary {
  const totalRuns = input.runs.length;
  const successfulRuns = input.runs.filter((run) => run.status === 'success').length;
  const failedRuns = input.runs.filter((run) => run.status === 'error').length;
  const cancelledRuns = input.runs.filter(
    (run) => run.status === 'cancelled',
  ).length;
  const activeRuns = input.runs.filter((run) =>
    ['running', 'waiting_approval', 'paused'].includes(run.status),
  ).length;
  const durations = input.runs
    .map((run) => elapsedMs(run.startedAt ?? run.createdAt, run.completedAt))
    .filter((value): value is number => value !== null);
  const approvalLatencies = input.approvals
    .map((approval) => elapsedMs(approval.createdAt, approval.resolvedAt))
    .filter((value): value is number => value !== null);

  return {
    totalRuns,
    successfulRuns,
    failedRuns,
    cancelledRuns,
    activeRuns,
    successRate: totalRuns > 0 ? successfulRuns / totalRuns : 0,
    averageDurationMs: average(durations),
    failedTaskCount: input.tasks.filter(
      (task) =>
        typeof task.status === 'string' &&
        ['error', 'cancelled'].includes(task.status),
    ).length,
    approvalLatency: {
      resolvedCount: approvalLatencies.length,
      averageMs: average(approvalLatencies),
    },
  };
}
