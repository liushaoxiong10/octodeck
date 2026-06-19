import type { OctoDeckEvent, OctoDeckEventDomain } from './octodeck-event.types';

type CreateOctoDeckEventInput<TPayload> = Omit<OctoDeckEvent<TPayload>, 'id' | 'version' | 'timestamp'> & {
  id?: string;
  timestamp?: string;
};

function nextEventId(): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined;
  if (cryptoApi?.randomUUID) return `evt_${cryptoApi.randomUUID()}`;
  return `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function createOctoDeckEvent<TPayload>(input: CreateOctoDeckEventInput<TPayload>): OctoDeckEvent<TPayload> {
  return {
    id: input.id ?? nextEventId(),
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

export function octodeckEventsFromWsMessage(data: any): OctoDeckEvent[] {
  if (!data || typeof data !== 'object') return [];
  if (data.type === 'octodeck_event' && data.event?.domain) return [data.event as OctoDeckEvent];
  if (data.type === 'issue_event' && data.event) {
    const event = data.event;
    return [createOctoDeckEvent({
      type: `issue.timeline.${event.event_type}`,
      domain: 'issue',
      action: event.event_type,
      workspaceJid: data.workspaceJid,
      issueId: data.issueId,
      runId: data.runId ?? event.run_id ?? null,
      userId: event.actor_id ?? undefined,
      timestamp: event.created_at,
      correlationId: event.reference_id ?? undefined,
      payload: event,
    })];
  }
  if (data.type === 'issue_request_created' || data.type === 'issue_request_answered' || data.type === 'issue_request_expired') {
    const request = data.request ?? {};
    const action = String(data.type).replace('issue_request_', '');
    return [createOctoDeckEvent({
      type: `approval.request.${action}`,
      domain: 'approval',
      action,
      workspaceJid: data.workspaceJid,
      issueId: data.issueId,
      runId: request.run_id,
      userId: request.answered_by ?? undefined,
      timestamp: request.answered_at ?? request.created_at,
      correlationId: request.correlation_id ?? request.id,
      payload: request,
    })];
  }
  if (data.type === 'runner_state') return [standardEvent('runtime', `runtime.runner.${data.state}`, data.state, data, { chatJid: data.chatJid })];
  if (data.type === 'terminal_output') return [standardEvent('runtime', 'runtime.terminal.output', 'output', data, { chatJid: data.chatJid })];
  if (data.type === 'terminal_started') return [standardEvent('runtime', 'runtime.terminal.started', 'started', data, { chatJid: data.chatJid })];
  if (data.type === 'terminal_stopped') return [standardEvent('runtime', 'runtime.terminal.stopped', 'stopped', data, { chatJid: data.chatJid })];
  if (data.type === 'terminal_error') return [standardEvent('runtime', 'runtime.terminal.error', 'error', data, { chatJid: data.chatJid })];
  if (data.type === 'docker_build_log') return [standardEvent('system', 'system.docker_build.log', 'log', data)];
  if (data.type === 'docker_build_complete') return [standardEvent('system', 'system.docker_build.complete', 'complete', data)];
  if (data.type === 'task_state') return [standardEvent('agent_task', `agent_task.state.${data.status}`, data.status, data, { chatJid: data.chatJid, taskId: data.taskId })];
  if (data.type === 'agent_status') return [standardEvent('agent_task', `agent_task.agent_status.${data.status}`, 'agent_status', data, { chatJid: data.chatJid, taskId: data.agentId })];
  if (data.type === 'new_message') return [standardEvent('chat', 'chat.message.created', 'created', data, { chatJid: data.chatJid, userId: data.message?.sender, timestamp: data.message?.timestamp })];
  if (data.type === 'stream_event') {
    const events = [standardEvent('agent_task', `agent_task.stream.${data.event?.eventType}`, data.event?.eventType, data, { chatJid: data.chatJid, taskId: data.event?.taskId ?? data.event?.toolUseId, correlationId: data.event?.turnId })];
    if (data.event?.eventType === 'memory_recall' || data.event?.eventType === 'compact_boundary') {
      events.push(standardEvent('memory', `memory.stream.${data.event.eventType}`, data.event.eventType, data, { chatJid: data.chatJid, taskId: data.event?.taskId ?? data.event?.toolUseId, correlationId: data.event?.turnId }));
    }
    return events;
  }
  if (data.type === 'stream_snapshot') return [standardEvent('agent_task', 'agent_task.stream.snapshot', 'snapshot', data, { chatJid: data.chatJid, correlationId: data.snapshot?.turnId })];
  if (data.type === 'ws_error') return [standardEvent('system', 'system.ws.error', 'error', data, { chatJid: data.chatJid })];
  if (data.type === 'whatsapp_status') return [standardEvent('device', `device.whatsapp.${data.status}`, data.status, data, { userId: data.userId, deviceLinkId: data.meJid })];
  if (data.type === 'billing_update') return [standardEvent('billing', 'billing.usage.updated', 'updated', data.usage, { userId: data.userId })];
  if (data.type === 'group_created') return [standardEvent('chat', 'chat.group.created', 'group_created', data, { chatJid: data.jid })];
  if (data.type === 'repo_knowledge_run_state') return [standardEvent('repo_knowledge', `repo_knowledge.run.${data.status}`, data.status, data, { repoId: data.repoId, userId: data.userId, runId: data.runId, taskId: data.taskId, deviceLinkId: data.deviceLinkId })];
  if (data.type === 'memory_update') return [standardEvent('memory', `memory.${data.memoryType}.${data.action}`, data.action, data, { userId: data.userId, deviceLinkId: data.deviceLinkId, correlationId: data.correlationId })];
  return [];
}

function standardEvent(
  domain: OctoDeckEventDomain,
  type: string,
  action: string,
  payload: unknown,
  route: Partial<Pick<OctoDeckEvent, 'chatJid' | 'repoId' | 'runId' | 'taskId' | 'userId' | 'timestamp' | 'deviceLinkId' | 'correlationId'>> = {},
): OctoDeckEvent {
  return createOctoDeckEvent({
    type,
    domain,
    action,
    payload,
    ...route,
  });
}
