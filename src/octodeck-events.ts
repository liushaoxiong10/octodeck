import type { IssueAgentRequest, IssueEvent, WsMessageOut } from './types.js';
export type { OctoDeckEvent, OctoDeckEventDomain, OctoDeckNotificationInboxItem } from './octodeck-event.types.js';
export { groupOctoDeckEventsForNotificationInbox } from './octodeck-event.types.js';
import type { OctoDeckEvent } from './octodeck-event.types.js';

export type CreateOctoDeckEventInput<TPayload> = Omit<
  OctoDeckEvent<TPayload>,
  'id' | 'version' | 'timestamp'
> & {
  id?: string;
  timestamp?: string;
};

export function createOctoDeckEvent<TPayload>(
  input: CreateOctoDeckEventInput<TPayload>,
): OctoDeckEvent<TPayload> {
  return {
    id: input.id ?? `evt_${crypto.randomUUID()}`,
    version: 1,
    timestamp: input.timestamp ?? new Date().toISOString(),
    type: input.type,
    domain: input.domain,
    action: input.action,
    userId: input.userId,
    workspaceJid: input.workspaceJid,
    chatJid: input.chatJid,
    issueId: input.issueId,
    runId: input.runId,
    repoId: input.repoId,
    taskId: input.taskId,
    deviceLinkId: input.deviceLinkId,
    correlationId: input.correlationId,
    payload: input.payload,
  };
}

export function octodeckEventsFromWsMessage(msg: WsMessageOut): OctoDeckEvent[] {
  switch (msg.type) {
    case 'octodeck_event':
      return [msg.event];
    case 'issue_event':
      return [issueTimelineEvent(msg.workspaceJid, msg.issueId, msg.runId, msg.event)];
    case 'issue_request_created':
    case 'issue_request_answered':
    case 'issue_request_expired':
      return [issueRequestEvent(msg.workspaceJid, msg.issueId, msg.type, msg.request)];
    case 'stream_event':
      return streamEvents(msg);
    case 'stream_snapshot':
      return [
        createOctoDeckEvent({
          type: 'agent_task.stream.snapshot',
          domain: 'agent_task',
          action: 'snapshot',
          chatJid: msg.chatJid,
          correlationId: msg.snapshot.turnId,
          payload: msg,
        }),
      ];
    case 'ws_error':
      return [
        createOctoDeckEvent({
          type: 'system.ws.error',
          domain: 'system',
          action: 'error',
          chatJid: msg.chatJid,
          payload: msg,
        }),
      ];
    case 'agent_status':
      return [
        createOctoDeckEvent({
          type: `agent_task.agent_status.${msg.status}`,
          domain: 'agent_task',
          action: 'agent_status',
          chatJid: msg.chatJid,
          taskId: msg.agentId,
          payload: msg,
        }),
      ];
    case 'runner_state':
      return [
        createOctoDeckEvent({
          type: `runtime.runner.${msg.state}`,
          domain: 'runtime',
          action: msg.state,
          chatJid: msg.chatJid,
          payload: { state: msg.state },
        }),
      ];
    case 'terminal_output':
      return [runtimeTerminalEvent('output', msg)];
    case 'terminal_started':
      return [runtimeTerminalEvent('started', msg)];
    case 'terminal_stopped':
      return [runtimeTerminalEvent('stopped', msg)];
    case 'terminal_error':
      return [runtimeTerminalEvent('error', msg)];
    case 'docker_build_log':
      return [systemDockerBuildEvent('log', msg)];
    case 'docker_build_complete':
      return [systemDockerBuildEvent('complete', msg)];
    case 'new_message':
      return [
        createOctoDeckEvent({
          type: 'chat.message.created',
          domain: 'chat',
          action: 'created',
          chatJid: msg.chatJid,
          userId: msg.message.sender,
          timestamp: msg.message.timestamp,
          payload: msg,
        }),
      ];
    case 'task_state':
      return [
        createOctoDeckEvent({
          type: `agent_task.state.${msg.status}`,
          domain: 'agent_task',
          action: msg.status,
          chatJid: msg.chatJid,
          taskId: msg.taskId,
          payload: msg,
        }),
      ];
    case 'whatsapp_status':
      return [
        createOctoDeckEvent({
          type: `device.whatsapp.${msg.status}`,
          domain: 'device',
          action: msg.status,
          userId: msg.userId,
          deviceLinkId: msg.meJid,
          payload: msg,
        }),
      ];
    case 'billing_update':
      return [
        createOctoDeckEvent({
          type: 'billing.usage.updated',
          domain: 'billing',
          action: 'updated',
          userId: msg.userId,
          payload: msg.usage,
        }),
      ];
    case 'group_created':
      return [
        createOctoDeckEvent({
          type: 'chat.group.created',
          domain: 'chat',
          action: 'group_created',
          chatJid: msg.jid,
          payload: msg,
        }),
      ];
    case 'repo_knowledge_run_state':
      return [
        createOctoDeckEvent({
          type: `repo_knowledge.run.${msg.status}`,
          domain: 'repo_knowledge',
          action: msg.status,
          repoId: msg.repoId,
          userId: msg.userId,
          runId: msg.runId,
          taskId: msg.taskId,
          deviceLinkId: msg.deviceLinkId,
          payload: msg,
        }),
      ];
    case 'memory_update':
      return [
        createOctoDeckEvent({
          type: `memory.${msg.memoryType}.${msg.action}`,
          domain: 'memory',
          action: msg.action,
          userId: msg.userId,
          deviceLinkId: msg.deviceLinkId,
          correlationId: msg.correlationId,
          payload: msg,
        }),
      ];
    default:
      return [];
  }
}

function streamEvents(msg: Extract<WsMessageOut, { type: 'stream_event' }>): OctoDeckEvent[] {
  const events: OctoDeckEvent[] = [
    createOctoDeckEvent({
      type: `agent_task.stream.${msg.event.eventType}`,
      domain: 'agent_task',
      action: msg.event.eventType,
      chatJid: msg.chatJid,
      taskId: msg.event.taskId ?? msg.event.toolUseId,
      correlationId: msg.event.turnId,
      timestamp: new Date().toISOString(),
      payload: { event: msg.event, agentId: msg.agentId },
    }),
  ];
  if (msg.event.eventType === 'memory_recall' || msg.event.eventType === 'compact_boundary') {
    events.push(
      createOctoDeckEvent({
        type: `memory.stream.${msg.event.eventType}`,
        domain: 'memory',
        action: msg.event.eventType,
        chatJid: msg.chatJid,
        taskId: msg.event.taskId ?? msg.event.toolUseId,
        correlationId: msg.event.turnId,
        timestamp: new Date().toISOString(),
        payload: { event: msg.event, agentId: msg.agentId },
      }),
    );
  }
  return events;
}

function runtimeTerminalEvent(
  action: 'output' | 'started' | 'stopped' | 'error',
  msg: Extract<WsMessageOut, { type: 'terminal_output' | 'terminal_started' | 'terminal_stopped' | 'terminal_error' }>,
): OctoDeckEvent {
  return createOctoDeckEvent({
    type: `runtime.terminal.${action}`,
    domain: 'runtime',
    action,
    chatJid: msg.chatJid,
    payload: msg,
  });
}

function systemDockerBuildEvent(
  action: 'log' | 'complete',
  msg: Extract<WsMessageOut, { type: 'docker_build_log' | 'docker_build_complete' }>,
): OctoDeckEvent {
  return createOctoDeckEvent({
    type: `system.docker_build.${action}`,
    domain: 'system',
    action,
    payload: msg,
  });
}

function issueTimelineEvent(
  workspaceJid: string,
  issueId: string,
  runId: string | null,
  event: IssueEvent,
): OctoDeckEvent<IssueEvent> {
  return createOctoDeckEvent({
    type: `issue.timeline.${event.event_type}`,
    domain: 'issue',
    action: event.event_type,
    workspaceJid,
    issueId,
    runId: runId ?? event.run_id ?? null,
    userId: event.actor_id ?? undefined,
    timestamp: event.created_at,
    correlationId: event.reference_id ?? undefined,
    payload: event,
  });
}

function issueRequestEvent(
  workspaceJid: string,
  issueId: string,
  messageType: 'issue_request_created' | 'issue_request_answered' | 'issue_request_expired',
  request: IssueAgentRequest,
): OctoDeckEvent<IssueAgentRequest> {
  const action = messageType.replace('issue_request_', '');
  return createOctoDeckEvent({
    type: `approval.request.${action}`,
    domain: 'approval',
    action,
    workspaceJid,
    issueId,
    runId: request.run_id,
    userId: request.answered_by ?? undefined,
    timestamp: request.answered_at ?? request.created_at,
    correlationId: request.correlation_id ?? request.id,
    payload: request,
  });
}
