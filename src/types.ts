import type { StreamEvent } from './stream-event.types.js';

export interface AdditionalMount {
  hostPath: string; // Absolute path on host (supports ~ for home)
  containerPath?: string; // Optional — defaults to basename of hostPath. Mounted at /workspace/extra/{value}
  readonly?: boolean; // Default: true for safety
}

/**
 * Mount Allowlist - Security configuration for additional mounts
 * Stored at config/mount-allowlist.json in the project root.
 */
export interface MountAllowlist {
  // Directories that can be mounted into containers
  allowedRoots: AllowedRoot[];
  // Glob patterns for paths that should never be mounted (e.g., ".ssh", ".gnupg")
  blockedPatterns: string[];
  // If true, non-main groups can only mount read-only regardless of config
  nonMainReadOnly: boolean;
}

export interface AllowedRoot {
  // Absolute path or ~ for home (e.g., "~/projects", "/var/repos")
  path: string;
  // Whether read-write mounts are allowed under this root
  allowReadWrite: boolean;
  // Optional description for documentation
  description?: string;
}

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
}

export type ExecutionMode = 'container' | 'host';
export type AgentRuntimeProfile =
  | 'server-agent'
  | 'server-agent-device-tools'
  | 'device-cli-agent';
export type ConversationSource = 'manual' | 'feishu_thread';
export type ConversationNavMode = 'horizontal' | 'vertical_threads';
export type ImBindingMode = 'single_context' | 'thread_map';

/** 飞书消息的话题/线程元数据，用于 thread_map 路由 */
export interface FeishuMessageMeta {
  threadId?: string;
  rootId?: string;
  parentId?: string;
  messageId?: string;
  text?: string;
}

export interface RegisteredGroup {
  name: string;
  folder: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  /** Product-level runtime shape. Supersedes ambiguous executionMode/executionNode UI semantics. */
  runtimeProfile?: AgentRuntimeProfile;
  executionMode?: ExecutionMode; // 默认 'container'
  customCwd?: string; // 宿主机模式的自定义工作目录（绝对路径）
  repoId?: string; // 引用统一管理的 Repo（优先于 repoGitUrl/repoDevicePath 展示与选择）
  repoGitUrl?: string; // Device 原生执行：远端 Git 仓库地址，在 device workspace/repo 下缓存并基于 worktree 执行
  repoDevicePath?: string; // Device 原生执行：指定当前 device 上的项目目录；若支持 git 则基于 worktree，否则直接操作目录
  initSourcePath?: string; // 容器模式下复制来源的宿主机绝对路径
  initGitUrl?: string; // 容器模式下 clone 来源的 Git URL
  created_by?: string;
  is_home?: boolean; // 用户主容器标记
  target_agent_id?: string; // IM 消息路由到指定 conversation agent
  target_main_jid?: string; // IM 消息路由到指定工作区的主对话（web:{folder}）
  reply_policy?: 'source_only' | 'mirror'; // IM 绑定的回复策略
  require_mention?: boolean; // 群聊是否需要 @机器人 才响应（默认 false）
  activation_mode?:
    | 'auto'
    | 'always'
    | 'when_mentioned'
    | 'owner_mentioned'
    | 'disabled'; // 消息门控模式（默认 'auto'，兼容 require_mention）
  owner_im_id?: string; // activation_mode 为 'owner_mentioned' 时，仅此 IM 标识符的发送者被响应
  sender_allowlist?: string[] | null; // null/undefined = 不限制，[] = 仅 owner 可触发（未 /claim 时无人可触发），[ids] = 白名单
  mcp_mode?: 'inherit' | 'custom'; // MCP 配置模式（默认 'inherit' 继承用户配置）
  selected_mcps?: string[] | null; // custom 模式下选中的 MCP server IDs
  conversation_source?: ConversationSource; // 工作区会话来源（默认 manual）
  conversation_nav_mode?: ConversationNavMode; // 工作区会话导航模式（默认 horizontal）
  binding_mode?: ImBindingMode; // IM 绑定模式（默认 single_context）
  feishu_chat_mode?: string; // 飞书群模式：group/topic/p2p 等
  feishu_group_message_type?: string; // 飞书群消息形式：chat/thread
  backend?: string; // Agent 后端选择（默认走 SystemSettings.defaultBackend，最终回退 'claude-sdk'）
  /** Device used by server-agent-device-tools or device-cli-agent. */
  deviceLinkId?: string;
  /** Agent client to launch on device-cli-agent, e.g. claude-code/codex/traecli. */
  agentClientId?: string;
  /**
   * 命令执行节点。
   *   - undefined / 'server-local' → server 进程内 spawn（沿用旧逻辑）
   *   - cl_xxxx → 指定 AgentLink 设备
   *   - runtime:cl_xxxx:agentClient 或 cl_xxxx:agentClient → 指定设备上的 Agent runtime
   *   - provider:agentClient → 自动选择在线且有容量的 provider runtime
   * 不在线的 link 会降级回 'server-local' 并打 warn。
   */
  executionNode?: string;
}

export type ManagedRepoKind = 'git' | 'device_path';

export interface ManagedRepo {
  id: string;
  name: string;
  kind: ManagedRepoKind;
  gitUrl?: string;
  devicePath?: string;
  deviceLinkId?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * AgentLink — 用户自有的 octodeck-daemon 客户端注册记录。
 * Server 持有 token 的 bcrypt hash，明文 token 仅在创建时一次性返回给前端。
 * 在线状态不入库，由 AgentLinkRegistry 内存维护。
 */
export interface AgentLink {
  id: string; // 'cl_' + 16 hex
  userId: string;
  displayName: string;
  capabilities: string[];
  agentClients?: Array<{
    id: string;
    displayName: string;
    binary: string;
    version?: string;
    permissionModes?: string[];
    capabilities?: string[];
  }>;
  resources?: {
    cpuCount?: number;
    cpuUsedPercent?: number;
    load1?: number;
    load5?: number;
    load15?: number;
    memoryTotalBytes?: number;
    memoryUsedBytes?: number;
    memoryUsedPercent?: number;
    diskTotalBytes?: number;
    diskUsedBytes?: number;
    diskUsedPercent?: number;
    disks?: Array<{
      filesystem?: string;
      mountPoint: string;
      diskTotalBytes?: number;
      diskUsedBytes?: number;
      diskUsedPercent?: number;
    }>;
    collectedAt?: string;
  };
  os?: string;
  arch?: string;
  hostname?: string;
  clientVersion?: string;
  lastConnectedAt?: string;
  lastSeenAt?: string;
  createdAt: string;
  revokedAt?: string;
}

export interface GroupMember {
  user_id: string;
  role: 'owner' | 'member';
  added_at: string;
  added_by?: string;
  username: string;
  display_name: string;
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  source_jid?: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  attachments?: string;
  turn_id?: string | null;
  session_id?: string | null;
  sdk_message_uuid?: string | null;
  source_kind?: MessageSourceKind | null;
  finalization_reason?: MessageFinalizationReason | null;
  task_id?: string | null;
}

export type MessageSourceKind =
  | 'sdk_final'
  | 'sdk_send_message'
  | 'interrupt_partial'
  | 'overflow_partial'
  | 'compact_partial'
  | 'user_command'
  | 'scheduled_task_prompt'
  | 'legacy'
  | 'auto_continue';

export type MessageFinalizationReason =
  | 'completed'
  | 'interrupted'
  | 'error'
  | 'shutdown'
  | 'crash_recovery';

export interface MessageAttachment {
  type: 'image';
  data: string; // base64 编码的图片数据
  mimeType?: string; // 如 'image/png'、'image/jpeg'
}

export interface MessageCursor {
  timestamp: string;
  id: string;
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  execution_type: 'agent' | 'script';
  script_command: string | null;
  execution_mode?: 'host' | 'container' | null;
  execution_node?: string | null;
  workspace_jid?: string | null;
  workspace_folder?: string | null;
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed' | 'parsing';
  claim_token?: string | null;
  claimed_by?: string | null;
  claimed_at?: string | null;
  lease_expires_at?: string | null;
  created_at: string;
  created_by?: string;
  notify_channels?: string[] | null;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'running' | 'success' | 'error';
  result: string | null;
  error: string | null;
}

export type IssueStatus =
  | 'todo'
  | 'in_progress'
  | 'review'
  | 'done'
  | 'canceled';

export type IssuePriority = 'low' | 'medium' | 'high' | 'urgent';

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
  workspace_jid: string;
  workspace_folder: string;
  agent_link_id?: string | null;
  agent_client_id?: string | null;
  execution_node?: string | null;
  backend?: string | null;
  selected_skills?: string[] | null;
  status: 'queued' | 'running' | 'success' | 'error' | 'canceled';
  result?: string | null;
  error?: string | null;
  session_id?: string | null;
  created_by: string;
  created_at: string;
  run_started_at?: string | null;
  run_completed_at?: string | null;
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

// --- Auth types ---

export type UserRole = 'admin' | 'member';
export type UserStatus = 'active' | 'disabled' | 'deleted';

export interface AuthUser {
  id: string;
  username: string;
  role: UserRole;
  status: 'active' | 'disabled' | 'deleted';
  display_name: string;
  permissions: Permission[];
  must_change_password: boolean;
}

export type Permission =
  | 'manage_system_config'
  | 'manage_group_env'
  | 'manage_users'
  | 'manage_invites'
  | 'view_audit_log'
  | 'manage_billing';

export type PermissionTemplateKey =
  | 'admin_full'
  | 'member_basic'
  | 'ops_manager'
  | 'user_admin';

export interface User {
  id: string;
  username: string;
  password_hash: string;
  display_name: string;
  role: UserRole;
  status: UserStatus;
  permissions: Permission[];
  must_change_password: boolean;
  disable_reason: string | null;
  notes: string | null;
  avatar_emoji: string | null;
  avatar_color: string | null;
  avatar_url: string | null;
  ai_name: string | null;
  ai_avatar_emoji: string | null;
  ai_avatar_color: string | null;
  ai_avatar_url: string | null;
  /**
   * Per-user default for require_mention on auto-registered IM group chats.
   * When true, newly auto-registered Feishu/Telegram/etc groups start with
   * require_mention=1 (only @bot triggers a response). false preserves the
   * legacy default of responding to every owner-sent message in the group.
   * Existing groups are not retroactively changed.
   */
  default_require_mention: boolean;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
  deleted_at: string | null;
}

export interface UserPublic {
  id: string;
  username: string;
  display_name: string;
  role: UserRole;
  status: UserStatus;
  permissions: Permission[];
  must_change_password: boolean;
  disable_reason: string | null;
  notes: string | null;
  avatar_emoji: string | null;
  avatar_color: string | null;
  avatar_url: string | null;
  ai_name: string | null;
  ai_avatar_emoji: string | null;
  ai_avatar_color: string | null;
  ai_avatar_url: string | null;
  default_require_mention: boolean;
  created_at: string;
  last_login_at: string | null;
  last_active_at: string | null;
  deleted_at: string | null;
}

export interface UserSession {
  id: string;
  user_id: string;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
  expires_at: string;
  last_active_at: string;
}

export interface UserSessionWithUser extends UserSession {
  username: string;
  role: UserRole;
  status: UserStatus;
  display_name: string;
  permissions: Permission[];
  must_change_password: boolean;
}

export interface InviteCode {
  code: string;
  created_by: string;
  role: UserRole;
  permission_template: PermissionTemplateKey | null;
  permissions: Permission[];
  max_uses: number;
  used_count: number;
  expires_at: string | null;
  created_at: string;
}

export interface InviteCodeWithCreator extends InviteCode {
  creator_username: string;
}

export type AuthEventType =
  | 'login_success'
  | 'login_failed'
  | 'logout'
  | 'password_changed'
  | 'profile_updated'
  | 'user_created'
  | 'user_disabled'
  | 'user_enabled'
  | 'user_deleted'
  | 'user_restored'
  | 'user_updated'
  | 'role_changed'
  | 'session_revoked'
  | 'invite_created'
  | 'invite_deleted'
  | 'invite_used'
  | 'recovery_reset'
  | 'register_success';

export interface AuthAuditLog {
  id: number;
  event_type: AuthEventType;
  username: string;
  actor_username: string | null;
  ip_address: string | null;
  user_agent: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
}

// --- Sub-Agent types ---

export type AgentStatus = 'idle' | 'running' | 'completed' | 'error';
export type AgentKind = 'task' | 'conversation' | 'spawn';

export interface SubAgent {
  id: string;
  group_folder: string;
  chat_jid: string;
  name: string;
  prompt: string;
  status: AgentStatus;
  kind: AgentKind;
  created_by: string | null;
  created_at: string;
  completed_at: string | null;
  result_summary: string | null;
  last_im_jid: string | null;
  /** 发起 /spawn 命令的源会话 JID，用于完成后结果回注 */
  spawned_from_jid: string | null;
  source_kind?: 'manual' | 'feishu_thread' | 'auto_im' | null;
  thread_id?: string | null;
  root_message_id?: string | null;
  title_source?: 'manual' | 'feishu_root' | 'auto' | 'auto_pending' | null;
  last_active_at?: string | null;
}

export interface ImContextBinding {
  source_jid: string;
  context_type: 'thread';
  context_id: string;
  workspace_jid: string;
  agent_id: string;
  root_message_id: string | null;
  title: string | null;
  last_active_at: string;
  created_at: string;
  updated_at: string;
}

// WebSocket message types
export type WsMessageOut =
  | {
      type: 'new_message';
      chatJid: string;
      message: NewMessage & { is_from_me: boolean };
      agentId?: string;
      source?: string;
    }
  | {
      type: 'agent_reply';
      chatJid: string;
      text: string;
      timestamp: string;
      agentId?: string;
    }
  | { type: 'typing'; chatJid: string; isTyping: boolean; agentId?: string }
  | {
      type: 'status_update';
      activeContainers: number;
      activeHostProcesses: number;
      activeTotal: number;
      queueLength: number;
    }
  | {
      type: 'stream_event';
      chatJid: string;
      event: StreamEvent;
      agentId?: string;
    }
  | {
      type: 'agent_status';
      chatJid: string;
      agentId: string;
      status: AgentStatus;
      kind?: AgentKind;
      name: string;
      prompt: string;
      resultSummary?: string;
      titleGenerating?: boolean;
    }
  | {
      type: 'runner_state';
      chatJid: string;
      state: 'idle' | 'running';
    }
  | {
      type: 'task_state';
      chatJid: string;
      taskId: string;
      status: 'running' | 'completed' | 'error';
      name: string;
      prompt: string;
      resultSummary?: string;
      kind?: AgentKind;
    }
  | { type: 'terminal_output'; chatJid: string; data: string }
  | { type: 'terminal_started'; chatJid: string }
  | { type: 'terminal_stopped'; chatJid: string; reason?: string }
  | { type: 'terminal_error'; chatJid: string; error: string }
  | { type: 'group_created'; jid: string; folder: string; name: string }
  | { type: 'docker_build_log'; line: string }
  | { type: 'docker_build_complete'; success: boolean; error?: string }
  | {
      type: 'whatsapp_status';
      userId: string;
      status: 'connecting' | 'qr' | 'connected' | 'disconnected' | 'logged_out';
      qr?: string;
      qrDataUrl?: string;
      error?: string;
      meJid?: string;
      meName?: string;
    }
  | {
      type: 'billing_update';
      userId: string;
      usage: BillingAccessResult;
    }
  | { type: 'ws_error'; error: string; chatJid?: string }
  | {
      type: 'stream_snapshot';
      chatJid: string;
      snapshot: {
        partialText: string;
        thinkingText?: string;
        activeTools: Array<{
          toolName: string;
          toolUseId: string;
          startTime: number;
          toolInputSummary?: string;
          parentToolUseId?: string | null;
        }>;
        recentEvents: Array<{
          id: string;
          timestamp: number;
          text: string;
          kind:
            | 'tool'
            | 'skill'
            | 'hook'
            | 'status'
            | 'task'
            | 'memory'
            | 'debug'
            | 'context';
        }>;
        traceEvents?: Array<{
          id: string;
          timestamp: number;
          kind:
            | 'tool'
            | 'skill'
            | 'hook'
            | 'status'
            | 'task'
            | 'memory'
            | 'debug'
            | 'context';
          scope?: StreamEvent['agentScope'];
          title: string;
          summary?: string;
          detail?: string;
          taskId?: string;
          toolUseId?: string;
          parentToolUseId?: string | null;
          displayLevel?: StreamEvent['displayLevel'];
        }>;
        taskStates?: Record<string, unknown>;
        contextAudit?: StreamEvent['contextAudit'];
        todos?: Array<{ id: string; content: string; status: string }>;
        systemStatus: string | null;
        turnId?: string;
      };
    };

export type WsMessageIn =
  | {
      type: 'send_message';
      chatJid: string;
      content: string;
      attachments?: MessageAttachment[];
      agentId?: string;
    }
  | { type: 'terminal_start'; chatJid: string; cols: number; rows: number }
  | { type: 'terminal_input'; chatJid: string; data: string }
  | { type: 'terminal_resize'; chatJid: string; cols: number; rows: number }
  | { type: 'terminal_stop'; chatJid: string };

// --- Streaming event types (canonical source: shared/stream-event.ts) ---
export type { StreamEventType } from './stream-event.types.js';
export type { StreamEvent };

// --- Billing types ---

export interface BillingPlan {
  id: string;
  name: string;
  description: string | null;
  tier: number; // 0=免费, 10=基础, 20=专业, 30=企业
  monthly_cost_usd: number;
  monthly_token_quota: number | null; // null=无限
  monthly_cost_quota: number | null; // null=无限
  daily_cost_quota: number | null; // null=无限
  weekly_cost_quota: number | null; // null=无限
  daily_token_quota: number | null; // null=无限
  weekly_token_quota: number | null; // null=无限
  rate_multiplier: number; // 费用倍率，默认 1.0
  trial_days: number | null; // 试用天数
  sort_order: number; // 排序权重
  display_price: string | null; // 展示价格文本（如 "¥99/月"）
  highlight: boolean; // 推荐标记
  max_groups: number | null;
  max_concurrent_containers: number | null;
  max_im_channels: number | null;
  max_mcp_servers: number | null;
  max_storage_mb: number | null;
  allow_overage: boolean;
  features: string[]; // JSON 特性标签
  is_default: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface UserSubscription {
  id: string;
  user_id: string;
  plan_id: string;
  status: 'active' | 'expired' | 'cancelled';
  started_at: string;
  expires_at: string | null;
  cancelled_at: string | null;
  trial_ends_at: string | null;
  notes: string | null;
  auto_renew: boolean;
  created_at: string;
}

export interface UserBalance {
  user_id: string;
  balance_usd: number;
  total_deposited_usd: number;
  total_consumed_usd: number;
  updated_at: string;
}

export type BalanceTransactionType =
  | 'deposit'
  | 'deduction'
  | 'refund'
  | 'adjustment'
  | 'redeem';
export type BalanceTransactionSource =
  | 'admin_manual_recharge'
  | 'admin_manual_deduct'
  | 'usage_charge'
  | 'redeem_code'
  | 'migration_opening'
  | 'refund'
  | 'subscription_renewal'
  | 'system_adjustment';
export type BalanceOperatorType = 'system' | 'admin' | 'user';
export type BalanceReferenceType =
  | 'message'
  | 'task'
  | 'subscription'
  | 'redeem_code'
  | 'admin_adjust';

export interface BalanceTransaction {
  id: number;
  user_id: string;
  type: BalanceTransactionType;
  amount_usd: number; // 正=入账, 负=扣除
  balance_after: number;
  description: string | null;
  reference_type: BalanceReferenceType | null;
  reference_id: string | null;
  actor_id: string | null;
  source: BalanceTransactionSource;
  operator_type: BalanceOperatorType;
  notes: string | null;
  idempotency_key: string | null;
  created_at: string;
}

export interface MonthlyUsage {
  user_id: string;
  month: string; // YYYY-MM
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
  message_count: number;
  updated_at: string;
}

export type RedeemCodeType = 'balance' | 'subscription' | 'trial';

export interface RedeemCode {
  code: string;
  type: RedeemCodeType;
  value_usd: number | null;
  plan_id: string | null;
  duration_days: number | null;
  max_uses: number;
  used_count: number;
  expires_at: string | null;
  created_by: string;
  notes: string | null;
  batch_id: string | null;
  created_at: string;
}

export interface RedeemCodeUsage {
  id: number;
  code: string;
  user_id: string;
  redeemed_at: string;
}

export type BillingAuditEventType =
  | 'plan_created'
  | 'plan_updated'
  | 'plan_deleted'
  | 'subscription_assigned'
  | 'subscription_cancelled'
  | 'subscription_expired'
  | 'balance_adjusted'
  | 'manual_recharge'
  | 'manual_deduct'
  | 'balance_deducted'
  | 'code_created'
  | 'code_redeemed'
  | 'code_deleted'
  | 'wallet_blocked'
  | 'wallet_unblocked'
  | 'quota_exceeded';

export interface BillingAuditLog {
  id: number;
  event_type: BillingAuditEventType;
  user_id: string;
  actor_id: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
}

export interface DailyUsage {
  user_id: string;
  date: string; // YYYY-MM-DD
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
  message_count: number;
}

export interface QuotaWindowUsage {
  costUsed: number;
  costQuota: number | null;
  tokenUsed: number;
  tokenQuota: number | null;
}

export interface QuotaCheckResult {
  allowed: boolean;
  reason?: string;
  exceededWindow?: 'daily' | 'weekly' | 'monthly'; // 哪个窗口超限
  resetAt?: string; // 下次重置时间 ISO
  warningPercent?: number; // 当前用量百分比 (0-100+)
  usage?: QuotaWindowUsage & {
    daily?: QuotaWindowUsage;
    weekly?: QuotaWindowUsage;
  };
}

export type BillingBlockType =
  | 'insufficient_balance'
  | 'plan_inactive'
  | 'quota_exceeded'
  | 'resource_limit';

export interface BillingAccessResult {
  allowed: boolean;
  blockType?: BillingBlockType;
  reason?: string;
  balanceUsd: number;
  minBalanceUsd: number;
  balanceMissingUsd?: number;
  planId: string | null;
  planName: string | null;
  subscriptionStatus: 'active' | 'expired' | 'cancelled' | 'default' | null;
  warningPercent?: number;
  usage?: QuotaCheckResult['usage'];
  exceededWindow?: QuotaCheckResult['exceededWindow'];
  resetAt?: string;
}
