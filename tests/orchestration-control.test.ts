import { describe, expect, test } from 'vitest';

import { buildOrchestrationControlSnapshot, buildOrchestrationQualityEvaluations } from '../src/orchestration-control.js';

describe('orchestration control snapshot', () => {
  test('聚合 Issue、Task、Agent Task 的编排事件并按时间倒序输出摘要', () => {
    const snapshot = buildOrchestrationControlSnapshot({
      issues: [
        {
          id: 'iss_1',
          title: 'Deploy service',
          workspace_jid: 'web:main',
          workspace_folder: 'main',
          status: 'waiting_for_human',
          priority: 'urgent',
          created_by: 'u1',
          created_at: '2026-06-15T00:00:00.000Z',
          updated_at: '2026-06-15T00:01:00.000Z',
          description: 'deploy',
        },
      ],
      issueRunsByIssue: {
        iss_1: [
          {
            id: 'run_1',
            issue_id: 'iss_1',
            workspace_jid: 'web:main',
            workspace_folder: 'main',
            status: 'awaiting_input',
            created_by: 'u1',
            created_at: '2026-06-15T00:02:00.000Z',
          },
        ],
      },
      issueEventsByRun: {
        run_1: [
          {
            id: 'ev_1',
            issue_id: 'iss_1',
            run_id: 'run_1',
            event_type: 'orchestration_policy_approval_required',
            title: 'Orchestration policy: request approval',
            summary: 'Deploy service',
            detail: 'High-risk permission requires approval',
            payload: {
              decision: { mode: 'approval_required', enforcementAction: 'request_approval', riskLevel: 'high' },
            },
            created_at: '2026-06-15T00:03:00.000Z',
          },
        ],
      },
      issueRequestsByIssue: {
        iss_1: [
          {
            id: 'req_1',
            issue_id: 'iss_1',
            run_id: 'run_1',
            kind: 'permission',
            title: 'Orchestration approval required',
            status: 'pending',
            created_at: '2026-06-15T00:04:00.000Z',
          },
        ],
      },
      tasks: [
        {
          id: 'task_1',
          group_folder: 'main',
          chat_jid: 'web:main',
          prompt: 'Summarize repo',
          schedule_type: 'cron',
          schedule_value: '0 9 * * *',
          context_mode: 'isolated',
          execution_type: 'agent',
          script_command: null,
          next_run: null,
          last_run: null,
          last_result: null,
          status: 'active',
          created_at: '2026-06-15T00:00:00.000Z',
        },
      ],
      taskLogsByTask: {
        task_1: [
          {
            task_id: 'task_1',
            run_at: '2026-06-15T00:05:00.000Z',
            duration_ms: 0,
            status: 'error',
            result: null,
            error: 'Blocked: No compatible runtime',
          },
        ],
      },
      agentTasks: [
        {
          id: 'agtask_1',
          source_type: 'scheduled_task',
          source_ref: 'task_1',
          run_ref: 'orch_1',
          status: 'skipped',
          context: {
            orchestrationPolicy: true,
            enforcementAction: 'block',
            decision: { mode: 'blocked', riskLevel: 'medium', blockers: ['No compatible runtime'] },
          },
          created_at: '2026-06-15T00:05:01.000Z',
          updated_at: '2026-06-15T00:05:01.000Z',
        },
      ],
      agentTeamRuns: [
        {
          id: 'team_1',
          prompt: 'Ship project',
          status: 'waiting_approval',
          createdAt: '2026-06-15T00:06:00.000Z',
          updatedAt: '2026-06-15T00:06:00.000Z',
        },
      ],
      agentTeamApprovalsByRun: {
        team_1: [
          {
            id: 'tappr_1',
            runId: 'team_1',
            status: 'pending',
            title: 'Team approval',
            riskLevel: 'high',
            createdAt: '2026-06-15T00:07:00.000Z',
          },
        ],
      },
      limit: 20,
    });

    expect(snapshot.summary).toMatchObject({
      total: 6,
      autoExecuted: 0,
      waitingApproval: 3,
      blocked: 2,
      manualReview: 0,
      failed: 1,
    });
    expect(snapshot.events.map((event) => event.type)).toEqual([
      'approval_requested',
      'approval_requested',
      'blocked',
      'blocked',
      'approval_requested',
      'run_waiting',
    ]);
    expect(snapshot.events[0]).toMatchObject({
      source: 'agent_team',
      sourceId: 'team_1',
      riskLevel: 'high',
      href: '/agents?runId=team_1',
    });
  });

  test('timeline 只返回指定 source 和 sourceId 的事件', () => {
    const snapshot = buildOrchestrationControlSnapshot({
      issues: [],
      issueRunsByIssue: {},
      issueEventsByRun: {},
      issueRequestsByIssue: {},
      tasks: [],
      taskLogsByTask: {},
      agentTasks: [
        {
          id: 'agtask_task_1',
          source_type: 'scheduled_task',
          source_ref: 'task_1',
          status: 'waiting_approval',
          context: { orchestrationPolicy: true, enforcementAction: 'request_approval' },
          created_at: '2026-06-15T00:01:00.000Z',
          updated_at: '2026-06-15T00:01:00.000Z',
        },
        {
          id: 'agtask_task_2',
          source_type: 'scheduled_task',
          source_ref: 'task_2',
          status: 'skipped',
          context: { orchestrationPolicy: true, enforcementAction: 'block' },
          created_at: '2026-06-15T00:02:00.000Z',
          updated_at: '2026-06-15T00:02:00.000Z',
        },
      ],
      agentTeamRuns: [],
      agentTeamApprovalsByRun: {},
      timeline: { source: 'task', sourceId: 'task_1' },
    });

    expect(snapshot.events).toHaveLength(1);
    expect(snapshot.events[0]).toMatchObject({ source: 'task', sourceId: 'task_1' });
  });

  test('将 runtime 自愈事件纳入控制台 timeline', () => {
    const snapshot = buildOrchestrationControlSnapshot({
      issues: [
        {
          id: 'iss_runtime',
          title: 'Recover stale runtime run',
          workspace_jid: 'web:main',
          workspace_folder: 'main',
          status: 'in_progress',
          priority: 'normal',
          created_by: 'u1',
          created_at: '2026-06-15T01:00:00.000Z',
          updated_at: '2026-06-15T01:00:00.000Z',
        },
      ],
      issueRunsByIssue: {
        iss_runtime: [
          {
            id: 'run_runtime',
            issue_id: 'iss_runtime',
            workspace_jid: 'web:main',
            workspace_folder: 'main',
            status: 'running',
            created_by: 'u1',
            created_at: '2026-06-15T01:01:00.000Z',
          },
        ],
      },
      issueEventsByRun: {
        run_runtime: [
          {
            id: 'ev_recovered',
            issue_id: 'iss_runtime',
            run_id: 'run_runtime',
            event_type: 'runtime_self_healed',
            title: 'Runtime target self-healed',
            summary: 'cl_stale:claude-code → cl_ready:claude-code',
            payload: {
              strategy: 'failover_same_agent',
              originalBlockedReason: 'runtime_degraded',
            },
            created_at: '2026-06-15T01:02:00.000Z',
          },
        ],
      },
      issueRequestsByIssue: {},
      tasks: [],
      taskLogsByTask: {},
      agentTasks: [],
      agentTeamRuns: [],
      agentTeamApprovalsByRun: {},
    });

    expect(snapshot.summary.recovered).toBe(1);
    expect(snapshot.events).toHaveLength(1);
    expect(snapshot.events[0]).toMatchObject({
      id: 'issue-event:ev_recovered',
      source: 'issue',
      sourceId: 'iss_runtime',
      runId: 'run_runtime',
      type: 'runtime_recovered',
      enforcementAction: 'failover_same_agent',
      href: '/issues/detail/iss_runtime',
    });
  });

  test('生成质量评价和 scorecard，并把低质量运行纳入控制台事件', () => {
    const snapshot = buildOrchestrationControlSnapshot({
      issues: [
        {
          id: 'iss_quality',
          title: 'Change code without tests',
          workspace_jid: 'web:main',
          workspace_folder: 'main',
          status: 'review',
          priority: 'normal',
          created_by: 'u1',
          created_at: '2026-06-15T02:00:00.000Z',
          updated_at: '2026-06-15T02:10:00.000Z',
        },
      ],
      issueRunsByIssue: {
        iss_quality: [
          {
            id: 'run_quality',
            issue_id: 'iss_quality',
            workspace_jid: 'web:main',
            workspace_folder: 'main',
            status: 'success',
            result: 'Modified src/quality.ts',
            agent_client_id: 'claude-code',
            execution_node: 'runtime:cl_ready:claude-code',
            created_by: 'u1',
            created_at: '2026-06-15T02:01:00.000Z',
            run_completed_at: '2026-06-15T02:09:00.000Z',
          },
        ],
      },
      issueEventsByRun: {
        run_quality: [
          {
            id: 'ev_policy',
            issue_id: 'iss_quality',
            run_id: 'run_quality',
            event_type: 'orchestration_policy_auto',
            payload: { decision: { mode: 'auto', enforcementAction: 'execute', riskLevel: 'low' } },
            created_at: '2026-06-15T02:01:10.000Z',
          },
          {
            id: 'ev_files',
            issue_id: 'iss_quality',
            run_id: 'run_quality',
            event_type: 'files_changed',
            title: 'Files changed',
            summary: 'src/quality.ts',
            created_at: '2026-06-15T02:08:00.000Z',
          },
        ],
      },
      issueRequestsByIssue: {},
      tasks: [],
      taskLogsByTask: {},
      agentTasks: [],
      agentTeamRuns: [],
      agentTeamApprovalsByRun: {},
    });

    expect(snapshot.quality.summary).toMatchObject({ total: 1, needsReview: 1, passed: 0 });
    expect(snapshot.quality.runtimes[0]).toMatchObject({ id: 'runtime:cl_ready:claude-code', total: 1, needsReview: 1 });
    expect(snapshot.events[0]).toMatchObject({
      type: 'quality_needs_review',
      source: 'issue',
      sourceId: 'iss_quality',
      runId: 'run_quality',
      enforcementAction: 'needs_review',
    });
  });

  test('构建可复用质量评价列表供 API 返回明细', () => {
    const evaluations = buildOrchestrationQualityEvaluations({
      issues: [
        {
          id: 'iss_eval',
          title: 'Verified code change',
          workspace_jid: 'web:main',
          workspace_folder: 'main',
          status: 'done',
          priority: 'normal',
          created_by: 'u1',
          created_at: '2026-06-15T03:00:00.000Z',
          updated_at: '2026-06-15T03:10:00.000Z',
        },
      ],
      issueRunsByIssue: {
        iss_eval: [
          {
            id: 'run_eval',
            issue_id: 'iss_eval',
            workspace_jid: 'web:main',
            workspace_folder: 'main',
            status: 'success',
            result: 'Changed src/foo.ts and ran npm test',
            created_by: 'u1',
            created_at: '2026-06-15T03:01:00.000Z',
            run_completed_at: '2026-06-15T03:09:00.000Z',
          },
        ],
      },
      issueEventsByRun: {},
      issueRequestsByIssue: {},
      tasks: [],
      taskLogsByTask: {},
      agentTasks: [
        {
          id: 'agtask_eval',
          source_type: 'scheduled_task',
          source_ref: 'task_eval',
          status: 'error',
          error: 'vitest failed',
          agent_client_id: 'claude-code',
          execution_node: 'runtime:cl_eval:claude-code',
          created_at: '2026-06-15T03:02:00.000Z',
          updated_at: '2026-06-15T03:03:00.000Z',
        },
      ],
      agentTeamRuns: [],
      agentTeamApprovalsByRun: {},
    });

    expect(evaluations.map((evaluation) => evaluation.id)).toEqual([
      'quality:issue:iss_eval:run_eval',
      'quality:task:task_eval:agtask_eval',
    ]);
    expect(evaluations[0]).toMatchObject({ outcome: 'passed', score: 94 });
    expect(evaluations[1]).toMatchObject({ outcome: 'failed', failureCategory: 'test_failure' });
  });

  test('质量评价不会重复统计 issue run 镜像任务，也不会跨 run 复用拒绝审批', () => {
    const evaluations = buildOrchestrationQualityEvaluations({
      issues: [
        {
          id: 'iss_multi',
          title: 'Multi run issue',
          workspace_jid: 'web:main',
          workspace_folder: 'main',
          status: 'done',
          priority: 'normal',
          created_by: 'u1',
          created_at: '2026-06-15T04:00:00.000Z',
          updated_at: '2026-06-15T04:10:00.000Z',
        },
      ],
      issueRunsByIssue: {
        iss_multi: [
          {
            id: 'run_rejected',
            issue_id: 'iss_multi',
            workspace_jid: 'web:main',
            workspace_folder: 'main',
            status: 'error',
            error: 'permission denied',
            created_by: 'u1',
            created_at: '2026-06-15T04:01:00.000Z',
          },
          {
            id: 'run_success',
            issue_id: 'iss_multi',
            workspace_jid: 'web:main',
            workspace_folder: 'main',
            status: 'success',
            result: 'done',
            created_by: 'u1',
            created_at: '2026-06-15T04:03:00.000Z',
          },
        ],
      },
      issueEventsByRun: {},
      issueRequestsByIssue: {
        iss_multi: [
          {
            id: 'req_rejected',
            issue_id: 'iss_multi',
            run_id: 'run_rejected',
            kind: 'permission',
            status: 'answered',
            decision: 'reject',
            created_at: '2026-06-15T04:02:00.000Z',
          },
        ],
      },
      tasks: [],
      taskLogsByTask: {},
      agentTasks: [
        {
          id: 'agtask_run_success',
          source_type: 'issue_run',
          source_ref: 'iss_multi',
          run_ref: 'run_success',
          status: 'success',
          result: 'done',
          created_at: '2026-06-15T04:03:00.000Z',
          updated_at: '2026-06-15T04:04:00.000Z',
        },
      ],
      agentTeamRuns: [],
      agentTeamApprovalsByRun: {},
    });

    expect(evaluations).toHaveLength(2);
    expect(evaluations.find((evaluation) => evaluation.runId === 'run_rejected')).toMatchObject({ failureCategory: 'user_rejected' });
    expect(evaluations.find((evaluation) => evaluation.runId === 'run_success')).toMatchObject({ outcome: 'passed' });
  });

  test('质量失败进入控制台失败摘要', () => {
    const snapshot = buildOrchestrationControlSnapshot({
      issues: [
        {
          id: 'iss_failed_quality',
          title: 'Test failed',
          workspace_jid: 'web:main',
          workspace_folder: 'main',
          status: 'review',
          priority: 'normal',
          created_by: 'u1',
          created_at: '2026-06-15T05:00:00.000Z',
          updated_at: '2026-06-15T05:10:00.000Z',
        },
      ],
      issueRunsByIssue: {
        iss_failed_quality: [
          {
            id: 'run_failed_quality',
            issue_id: 'iss_failed_quality',
            workspace_jid: 'web:main',
            workspace_folder: 'main',
            status: 'error',
            error: 'vitest failed',
            created_by: 'u1',
            created_at: '2026-06-15T05:01:00.000Z',
          },
        ],
      },
      issueEventsByRun: {},
      issueRequestsByIssue: {},
      tasks: [],
      taskLogsByTask: {},
      agentTasks: [],
      agentTeamRuns: [],
      agentTeamApprovalsByRun: {},
    });

    expect(snapshot.events[0]).toMatchObject({ type: 'quality_failed', status: 'failed' });
    expect(snapshot.summary.failed).toBe(1);
  });

  test('timeline 过滤时质量 scorecard 同步收敛到指定对象', () => {
    const snapshot = buildOrchestrationControlSnapshot({
      issues: [
        { id: 'iss_a', title: 'A', workspace_jid: 'web:main', workspace_folder: 'main', status: 'done', priority: 'normal', created_by: 'u1', created_at: '2026-06-15T06:00:00.000Z', updated_at: '2026-06-15T06:00:00.000Z' },
        { id: 'iss_b', title: 'B', workspace_jid: 'web:main', workspace_folder: 'main', status: 'done', priority: 'normal', created_by: 'u1', created_at: '2026-06-15T06:00:00.000Z', updated_at: '2026-06-15T06:00:00.000Z' },
      ],
      issueRunsByIssue: {
        iss_a: [{ id: 'run_a', issue_id: 'iss_a', workspace_jid: 'web:main', workspace_folder: 'main', status: 'success', result: 'done', created_by: 'u1', created_at: '2026-06-15T06:01:00.000Z' }],
        iss_b: [{ id: 'run_b', issue_id: 'iss_b', workspace_jid: 'web:main', workspace_folder: 'main', status: 'error', error: 'failed', created_by: 'u1', created_at: '2026-06-15T06:02:00.000Z' }],
      },
      issueEventsByRun: {},
      issueRequestsByIssue: {},
      tasks: [],
      taskLogsByTask: {},
      agentTasks: [],
      agentTeamRuns: [],
      agentTeamApprovalsByRun: {},
      timeline: { source: 'issue', sourceId: 'iss_a' },
    });

    expect(snapshot.quality.summary).toMatchObject({ total: 1, passed: 1, failed: 0 });
  });

  test('将 delivery gate 事件纳入控制台 timeline 和阻断摘要', () => {
    const snapshot = buildOrchestrationControlSnapshot({
      issues: [
        { id: 'iss_delivery', title: 'Deliver change', workspace_jid: 'web:main', workspace_folder: 'main', status: 'review', priority: 'normal', created_by: 'u1', created_at: '2026-06-15T07:00:00.000Z', updated_at: '2026-06-15T07:00:00.000Z' },
      ],
      issueRunsByIssue: {
        iss_delivery: [{ id: 'run_delivery', issue_id: 'iss_delivery', workspace_jid: 'web:main', workspace_folder: 'main', status: 'success', result: 'Modified src/app.ts', created_by: 'u1', created_at: '2026-06-15T07:01:00.000Z' }],
      },
      issueEventsByRun: {
        run_delivery: [
          { id: 'ev_delivery_blocked', issue_id: 'iss_delivery', run_id: 'run_delivery', event_type: 'delivery_quality_blocked', title: 'Delivery blocked by quality gate', summary: 'missing_verification', detail: 'Code changes require verification', created_at: '2026-06-15T07:03:00.000Z' },
        ],
      },
      issueRequestsByIssue: {},
      tasks: [],
      taskLogsByTask: {},
      agentTasks: [],
      agentTeamRuns: [],
      agentTeamApprovalsByRun: {},
    });

    expect(snapshot.events[0]).toMatchObject({
      id: 'issue-event:ev_delivery_blocked',
      type: 'delivery_blocked',
      source: 'issue',
      sourceId: 'iss_delivery',
      runId: 'run_delivery',
    });
    expect(snapshot.summary.blocked).toBe(1);
  });

  test('Review Agent child success resolves issue run quality gate in orchestration scorecards', () => {
    const evaluations = buildOrchestrationQualityEvaluations({
      issues: [
        { id: 'iss_review_resolved', title: 'Review resolved', workspace_jid: 'web:main', workspace_folder: 'main', status: 'review', priority: 'normal', created_by: 'u1', created_at: '2026-06-15T08:00:00.000Z', updated_at: '2026-06-15T08:00:00.000Z' },
      ],
      issueRunsByIssue: {
        iss_review_resolved: [
          { id: 'run_parent', issue_id: 'iss_review_resolved', workspace_jid: 'web:main', workspace_folder: 'main', status: 'success', result: 'Modified src/app.ts', created_by: 'u1', created_at: '2026-06-15T08:01:00.000Z' },
          { id: 'run_review_child', issue_id: 'iss_review_resolved', workspace_jid: 'web:main', workspace_folder: 'main', parent_run_id: 'run_parent', status: 'success', result: 'Review Agent found no blockers', created_by: 'u1', created_at: '2026-06-15T08:02:00.000Z' },
        ],
      },
      issueEventsByRun: {
        run_parent: [
          { id: 'ev_files', issue_id: 'iss_review_resolved', run_id: 'run_parent', event_type: 'files_changed', summary: 'src/app.ts', created_at: '2026-06-15T08:01:30.000Z' },
          { id: 'ev_review', issue_id: 'iss_review_resolved', run_id: 'run_parent', event_type: 'review_agent_run_created', payload: { reviewRunId: 'run_review_child' }, created_at: '2026-06-15T08:02:00.000Z' },
        ],
        run_review_child: [
          { id: 'ev_review_queued', issue_id: 'iss_review_resolved', run_id: 'run_review_child', event_type: 'run_queued', payload: { trigger: 'review_agent', parentRunId: 'run_parent' }, created_at: '2026-06-15T08:02:00.000Z' },
        ],
      },
      issueRequestsByIssue: {},
      tasks: [],
      taskLogsByTask: {},
      agentTasks: [],
      agentTeamRuns: [],
      agentTeamApprovalsByRun: {},
    });

    expect(evaluations.find((evaluation) => evaluation.runId === 'run_parent')).toMatchObject({
      outcome: 'passed',
      failureCategory: null,
      needsReview: false,
    });
  });

  test('将 release governance 事件纳入控制台 timeline 和摘要', () => {
    const snapshot = buildOrchestrationControlSnapshot({
      issues: [
        { id: 'iss_release', title: 'Release change', workspace_jid: 'web:main', workspace_folder: 'main', status: 'review', priority: 'normal', created_by: 'u1', created_at: '2026-06-15T09:00:00.000Z', updated_at: '2026-06-15T09:00:00.000Z' },
      ],
      issueRunsByIssue: {
        iss_release: [{ id: 'run_release', issue_id: 'iss_release', workspace_jid: 'web:main', workspace_folder: 'main', status: 'success', result: 'Changed src/release.ts and ran npm test', created_by: 'u1', created_at: '2026-06-15T09:01:00.000Z' }],
      },
      issueEventsByRun: {
        run_release: [
          { id: 'ev_checks_failed', issue_id: 'iss_release', run_id: 'run_release', event_type: 'release_checks_failed', title: 'Release checks failed', summary: '1 check(s) failed', created_at: '2026-06-15T09:03:00.000Z' },
          { id: 'ev_merge_ready', issue_id: 'iss_release', run_id: 'run_release', event_type: 'release_merge_ready', title: 'Release merge ready', summary: 'Checks passed', created_at: '2026-06-15T09:04:00.000Z' },
          { id: 'ev_rollback', issue_id: 'iss_release', run_id: 'run_release', event_type: 'release_rollback_required', title: 'Release rollback required', summary: 'smoke test failed', created_at: '2026-06-15T09:05:00.000Z' },
        ],
      },
      issueRequestsByIssue: {},
      tasks: [],
      taskLogsByTask: {},
      agentTasks: [],
      agentTeamRuns: [],
      agentTeamApprovalsByRun: {},
    });

    expect(snapshot.events.map((event) => event.type)).toEqual([
      'release_rollback_required',
      'release_ready',
      'release_blocked',
    ]);
    expect(snapshot.summary.blocked).toBe(2);
    expect(snapshot.summary.failed).toBe(1);
  });

  test('将 production health 事件纳入控制台 timeline 和摘要', () => {
    const snapshot = buildOrchestrationControlSnapshot({
      issues: [
        { id: 'iss_prod', title: 'Production change', workspace_jid: 'web:main', workspace_folder: 'main', status: 'review', priority: 'normal', created_by: 'u1', created_at: '2026-06-15T10:00:00.000Z', updated_at: '2026-06-15T10:00:00.000Z' },
      ],
      issueRunsByIssue: {
        iss_prod: [{ id: 'run_prod', issue_id: 'iss_prod', workspace_jid: 'web:main', workspace_folder: 'main', status: 'success', result: 'Released prod change', created_by: 'u1', created_at: '2026-06-15T10:01:00.000Z' }],
      },
      issueEventsByRun: {
        run_prod: [
          { id: 'ev_observing', issue_id: 'iss_prod', run_id: 'run_prod', event_type: 'production_observation_started', title: 'Production observation started', summary: 'observing', created_at: '2026-06-15T10:03:00.000Z' },
          { id: 'ev_degraded', issue_id: 'iss_prod', run_id: 'run_prod', event_type: 'production_health_degraded', title: 'Production health degraded', summary: 'latency elevated', created_at: '2026-06-15T10:04:00.000Z' },
          { id: 'ev_incident', issue_id: 'iss_prod', run_id: 'run_prod', event_type: 'production_incident_detected', title: 'Production incident detected', summary: 'checkout 500s', created_at: '2026-06-15T10:05:00.000Z' },
          { id: 'ev_mitigation', issue_id: 'iss_prod', run_id: 'run_prod', event_type: 'production_mitigation_running', title: 'Production mitigation running', summary: 'mitigating', created_at: '2026-06-15T10:06:00.000Z' },
          { id: 'ev_recovered', issue_id: 'iss_prod', run_id: 'run_prod', event_type: 'production_recovered', title: 'Production recovered', summary: 'healthy', created_at: '2026-06-15T10:07:00.000Z' },
        ],
      },
      issueRequestsByIssue: {},
      tasks: [],
      taskLogsByTask: {},
      agentTasks: [],
      agentTeamRuns: [],
      agentTeamApprovalsByRun: {},
    });

    expect(snapshot.events.map((event) => event.type)).toEqual([
      'production_recovered',
      'production_mitigation_running',
      'production_incident',
      'production_degraded',
      'production_observing',
    ]);
    expect(snapshot.summary.blocked).toBe(1);
    expect(snapshot.summary.failed).toBe(1);
    expect(snapshot.summary.recovered).toBe(1);
  });

  test('将 remediation 事件纳入控制台 timeline 和摘要', () => {
    const snapshot = buildOrchestrationControlSnapshot({
      issues: [
        { id: 'iss_remediate', title: 'Remediate change', workspace_jid: 'web:main', workspace_folder: 'main', status: 'review', priority: 'normal', created_by: 'u1', created_at: '2026-06-16T10:00:00.000Z', updated_at: '2026-06-16T10:00:00.000Z' },
      ],
      issueRunsByIssue: {
        iss_remediate: [{ id: 'run_remediate', issue_id: 'iss_remediate', workspace_jid: 'web:main', workspace_folder: 'main', status: 'success', result: 'Released prod change', created_by: 'u1', created_at: '2026-06-16T10:01:00.000Z' }],
      },
      issueEventsByRun: {
        run_remediate: [
          { id: 'ev_proposed', issue_id: 'iss_remediate', run_id: 'run_remediate', event_type: 'remediation_proposed', title: 'Remediation proposed', summary: 'spawn fix run', created_at: '2026-06-16T10:03:00.000Z' },
          { id: 'ev_waiting', issue_id: 'iss_remediate', run_id: 'run_remediate', event_type: 'remediation_waiting_approval', title: 'Remediation waiting approval', summary: 'rollback approval', created_at: '2026-06-16T10:04:00.000Z' },
          { id: 'ev_running', issue_id: 'iss_remediate', run_id: 'run_remediate', event_type: 'remediation_running', title: 'Remediation running', summary: 'fix running', created_at: '2026-06-16T10:05:00.000Z' },
          { id: 'ev_verifying', issue_id: 'iss_remediate', run_id: 'run_remediate', event_type: 'remediation_verifying', title: 'Remediation verifying', summary: 'verify recovery', created_at: '2026-06-16T10:06:00.000Z' },
          { id: 'ev_failed', issue_id: 'iss_remediate', run_id: 'run_remediate', event_type: 'remediation_failed', title: 'Remediation failed', summary: 'fix failed', created_at: '2026-06-16T10:07:00.000Z' },
          { id: 'ev_resolved', issue_id: 'iss_remediate', run_id: 'run_remediate', event_type: 'remediation_resolved', title: 'Remediation resolved', summary: 'healthy', created_at: '2026-06-16T10:08:00.000Z' },
        ],
      },
      issueRequestsByIssue: {},
      tasks: [],
      taskLogsByTask: {},
      agentTasks: [],
      agentTeamRuns: [],
      agentTeamApprovalsByRun: {},
    });

    expect(snapshot.events.map((event) => event.type)).toEqual([
      'remediation_resolved',
      'remediation_failed',
      'remediation_verifying',
      'remediation_running',
      'remediation_waiting_approval',
      'remediation_proposed',
    ]);
    expect(snapshot.summary.waitingApproval).toBe(1);
    expect(snapshot.summary.blocked).toBe(2);
    expect(snapshot.summary.failed).toBe(1);
    expect(snapshot.summary.recovered).toBe(1);
  });

  test('摘要统计不受 timeline 返回数量限制影响', () => {
    const snapshot = buildOrchestrationControlSnapshot({
      issues: [
        { id: 'iss_limited', title: 'Limited control', workspace_jid: 'web:main', workspace_folder: 'main', status: 'review', priority: 'normal', created_by: 'u1', created_at: '2026-06-16T11:00:00.000Z', updated_at: '2026-06-16T11:00:00.000Z' },
      ],
      issueRunsByIssue: {
        iss_limited: [{ id: 'run_limited', issue_id: 'iss_limited', workspace_jid: 'web:main', workspace_folder: 'main', status: 'success', result: 'Released prod change', created_by: 'u1', created_at: '2026-06-16T11:01:00.000Z' }],
      },
      issueEventsByRun: {
        run_limited: [
          { id: 'ev_failed_limited', issue_id: 'iss_limited', run_id: 'run_limited', event_type: 'remediation_failed', title: 'Remediation failed', summary: 'fix failed', created_at: '2026-06-16T11:02:00.000Z' },
          { id: 'ev_resolved_limited', issue_id: 'iss_limited', run_id: 'run_limited', event_type: 'remediation_resolved', title: 'Remediation resolved', summary: 'healthy', created_at: '2026-06-16T11:03:00.000Z' },
        ],
      },
      issueRequestsByIssue: {},
      tasks: [],
      taskLogsByTask: {},
      agentTasks: [],
      agentTeamRuns: [],
      agentTeamApprovalsByRun: {},
      limit: 1,
    });

    expect(snapshot.events.map((event) => event.type)).toEqual(['remediation_resolved']);
    expect(snapshot.summary.total).toBe(2);
    expect(snapshot.summary.failed).toBe(1);
    expect(snapshot.summary.recovered).toBe(1);
  });

  test('将 incident knowledge archived 事件纳入控制台 timeline 和摘要', () => {
    const baseInput = {
      issues: [
        { id: 'iss_incident_kb', title: 'Archive incident', workspace_jid: 'web:main', workspace_folder: 'main', status: 'review', priority: 'normal', created_by: 'u1', created_at: '2026-06-16T12:00:00.000Z', updated_at: '2026-06-16T12:00:00.000Z' },
      ],
      issueRunsByIssue: {
        iss_incident_kb: [{ id: 'run_incident_kb', issue_id: 'iss_incident_kb', workspace_jid: 'web:main', workspace_folder: 'main', status: 'success', result: 'incident archived', created_by: 'u1', created_at: '2026-06-16T12:01:00.000Z' }],
      },
      issueRequestsByIssue: {},
      tasks: [],
      taskLogsByTask: {},
      agentTasks: [],
      agentTeamRuns: [],
      agentTeamApprovalsByRun: {},
    };
    const resolved = buildOrchestrationControlSnapshot({
      ...baseInput,
      issueEventsByRun: {
        run_incident_kb: [
          { id: 'ev_incident_archived', issue_id: 'iss_incident_kb', run_id: 'run_incident_kb', event_type: 'incident_knowledge_archived', title: 'Incident knowledge archived', summary: 'checkout 500s', payload: { incidentKnowledge: { status: 'resolved', severity: 'high' } }, created_at: '2026-06-16T12:02:00.000Z' },
        ],
      },
    });

    expect(resolved.events[0]).toMatchObject({ type: 'incident_resolved', title: 'Incident knowledge archived' });
    expect(resolved.summary.recovered).toBe(1);

    const failed = buildOrchestrationControlSnapshot({
      ...baseInput,
      issueEventsByRun: {
        run_incident_kb: [
          { id: 'ev_incident_failed', issue_id: 'iss_incident_kb', run_id: 'run_incident_kb', event_type: 'incident_knowledge_archived', title: 'Incident knowledge archived', summary: 'checkout 500s', payload: { incidentKnowledge: { status: 'failed', severity: 'critical' } }, created_at: '2026-06-16T12:02:00.000Z' },
        ],
      },
    });

    expect(failed.events[0]).toMatchObject({ type: 'incident_archived', riskLevel: 'critical' });
    expect(failed.summary.blocked).toBe(1);
    expect(failed.summary.failed).toBe(1);
  });

  test('将 runbook reuse apply 审计事件映射为推荐、应用和阻断 timeline', () => {
    const snapshot = buildOrchestrationControlSnapshot({
      issues: [
        { id: 'iss_runbook', title: 'Reuse runbook', workspace_jid: 'web:main', workspace_folder: 'main', status: 'review', priority: 'normal', created_by: 'u1', created_at: '2026-06-16T13:00:00.000Z', updated_at: '2026-06-16T13:00:00.000Z' },
      ],
      issueRunsByIssue: {
        iss_runbook: [{ id: 'run_runbook', issue_id: 'iss_runbook', workspace_jid: 'web:main', workspace_folder: 'main', status: 'success', result: 'runbook reuse evaluated', created_by: 'u1', created_at: '2026-06-16T13:01:00.000Z' }],
      },
      issueEventsByRun: {
        run_runbook: [
          { id: 'ev_runbook_applied', issue_id: 'iss_runbook', run_id: 'run_runbook', event_type: 'runbook_reuse_applied', title: 'Runbook reuse applied', summary: 'Reuse remediation actions', payload: { runbookReuse: { recommendation: { status: 'reuse_recommended', approvalRequired: false } } }, created_at: '2026-06-16T13:02:00.000Z' },
          { id: 'ev_runbook_candidate', issue_id: 'iss_runbook', run_id: 'run_runbook', event_type: 'runbook_reuse_recommended', title: 'Runbook reuse recommended', summary: 'Candidate found', payload: { runbookReuse: { recommendation: { status: 'candidate_found', approvalRequired: false } } }, created_at: '2026-06-16T13:03:00.000Z' },
          { id: 'ev_runbook_approval', issue_id: 'iss_runbook', run_id: 'run_runbook', event_type: 'runbook_reuse_applied', title: 'Runbook reuse needs approval', summary: 'Rollback approval required', payload: { runbookReuse: { recommendation: { status: 'approval_required', approvalRequired: true } } }, created_at: '2026-06-16T13:04:00.000Z' },
          { id: 'ev_runbook_blocked', issue_id: 'iss_runbook', run_id: 'run_runbook', event_type: 'runbook_reuse_blocked', title: 'Runbook reuse blocked', summary: 'Historical remediation failed', payload: { runbookReuse: { recommendation: { status: 'not_reusable', approvalRequired: true } } }, created_at: '2026-06-16T13:05:00.000Z' },
        ],
      },
      issueRequestsByIssue: {},
      tasks: [],
      taskLogsByTask: {},
      agentTasks: [],
      agentTeamRuns: [],
      agentTeamApprovalsByRun: {},
    });

    expect(snapshot.events.map((event) => event.type)).toEqual([
      'runbook_reuse_blocked',
      'runbook_reuse_recommended',
      'runbook_reuse_recommended',
      'runbook_reuse_applied',
    ]);
    expect(snapshot.events.some((event) => event.type === 'runbook_reuse_applied')).toBe(true);
    expect(snapshot.summary.manualReview).toBe(3);
    expect(snapshot.summary.waitingApproval).toBe(1);
    expect(snapshot.summary.blocked).toBe(1);
    expect(snapshot.summary.recovered).toBe(0);
  });

  test('runbook reuse 摘要统计基于完整 sorted events 而不是 limit 后 events', () => {
    const snapshot = buildOrchestrationControlSnapshot({
      issues: [
        { id: 'iss_runbook_limited', title: 'Limited runbook reuse', workspace_jid: 'web:main', workspace_folder: 'main', status: 'review', priority: 'normal', created_by: 'u1', created_at: '2026-06-16T14:00:00.000Z', updated_at: '2026-06-16T14:00:00.000Z' },
      ],
      issueRunsByIssue: {
        iss_runbook_limited: [{ id: 'run_runbook_limited', issue_id: 'iss_runbook_limited', workspace_jid: 'web:main', workspace_folder: 'main', status: 'success', result: 'runbook reuse evaluated', created_by: 'u1', created_at: '2026-06-16T14:01:00.000Z' }],
      },
      issueEventsByRun: {
        run_runbook_limited: [
          { id: 'ev_runbook_applied_limited', issue_id: 'iss_runbook_limited', run_id: 'run_runbook_limited', event_type: 'runbook_reuse_applied', title: 'Runbook reuse applied', payload: { runbookReuse: { recommendation: { status: 'reuse_recommended', approvalRequired: false } } }, created_at: '2026-06-16T14:02:00.000Z' },
          { id: 'ev_runbook_approval_limited', issue_id: 'iss_runbook_limited', run_id: 'run_runbook_limited', event_type: 'runbook_reuse_applied', title: 'Runbook reuse recommended', payload: { runbookReuse: { recommendation: { status: 'candidate_found', approvalRequired: true } } }, created_at: '2026-06-16T14:03:00.000Z' },
        ],
      },
      issueRequestsByIssue: {},
      tasks: [],
      taskLogsByTask: {},
      agentTasks: [],
      agentTeamRuns: [],
      agentTeamApprovalsByRun: {},
      limit: 1,
    });

    expect(snapshot.events.map((event) => event.type)).toEqual(['runbook_reuse_recommended']);
    expect(snapshot.summary.total).toBe(2);
    expect(snapshot.summary.manualReview).toBe(2);
    expect(snapshot.summary.waitingApproval).toBe(1);
  });

  test('将 fix run spawner 事件纳入控制台 timeline 和摘要', () => {
    const snapshot = buildOrchestrationControlSnapshot({
      issues: [
        { id: 'iss_fix_run', title: 'Spawn fix run', workspace_jid: 'web:main', workspace_folder: 'main', status: 'review', priority: 'normal', created_by: 'u1', created_at: '2026-06-16T15:00:00.000Z', updated_at: '2026-06-16T15:00:00.000Z' },
      ],
      issueRunsByIssue: {
        iss_fix_run: [{ id: 'run_fix_source', issue_id: 'iss_fix_run', workspace_jid: 'web:main', workspace_folder: 'main', status: 'success', result: 'runbook reuse evaluated', created_by: 'u1', created_at: '2026-06-16T15:01:00.000Z' }],
      },
      issueEventsByRun: {
        run_fix_source: [
          { id: 'ev_fix_proposed', issue_id: 'iss_fix_run', run_id: 'run_fix_source', event_type: 'fix_run_proposed', title: 'Fix run proposed', payload: { fixRunDraft: { status: 'draft_ready', riskLevel: 'high' } }, created_at: '2026-06-16T15:02:00.000Z' },
          { id: 'ev_fix_spawned', issue_id: 'iss_fix_run', run_id: 'run_fix_source', event_type: 'fix_run_spawned', title: 'Fix run spawned', summary: 'irun_fix_child', payload: { fixRunId: 'irun_fix_child', fixRunDraft: { status: 'draft_ready', riskLevel: 'high' } }, created_at: '2026-06-16T15:03:00.000Z' },
          { id: 'ev_fix_blocked', issue_id: 'iss_fix_run', run_id: 'run_fix_source', event_type: 'fix_run_blocked', title: 'Fix run blocked', payload: { fixRunDraft: { status: 'blocked', riskLevel: 'critical' } }, created_at: '2026-06-16T15:04:00.000Z' },
        ],
      },
      issueRequestsByIssue: {},
      tasks: [],
      taskLogsByTask: {},
      agentTasks: [],
      agentTeamRuns: [],
      agentTeamApprovalsByRun: {},
    });

    expect(snapshot.events.map((event) => event.type)).toEqual(['fix_run_blocked', 'fix_run_spawned', 'fix_run_proposed']);
    expect(snapshot.summary.blocked).toBe(1);
    expect(snapshot.summary.manualReview).toBe(2);
    expect(snapshot.summary.autoExecuted).toBe(1);
  });

  test('将 resolution gate 事件纳入控制台 timeline 和摘要', () => {
    const snapshot = buildOrchestrationControlSnapshot({
      issues: [
        { id: 'iss_resolution_gate', title: 'Apply resolution gate', workspace_jid: 'web:main', workspace_folder: 'main', status: 'review', priority: 'normal', created_by: 'u1', created_at: '2026-06-16T15:30:00.000Z', updated_at: '2026-06-16T15:30:00.000Z' },
      ],
      issueRunsByIssue: {
        iss_resolution_gate: [{ id: 'run_resolution_gate', issue_id: 'iss_resolution_gate', workspace_jid: 'web:main', workspace_folder: 'main', status: 'success', result: 'resolution gate evaluated', created_by: 'u1', created_at: '2026-06-16T15:31:00.000Z' }],
      },
      issueEventsByRun: {
        run_resolution_gate: [
          { id: 'ev_resolution_ready', issue_id: 'iss_resolution_gate', run_id: 'run_resolution_gate', event_type: 'resolution_gate_ready', title: 'Resolution ready', payload: { resolutionGate: { status: 'ready', riskLevel: 'medium' } }, created_at: '2026-06-16T15:32:00.000Z' },
          { id: 'ev_resolution_approval', issue_id: 'iss_resolution_gate', run_id: 'run_resolution_gate', event_type: 'resolution_gate_ready', title: 'Resolution approval required', payload: { resolutionGate: { status: 'approval_required', riskLevel: 'critical', approvalRequired: true } }, created_at: '2026-06-16T15:32:30.000Z' },
          { id: 'ev_resolution_review', issue_id: 'iss_resolution_gate', run_id: 'run_resolution_gate', event_type: 'resolution_gate_ready', title: 'Resolution needs review', payload: { resolutionGate: { status: 'needs_review', riskLevel: 'high' } }, created_at: '2026-06-16T15:33:00.000Z' },
          { id: 'ev_resolution_blocked', issue_id: 'iss_resolution_gate', run_id: 'run_resolution_gate', event_type: 'resolution_gate_ready', title: 'Resolution blocked', payload: { resolutionGate: { status: 'blocked', riskLevel: 'critical' } }, created_at: '2026-06-16T15:34:00.000Z' },
          { id: 'ev_resolution_applied', issue_id: 'iss_resolution_gate', run_id: 'run_resolution_gate', event_type: 'resolution_gate_applied', title: 'Resolution applied', payload: { resolutionGate: { status: 'ready', riskLevel: 'medium' } }, created_at: '2026-06-16T15:35:00.000Z' },
        ],
      },
      issueRequestsByIssue: {},
      tasks: [],
      taskLogsByTask: {},
      agentTasks: [],
      agentTeamRuns: [],
      agentTeamApprovalsByRun: {},
    });

    expect(snapshot.events.map((event) => event.type)).toEqual(['resolution_applied', 'resolution_blocked', 'resolution_needs_review', 'resolution_needs_review', 'resolution_ready']);
    expect(snapshot.summary.recovered).toBe(1);
    expect(snapshot.summary.blocked).toBe(1);
    expect(snapshot.summary.manualReview).toBe(3);
  });

  test('将 fix run outcome 事件纳入控制台 timeline 和摘要', () => {
    const snapshot = buildOrchestrationControlSnapshot({
      issues: [
        { id: 'iss_fix_outcome', title: 'Verify fix run', workspace_jid: 'web:main', workspace_folder: 'main', status: 'review', priority: 'normal', created_by: 'u1', created_at: '2026-06-16T16:00:00.000Z', updated_at: '2026-06-16T16:00:00.000Z' },
      ],
      issueRunsByIssue: {
        iss_fix_outcome: [{ id: 'run_fix_child', issue_id: 'iss_fix_outcome', workspace_jid: 'web:main', workspace_folder: 'main', status: 'success', result: 'tests passed', created_by: 'u1', created_at: '2026-06-16T16:01:00.000Z' }],
      },
      issueEventsByRun: {
        run_fix_child: [
          { id: 'ev_fix_verifying', issue_id: 'iss_fix_outcome', run_id: 'run_fix_child', event_type: 'fix_run_verifying', title: 'Fix run verifying', payload: { fixRunOutcome: { status: 'pending', riskLevel: 'medium' } }, created_at: '2026-06-16T16:02:00.000Z' },
          { id: 'ev_fix_resolved', issue_id: 'iss_fix_outcome', run_id: 'run_fix_child', event_type: 'fix_run_resolved', title: 'Fix run resolved', payload: { fixRunOutcome: { status: 'resolved', riskLevel: 'high' } }, created_at: '2026-06-16T16:03:00.000Z' },
          { id: 'ev_fix_needs_review', issue_id: 'iss_fix_outcome', run_id: 'run_fix_child', event_type: 'fix_run_needs_review', title: 'Fix run needs review', payload: { fixRunOutcome: { status: 'needs_review', riskLevel: 'medium' } }, created_at: '2026-06-16T16:04:00.000Z' },
          { id: 'ev_fix_failed', issue_id: 'iss_fix_outcome', run_id: 'run_fix_child', event_type: 'fix_run_failed', title: 'Fix run failed', payload: { fixRunOutcome: { status: 'failed', riskLevel: 'critical' } }, created_at: '2026-06-16T16:05:00.000Z' },
        ],
      },
      issueRequestsByIssue: {},
      tasks: [],
      taskLogsByTask: {},
      agentTasks: [],
      agentTeamRuns: [],
      agentTeamApprovalsByRun: {},
    });

    expect(snapshot.events.map((event) => event.type)).toEqual(['fix_run_failed', 'fix_run_needs_review', 'fix_run_resolved', 'fix_run_verifying']);
    expect(snapshot.summary.recovered).toBe(1);
    expect(snapshot.summary.failed).toBe(1);
    expect(snapshot.summary.blocked).toBe(1);
    expect(snapshot.summary.manualReview).toBe(2);
  });
});
