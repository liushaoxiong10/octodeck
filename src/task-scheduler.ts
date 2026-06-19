import { ChildProcess } from 'child_process';
import crypto from 'node:crypto';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import path from 'path';

import {
  DATA_DIR,
  GROUPS_DIR,
  SCHEDULER_POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import { getSystemSettings } from './runtime-config.js';
import { ContainerOutput, writeTasksSnapshot } from './container-runner.js';
import { resolveBackend } from './backends/registry.js';
import {
  advanceSkippedTask,
  claimTaskRun,
  getAllTasks,
  cleanupOldTaskRunLogs,
  cleanupStaleRunningLogs,
  deleteGroupData,
  getDueTasks,
  getTaskById,
  getUserById,
  getUserHomeGroup,
  logTaskRun,
  logTaskRunStart,
  releaseTaskRunClaim,
  upsertAgentTask,
  updateTaskRunLog,
  updateTaskAfterRun,
  updateTaskAfterRunClaimed,
} from './db.js';
import { enforceOrchestrationDecision } from './orchestration-enforcer.js';
import { evaluateOrchestrationPolicy } from './orchestration-policy.js';
import { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';
import { resolveTaskOwner } from './task-utils.js';
import { removeFlowArtifacts } from './file-manager.js';
import { hasScriptCapacity, runScript } from './script-runner.js';
import type { StreamEvent } from './stream-event.types.js';
import { AuthUser, ExecutionMode, RegisteredGroup, ScheduledTask, User } from './types.js';
import { checkBillingAccessFresh, isBillingEnabled } from './billing.js';
import { checkOwnerActive } from './owner-gate.js';
import { stripAgentInternalTags } from './utils.js';
import { requestWorkspaceCleanup } from './agent-link/registry.js';
import { buildRegistryGovernanceSnapshot } from './routes/registry.js';

/**
 * Resolve the actual group JID to send a task to.
 * Falls back from the task's stored chat_jid to any group matching the same folder.
 */
function resolveTargetGroupJid(
  task: ScheduledTask,
  groups: Record<string, RegisteredGroup>,
): string {
  const directTarget = groups[task.chat_jid];
  if (directTarget && directTarget.folder === task.group_folder) {
    return task.chat_jid;
  }
  const sameFolder = Object.entries(groups).filter(
    ([, g]) => g.folder === task.group_folder,
  );
  const preferred =
    sameFolder.find(([jid]) => jid.startsWith('web:')) || sameFolder[0];
  return preferred?.[0] || '';
}

function resolveTaskExecutionMode(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): ExecutionMode {
  if (task.execution_mode === 'host' || task.execution_mode === 'container') {
    return task.execution_mode;
  }
  // Legacy fallback: inherit from the original group
  const groups = deps.registeredGroups();
  const group = groups[task.chat_jid];
  if (group) {
    if (!group.is_home) {
      const homeSibling = Object.values(groups).find(
        (g) => g.folder === group.folder && g.is_home,
      );
      if (homeSibling) return homeSibling.executionMode || 'container';
    }
    return group.executionMode || 'container';
  }
  return 'container';
}

function resolveTaskExecutionNode(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): string | undefined {
  if (task.execution_node) return task.execution_node;
  const group = deps.registeredGroups()[task.chat_jid];
  return group?.executionNode;
}

function deviceLinkIdFromExecutionTarget(
  value: string | undefined | null,
): string | undefined {
  if (!value || value === 'server-local') return undefined;
  const runtimeMatch = /^runtime:(cl_[0-9a-f]{16}):/.exec(value);
  if (runtimeMatch) return runtimeMatch[1];
  const legacyRuntimeMatch = /^(cl_[0-9a-f]{16}):/.exec(value);
  if (legacyRuntimeMatch) return legacyRuntimeMatch[1];
  return /^cl_[0-9a-f]{16}$/.test(value) ? value : undefined;
}

function resolveTaskSourceGroup(
  task: ScheduledTask,
  groups: Record<string, RegisteredGroup>,
): RegisteredGroup | undefined {
  return groups[task.chat_jid] || Object.values(groups).find(
    (g) => g.folder === task.group_folder,
  );
}

function userToAuthUser(user: User): AuthUser {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    status: user.status,
    display_name: user.display_name,
    permissions: user.permissions,
    must_change_password: user.must_change_password,
  };
}

function applyTaskWorkspaceConfig(
  group: RegisteredGroup,
  task: ScheduledTask,
  sourceGroup: RegisteredGroup | undefined,
  deps: SchedulerDependencies,
): RegisteredGroup {
  const executionMode = resolveTaskExecutionMode(task, deps);
  const runtimeProfile =
    task.runtime_profile ?? sourceGroup?.runtimeProfile ?? group.runtimeProfile;
  const executionNode =
    executionMode === 'host'
      ? (resolveTaskExecutionNode(task, deps) ?? group.executionNode)
      : undefined;

  return {
    ...group,
    executionMode,
    executionNode,
    runtimeProfile: runtimeProfile ?? undefined,
    agentClientId:
      task.agent_client_id ?? sourceGroup?.agentClientId ?? group.agentClientId,
    backend: task.backend ?? sourceGroup?.backend ?? group.backend,
    agentModel: task.agent_model ?? sourceGroup?.agentModel ?? group.agentModel,
    customCwd: sourceGroup?.customCwd ?? group.customCwd,
    repoId: sourceGroup?.repoId ?? group.repoId,
    repoGitUrl: sourceGroup?.repoGitUrl ?? group.repoGitUrl,
    repoMainBranch: sourceGroup?.repoMainBranch ?? group.repoMainBranch,
    repoDevicePath: sourceGroup?.repoDevicePath ?? group.repoDevicePath,
    deviceLinkId: sourceGroup?.deviceLinkId ?? group.deviceLinkId,
  };
}

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    containerName: string | null,
    groupFolder: string,
    displayName?: string,
    taskRunId?: string,
    selectedProviderId?: string | null,
  ) => void;
  sendMessage: (
    jid: string,
    text: string,
    options?: { source?: string },
  ) => Promise<string | undefined | void>;
  broadcastStreamEvent?: (chatJid: string, event: StreamEvent) => void;
  onWorkspaceCreated?: (
    jid: string,
    folder: string,
    name: string,
    userId?: string,
  ) => void;
  /** Store task prompt as a user-visible message in the workspace chat */
  storePromptMessage?: (
    chatJid: string,
    senderId: string,
    senderName: string,
    text: string,
    taskId?: string,
  ) => void;
  /** Store task result in workspace chat and push to owner's IM channels */
  storeResultAndNotify?: (
    chatJid: string,
    text: string,
    options: {
      ownerId?: string;
      notifyChannels?: string[] | null;
      sourceKind?: ContainerOutput['sourceKind'];
      skipStore?: boolean;
      workspaceFolder?: string;
    },
  ) => Promise<void>;
  assistantName: string;
}

export interface RunTaskOptions {
  /** Unique ID for isolated task IPC namespace (tasks-run/{taskRunId}/) */
  taskRunId?: string;
  /** Manual trigger — don't update next_run, skip isTaskStillActive check */
  manualRun?: boolean;
  /** DB fencing token acquired by claimTaskRun before execution starts. */
  claimToken?: string;
}

const runningTaskIds = new Set<string>();

export function getRunningTaskIds(): string[] {
  return [...runningTaskIds];
}

/**
 * Decide whether a due task is so overdue that we should skip this missed run
 * and advance to the next scheduled trigger instead. Prevents the
 * "restart-storm" failure mode where many tasks fire concurrently after a
 * long downtime. Exported for direct test coverage of the policy.
 */
export function shouldSkipBackfill(
  nextRunIso: string | null | undefined,
  nowMs: number,
  graceMs: number,
): boolean {
  if (graceMs <= 0 || !nextRunIso) return false;
  const overdueMs = nowMs - new Date(nextRunIso).getTime();
  return overdueMs > graceMs;
}

function completeTaskRunWithFence(
  taskId: string,
  claimToken: string | undefined,
  nextRun: string | null,
  resultSummary: string,
): boolean {
  if (!claimToken) {
    updateTaskAfterRun(taskId, nextRun, resultSummary);
    return true;
  }
  const updated = updateTaskAfterRunClaimed(
    taskId,
    claimToken,
    nextRun,
    resultSummary,
  );
  if (!updated) {
    logger.warn(
      { taskId },
      'Task run completion ignored because claim token is stale or missing',
    );
  }
  return updated;
}

function releaseTaskClaimIfPresent(
  taskId: string,
  claimToken: string | undefined,
): void {
  if (!claimToken) return;
  releaseTaskRunClaim(taskId, claimToken);
}

function computeNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    return interval.next().toISOString();
  } else if (task.schedule_type === 'interval') {
    const ms = Number(task.schedule_value);
    if (!Number.isFinite(ms) || ms <= 0) return null;
    const anchor = task.next_run
      ? new Date(task.next_run).getTime()
      : Date.now();
    const now = Date.now();
    const elapsed = now - anchor;
    const periods = elapsed > 0 ? Math.ceil(elapsed / ms) : 1;
    return new Date(anchor + periods * ms).toISOString();
  }
  // 'once' tasks have no next run
  return null;
}

async function enforceScheduledTaskOrchestration(
  task: ScheduledTask,
  sourceGroup: RegisteredGroup | undefined,
  claimToken: string,
): Promise<boolean> {
  const ownerId = task.created_by ?? sourceGroup?.created_by;
  const owner = ownerId ? getUserById(ownerId) : undefined;
  if (!owner) return true;

  const { registry } = buildRegistryGovernanceSnapshot(userToAuthUser(owner));
  const decision = evaluateOrchestrationPolicy({
    source: 'task',
    item: {
      id: task.id,
      title: task.prompt,
      description: task.script_command,
      priority: null,
      selectedSkillIds: null,
      agentClientId: task.agent_client_id ?? null,
      executionNode: task.execution_node ?? null,
    },
    registry,
  });

  const shouldExecute = decision.mode === 'auto' && decision.enforcementAction === 'execute';
  if (shouldExecute) return true;

  const now = new Date().toISOString();
  const runLogId = logTaskRunStart(task.id);
  const nextRun = computeNextRun(task);
  const runRef = `orch_${crypto.randomBytes(8).toString('hex')}`;

  await enforceOrchestrationDecision({
    source: 'task',
    sourceId: task.id,
    title: task.prompt,
    decision,
    now,
    createApprovalRequest: () => ({ requestId: runRef, runId: runRef }),
    createEvent: (event) => {
      const blocked = event.decision.mode === 'blocked';
      const approval = event.decision.mode === 'approval_required';
      const result = approval
        ? `Approval required: ${event.detail ?? event.summary}`
        : blocked
          ? `Blocked: ${event.detail ?? event.summary}`
          : `Manual review required: ${event.detail ?? event.summary}`;
      updateTaskRunLog(runLogId, {
        duration_ms: 0,
        status: blocked ? 'error' : 'success',
        result: blocked ? null : result,
        error: blocked ? result : null,
      });
      upsertAgentTask({
        id: `agtask_${runRef}`,
        source_type: 'scheduled_task',
        source_ref: task.id,
        run_ref: runRef,
        status: approval ? 'waiting_approval' : blocked ? 'skipped' : 'paused',
        workspace_jid: task.workspace_jid ?? task.chat_jid,
        workspace_folder: task.workspace_folder ?? task.group_folder,
        actor_user_id: owner.id,
        agent_client_id: task.agent_client_id ?? null,
        execution_node: task.execution_node ?? null,
        backend: task.backend ?? null,
        result: blocked ? null : result,
        error: blocked ? result : null,
        context: {
          taskId: task.id,
          orchestrationPolicy: true,
          enforcementAction: event.decision.enforcementAction,
          decision: event.decision,
        },
        created_at: now,
        updated_at: now,
        completed_at: approval ? null : now,
      });
    },
  });

  completeTaskRunWithFence(
    task.id,
    claimToken,
    nextRun,
    decision.mode === 'blocked'
      ? `Blocked: ${decision.blockers.join(' · ') || 'Orchestration policy blocked execution'}`
      : decision.mode === 'approval_required'
        ? 'Approval required before scheduled task execution'
        : 'Manual orchestration review required before scheduled task execution',
  );
  return false;
}

/**
 * Re-check DB before running — task may have been cancelled/paused while queued.
 * Returns true if the task is still active and should proceed.
 */
function isTaskStillActive(taskId: string, label?: string): boolean {
  const currentTask = getTaskById(taskId);
  if (!currentTask || currentTask.status !== 'active') {
    logger.info(
      { taskId },
      `Skipping ${label ?? 'task'}: deleted or no longer active since enqueue`,
    );
    return false;
  }
  return true;
}

async function runTask(
  staleTask: ScheduledTask,
  deps: SchedulerDependencies,
  options?: RunTaskOptions,
): Promise<void> {
  if (!options?.manualRun && !isTaskStillActive(staleTask.id, 'task')) {
    releaseTaskClaimIfPresent(staleTask.id, options?.claimToken);
    return;
  }

  // Refresh task from DB to avoid stale closure data
  const task = getTaskById(staleTask.id);
  if (!task) {
    releaseTaskClaimIfPresent(staleTask.id, options?.claimToken);
    return;
  }

  runningTaskIds.add(task.id);
  const startTime = Date.now();
  const runLogId = logTaskRunStart(task.id);
  const taskRunId = options?.taskRunId || crypto.randomUUID();
  const scheduledTaskHasWorkspace = !!(
    task.workspace_jid &&
    task.workspace_folder &&
    deps.registeredGroups()[task.workspace_jid]
  );

  // Background task mode: execute against the source workspace configuration
  // without registering/creating a new visible workspace. The daemon still gets
  // taskId/taskRunId metadata so device-local runs use
  // ~/.octodeck/workspace/tasks/<taskId>/<taskRunId>.
  const groups = deps.registeredGroups();
  const sourceJid = resolveTargetGroupJid(task, groups) || task.chat_jid;
  const sourceGroup = groups[sourceJid] || resolveTaskSourceGroup(task, groups);

  const mirrorScheduledTaskRun = (
    status: 'queued' | 'running' | 'success' | 'error' | 'canceled' | 'lost',
    extra: { result?: string | null; error?: string | null; completedAt?: string | null } = {},
  ) => {
    const now = new Date().toISOString();
    upsertAgentTask({
      id: `agtask_${taskRunId}`,
      source_type: 'scheduled_task',
      source_ref: task.id,
      run_ref: taskRunId,
      status,
      workspace_jid: task.workspace_jid ?? sourceJid ?? task.chat_jid,
      workspace_folder: task.workspace_folder ?? task.group_folder,
      actor_user_id: task.created_by ?? null,
      agent_client_id: task.agent_client_id ?? null,
      execution_node: task.execution_node ?? null,
      backend: task.backend ?? null,
      result: extra.result ?? null,
      error: extra.error ?? null,
      context: {
        taskId: task.id,
        runLogId,
        manualRun: !!options?.manualRun,
        scheduleType: task.schedule_type,
        executionType: task.execution_type,
      },
      created_at: new Date(startTime).toISOString(),
      started_at: status === 'queued' ? null : new Date(startTime).toISOString(),
      completed_at: extra.completedAt ?? null,
      updated_at: now,
    });
  };

  mirrorScheduledTaskRun('running');

  if (!sourceGroup) {
    logger.error(
      { taskId: task.id, chatJid: task.chat_jid, groupFolder: task.group_folder },
      'Source workspace group not found for background task',
    );
    updateTaskRunLog(runLogId, {
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Source workspace group not found: ${task.chat_jid}`,
    });
    mirrorScheduledTaskRun('error', {
      error: `Source workspace group not found: ${task.chat_jid}`,
      completedAt: new Date().toISOString(),
    });
    const nextRun = options?.manualRun ? task.next_run : computeNextRun(task);
    completeTaskRunWithFence(
      task.id,
      options?.claimToken,
      nextRun,
      `Error: Source workspace group not found: ${task.chat_jid}`,
    );
    runningTaskIds.delete(task.id);
    return;
  }

  const taskGroup = applyTaskWorkspaceConfig(
    {
      ...sourceGroup,
      folder: sourceGroup.folder,
      created_by: resolveTaskOwner(task, sourceGroup),
      // Background task runs must not be treated as the user's interactive home
      // conversation even if the source workspace is the home workspace.
      is_home: false,
    },
    task,
    sourceGroup,
    deps,
  );

  const effectiveJid = `${sourceJid}#task:${taskRunId}`;

  const groupDir = path.join(GROUPS_DIR, taskGroup.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info(
    { taskId: task.id, group: taskGroup.folder, sourceJid, taskRunId },
    'Running scheduled task in background mode',
  );

  // Owner gate before running task: a disabled/deleted owner's scheduled
  // tasks must stop firing (billing only checks balance, not status, and is
  // skipped for admins — so it can't cover this). See `src/owner-gate.ts`.
  if (taskGroup.created_by) {
    const ownerGate = checkOwnerActive(getUserById(taskGroup.created_by));
    if (!ownerGate.allowed) {
      logger.info(
        {
          taskId: task.id,
          userId: taskGroup.created_by,
          ownerStatus: ownerGate.status,
        },
        'Owner not active, blocking scheduled task',
      );
    updateTaskRunLog(runLogId, {
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: '账户已禁用',
    });
      mirrorScheduledTaskRun('error', { error: '账户已禁用', completedAt: new Date().toISOString() });
      runningTaskIds.delete(task.id);
      const nextRun = options?.manualRun ? task.next_run : computeNextRun(task);
      completeTaskRunWithFence(
        task.id,
        options?.claimToken,
        nextRun,
        'Error: 账户已禁用',
      );
      return;
    }
  }

  // Billing quota check before running task
  if (isBillingEnabled() && taskGroup.created_by) {
    const owner = getUserById(taskGroup.created_by);
    if (owner && owner.role !== 'admin') {
      const accessResult = checkBillingAccessFresh(
        taskGroup.created_by,
        owner.role,
      );
      if (!accessResult.allowed) {
        const reason = accessResult.reason || '当前账户不可用';
        logger.info(
          {
            taskId: task.id,
            userId: taskGroup.created_by,
            reason,
            blockType: accessResult.blockType,
          },
          'Billing access denied, blocking scheduled task',
        );
        updateTaskRunLog(runLogId, {
          duration_ms: Date.now() - startTime,
          status: 'error',
          result: null,
          error: `计费限制: ${reason}`,
        });
        mirrorScheduledTaskRun('error', { error: `计费限制: ${reason}`, completedAt: new Date().toISOString() });
        runningTaskIds.delete(task.id);
        // Still compute next run so the task isn't stuck (but preserve for manual runs)
        const nextRun = options?.manualRun
          ? task.next_run
          : computeNextRun(task);
        completeTaskRunWithFence(
          task.id,
          options?.claimToken,
          nextRun,
          `Error: 计费限制: ${reason}`,
        );
        return;
      }
    }
  }

  // Update tasks snapshot for container to read (filtered by group)
  const isHome = false; // Task workspaces are never home
  const isAdminHome = false;
  const tasks = getAllTasks();
  writeTasksSnapshot(
    taskGroup.folder,
    isAdminHome,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  let result: string | null = null;
  let error: string | null = null;
  // Track the time of last meaningful output from the agent.
  // duration_ms should measure actual work time, not include idle wait.
  let lastOutputTime = startTime;
  let runLogFinalized = false;

  const finalizeRunLog = () => {
    if (runLogFinalized) return;
    runLogFinalized = true;
    // 注意：runningTaskIds.delete() 不在此处调用，
    // 必须等到 updateTaskAfterRun() ��新 next_run 后才能释放防重复屏障（#363）
    const durationMs = lastOutputTime - startTime;
    updateTaskRunLog(runLogId, {
      duration_ms: durationMs,
      status: error ? 'error' : 'success',
      result,
      error,
    });
    mirrorScheduledTaskRun(error ? 'error' : 'success', {
      result,
      error,
      completedAt: new Date().toISOString(),
    });
    // Send _close sentinel so the idle agent process exits promptly,
    // freeing the queue slot for the next run.
    if (idleTimer) clearTimeout(idleTimer);
    deps.queue.closeStdin(effectiveJid);
  };

  // Background task runs are intentionally detached from the interactive
  // workspace session. The backend gets taskRunId/messageTaskId to isolate IPC
  // and remote daemon cwd without creating a visible chat workspace.
  const sessionId = undefined;

  // Idle timer: writes _close sentinel after idleTimeout of no output,
  // so the container exits instead of hanging at waitForIpcMessage forever.
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { taskId: task.id },
        'Scheduled task idle timeout, closing container stdin',
      );
      deps.queue.closeStdin(effectiveJid);
    }, getSystemSettings().idleTimeout);
  };

  try {
    const executionMode = resolveTaskExecutionMode(task, deps);
    const backend = resolveBackend(taskGroup);

    // Resolve owner's home folder for correct volume mounts (skills, memory, CLAUDE.md)
    const ownerHomeFolder = taskGroup.created_by
      ? getUserHomeGroup(taskGroup.created_by)?.folder || taskGroup.folder
      : taskGroup.folder;

    let output: ContainerOutput;
    if (!backend.supportsExecutionMode(executionMode)) {
      output = {
        status: 'error',
        result: `后端 ${backend.displayName} 不支持执行模式 ${executionMode}`,
        error: `backend ${backend.id} does not support executionMode ${executionMode}`,
      };
    } else {
      output = await backend.run({
        group: taskGroup,
        executionMode,
        input: {
          prompt: task.prompt,
          sessionId,
          groupFolder: taskGroup.folder,
          chatJid: sourceJid,
          isMain: isAdminHome,
          isHome,
          isAdminHome,
          isScheduledTask: true,
          taskRunId,
          messageTaskId: task.id,
          scheduledTaskHasWorkspace,
        },
        onProcess: (proc, identifier, selectedProviderId) =>
          deps.onProcess(
            effectiveJid,
            proc,
            executionMode === 'container' ? identifier : null,
            taskGroup.folder,
            identifier,
            taskRunId,
            selectedProviderId,
          ),
        onOutput: async (streamedOutput: ContainerOutput) => {
          // Background tasks do not create a task workspace; stream to the
          // source workspace channel for any active viewers.
          if (
            streamedOutput.status === 'stream' &&
            streamedOutput.streamEvent
          ) {
            deps.broadcastStreamEvent?.(
              sourceJid,
              streamedOutput.streamEvent,
            );
          }
          if (streamedOutput.result) {
            result = streamedOutput.result;
            lastOutputTime = Date.now();
            resetIdleTimer();
          }
          if (streamedOutput.status === 'error') {
            error = streamedOutput.error || 'Unknown error';
            lastOutputTime = Date.now();
          }
          // Finalize run log on first non-stream output (success/error/closed).
          // Don't wait for the process to exit — idle timeout can be very long.
          if (streamedOutput.status !== 'stream') {
            finalizeRunLog();
          }
        },
        ownerHomeFolder,
      });
    }

    if (idleTimer) clearTimeout(idleTimer);

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
      lastOutputTime = Date.now();
    } else if (output.result) {
      // Messages are sent via MCP tool (IPC), result text is just logged
      result = output.result;
      lastOutputTime = Date.now();
    }

    // Finalize if not already done by onOutput callback
    finalizeRunLog();

    logger.info(
      { taskId: task.id, durationMs: lastOutputTime - startTime },
      'Task completed',
    );
  } catch (err) {
    if (idleTimer) clearTimeout(idleTimer);
    error = err instanceof Error ? err.message : String(err);
    lastOutputTime = Date.now();
    logger.error({ taskId: task.id, error }, 'Task failed');
  } finally {
    const cleanupDeviceLinkId =
      taskGroup.deviceLinkId ||
      deviceLinkIdFromExecutionTarget(taskGroup.executionNode) ||
      deviceLinkIdFromExecutionTarget(task.execution_node);
    if (cleanupDeviceLinkId) {
      requestWorkspaceCleanup({
        linkId: cleanupDeviceLinkId,
        workspace: taskGroup.folder,
        scope: 'task',
        taskId: task.id,
        taskRunId,
      });
    }

    // Clean up isolated task IPC directory
    if (taskRunId) {
      const taskRunDir = path.join(
        DATA_DIR,
        'ipc',
        taskGroup.folder,
        'tasks-run',
        taskRunId,
      );
      try {
        fs.rmSync(taskRunDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }

    // Safety net: finalize run log if not already done by onOutput callback
    finalizeRunLog();
  }

  // manualRun: preserve original next_run schedule
  const nextRun = options?.manualRun ? task.next_run : computeNextRun(task);

  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  let completionAccepted = false;
  try {
    completionAccepted = completeTaskRunWithFence(
      task.id,
      options?.claimToken,
      nextRun,
      resultSummary,
    );
  } finally {
    runningTaskIds.delete(task.id);
  }

  if (completionAccepted && deps.storeResultAndNotify && (result || error)) {
    const text = error ? `执行出错: ${error}` : stripAgentInternalTags(result!);

    if (text) {
      try {
        await deps.storeResultAndNotify(sourceJid, text, {
          ownerId: taskGroup.created_by || undefined,
          notifyChannels: task.notify_channels,
          sourceKind: 'sdk_final',
          workspaceFolder: task.group_folder || undefined,
        });
      } catch (err) {
        logger.error(
          { taskId: task.id, err },
          'Failed to store/notify task result',
        );
      }
    }
  }

  // Auto-cleanup once-task workspace after completion
  if (
    task.schedule_type === 'once' &&
    !options?.manualRun &&
    task.workspace_jid &&
    task.workspace_folder
  ) {
    setTimeout(() => {
      try {
        const groups = deps.registeredGroups();
        if (groups[task.workspace_jid!]) {
          deleteGroupData(task.workspace_jid!, task.workspace_folder!);
          delete groups[task.workspace_jid!];
          removeFlowArtifacts(task.workspace_folder!);
          logger.info(
            { taskId: task.id, folder: task.workspace_folder },
            'Cleaned up once-task workspace',
          );
        }
      } catch (err) {
        logger.error(
          { taskId: task.id, err },
          'Failed to cleanup once-task workspace',
        );
      }
    }, 60_000);
  }
}

async function runScriptTask(
  staleTask: ScheduledTask,
  deps: SchedulerDependencies,
  groupJid: string,
  manualRun = false,
  claimToken?: string,
): Promise<void> {
  if (!manualRun && !isTaskStillActive(staleTask.id, 'script task')) {
    releaseTaskClaimIfPresent(staleTask.id, claimToken);
    return;
  }

  // Refresh task from DB to avoid stale closure data
  const task = getTaskById(staleTask.id);
  if (!task) {
    releaseTaskClaimIfPresent(staleTask.id, claimToken);
    return;
  }

  runningTaskIds.add(task.id);
  const startTime = Date.now();
  const runLogId = logTaskRunStart(task.id);

  logger.info(
    { taskId: task.id, group: task.group_folder, executionType: 'script' },
    'Running script task',
  );

  // Owner gate before running script task: same as the Agent-task path, a
  // disabled/deleted owner's scheduled scripts must stop firing regardless of
  // billing toggle or role. See `src/owner-gate.ts`.
  {
    const ownerId = deps.registeredGroups()[groupJid]?.created_by;
    if (ownerId) {
      const ownerGate = checkOwnerActive(getUserById(ownerId));
      if (!ownerGate.allowed) {
        logger.info(
          { taskId: task.id, userId: ownerId, ownerStatus: ownerGate.status },
          'Owner not active, blocking script task',
        );
        updateTaskRunLog(runLogId, {
          duration_ms: Date.now() - startTime,
          status: 'error',
          result: null,
          error: '账户已禁用',
        });
        runningTaskIds.delete(task.id);
        const nextRun = manualRun ? task.next_run : computeNextRun(task);
        completeTaskRunWithFence(
          task.id,
          claimToken,
          nextRun,
          'Error: 账户已禁用',
        );
        return;
      }
    }
  }

  // Billing quota check before running script task
  if (isBillingEnabled() && task.group_folder) {
    const groups = deps.registeredGroups();
    const group = groups[groupJid];
    if (group?.created_by) {
      const owner = getUserById(group.created_by);
      if (owner && owner.role !== 'admin') {
        const accessResult = checkBillingAccessFresh(
          group.created_by,
          owner.role,
        );
        if (!accessResult.allowed) {
          const reason = accessResult.reason || '当前账户不可用';
          logger.info(
            {
              taskId: task.id,
              userId: group.created_by,
              reason,
              blockType: accessResult.blockType,
            },
            'Billing access denied, blocking script task',
          );
          updateTaskRunLog(runLogId, {
            duration_ms: Date.now() - startTime,
            status: 'error',
            result: null,
            error: `计费限制: ${reason}`,
          });
          runningTaskIds.delete(task.id);
          const nextRun = manualRun ? task.next_run : computeNextRun(task);
          completeTaskRunWithFence(
            task.id,
            claimToken,
            nextRun,
            `Error: 计费限制: ${reason}`,
          );
          return;
        }
      }
    }
  }

  const groupDir = path.join(GROUPS_DIR, task.group_folder);
  fs.mkdirSync(groupDir, { recursive: true });

  if (!task.script_command) {
    logger.error(
      { taskId: task.id },
      'Script task has no script_command, skipping',
    );
    updateTaskRunLog(runLogId, {
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: 'script_command is empty',
    });
    const nextRun = manualRun ? task.next_run : computeNextRun(task);
    completeTaskRunWithFence(
      task.id,
      claimToken,
      nextRun,
      'Error: script_command is empty',
    );
    runningTaskIds.delete(task.id);
    return;
  }

  let result: string | null = null;
  let error: string | null = null;

  try {
    const scriptResult = await runScript(
      task.script_command,
      task.group_folder,
      resolveTaskExecutionNode(task, deps),
    );

    if (scriptResult.timedOut) {
      error = `脚本执行超时 (${Math.round(scriptResult.durationMs / 1000)}s)`;
    } else if (scriptResult.exitCode !== 0) {
      error = scriptResult.stderr.trim() || `退出码: ${scriptResult.exitCode}`;
      result = scriptResult.stdout.trim() || null;
    } else {
      result = scriptResult.stdout.trim() || null;
    }

    logger.info(
      {
        taskId: task.id,
        durationMs: Date.now() - startTime,
        exitCode: scriptResult.exitCode,
      },
      'Script task completed',
    );
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Script task failed');
  }

  const durationMs = Date.now() - startTime;

  updateTaskRunLog(runLogId, {
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });

  // manualRun: preserve original next_run schedule
  const nextRun = manualRun ? task.next_run : computeNextRun(task);
  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  let completionAccepted = false;
  try {
    completionAccepted = completeTaskRunWithFence(
      task.id,
      claimToken,
      nextRun,
      resultSummary,
    );
  } finally {
    runningTaskIds.delete(task.id);
  }

  // Send result only after the DB claim accepts completion. If this run lost
  // its lease/fencing token, suppress stale user-visible side effects too.
  if (completionAccepted && (error || result)) {
    const text = error
      ? `[脚本] 执行失败: ${error}${result ? `\n输出:\n${result.slice(0, 500)}` : ''}`
      : `[脚本] ${result!.slice(0, 1000)}`;
    const fullText = `${deps.assistantName}: ${text}`;

    await deps.sendMessage(groupJid, fullText, { source: 'scheduled_task' });

    if (deps.storeResultAndNotify) {
      const groups = deps.registeredGroups();
      const group = groups[groupJid];
      if (group?.created_by) {
        try {
          await deps.storeResultAndNotify(groupJid, fullText, {
            ownerId: group.created_by,
            notifyChannels: task.notify_channels,
            skipStore: true,
            workspaceFolder: task.group_folder,
          });
        } catch (notifyErr) {
          logger.error(
            { taskId: task.id, err: notifyErr },
            'Failed to notify script task result to IM',
          );
        }
      }
    }
  }
}

let schedulerRunning = false;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
let lastCleanupTime = 0;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;

  // Clean up stale state from previous process crash
  runningTaskIds.clear();
  try {
    const cleaned = cleanupStaleRunningLogs();
    if (cleaned > 0) {
      logger.info(
        { cleaned },
        'Cleaned up stale running task logs from previous session',
      );
    }
  } catch (err) {
    logger.error({ err }, 'Failed to cleanup stale running task logs');
  }

  // Clean up orphaned workspaces from completed once-tasks
  // (covers the case where process restarted before setTimeout cleanup fired)
  try {
    const allTasks = getAllTasks();
    const groups = deps.registeredGroups();
    let cleaned = 0;
    for (const t of allTasks) {
      if (
        t.schedule_type === 'once' &&
        t.status === 'completed' &&
        t.workspace_jid &&
        t.workspace_folder &&
        groups[t.workspace_jid]
      ) {
        deleteGroupData(t.workspace_jid, t.workspace_folder);
        delete groups[t.workspace_jid];
        removeFlowArtifacts(t.workspace_folder);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logger.info(
        { cleaned },
        'Cleaned up orphaned once-task workspaces from previous session',
      );
    }
  } catch (err) {
    logger.error({ err }, 'Failed to cleanup orphaned once-task workspaces');
  }

  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      // Periodic cleanup of old task run logs (every 24h)
      const now = Date.now();
      if (now - lastCleanupTime >= CLEANUP_INTERVAL_MS) {
        lastCleanupTime = now;
        try {
          const deleted = cleanupOldTaskRunLogs();
          if (deleted > 0) {
            logger.info({ deleted }, 'Cleaned up old task run logs');
          }
        } catch (err) {
          logger.error({ err }, 'Failed to cleanup old task run logs');
        }
      }

      try {
        const { runDueAutopilots } = await import('./routes/autopilots.js');
        const autopilotResults = await runDueAutopilots();
        if (autopilotResults.length > 0) {
          logger.info(
            { count: autopilotResults.length },
            'Triggered due autopilots',
          );
        }
      } catch (err) {
        logger.error({ err }, 'Failed to trigger due autopilots');
      }

      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      const graceMs = getSystemSettings().taskBackfillGraceMs;

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        if (runningTaskIds.has(currentTask.id)) {
          continue;
        }

        if (shouldSkipBackfill(currentTask.next_run, Date.now(), graceMs)) {
          const overdueMs =
            Date.now() - new Date(currentTask.next_run!).getTime();
          const advancedNextRun = computeNextRun(currentTask);
          advanceSkippedTask(currentTask.id, advancedNextRun);
          logTaskRun({
            task_id: currentTask.id,
            run_at: new Date().toISOString(),
            duration_ms: 0,
            status: 'success',
            result: `Skipped: overdue by ${Math.round(overdueMs / 1000)}s, exceeds backfill grace window (${Math.round(graceMs / 1000)}s)`,
            error: null,
          });
          logger.info(
            {
              taskId: currentTask.id,
              overdueMs,
              graceMs,
              nextRun: advancedNextRun,
            },
            'Skipping overdue task: exceeds backfill grace window',
          );
          continue;
        }

        const groups = deps.registeredGroups();
        const targetGroupJid = resolveTargetGroupJid(currentTask, groups);

        if (!targetGroupJid) {
          logger.error(
            { taskId: currentTask.id, groupFolder: currentTask.group_folder },
            'Target group not registered, skipping scheduled task',
          );
          continue;
        }

        if (currentTask.execution_type === 'script') {
          if (!hasScriptCapacity()) {
            logger.debug(
              { taskId: currentTask.id },
              'Script concurrency limit reached, skipping',
            );
            continue;
          }
          const claim = claimTaskRun(currentTask.id, {
            expectedNextRun: currentTask.next_run,
            claimedBy: 'scheduler:script',
          });
          if (!claim) {
            logger.debug(
              { taskId: currentTask.id },
              'Script task claim lost, skipping',
            );
            continue;
          }
          // Script tasks run directly, not through GroupQueue
          runScriptTask(
            currentTask,
            deps,
            targetGroupJid,
            false,
            claim.token,
          ).catch((err) => {
            logger.error(
              { taskId: currentTask.id, err },
              'Unhandled error in runScriptTask',
            );
          });
        } else {
          const claim = claimTaskRun(currentTask.id, {
            expectedNextRun: currentTask.next_run,
            claimedBy: 'scheduler:background',
          });
          if (!claim) {
            logger.debug(
              { taskId: currentTask.id },
              'Background task claim lost, skipping',
            );
            continue;
          }
          const sourceGroup = groups[targetGroupJid] || resolveTaskSourceGroup(currentTask, groups);
          const orchestrationAllowed = await enforceScheduledTaskOrchestration(
            currentTask,
            sourceGroup,
            claim.token,
          );
          if (!orchestrationAllowed) {
            logger.info(
              { taskId: currentTask.id },
              'Scheduled task held by orchestration policy',
            );
            continue;
          }
          // Agent tasks run in background mode. Do not create or use a visible
          // task workspace; isolate only the process/IPC namespace.
          const taskQueueJid = `${targetGroupJid}#task:${currentTask.id}`;
          deps.queue.enqueueTask(taskQueueJid, currentTask.id, () =>
            runTask(currentTask, deps, {
              taskRunId: crypto.randomUUID(),
              claimToken: claim.token,
            }),
          );
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

/**
 * Manually trigger a task to run now (fire-and-forget).
 * Does not change next_run — the task continues its normal schedule.
 */
export function triggerTaskNow(
  taskId: string,
  deps: SchedulerDependencies,
): { success: boolean; error?: string } {
  const task = getTaskById(taskId);
  if (!task) return { success: false, error: 'Task not found' };
  if (task.status === 'completed')
    return { success: false, error: 'Task already completed' };
  if (task.status === 'paused')
    return { success: false, error: '任务已暂停，请先恢复后再运行' };
  if (runningTaskIds.has(taskId))
    return { success: false, error: 'Task is already running' };

  const claim = claimTaskRun(task.id, {
    manualRun: true,
    claimedBy: 'manual',
  });
  if (!claim) return { success: false, error: 'Task is already running' };

  const groups = deps.registeredGroups();
  const targetGroupJid = resolveTargetGroupJid(task, groups);
  if (!targetGroupJid) {
    releaseTaskRunClaim(task.id, claim.token);
    return { success: false, error: 'Target group not registered' };
  }

  if (task.execution_type === 'script') {
    if (!hasScriptCapacity()) {
      releaseTaskRunClaim(task.id, claim.token);
      return { success: false, error: 'Script concurrency limit reached' };
    }
    runScriptTask(task, deps, targetGroupJid, true, claim.token).catch((err) =>
      logger.error({ taskId, err }, 'Manual script task failed'),
    );
  } else {
    const opts: RunTaskOptions = {
      manualRun: true,
      taskRunId: crypto.randomUUID(),
      claimToken: claim.token,
    };
    const taskQueueJid = `${targetGroupJid}#task:${task.id}`;
    deps.queue.enqueueTask(taskQueueJid, task.id, () =>
      runTask(task, deps, opts),
    );
  }

  return { success: true };
}
