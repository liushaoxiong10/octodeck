import * as crypto from 'node:crypto';

import type { ContainerOutput } from './container-runner.js';
import type { StreamEvent } from './stream-event.types.js';
import {
  ensureChatExists,
  getIssueAgentRunById,
  getIssueById,
  getRegisteredGroup,
  getUserHomeGroup,
  storeMessageDirect,
  updateIssue,
  updateIssueAgentRun,
  updateIssueLastRun,
} from './db.js';
import { logger } from './logger.js';
import { resolveBackend } from './backends/registry.js';
import type { IssueAgentRun, RegisteredGroup, WorkspaceIssue } from './types.js';
import type { WebDeps } from './web-context.js';

export function buildIssuePrompt(issue: WorkspaceIssue, run: IssueAgentRun): string {
  return [
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
    '',
    'Instructions:',
    '- Start from this issue context.',
    '- If code changes are needed, briefly explain your plan first.',
    '- When finished, summarize changes, risks, and verification steps.',
    '</issue_context>',
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}

function buildIssueGroup(baseGroup: RegisteredGroup, issue: WorkspaceIssue, run: IssueAgentRun): RegisteredGroup {
  const executionNode = run.execution_node ?? issue.execution_node ?? undefined;
  return {
    ...baseGroup,
    folder: issue.workspace_folder,
    backend: run.backend ?? issue.backend ?? baseGroup.backend,
    repoId: issue.project_repo_id ?? baseGroup.repoId,
    repoGitUrl: issue.project_git_url ?? baseGroup.repoGitUrl,
    repoDevicePath: issue.project_device_path ?? baseGroup.repoDevicePath,
    deviceLinkId: run.agent_link_id ?? issue.agent_link_id ?? baseGroup.deviceLinkId,
    agentClientId: run.agent_client_id ?? issue.agent_client_id ?? baseGroup.agentClientId,
    executionNode: executionNode ?? baseGroup.executionNode,
    executionMode: executionNode ? 'host' : baseGroup.executionMode ?? 'container',
  };
}

function persistIssuePrompt(issue: WorkspaceIssue, senderId: string, text: string): void {
  const msgId = crypto.randomUUID();
  ensureChatExists(issue.workspace_jid);
  storeMessageDirect(
    msgId,
    issue.workspace_jid,
    senderId,
    'Issue Agent',
    text,
    new Date().toISOString(),
    false,
    { meta: { sourceKind: 'user_command' } },
  );
}

export async function runIssueAgent(
  issueId: string,
  runId: string,
  deps: Pick<WebDeps, 'queue'> & {
    broadcastStreamEvent?: (chatJid: string, event: StreamEvent) => void;
  },
): Promise<void> {
  const issue = getIssueById(issueId);
  const run = getIssueAgentRunById(runId);
  if (!issue || !run) return;

  const startedAt = new Date().toISOString();
  updateIssueAgentRun(runId, { status: 'running', run_started_at: startedAt });
  updateIssueLastRun(issueId, runId, 'running');

  try {
    const baseGroup = getRegisteredGroup(issue.workspace_jid);
    if (!baseGroup) throw new Error('Workspace not found');

    const issueGroup = buildIssueGroup(baseGroup, issue, run);
    const executionMode = issueGroup.executionMode === 'host' ? 'host' : 'container';
    const backend = resolveBackend(issueGroup);
    const ownerHomeFolder = issueGroup.created_by
      ? getUserHomeGroup(issueGroup.created_by)?.folder || issue.workspace_folder
      : issue.workspace_folder;
    const prompt = buildIssuePrompt(issue, run);
    persistIssuePrompt(issue, issue.created_by, prompt);

    let latestResult = '';
    let latestError = '';
    let output: ContainerOutput;
    if (!backend.supportsExecutionMode(executionMode)) {
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
          chatJid: issue.workspace_jid,
          isMain: false,
          isHome: !!issueGroup.is_home,
          isAdminHome: false,
          taskRunId: run.id,
        },
        onProcess: (proc, identifier, selectedProviderId) => {
          deps.queue.registerProcess(issue.workspace_jid, proc, {
            containerName: executionMode === 'container' ? identifier : null,
            groupFolder: issue.workspace_folder,
            displayName: identifier,
            taskRunId: run.id,
            selectedProviderId,
          });
        },
        onOutput: async (streamedOutput) => {
          if (streamedOutput.status === 'stream' && streamedOutput.streamEvent) {
            deps.broadcastStreamEvent?.(issue.workspace_jid, streamedOutput.streamEvent);
          }
          if (streamedOutput.result) latestResult = streamedOutput.result;
          if (streamedOutput.error) latestError = streamedOutput.error;
        },
        ownerHomeFolder,
      });
    }

    if (output.result) latestResult = output.result;
    if (output.error) latestError = output.error;
    const status = output.status === 'error' ? 'error' : 'success';
    updateIssueAgentRun(runId, {
      status,
      result: latestResult || output.result || null,
      error: status === 'error' ? latestError || output.error || 'Unknown error' : null,
      session_id: output.newSessionId ?? run.session_id ?? null,
      run_completed_at: new Date().toISOString(),
    });
    updateIssueLastRun(issueId, runId, status);
    if (status === 'success' && issue.status === 'todo') {
      updateIssue(issueId, { status: 'review' });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, issueId, runId }, 'Issue agent run failed');
    updateIssueAgentRun(runId, {
      status: 'error',
      error: message,
      run_completed_at: new Date().toISOString(),
    });
    updateIssueLastRun(issueId, runId, 'error');
  }
}
