import * as crypto from 'node:crypto';

import type { ContainerOutput } from './container-runner.js';
import type { StreamEvent } from './stream-event.types.js';
import {
  ensureChatExists,
  createIssueAgentRequest,
  createIssueAgentRunEvent,
  createIssueEvent,
  getIssueAgentRunById,
  getIssueById,
  getLastCompletedIssueRunAt,
  getRegisteredGroup,
  getUserHomeGroup,
  listIssueAgentRequests,
  listIssueComments,
  setIssueAgentRunAwaiting,
  storeMessageDirect,
  touchIssueAgentRunHeartbeat,
  updateIssue,
  updateIssueAgentRun,
  updateIssueLastRun,
  updateChatName,
} from './db.js';
import { logger } from './logger.js';
import { afterIssueEventCreated } from './issue-notifier.js';
import { resolveBackend } from './backends/registry.js';
import type {
  IssueAgentRequest,
  IssueAgentRun,
  IssueComment,
  RegisteredGroup,
  WorkspaceIssue,
} from './types.js';
import type { WebDeps } from './web-context.js';

export function buildIssuePrompt(
  issue: WorkspaceIssue,
  run: IssueAgentRun,
  comments: IssueComment[] | null = null,
  lastAnsweredRequest: IssueAgentRequest | null = null,
): string {
  const parts: (string | null)[] = [];
  if (lastAnsweredRequest) {
    if (lastAnsweredRequest.kind === 'clarification') {
      const question =
        (lastAnsweredRequest.payload as Record<string, unknown> | null)?.question ??
        lastAnsweredRequest.summary ??
        '(question not available)';
      parts.push('[USER REPLY TO YOUR PREVIOUS QUESTION]');
      parts.push(`Q: ${String(question)}`);
      parts.push(`A: ${lastAnsweredRequest.answer ?? '(empty)'}`);
      parts.push('');
    } else if (lastAnsweredRequest.kind === 'permission') {
      parts.push('[PERMISSION DECISION]');
      parts.push(
        `Decision: ${lastAnsweredRequest.decision ?? 'unknown'}${
          lastAnsweredRequest.answer ? `; Message: ${lastAnsweredRequest.answer}` : ''
        }`,
      );
      parts.push('');
    }
  }
  parts.push(
    '<issue_context>',
    `Issue ID: ${issue.id}`,
    `Issue Run ID: ${run.id}`,
    `Title: ${issue.title}`,
    `Status: ${issue.status}`,
    `Priority: ${issue.priority}`,
    `Workspace: ${issue.workspace_folder} (${issue.workspace_jid})`,
    issue.project_repo_id ? `Project: ${issue.project_repo_id}` : 'Project: No project',
    issue.project_git_url ? `Project Git URL: ${issue.project_git_url}` : null,
    issue.project_device_path ? `Project Device Path: ${issue.project_device_path}` : null,
    `Selected Skills: ${(run.selected_skills?.length ? run.selected_skills : issue.selected_skills ?? []).join(', ') || 'No skill'}`,
    '',
    'Description:',
    issue.description || '(empty)',
  );
  if (comments && comments.length) {
    parts.push('');
    parts.push('Discussion (newest first, use as context update since initial issue):');
    for (let i = comments.length - 1; i >= 0; i--) {
      const c = comments[i];
      const by = c.source_type === 'agent' ? '[Agent]' : c.source_type === 'system' ? '[System]' : `[User ${c.created_by ?? 'unknown'}]`;
      const time = new Date(c.created_at).toLocaleString();
      parts.push(`--- Comment #${i + 1} @ ${time} ${by} ---`);
      parts.push(c.body || '(empty)');
    }
  }
  parts.push('');
  parts.push('Instructions:');
  parts.push('- Start from this issue context.');
  parts.push('- If code changes are needed, briefly explain your plan first.');
  parts.push('- When finished, summarize changes, risks, and verification steps.');
  parts.push('</issue_context>');
  return parts.filter((line): line is string => line !== null).join('\n');
}

function buildIssueGroup(baseGroup: RegisteredGroup, issue: WorkspaceIssue, run: IssueAgentRun): RegisteredGroup {
  const executionNode = run.execution_node ?? issue.execution_node ?? undefined;
  return {
    ...baseGroup,
    folder: issue.workspace_folder,
    backend: run.backend ?? issue.backend ?? baseGroup.backend,
    repoId: issue.project_repo_id ?? baseGroup.repoId,
    repoGitUrl: issue.project_git_url ?? baseGroup.repoGitUrl,
    repoMainBranch: issue.project_git_url ? undefined : baseGroup.repoMainBranch,
    repoDevicePath: issue.project_device_path ?? baseGroup.repoDevicePath,
    deviceLinkId: run.agent_link_id ?? issue.agent_link_id ?? baseGroup.deviceLinkId,
    agentClientId: run.agent_client_id ?? issue.agent_client_id ?? baseGroup.agentClientId,
    executionNode: executionNode ?? baseGroup.executionNode,
    executionMode: executionNode ? 'host' : baseGroup.executionMode ?? 'container',
  };
}

function issueRunChatJid(issue: WorkspaceIssue, run: IssueAgentRun): string {
  return `${issue.workspace_jid}#issue:${run.id}`;
}

function persistIssuePrompt(issue: WorkspaceIssue, run: IssueAgentRun, senderId: string, text: string): void {
  const msgId = crypto.randomUUID();
  const chatJid = issueRunChatJid(issue, run);
  ensureChatExists(chatJid);
  updateChatName(chatJid, `Issue · ${issue.title.slice(0, 80)}`);
  storeMessageDirect(
    msgId,
    chatJid,
    senderId,
    'Issue Agent',
    text,
    new Date().toISOString(),
    false,
    { meta: { sourceKind: 'user_command' } },
  );
}

function auditIssueRunEvent(
  issueId: string,
  runId: string,
  eventType: string,
  input: {
    title?: string | null;
    summary?: string | null;
    detail?: string | null;
    payload?: Record<string, unknown> | null;
  } = {},
): void {
  try {
    createIssueAgentRunEvent({
      id: `irev_${crypto.randomBytes(8).toString('hex')}`,
      issue_id: issueId,
      run_id: runId,
      event_type: eventType,
      title: input.title ?? null,
      summary: input.summary ?? null,
      detail: input.detail ?? null,
      payload: input.payload ?? null,
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    logger.warn({ err, issueId, runId, eventType }, 'Failed to persist issue run audit event');
  }
}

function streamEventSummary(event: StreamEvent): string {
  if (event.eventType === 'tool_use_start') {
    return `${event.skillName ? `Skill ${event.skillName}` : `Tool ${event.toolName || 'unknown'}`}${event.toolInputSummary ? ` · ${event.toolInputSummary}` : ''}`;
  }
  if (event.eventType === 'tool_use_end') {
    return `${event.toolName ? `Tool ${event.toolName}` : 'Tool'} ${event.statusText === 'error' ? 'failed' : 'responded'}${event.elapsedSeconds ? ` · ${event.elapsedSeconds}s` : ''}`;
  }
  if (event.eventType === 'tool_progress') {
    return `${event.toolName || 'Tool'} progress${event.toolInputSummary ? ` · ${event.toolInputSummary}` : ''}`;
  }
  return (
    event.title ||
    event.summary ||
    event.statusText ||
    event.toolName ||
    event.taskDescription ||
    event.rawType ||
    event.text?.slice(0, 160) ||
    event.eventType
  );
}

export async function runIssueAgent(
  issueId: string,
  runId: string,
  deps: Pick<WebDeps, 'queue' | 'broadcastIssueRequest'> & {
    broadcastStreamEvent?: (chatJid: string, event: StreamEvent) => void;
  },
): Promise<void> {
  const issue = getIssueById(issueId);
  const run = getIssueAgentRunById(runId);
  if (!issue || !run) return;

  const startedAt = new Date().toISOString();
  updateIssueAgentRun(runId, {
    status: 'running',
    run_started_at: startedAt,
    last_seen_at: startedAt,
    heartbeat_deadline_at: new Date(Date.now() + 90_000).toISOString(),
  });
  updateIssueLastRun(issueId, runId, 'running');
  auditIssueRunEvent(issueId, runId, 'run_started', {
    title: 'Run started',
    summary: issue.title,
    payload: {
      issueId,
      runId,
      workspaceJid: issue.workspace_jid,
      workspaceFolder: issue.workspace_folder,
      issueStatus: issue.status,
      priority: issue.priority,
    },
  });
  const evRunStarted = createIssueEvent({
    issue_id: issueId,
    run_id: runId,
    event_type: 'run_started',
    actor_type: 'system',
    title: 'Run started',
    summary: issue.title,
    detail: { workspace_jid: issue.workspace_jid, workspace_folder: issue.workspace_folder, issue_status_before: issue.status },
  });
  afterIssueEventCreated(evRunStarted, issue);
  if (issue.status === 'todo') {
    updateIssue(issueId, { status: 'in_progress' });
    auditIssueRunEvent(issueId, runId, 'issue_status_changed', {
      title: 'Issue moved to in progress',
      summary: 'todo → in_progress',
      payload: { from: 'todo', to: 'in_progress' },
    });
    const evStatus = createIssueEvent({
      issue_id: issueId,
      event_type: 'status_changed',
      run_id: runId,
      actor_type: 'system',
      title: 'Status changed by agent',
      summary: 'todo → in_progress',
      detail: { from: 'todo', to: 'in_progress', cause: 'run_start' },
    });
    afterIssueEventCreated(evStatus, issue);
  }

  try {
    const baseGroup = getRegisteredGroup(issue.workspace_jid);
    if (!baseGroup) throw new Error('Workspace not found');

    const issueGroup = buildIssueGroup(baseGroup, issue, run);
    const executionMode = issueGroup.executionMode === 'host' ? 'host' : 'container';
    const backend = resolveBackend(issueGroup);
    const ownerHomeFolder = issueGroup.created_by
      ? getUserHomeGroup(issueGroup.created_by)?.folder || issue.workspace_folder
      : issue.workspace_folder;

    // --- comment context injection ---
    let injectedComments: IssueComment[] | null = null;
    try {
      const lastCompletedAt = getLastCompletedIssueRunAt(issue.id, run.id);
      injectedComments = listIssueComments(issue.id, { sinceAt: lastCompletedAt ?? undefined });
    } catch (err) {
      logger.warn({ err, issueId: issue.id, runId: run.id }, 'Failed to load issue comments for prompt injection; continuing without comments');
      injectedComments = null;
    }

    // --- last answered agent request injection (clarification / permission resume) ---
    let lastAnsweredRequest: IssueAgentRequest | null = null;
    if (run.parent_run_id) {
      try {
        const answered = listIssueAgentRequests(issue.id, {
          status: 'answered',
          runId: run.parent_run_id,
        });
        lastAnsweredRequest = answered[0] ?? null;
      } catch (err) {
        logger.warn(
          { err, issueId: issue.id, parentRunId: run.parent_run_id },
          'Failed to load answered agent request for prompt injection',
        );
      }
    }

    const prompt = buildIssuePrompt(issue, run, injectedComments, lastAnsweredRequest);
    const runChatJid = issueRunChatJid(issue, run);
    persistIssuePrompt(issue, run, issue.created_by, prompt);
    auditIssueRunEvent(issueId, runId, 'input_prepared', {
      title: 'Issue prompt prepared',
      summary: `${prompt.length} chars`,
      detail: prompt,
      payload: {
        backend: backend.id,
        backendName: backend.displayName,
        executionMode,
        executionNode: issueGroup.executionNode ?? null,
        agentLinkId: issueGroup.deviceLinkId ?? null,
        agentClientId: issueGroup.agentClientId ?? null,
        selectedSkills: run.selected_skills ?? issue.selected_skills ?? [],
      },
    });

    let latestResult = '';
    let latestError = '';
    let output: ContainerOutput;
    if (!backend.supportsExecutionMode(executionMode)) {
      auditIssueRunEvent(issueId, runId, 'backend_rejected', {
        title: 'Backend rejected execution mode',
        summary: `Backend ${backend.displayName} does not support ${executionMode}`,
        payload: { backend: backend.id, executionMode },
      });
      const evBackend = createIssueEvent({
        issue_id: issueId,
        run_id: runId,
        event_type: 'run_status_changed',
        actor_type: 'system',
        title: 'Backend rejected execution mode',
        summary: `Backend ${backend.displayName} does not support ${executionMode}`,
        detail: { backend: backend.id, execution_mode: executionMode },
      });
      afterIssueEventCreated(evBackend, issue);
      output = {
        status: 'error',
        result: null,
        error: `Backend ${backend.displayName} does not support ${executionMode}`,
      };
    } else {
      output = await backend.run({
        group: issueGroup,
        executionMode,
        input: {
          prompt,
          sessionId: run.session_id ?? undefined,
          groupFolder: issue.workspace_folder,
          chatJid: runChatJid,
          isMain: false,
          isHome: !!issueGroup.is_home,
          isAdminHome: false,
          isScheduledTask: true,
          messageTaskId: issue.id,
          taskRunId: run.id,
          scheduledTaskHasWorkspace: true,
        },
        onProcess: (proc, identifier, selectedProviderId) => {
          auditIssueRunEvent(issueId, runId, 'process_registered', {
            title: 'Agent process registered',
            summary: identifier,
            payload: { identifier, selectedProviderId: selectedProviderId ?? null, executionMode },
          });
          deps.queue.registerProcess(runChatJid, proc, {
            containerName: executionMode === 'container' ? identifier : null,
            groupFolder: issue.workspace_folder,
            displayName: identifier,
            taskRunId: run.id,
            selectedProviderId,
          });
        },
        onOutput: async (streamedOutput) => {
          // Touch heartbeat on any frame so the reconciler keeps this run alive.
          try {
            touchIssueAgentRunHeartbeat(runId);
          } catch (err) {
            logger.warn({ err, runId }, 'Failed to touch issue agent run heartbeat');
          }
          if (streamedOutput.status === 'stream' && streamedOutput.streamEvent) {
            const se = streamedOutput.streamEvent;
            auditIssueRunEvent(issueId, runId, `stream:${se.eventType}`, {
              title: se.title || se.eventType,
              summary: streamEventSummary(se),
              detail: se.detail || se.text || null,
              payload: { streamEvent: se },
            });
            deps.broadcastStreamEvent?.(runChatJid, se);

            // P1-4: persist permission_request as a pending agent request and
            // pause the run / issue so the human can decide.
            if (se.eventType === 'permission_request') {
              try {
                const raw = (se as unknown as { rawEvent?: unknown }).rawEvent;
                const rawObj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
                const correlationId =
                  (rawObj?.requestId as string | undefined) ??
                  (rawObj?.request_id as string | undefined) ??
                  (rawObj?.id as string | undefined) ??
                  null;
                const now = new Date().toISOString();
                const expiresAt = new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString();
                const reqId = `iaq_${crypto.randomBytes(8).toString('hex')}`;
                const req = createIssueAgentRequest({
                  id: reqId,
                  issue_id: issueId,
                  run_id: runId,
                  kind: 'permission',
                  correlation_id: correlationId,
                  title: 'Agent requested permission',
                  summary: (se.title || se.toolName || 'permission request').slice(0, 200),
                  detail: se.detail ?? null,
                  payload: rawObj ?? null,
                  status: 'pending',
                  created_at: now,
                  expires_at: expiresAt,
                });
                setIssueAgentRunAwaiting(runId, 'permission', req.id);
                if (issue.status !== 'waiting_for_human') {
                  updateIssue(issueId, { status: 'waiting_for_human' });
                }
                const evReq = createIssueEvent({
                  issue_id: issueId,
                  run_id: runId,
                  event_type: 'agent_request_created',
                  actor_type: 'agent',
                  title: 'Agent waiting for human approval',
                  summary: req.summary ?? null,
                  payload: { requestId: req.id, kind: 'permission', correlationId },
                });
                afterIssueEventCreated(evReq, issue);
                deps.broadcastIssueRequest?.(
                  issue.workspace_jid,
                  issueId,
                  req,
                  'issue_request_created',
                );
              } catch (err) {
                logger.error({ err, runId, issueId }, 'Failed to persist permission_request');
              }
            }
          }
          if (streamedOutput.result) {
            latestResult = streamedOutput.result;
            auditIssueRunEvent(issueId, runId, 'partial_result', {
              title: 'Agent result updated',
              summary: streamedOutput.result.slice(0, 240),
              detail: streamedOutput.result,
            });
          }
          if (streamedOutput.error) {
            latestError = streamedOutput.error;
            auditIssueRunEvent(issueId, runId, 'partial_error', {
              title: 'Agent error updated',
              summary: streamedOutput.error.slice(0, 240),
              detail: streamedOutput.error,
            });
          }
        },
        ownerHomeFolder,
      });
    }

    if (output.result) latestResult = output.result;
    if (output.error) latestError = output.error;
    const currentStatus = getIssueAgentRunById(runId)?.status;
    if (currentStatus === 'canceled') {
      return;
    }
    // If the run was paused while waiting for human input (permission /
    // clarification), do not overwrite the status with success/error – let the
    // human answer drive the next state transition.
    if (currentStatus === 'awaiting_input') {
      auditIssueRunEvent(issueId, runId, 'run_paused_for_input', {
        title: 'Run paused, waiting for human input',
        summary: `awaiting_input (${getIssueAgentRunById(runId)?.awaiting_kind ?? 'unknown'})`,
        payload: { sessionId: output.newSessionId ?? run.session_id ?? null },
      });
      // Persist new session id (if any) so the resumed run can reuse it.
      if (output.newSessionId) {
        updateIssueAgentRun(runId, { session_id: output.newSessionId });
      }
      updateIssueLastRun(issueId, runId, 'awaiting_input');
      return;
    }
    const status = output.status === 'error' ? 'error' : 'success';
    auditIssueRunEvent(issueId, runId, status === 'success' ? 'run_succeeded' : 'run_failed', {
      title: status === 'success' ? 'Run succeeded' : 'Run failed',
      summary: status === 'success' ? latestResult.slice(0, 240) : latestError || output.error || 'Unknown error',
      detail: status === 'success' ? latestResult || output.result || null : latestError || output.error || null,
      payload: { status, sessionId: output.newSessionId ?? run.session_id ?? null },
    });
    const evRunEnd = createIssueEvent({
      issue_id: issueId,
      run_id: runId,
      event_type: status === 'success' ? 'run_succeeded' : 'run_failed',
      actor_type: 'system',
      title: status === 'success' ? 'Run succeeded' : 'Run failed',
      summary: (status === 'success' ? latestResult : latestError || output.error || 'Unknown error')?.slice(0, 240) || null,
      detail: { status, session_id: output.newSessionId ?? run.session_id ?? null },
    });
    afterIssueEventCreated(evRunEnd, issue);
    updateIssueAgentRun(runId, {
      status,
      result: latestResult || output.result || null,
      error: status === 'error' ? latestError || output.error || 'Unknown error' : null,
      session_id: output.newSessionId ?? run.session_id ?? null,
      run_completed_at: new Date().toISOString(),
    });
    updateIssueLastRun(issueId, runId, status);
    if (status === 'success' && (issue.status === 'todo' || issue.status === 'in_progress')) {
      updateIssue(issueId, { status: 'review' });
      auditIssueRunEvent(issueId, runId, 'issue_status_changed', {
        title: 'Issue moved to review',
        summary: `${issue.status} → review`,
        payload: { from: issue.status, to: 'review' },
      });
      const evReview = createIssueEvent({
        issue_id: issueId,
        run_id: runId,
        event_type: 'status_changed',
        actor_type: 'system',
        title: 'Status changed by agent',
        summary: `${issue.status} → review`,
        detail: { from: issue.status, to: 'review', cause: 'run_succeeded' },
      });
      afterIssueEventCreated(evReview, issue);
    }
  } catch (err) {
    if (getIssueAgentRunById(runId)?.status === 'canceled') {
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, issueId, runId }, 'Issue agent run failed');
    auditIssueRunEvent(issueId, runId, 'run_exception', {
      title: 'Run failed with exception',
      summary: message,
      detail: err instanceof Error ? err.stack || err.message : String(err),
    });
    const evException = createIssueEvent({
      issue_id: issueId,
      run_id: runId,
      event_type: 'run_failed',
      actor_type: 'system',
      title: 'Run failed with exception',
      summary: message.length > 240 ? message.slice(0, 240) + '...' : message,
      detail: { error: message, cause: 'exception' },
    });
    afterIssueEventCreated(evException, issue);
    updateIssueAgentRun(runId, {
      status: 'error',
      error: message,
      run_completed_at: new Date().toISOString(),
    });
    updateIssueLastRun(issueId, runId, 'error');
  }
}
