import { describe, expect, test } from 'vitest';

import {
  createOctoDeckEvent,
  groupOctoDeckEventsForNotificationInbox,
  octodeckEventsFromWsMessage,
} from '../src/octodeck-events.js';
import type { WsMessageOut } from '../src/types.js';

describe('OctoDeck domain events', () => {
  test('creates versioned events with stable routing metadata', () => {
    const event = createOctoDeckEvent({
      type: 'repo_knowledge.index.ready',
      domain: 'repo_knowledge',
      action: 'ready',
      repoId: 'repo_1',
      userId: 'user_1',
      timestamp: '2026-06-12T01:02:03.000Z',
      payload: { chunks: 12 },
    });

    expect(event).toMatchObject({
      version: 1,
      type: 'repo_knowledge.index.ready',
      domain: 'repo_knowledge',
      action: 'ready',
      repoId: 'repo_1',
      userId: 'user_1',
      timestamp: '2026-06-12T01:02:03.000Z',
      payload: { chunks: 12 },
    });
    expect(event.id).toMatch(/^evt_/);
  });

  test('normalizes issue timeline websocket messages into domain events', () => {
    const msg: WsMessageOut = {
      type: 'issue_event',
      workspaceJid: 'web:main',
      issueId: 'issue_1',
      runId: 'run_1',
      event: {
        id: 'event_1',
        issue_id: 'issue_1',
        event_type: 'status_changed',
        actor_id: 'user_1',
        actor_type: 'user',
        created_at: '2026-06-12T02:00:00.000Z',
        payload: { status: 'done' },
      },
    };

    expect(octodeckEventsFromWsMessage(msg)).toEqual([
      expect.objectContaining({
        version: 1,
        type: 'issue.timeline.status_changed',
        domain: 'issue',
        action: 'status_changed',
        workspaceJid: 'web:main',
        issueId: 'issue_1',
        runId: 'run_1',
        userId: 'user_1',
        timestamp: '2026-06-12T02:00:00.000Z',
        payload: msg.event,
      }),
    ]);
  });

  test('normalizes approval request lifecycle messages for inbox consumers', () => {
    const request = {
      id: 'req_1',
      issue_id: 'issue_1',
      run_id: 'run_1',
      kind: 'permission' as const,
      status: 'pending' as const,
      title: '允许提交吗？',
      payload: { options: ['允许', '拒绝'] },
      created_at: '2026-06-12T03:00:00.000Z',
      expires_at: null,
      answered_by: null,
      answered_at: null,
      answer: null,
    };
    const msg: WsMessageOut = {
      type: 'issue_request_created',
      workspaceJid: 'web:main',
      issueId: 'issue_1',
      request,
    };

    expect(octodeckEventsFromWsMessage(msg)).toEqual([
      expect.objectContaining({
        type: 'approval.request.created',
        domain: 'approval',
        action: 'created',
        workspaceJid: 'web:main',
        issueId: 'issue_1',
        runId: 'run_1',
        timestamp: '2026-06-12T03:00:00.000Z',
        payload: request,
      }),
    ]);
  });

  test('passes through already-standard event websocket messages', () => {
    const event = createOctoDeckEvent({
      type: 'device.link.online',
      domain: 'device',
      action: 'online',
      deviceLinkId: 'link_1',
      userId: 'user_1',
      timestamp: '2026-06-12T04:00:00.000Z',
      payload: { status: 'online' },
    });

    expect(octodeckEventsFromWsMessage({ type: 'octodeck_event', event })).toEqual([event]);
  });

  test('groups approval events into notification inbox items', () => {
    const pending = createOctoDeckEvent({
      type: 'approval.request.created',
      domain: 'approval',
      action: 'created',
      issueId: 'issue_1',
      runId: 'run_1',
      timestamp: '2026-06-12T05:00:00.000Z',
      payload: { id: 'req_1', status: 'pending', title: '允许提交吗？' },
    });
    const answered = createOctoDeckEvent({
      type: 'approval.request.answered',
      domain: 'approval',
      action: 'answered',
      issueId: 'issue_1',
      runId: 'run_1',
      timestamp: '2026-06-12T05:01:00.000Z',
      payload: { id: 'req_1', status: 'answered', title: '允许提交吗？' },
    });

    expect(groupOctoDeckEventsForNotificationInbox([pending, answered])).toEqual([
      expect.objectContaining({
        id: 'req_1',
        kind: 'approval',
        status: 'answered',
        title: '允许提交吗？',
        issueId: 'issue_1',
        runId: 'run_1',
        updatedAt: '2026-06-12T05:01:00.000Z',
      }),
    ]);
  });

  test('keeps approval source links and decision urls in inbox items', () => {
    const pending = createOctoDeckEvent({
      type: 'approval.request.created',
      domain: 'approval',
      action: 'created',
      issueId: 'issue_1',
      runId: 'run_1',
      timestamp: '2026-06-12T05:00:00.000Z',
      payload: {
        id: 'req_1',
        status: 'pending',
        title: '允许提交吗？',
        href: '/issues/issue_1',
        decisionUrl: '/api/issues/issue_1/runs/run_1/approval-requests/req_1/decision',
      },
    });

    expect(groupOctoDeckEventsForNotificationInbox([pending])).toEqual([
      expect.objectContaining({
        id: 'req_1',
        href: '/issues/issue_1',
        decisionUrl: '/api/issues/issue_1/runs/run_1/approval-requests/req_1/decision',
      }),
    ]);
  });

  test('normalizes message and runtime websocket events for store reducers', () => {
    const messageEvents = octodeckEventsFromWsMessage({
      type: 'new_message',
      chatJid: 'web:main',
      message: {
        id: 'msg_1',
        chat_jid: 'web:main',
        sender: 'user_1',
        sender_name: '用户',
        content: 'hello',
        timestamp: '2026-06-12T06:00:00.000Z',
        is_from_me: true,
      },
    });
    const runtimeEvents = octodeckEventsFromWsMessage({
      type: 'runner_state',
      chatJid: 'web:main',
      state: 'running',
    });

    expect(messageEvents[0]).toEqual(expect.objectContaining({
      type: 'chat.message.created',
      domain: 'chat',
      action: 'created',
      chatJid: 'web:main',
      userId: 'user_1',
      timestamp: '2026-06-12T06:00:00.000Z',
    }));
    expect(runtimeEvents[0]).toEqual(expect.objectContaining({
      type: 'runtime.runner.running',
      domain: 'runtime',
      action: 'running',
      chatJid: 'web:main',
    }));
  });

  test('normalizes sub-agent status websocket messages into AgentTask domain events', () => {
    const agentStatusEvents = octodeckEventsFromWsMessage({
      type: 'agent_status',
      chatJid: 'web:main',
      agentId: 'agent_1',
      status: 'completed',
      kind: 'conversation',
      name: 'Reviewer',
      prompt: 'review code',
      resultSummary: 'looks good',
      titleGenerating: false,
    });

    expect(agentStatusEvents[0]).toEqual(expect.objectContaining({
      type: 'agent_task.agent_status.completed',
      domain: 'agent_task',
      action: 'agent_status',
      chatJid: 'web:main',
      taskId: 'agent_1',
      payload: expect.objectContaining({
        agentId: 'agent_1',
        status: 'completed',
        name: 'Reviewer',
      }),
    }));
  });

  test('normalizes terminal websocket messages into runtime domain events', () => {
    const terminalEvents = [
      octodeckEventsFromWsMessage({
        type: 'terminal_output',
        chatJid: 'web:main',
        data: 'hello',
      })[0],
      octodeckEventsFromWsMessage({
        type: 'terminal_started',
        chatJid: 'web:main',
      })[0],
      octodeckEventsFromWsMessage({
        type: 'terminal_stopped',
        chatJid: 'web:main',
        reason: 'done',
      })[0],
      octodeckEventsFromWsMessage({
        type: 'terminal_error',
        chatJid: 'web:main',
        error: 'boom',
      })[0],
    ];

    expect(terminalEvents).toEqual([
      expect.objectContaining({ type: 'runtime.terminal.output', domain: 'runtime', action: 'output', chatJid: 'web:main' }),
      expect.objectContaining({ type: 'runtime.terminal.started', domain: 'runtime', action: 'started', chatJid: 'web:main' }),
      expect.objectContaining({ type: 'runtime.terminal.stopped', domain: 'runtime', action: 'stopped', chatJid: 'web:main' }),
      expect.objectContaining({ type: 'runtime.terminal.error', domain: 'runtime', action: 'error', chatJid: 'web:main' }),
    ]);
    expect(terminalEvents[0]?.payload).toEqual(expect.objectContaining({ data: 'hello' }));
    expect(terminalEvents[3]?.payload).toEqual(expect.objectContaining({ error: 'boom' }));
  });

  test('normalizes docker build websocket messages into system domain events', () => {
    const logEvent = octodeckEventsFromWsMessage({
      type: 'docker_build_log',
      line: 'Step 1/5',
    })[0];
    const completeEvent = octodeckEventsFromWsMessage({
      type: 'docker_build_complete',
      success: false,
      error: 'build failed',
    })[0];

    expect(logEvent).toEqual(expect.objectContaining({
      type: 'system.docker_build.log',
      domain: 'system',
      action: 'log',
      payload: expect.objectContaining({ line: 'Step 1/5' }),
    }));
    expect(completeEvent).toEqual(expect.objectContaining({
      type: 'system.docker_build.complete',
      domain: 'system',
      action: 'complete',
      payload: expect.objectContaining({ success: false, error: 'build failed' }),
    }));
  });

  test('normalizes stream snapshot and websocket error messages into standard events', () => {
    const snapshotEvent = octodeckEventsFromWsMessage({
      type: 'stream_snapshot',
      chatJid: 'web:main',
      snapshot: {
        partialText: 'partial answer',
        thinkingText: 'thinking',
        activeTools: [],
        recentEvents: [],
        traceEvents: [],
        taskStates: {},
        systemStatus: null,
        turnId: 'turn_1',
      },
    } as any)[0];
    const errorEvent = octodeckEventsFromWsMessage({
      type: 'ws_error',
      chatJid: 'web:main',
      error: '消息格式无效',
    })[0];

    expect(snapshotEvent).toEqual(expect.objectContaining({
      type: 'agent_task.stream.snapshot',
      domain: 'agent_task',
      action: 'snapshot',
      chatJid: 'web:main',
      correlationId: 'turn_1',
      payload: expect.objectContaining({
        snapshot: expect.objectContaining({ partialText: 'partial answer' }),
      }),
    }));
    expect(errorEvent).toEqual(expect.objectContaining({
      type: 'system.ws.error',
      domain: 'system',
      action: 'error',
      chatJid: 'web:main',
      payload: expect.objectContaining({ error: '消息格式无效' }),
    }));
  });

  test('normalizes task, device, billing and group websocket events into standard domains', () => {
    const taskEvents = octodeckEventsFromWsMessage({
      type: 'task_state',
      chatJid: 'web:main',
      taskId: 'task_1',
      status: 'running',
      name: 'Nightly scan',
      prompt: 'scan',
    });
    const deviceEvents = octodeckEventsFromWsMessage({
      type: 'whatsapp_status',
      userId: 'user_1',
      status: 'connected',
      meJid: 'wa:me',
    });
    const billingEvents = octodeckEventsFromWsMessage({
      type: 'billing_update',
      userId: 'user_1',
      usage: { allowed: true, plan: null, period: null, usage: null, limits: null, reason: null } as any,
    });
    const groupEvents = octodeckEventsFromWsMessage({
      type: 'group_created',
      jid: 'web:new',
      folder: 'new',
      name: 'New workspace',
    });

    expect(taskEvents[0]).toEqual(expect.objectContaining({
      type: 'agent_task.state.running',
      domain: 'agent_task',
      action: 'running',
      chatJid: 'web:main',
      taskId: 'task_1',
    }));
    expect(deviceEvents[0]).toEqual(expect.objectContaining({
      type: 'device.whatsapp.connected',
      domain: 'device',
      action: 'connected',
      userId: 'user_1',
    }));
    expect(billingEvents[0]).toEqual(expect.objectContaining({
      type: 'billing.usage.updated',
      domain: 'billing',
      action: 'updated',
      userId: 'user_1',
    }));
    expect(groupEvents[0]).toEqual(expect.objectContaining({
      type: 'chat.group.created',
      domain: 'chat',
      action: 'group_created',
      chatJid: 'web:new',
    }));
  });

  test('normalizes repo knowledge and memory websocket events into standard domains', () => {
    const repoEvents = octodeckEventsFromWsMessage({
      type: 'repo_knowledge_run_state',
      repoId: 'repo_1',
      userId: 'user_1',
      runId: 'run_1',
      taskId: 'task_1',
      deviceLinkId: 'device_1',
      status: 'ready',
      stats: { chunks: 12 },
    } as any);
    const memoryEvents = octodeckEventsFromWsMessage({
      type: 'memory_update',
      userId: 'user_1',
      memoryType: 'global',
      path: 'CLAUDE.md',
      action: 'updated',
      source: 'web',
    } as any);
    const streamMemoryEvents = octodeckEventsFromWsMessage({
      type: 'stream_event',
      chatJid: 'web:main',
      event: {
        eventType: 'memory_recall',
        taskId: 'task_1',
        turnId: 'turn_1',
        summary: 'loaded cloud memory',
      },
    } as any);

    expect(repoEvents[0]).toEqual(expect.objectContaining({
      type: 'repo_knowledge.run.ready',
      domain: 'repo_knowledge',
      action: 'ready',
      repoId: 'repo_1',
      runId: 'run_1',
      taskId: 'task_1',
      deviceLinkId: 'device_1',
      userId: 'user_1',
    }));
    expect(memoryEvents[0]).toEqual(expect.objectContaining({
      type: 'memory.global.updated',
      domain: 'memory',
      action: 'updated',
      userId: 'user_1',
    }));
    expect(streamMemoryEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'memory.stream.memory_recall',
        domain: 'memory',
        action: 'memory_recall',
        chatJid: 'web:main',
        taskId: 'task_1',
        correlationId: 'turn_1',
      }),
    ]));
  });

  test('supports autopilot standard events for realtime store refresh', () => {
    const event = createOctoDeckEvent({
      type: 'autopilot.run.error',
      domain: 'autopilot',
      action: 'error',
      userId: 'user_1',
      runId: 'aprun_1',
      correlationId: 'ap_1',
      timestamp: '2026-06-13T00:00:00.000Z',
      payload: {
        autopilotId: 'ap_1',
        run: { id: 'aprun_1', status: 'error', attempt: 2 },
      },
    });

    expect(octodeckEventsFromWsMessage({ type: 'octodeck_event', event })).toEqual([
      expect.objectContaining({
        type: 'autopilot.run.error',
        domain: 'autopilot',
        action: 'error',
        userId: 'user_1',
        runId: 'aprun_1',
        correlationId: 'ap_1',
      }),
    ]);
  });

  test('groups failed and skipped autopilot events into notification inbox items', () => {
    const failed = createOctoDeckEvent({
      type: 'autopilot.run.error',
      domain: 'autopilot',
      action: 'error',
      userId: 'user_1',
      runId: 'aprun_error_1',
      correlationId: 'ap_retry_scan',
      timestamp: '2026-06-13T01:00:00.000Z',
      payload: {
        autopilotId: 'ap_retry_scan',
        autopilotName: 'Dependency scanner',
        run: { id: 'aprun_error_1', status: 'error', attempt: 2, error: 'Server not initialized' },
      },
    });
    const skipped = createOctoDeckEvent({
      type: 'autopilot.run.skipped',
      domain: 'autopilot',
      action: 'skipped',
      userId: 'user_1',
      runId: 'aprun_skip_1',
      correlationId: 'ap_nightly',
      timestamp: '2026-06-13T01:05:00.000Z',
      payload: {
        autopilotId: 'ap_nightly',
        autopilotName: 'Nightly repo health',
        run: { id: 'aprun_skip_1', status: 'skipped', skip_reason: 'previous run still running' },
      },
    });

    expect(groupOctoDeckEventsForNotificationInbox([failed, skipped])).toEqual([
      expect.objectContaining({
        id: 'autopilot:ap_nightly:aprun_skip_1',
        kind: 'notification',
        status: 'unread',
        title: 'Autopilot skipped: Nightly repo health',
        summary: 'previous run still running',
        runId: 'aprun_skip_1',
      }),
      expect.objectContaining({
        id: 'autopilot:ap_retry_scan:aprun_error_1',
        kind: 'notification',
        status: 'unread',
        title: 'Autopilot failed: Dependency scanner',
        summary: 'Server not initialized',
        runId: 'aprun_error_1',
      }),
    ]);
  });
});
