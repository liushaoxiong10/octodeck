// Zod schemas and validation types for API requests

import { z } from 'zod';
import { ALL_PERMISSIONS } from './permissions.js';
import type { Permission } from './types.js';
import { MAX_GROUP_NAME_LEN } from './web-context.js';

export const AgentRuntimeProfileSchema = z.enum([
  'server-agent',
  'server-agent-device-tools',
  'device-cli-agent',
]);

export const TaskPatchSchema = z.object({
  chat_jid: z.string().min(1).optional(),
  prompt: z.string().optional(),
  schedule_type: z.enum(['cron', 'interval', 'once']).optional(),
  schedule_value: z.string().optional(),
  context_mode: z.enum(['group', 'isolated']).optional(),
  execution_type: z.enum(['agent', 'script']).optional(),
  runtime_profile: AgentRuntimeProfileSchema.optional(),
  agent_client_id: z.string().min(1).max(128).optional(),
  backend: z.string().min(1).max(128).optional(),
  agent_model: z.string().max(256).optional(),
  execution_mode: z.enum(['host', 'container']).optional(),
  execution_node: z.string().min(1).max(128).optional(),
  script_command: z.string().max(4096).nullable().optional(),
  status: z.enum(['active', 'paused']).optional(),
  next_run: z.string().optional(),
  notify_channels: z
    .array(
      z.enum(['feishu', 'telegram', 'qq', 'wechat', 'dingtalk', 'discord']),
    )
    .nullable()
    .optional(),
});

// Cron 表达式校验：5 段（分 时 日 月 周）或 6 段（秒 分 时 日 月 周）
// 也允许预定义表达式如 @daily, @hourly 等
const CRON_REGEX =
  /^(@(yearly|annually|monthly|weekly|daily|hourly|minutely|secondly)|(\S+\s+){4,5}\S+)$/;

export const TaskCreateSchema = z
  .object({
    group_folder: z.string().min(1).optional(),
    chat_jid: z.string().min(1).optional(),
    prompt: z.string().optional().default(''),
    schedule_type: z.enum(['cron', 'interval', 'once']),
    schedule_value: z.string().min(1),
    context_mode: z.enum(['group', 'isolated']).optional(),
    execution_type: z.enum(['agent', 'script']).optional(),
    runtime_profile: AgentRuntimeProfileSchema.optional(),
    agent_client_id: z.string().min(1).max(128).optional(),
    backend: z.string().min(1).max(128).optional(),
    agent_model: z.string().max(256).optional(),
    execution_mode: z.enum(['host', 'container']).optional(),
    execution_node: z.string().min(1).max(128).optional(),
    script_command: z.string().max(4096).optional(),
    notify_channels: z
      .array(
        z.enum(['feishu', 'telegram', 'qq', 'wechat', 'dingtalk', 'discord']),
      )
      .nullable()
      .optional(),
  })
  .superRefine((data, ctx) => {
    const execType = data.execution_type || 'agent';
    if (execType === 'agent' && !data.prompt?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['prompt'],
        message: 'Agent 模式下 prompt 为必填项',
      });
    }
    if (execType === 'script' && !data.script_command?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['script_command'],
        message: '脚本模式下 script_command 为必填项',
      });
    }
    if (data.schedule_type === 'cron') {
      if (!CRON_REGEX.test(data.schedule_value.trim())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['schedule_value'],
          message: 'Invalid cron expression (expected 5 or 6 fields)',
        });
      }
    } else if (data.schedule_type === 'interval') {
      const num = Number(data.schedule_value);
      if (!Number.isFinite(num) || num <= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['schedule_value'],
          message: 'Interval must be a positive number (milliseconds)',
        });
      }
    } else if (data.schedule_type === 'once') {
      const ts = Date.parse(data.schedule_value);
      if (isNaN(ts)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['schedule_value'],
          message: 'Once schedule must be a valid ISO 8601 date string',
        });
      }
    }
  });

export const IssueCreateSchema = z.object({
  workspace_jid: z.string().min(1).optional(),
  workspace_folder: z.string().min(1).optional(),
  title: z.string().min(1).max(200),
  description: z.string().max(20000).optional().default(''),
  status: z
    .enum(['todo', 'in_progress', 'review', 'done', 'canceled'])
    .optional()
    .default('todo'),
  priority: z
    .enum(['low', 'medium', 'high', 'urgent'])
    .optional()
    .default('medium'),
  assignee_user_id: z.string().nullable().optional(),
  due_date: z.string().nullable().optional(),
  project_repo_id: z.string().nullable().optional(),
  agent_link_id: z.string().nullable().optional(),
  agent_client_id: z.string().nullable().optional(),
  execution_node: z.string().nullable().optional(),
  backend: z.string().nullable().optional(),
  selected_skills: z.array(z.string()).optional().default([]),
  start_agent: z.boolean().optional().default(false),
  create_more: z.boolean().optional().default(false),
});

export const IssuePatchSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(20000).optional(),
  status: z.enum(['todo', 'in_progress', 'review', 'done', 'canceled']).optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
  assignee_user_id: z.string().nullable().optional(),
  due_date: z.string().nullable().optional(),
  project_repo_id: z.string().nullable().optional(),
  agent_link_id: z.string().nullable().optional(),
  agent_client_id: z.string().nullable().optional(),
  execution_node: z.string().nullable().optional(),
  backend: z.string().nullable().optional(),
  selected_skills: z.array(z.string()).nullable().optional(),
});

export const IssueRunSchema = z.object({
  agent_link_id: z.string().nullable().optional(),
  agent_client_id: z.string().nullable().optional(),
  execution_node: z.string().nullable().optional(),
  backend: z.string().nullable().optional(),
  selected_skills: z.array(z.string()).nullable().optional(),
  comment_ids: z.array(z.string().min(1)).max(50).optional().nullable(),
  include_new_comments: z.boolean().optional().default(true),
});

export const IssueAttachmentCreateSchema = z.object({
  filename: z.string().min(1).max(255),
  mime_type: z.string().min(1).max(120),
  size_bytes: z.number().int().min(0).max(10 * 1024 * 1024),
  data_url: z.string().min(1).max(14 * 1024 * 1024),
});

// --- Issue comment ---

export const IssueCommentCreateSchema = z.object({
  body: z.string().min(1).max(20000),
});

export const IssueCommentUpdateSchema = z.object({
  body: z.string().min(1).max(20000),
});

// 单张图片附件上限 5MB（base64 编码后约 6.67MB）
const MAX_IMAGE_BASE64_LENGTH = (5 * 1024 * 1024 * 4) / 3; // ~6.67M chars

export const MessageAttachmentSchema = z.object({
  type: z.literal('image'),
  data: z.string().min(1).max(MAX_IMAGE_BASE64_LENGTH),
  mimeType: z
    .string()
    .regex(/^image\//)
    .optional(),
});

export const MessageCreateSchema = z
  .object({
    chatJid: z.string().min(1),
    content: z.string().optional().default(''),
    attachments: z.array(MessageAttachmentSchema).max(10).optional(),
  })
  .superRefine((data, ctx) => {
    const hasContent = data.content.trim().length > 0;
    const hasAttachments = (data.attachments?.length ?? 0) > 0;
    if (!hasContent && !hasAttachments) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['content'],
        message: 'content or attachments is required',
      });
    }
  });

export const GroupCreateSchema = z.object({
  name: z.string().min(1).max(MAX_GROUP_NAME_LEN),
  runtime_profile: AgentRuntimeProfileSchema.optional(),
  device_link_id: z
    .string()
    .regex(/^cl_[0-9a-f]{16}$/)
    .optional(),
  agent_client_id: z.string().min(1).max(64).optional(),
  agent_model: z.string().max(256).optional(),
  backend: z.string().min(1).max(64).optional(),
  execution_mode: z.enum(['container', 'host']).optional(),
  // Device target for native execution: built-in server device or connected octodeck-daemon device.
  execution_node: z.string().min(1).max(128).optional(),
  custom_cwd: z
    .string()
    .optional()
    .transform((val) => (val && val.trim() ? val.trim() : undefined)),
  repo_id: z
    .string()
    .optional()
    .transform((val) => (val && val.trim() ? val.trim() : undefined)),
  repo_git_url: z
    .string()
    .optional()
    .transform((val) => (val && val.trim() ? val.trim() : undefined)),
  repo_device_path: z
    .string()
    .optional()
    .transform((val) => (val && val.trim() ? val.trim() : undefined)),
  visible_repo_mode: z.enum(['all', 'selected']).optional(),
  visible_repo_ids: z.array(z.string().min(1).max(128)).max(200).optional(),
  init_source_path: z
    .string()
    .optional()
    .transform((val) => (val && val.trim() ? val.trim() : undefined)),
  init_git_url: z
    .string()
    .optional()
    .transform((val) => (val && val.trim() ? val.trim() : undefined)),
});

export const RepoCreateSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(80)
    .transform((val) => val.trim()),
  kind: z.enum(['git', 'device_path']),
  git_url: z
    .string()
    .optional()
    .transform((val) => (val && val.trim() ? val.trim() : undefined)),
  main_branch: z
    .string()
    .max(256)
    .optional()
    .transform((val) => (val && val.trim() ? val.trim() : undefined)),
  device_path: z
    .string()
    .optional()
    .transform((val) => (val && val.trim() ? val.trim() : undefined)),
  device_link_id: z
    .string()
    .optional()
    .transform((val) => (val && val.trim() ? val.trim() : undefined)),
});

export const RepoKnowledgeGenerateSchema = z.object({
  include_patterns: z.array(z.string().min(1)).optional(),
  exclude_patterns: z.array(z.string().min(1)).optional(),
  max_files: z.number().int().min(1).max(5000).optional(),
  max_file_bytes: z.number().int().min(512).max(512 * 1024).optional(),
  provider: z.enum(['builtin', 'auto', 'graphify', 'codegraph']).optional(),
  plugins: z.array(z.string().min(1)).optional(),
  use_external_graph: z.boolean().optional(),
  fallback_builtin: z.boolean().optional(),
  include_docs: z.boolean().optional(),
  include_dependencies: z.boolean().optional(),
  include_import_graph: z.boolean().optional(),
  search_backend: z.enum(['auto', 'sqlite', 'postgres', 'mongo']).optional(),
  source_kind: z.enum(['repo', 'git', 'device_path']).optional(),
  source_git_url: z.string().optional().transform((val) => (val && val.trim() ? val.trim() : undefined)),
  source_main_branch: z.string().optional().transform((val) => (val && val.trim() ? val.trim() : undefined)),
  source_device_path: z.string().optional().transform((val) => (val && val.trim() ? val.trim() : undefined)),
  source_device_link_id: z.string().optional().transform((val) => (val && val.trim() ? val.trim() : undefined)),
  execution_device_link_id: z.string().optional().transform((val) => (val && val.trim() ? val.trim() : undefined)),
  async: z.boolean().optional(),
  wait: z.boolean().optional(),
});

export const RepoKnowledgeSearchSchema = z.object({
  query: z.string().min(1).max(500),
  repo_id: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  kind: z.enum(['overview', 'file', 'symbol', 'dependency', 'doc', 'graph']).optional(),
  language: z.string().min(1).max(64).optional(),
  path_prefix: z.string().min(1).max(500).optional(),
  include_related: z.boolean().optional(),
});

export const GroupMemberAddSchema = z.object({
  user_id: z.string().min(1),
});

export const MemoryFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

export const MemoryGlobalSchema = z.object({
  content: z.string(),
});

export const ClaudeConfigSchema = z.object({
  anthropicBaseUrl: z.string(),
  anthropicModel: z.string().max(128).optional(),
});

export const ClaudeThirdPartyProfileCreateSchema = z.object({
  name: z.string().min(1).max(64),
  anthropicBaseUrl: z.string().max(2000),
  anthropicAuthToken: z.string().max(2000),
  anthropicModel: z.string().max(128).optional(),
  customEnv: z.record(z.string().max(256), z.string().max(4096)).optional(),
});

export const ClaudeThirdPartyProfilePatchSchema = z
  .object({
    name: z.string().min(1).max(64).optional(),
    anthropicBaseUrl: z.string().max(2000).optional(),
    anthropicModel: z.string().max(128).optional(),
    customEnv: z.record(z.string().max(256), z.string().max(4096)).optional(),
  })
  .refine(
    (data) =>
      typeof data.name === 'string' ||
      typeof data.anthropicBaseUrl === 'string' ||
      typeof data.anthropicModel === 'string' ||
      data.customEnv !== undefined,
    { message: 'At least one profile field must be provided' },
  );

export const ClaudeThirdPartyProfileSecretsSchema = z
  .object({
    anthropicAuthToken: z.string().max(2000).optional(),
    clearAnthropicAuthToken: z.boolean().optional(),
  })
  .refine(
    (data) =>
      typeof data.anthropicAuthToken === 'string' ||
      data.clearAnthropicAuthToken === true,
    { message: 'At least one secret field must be provided' },
  );

export const GroupPatchSchema = z.object({
  name: z.string().min(1).max(MAX_GROUP_NAME_LEN).optional(),
  is_pinned: z.boolean().optional(),
  activation_mode: z
    .enum(['auto', 'always', 'when_mentioned', 'owner_mentioned', 'disabled'])
    .optional(),
  runtime_profile: AgentRuntimeProfileSchema.optional(),
  device_link_id: z
    .string()
    .regex(/^cl_[0-9a-f]{16}$/)
    .nullable()
    .optional(),
  agent_client_id: z.string().min(1).max(64).nullable().optional(),
  agent_model: z.string().max(256).optional(),
  execution_mode: z.enum(['container', 'host']).optional(),
  backend: z.string().min(1).max(64).nullable().optional(),
  visible_repo_mode: z.enum(['all', 'selected']).optional(),
  visible_repo_ids: z.array(z.string().min(1).max(128)).max(200).nullable().optional(),
  // 'server-local' | cl_xxx | runtime:cl_xxx:agentClient | provider:agentClient
  execution_node: z.string().min(1).max(128).nullable().optional(),
});

export const LoginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export const RegisterSchema = z.object({
  username: z.string().min(3).max(32),
  password: z.string().min(8).max(128),
  display_name: z.string().max(64).optional(),
  invite_code: z.string().min(1).optional(),
});

export const RegistrationConfigSchema = z.object({
  allowRegistration: z.boolean(),
  requireInviteCode: z.boolean(),
});

export const SystemSettingsSchema = z.object({
  containerTimeout: z.number().int().min(60000).max(86400000).optional(),
  idleTimeout: z.number().int().min(60000).max(86400000).optional(),
  containerMaxOutputSize: z
    .number()
    .int()
    .min(1048576)
    .max(104857600)
    .optional(),
  maxConcurrentContainers: z.number().int().min(1).max(100).optional(),
  maxConcurrentHostProcesses: z.number().int().min(1).max(50).optional(),
  maxLoginAttempts: z.number().int().min(1).max(100).optional(),
  loginLockoutMinutes: z.number().int().min(1).max(1440).optional(),
  maxConcurrentScripts: z.number().int().min(1).max(50).optional(),
  scriptTimeout: z.number().int().min(5000).max(600000).optional(),
  billingEnabled: z.boolean().optional(),
  billingMode: z.literal('wallet_first').optional(),
  billingMinStartBalanceUsd: z.number().min(0).max(1000000).optional(),
  billingCurrency: z.string().min(1).max(10).optional(),
  billingCurrencyRate: z.number().min(0.0001).max(1000000).optional(),
  externalClaudeDir: z.string().max(512).optional(),
  autoCompactWindow: z
    .number()
    .int()
    .refine(
      (v) => v === 0 || (v >= 10000 && v <= 2000000),
      'autoCompactWindow must be 0 (disabled) or between 10000 and 2000000',
    )
    .optional(),
  disableMemoryLayerForAdminHost: z.boolean().optional(),
  pluginAutoScan: z.boolean().optional(),
  taskBackfillGraceMs: z
    .number()
    .int()
    .refine(
      (v) => v === 0 || (v >= 1000 && v <= 86400000),
      'taskBackfillGraceMs must be 0 (disabled) or between 1000 (1s) and 86400000 (24h)',
    )
    .optional(),
  defaultBackend: z.string().min(1).max(64).optional(),
  allowedBackends: z.array(z.string().min(1).max(64)).max(32).optional(),
});

// ─── Custom CLI backend ─────────────────────────────────────────
const CUSTOM_BACKEND_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;

const CustomBackendBaseShape = {
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(CUSTOM_BACKEND_ID_RE, '小写字母开头，仅 [a-z0-9_-]'),
  displayName: z.string().min(1).max(64),
  binary: z.string().min(1).max(512).optional(),
  argvTemplate: z.array(z.string().max(1000)).min(1).max(64).optional(),
  outputProtocol: z.enum(['jsonline-stream-json', 'plain-text']).optional(),
  supportsHost: z.boolean().optional(),
  supportsContainer: z.boolean().optional(),
  usesProviderPool: z.boolean().optional(),
  timeoutMs: z.number().int().min(60_000).max(86_400_000).optional(),
  maxOutputBytes: z.number().int().min(1_048_576).max(104_857_600).optional(),
  env: z.record(z.string().max(256), z.string().max(4096)).optional(),
  runtime: z.enum(['local-device', 'server-side']).optional(),
  model: z.string().min(1).max(256).optional(),
  supportsNativeSessions: z.boolean().optional(),
  sessionArgvTemplate: z.array(z.string().max(1000)).max(64).optional(),
  resumeArgvTemplate: z.array(z.string().max(1000)).min(1).max(64).optional(),
  workdirMode: z.enum(['auto', 'custom']).optional(),
  workdir: z.string().min(1).max(1024).optional(),
  providerId: z.string().min(1).max(64).nullable().optional(),
  deviceLinkId: z
    .string()
    .regex(/^cl_[0-9a-f]{16}$/)
    .nullable()
    .optional(),
  agentClientId: z.string().min(1).max(64).nullable().optional(),
  agentMdId: z.string().min(1).max(128).nullable().optional(),
};

export const CustomBackendCreateSchema = z
  .object({
    ...CustomBackendBaseShape,
    id: z.never('新增 Agent 时 ID 由系统自动生成').optional(),
  })
  .superRefine((data, ctx) => {
    if (data.supportsContainer === true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['supportsContainer'],
        message: '当前不支持 container 模式',
      });
    }
    if (
      (data.runtime ?? 'local-device') === 'local-device' &&
      !data.deviceLinkId
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['deviceLinkId'],
        message: 'LocalRuntime 必须选择设备',
      });
    }
    if (data.runtime === 'local-device' && !data.agentClientId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['agentClientId'],
        message: 'LocalRuntime 必须选择 Agent client',
      });
    }
    if (data.runtime === 'server-side' && !data.model) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['model'],
        message: 'Server Side 必须选择模型端点/模型名称',
      });
    }
    if (data.runtime === 'server-side' && !data.providerId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['providerId'],
        message: 'Server Side 必须选择模型端点',
      });
    }
    if (data.workdirMode === 'custom') {
      if (!data.workdir) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['workdir'],
          message: '自定义 Workdir 必填',
        });
      } else if (!data.workdir.startsWith('/')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['workdir'],
          message: 'Workdir 必须是绝对路径',
        });
      }
    }
    if (data.agentClientId) {
      if (!data.deviceLinkId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['deviceLinkId'],
          message: '选择 Agent client 时必须选择设备',
        });
      }
      return;
    }
    if (!data.binary) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['binary'],
        message: 'binary 必填',
      });
    }
    if (!data.outputProtocol) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['outputProtocol'],
        message: 'outputProtocol 必填',
      });
    }
    if (!data.argvTemplate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['argvTemplate'],
        message: 'argvTemplate 必填',
      });
    } else if (!data.argvTemplate.some((s) => s.includes('{prompt}'))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['argvTemplate'],
        message: 'argvTemplate 必须包含 {prompt} 占位符',
      });
    }
  });

export const CustomBackendPatchSchema = z
  .object({
    displayName: CustomBackendBaseShape.displayName.optional(),
    binary: CustomBackendBaseShape.binary.optional(),
    argvTemplate: CustomBackendBaseShape.argvTemplate.optional(),
    outputProtocol: CustomBackendBaseShape.outputProtocol.optional(),
    supportsHost: CustomBackendBaseShape.supportsHost,
    supportsContainer: CustomBackendBaseShape.supportsContainer,
    usesProviderPool: CustomBackendBaseShape.usesProviderPool,
    timeoutMs: CustomBackendBaseShape.timeoutMs,
    maxOutputBytes: CustomBackendBaseShape.maxOutputBytes,
    env: CustomBackendBaseShape.env,
    runtime: CustomBackendBaseShape.runtime,
    model: CustomBackendBaseShape.model,
    supportsNativeSessions: CustomBackendBaseShape.supportsNativeSessions,
    sessionArgvTemplate: CustomBackendBaseShape.sessionArgvTemplate,
    resumeArgvTemplate: CustomBackendBaseShape.resumeArgvTemplate,
    workdirMode: CustomBackendBaseShape.workdirMode,
    workdir: CustomBackendBaseShape.workdir,
    providerId: CustomBackendBaseShape.providerId,
    deviceLinkId: CustomBackendBaseShape.deviceLinkId,
    agentClientId: CustomBackendBaseShape.agentClientId,
    agentMdId: CustomBackendBaseShape.agentMdId,
  })
  .superRefine((data, ctx) => {
    if (data.supportsContainer === true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['supportsContainer'],
        message: '当前不支持 container 模式',
      });
    }
    if (data.workdirMode === 'custom') {
      if (!data.workdir) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['workdir'],
          message: '自定义 Workdir 必填',
        });
      } else if (!data.workdir.startsWith('/')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['workdir'],
          message: 'Workdir 必须是绝对路径',
        });
      }
    }
    if (
      data.argvTemplate &&
      !data.argvTemplate.some((s) => s.includes('{prompt}'))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['argvTemplate'],
        message: 'argvTemplate 必须包含 {prompt} 占位符',
      });
    }
    if (data.runtime === 'local-device' && data.deviceLinkId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['deviceLinkId'],
        message: 'LocalRuntime 必须选择设备',
      });
    }
    if (data.runtime === 'local-device' && data.agentClientId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['agentClientId'],
        message: 'LocalRuntime 必须选择 Agent client',
      });
    }
    if (data.runtime === 'server-side' && data.providerId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['providerId'],
        message: 'Server Side 必须选择模型端点',
      });
    }
  });

export const AppearanceConfigSchema = z.object({
  appName: z.string().max(32).optional(),
  aiName: z.string().min(1).max(32),
  aiAvatarEmoji: z.string().min(1).max(8),
  aiAvatarColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
});

export const ChangePasswordSchema = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(8).max(128),
});

export const ProfileUpdateSchema = z.object({
  username: z.string().min(3).max(32).optional(),
  display_name: z.string().max(64).optional(),
  avatar_emoji: z.string().max(8).nullable().optional(),
  avatar_color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional(),
  avatar_url: z
    .string()
    .max(2048)
    .refine((v) => v.startsWith('/api/auth/avatars/'), 'Invalid avatar URL')
    .nullable()
    .optional(),
  ai_name: z.string().min(1).max(32).nullable().optional(),
  ai_avatar_emoji: z.string().max(8).nullable().optional(),
  ai_avatar_color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional(),
  ai_avatar_url: z
    .string()
    .max(2048)
    .refine((v) => v.startsWith('/api/auth/avatars/'), 'Invalid avatar URL')
    .nullable()
    .optional(),
  default_require_mention: z.boolean().optional(),
});

export const PermissionValueSchema = z
  .string()
  .refine(
    (value): value is Permission =>
      (ALL_PERMISSIONS as string[]).includes(value),
    {
      message: 'Invalid permission',
    },
  );

export const AdminCreateUserSchema = z.object({
  username: z.string().min(3).max(32),
  password: z.string().min(8).max(128),
  display_name: z.string().max(64).optional(),
  role: z.enum(['admin', 'member']).optional(),
  permissions: z
    .array(PermissionValueSchema)
    .max(ALL_PERMISSIONS.length)
    .optional(),
  must_change_password: z.boolean().optional(),
  notes: z.string().max(2000).optional(),
});

export const AdminPatchUserSchema = z.object({
  role: z.enum(['admin', 'member']).optional(),
  status: z.enum(['active', 'disabled', 'deleted']).optional(),
  display_name: z.string().max(64).optional(),
  password: z.string().min(8).max(128).optional(),
  permissions: z
    .array(PermissionValueSchema)
    .max(ALL_PERMISSIONS.length)
    .optional(),
  disable_reason: z.string().max(256).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

export const InviteCreateSchema = z.object({
  role: z.enum(['admin', 'member']).optional(),
  permission_template: z
    .enum(['admin_full', 'member_basic', 'ops_manager', 'user_admin'])
    .optional(),
  permissions: z
    .array(PermissionValueSchema)
    .max(ALL_PERMISSIONS.length)
    .optional(),
  max_uses: z.number().int().min(0).max(1000).optional(),
  expires_in_hours: z.number().int().min(1).max(8760).optional(),
});

export const ClaudeOAuthCredentialsSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.number(),
  scopes: z.array(z.string()).default([]),
  subscriptionType: z.string().optional(),
});

export const ClaudeSecretsSchema = z
  .object({
    anthropicAuthToken: z.string().optional(),
    clearAnthropicAuthToken: z.boolean().optional(),
    anthropicApiKey: z.string().optional(),
    clearAnthropicApiKey: z.boolean().optional(),
    claudeCodeOauthToken: z.string().optional(),
    clearClaudeCodeOauthToken: z.boolean().optional(),
    claudeOAuthCredentials: ClaudeOAuthCredentialsSchema.optional(),
    clearClaudeOAuthCredentials: z.boolean().optional(),
  })
  .refine(
    (data) => {
      const hasAnthropicAuthToken =
        typeof data.anthropicAuthToken === 'string' ||
        data.clearAnthropicAuthToken === true;
      const hasAnthropicApiKey =
        typeof data.anthropicApiKey === 'string' ||
        data.clearAnthropicApiKey === true;
      const hasClaudeCodeOauthToken =
        typeof data.claudeCodeOauthToken === 'string' ||
        data.clearClaudeCodeOauthToken === true;
      const hasClaudeOAuthCredentials =
        data.claudeOAuthCredentials !== undefined ||
        data.clearClaudeOAuthCredentials === true;
      return (
        hasAnthropicAuthToken ||
        hasAnthropicApiKey ||
        hasClaudeCodeOauthToken ||
        hasClaudeOAuthCredentials
      );
    },
    { message: 'At least one secret field must be provided' },
  );

export const FeishuConfigSchema = z
  .object({
    appId: z.string().max(2000).optional(),
    appSecret: z.string().max(2000).optional(),
    clearAppSecret: z.boolean().optional(),
    enabled: z.boolean().optional(),
    autoIsolateContext: z.boolean().optional(),
  })
  .refine(
    (data) =>
      typeof data.appId === 'string' ||
      typeof data.appSecret === 'string' ||
      data.clearAppSecret === true ||
      typeof data.enabled === 'boolean' ||
      typeof data.autoIsolateContext === 'boolean',
    { message: 'At least one config field must be provided' },
  );

export const TelegramConfigSchema = z
  .object({
    botToken: z.string().max(2000).optional(),
    clearBotToken: z.boolean().optional(),
    proxyUrl: z.string().max(2000).optional(),
    clearProxyUrl: z.boolean().optional(),
    enabled: z.boolean().optional(),
  })
  .refine(
    (data) =>
      typeof data.botToken === 'string' ||
      data.clearBotToken === true ||
      typeof data.proxyUrl === 'string' ||
      data.clearProxyUrl === true ||
      typeof data.enabled === 'boolean',
    { message: 'At least one config field must be provided' },
  );

export const QQConfigSchema = z
  .object({
    appId: z.string().max(2000).optional(),
    appSecret: z.string().max(2000).optional(),
    clearAppSecret: z.boolean().optional(),
    enabled: z.boolean().optional(),
  })
  .refine(
    (data) =>
      typeof data.appId === 'string' ||
      typeof data.appSecret === 'string' ||
      data.clearAppSecret === true ||
      typeof data.enabled === 'boolean',
    { message: 'At least one config field must be provided' },
  );

export const ClaudeCustomEnvSchema = z.object({
  customEnv: z.record(z.string().max(256), z.string().max(4096)),
});

export const ContainerEnvSchema = z.object({
  anthropicBaseUrl: z.string().max(2000).optional(),
  anthropicAuthToken: z.string().max(2000).optional(),
  anthropicApiKey: z.string().max(2000).optional(),
  claudeCodeOauthToken: z.string().max(2000).optional(),
  anthropicModel: z.string().max(128).optional(),
  customEnv: z
    .record(z.string().max(256), z.string().max(4096))
    .optional()
    .refine((env) => !env || Object.keys(env).length <= 50, {
      message: 'customEnv must have at most 50 entries',
    }),
});

// Terminal WebSocket message schemas
export const TerminalStartSchema = z.object({
  chatJid: z.string().min(1),
  cols: z.number().int().optional(),
  rows: z.number().int().optional(),
});

export const TerminalInputSchema = z.object({
  chatJid: z.string().min(1),
  data: z.string().min(1).max(8192),
});

export const TerminalResizeSchema = z.object({
  chatJid: z.string().min(1),
  cols: z.number().int().optional(),
  rows: z.number().int().optional(),
});

export const TerminalStopSchema = z.object({
  chatJid: z.string().min(1),
});

// --- Billing schemas ---

export const BillingPlanCreateSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[\w-]+$/, 'ID must be alphanumeric with hyphens/underscores'),
  name: z.string().min(1).max(64),
  description: z.string().max(500).nullable().optional(),
  tier: z.number().int().min(0).max(100).optional(),
  monthly_cost_usd: z.number().min(0).optional(),
  monthly_token_quota: z.number().int().min(0).nullable().optional(),
  monthly_cost_quota: z.number().min(0).nullable().optional(),
  daily_cost_quota: z.number().min(0).nullable().optional(),
  weekly_cost_quota: z.number().min(0).nullable().optional(),
  daily_token_quota: z.number().int().min(0).nullable().optional(),
  weekly_token_quota: z.number().int().min(0).nullable().optional(),
  rate_multiplier: z.number().min(0.01).max(100).optional(),
  trial_days: z.number().int().min(1).max(365).nullable().optional(),
  sort_order: z.number().int().min(0).max(9999).optional(),
  display_price: z.string().max(64).nullable().optional(),
  highlight: z.boolean().optional(),
  max_groups: z.number().int().min(0).nullable().optional(),
  max_concurrent_containers: z.number().int().min(0).nullable().optional(),
  max_im_channels: z.number().int().min(0).nullable().optional(),
  max_mcp_servers: z.number().int().min(0).nullable().optional(),
  max_storage_mb: z.number().int().min(0).nullable().optional(),
  allow_overage: z.boolean().optional(),
  features: z.array(z.string().max(64)).max(50).optional(),
  is_default: z.boolean().optional(),
  is_active: z.boolean().optional(),
});

export const BillingPlanPatchSchema = BillingPlanCreateSchema.omit({
  id: true,
}).partial();

export const AssignPlanSchema = z.object({
  plan_id: z.string().min(1),
  duration_days: z.number().int().min(1).max(3650).optional(),
});

export const AdjustBalanceSchema = z.object({
  amount_usd: z.number().refine((v) => v !== 0, 'Amount cannot be zero'),
  description: z.string().min(1).max(500),
  idempotency_key: z.string().min(1).max(64).optional(),
});

export const BatchAssignPlanSchema = z.object({
  user_ids: z.array(z.string().min(1)).min(1).max(100),
  plan_id: z.string().min(1),
  duration_days: z.number().int().min(1).max(3650).optional(),
});

export const RedeemCodeCreateSchema = z
  .object({
    type: z.enum(['balance', 'subscription', 'trial']),
    value_usd: z.number().min(0.01).optional(),
    plan_id: z.string().min(1).optional(),
    duration_days: z.number().int().min(1).max(3650).optional(),
    max_uses: z.number().int().min(1).max(10000).optional(),
    count: z.number().int().min(1).max(100).optional(), // 批量生成数量
    prefix: z
      .string()
      .max(16)
      .regex(/^[\w-]*$/)
      .optional(), // 兑换码前缀
    expires_in_hours: z.number().int().min(1).max(87600).optional(),
    notes: z.string().max(500).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.type === 'balance' && (!data.value_usd || data.value_usd <= 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value_usd'],
        message: 'Balance type requires a positive value_usd',
      });
    }
    if (data.type === 'subscription' && !data.plan_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['plan_id'],
        message: 'Subscription type requires a plan_id',
      });
    }
    if (
      data.type === 'trial' &&
      (!data.duration_days || data.duration_days <= 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['duration_days'],
        message: 'Trial type requires a positive duration_days',
      });
    }
  });

export const RedeemCodeSchema = z.object({
  code: z.string().min(1).max(64),
});

// Memory types
export type MemoryType =
  | 'global'
  | 'session'
  | 'agent'
  | 'date'
  | 'conversation';

export interface MemorySource {
  path: string;
  label: string;
  type: MemoryType;
  writable: boolean;
  exists: boolean;
  updatedAt: string | null;
  size: number;
  ownerName?: string;
  folder?: string;
}

export interface MemoryFilePayload {
  path: string;
  content: string;
  updatedAt: string | null;
  size: number;
  writable: boolean;
}

export interface MemorySearchHit extends MemorySource {
  hits: number;
  snippet: string;
}

// --- Bug Report schemas ---

// 单张截图上限 5MB（base64 编码后约 6.67MB）
const MAX_SCREENSHOT_BASE64_LENGTH = (5 * 1024 * 1024 * 4) / 3;

export const BugReportGenerateSchema = z.object({
  description: z.string().min(1).max(5000),
  screenshots: z
    .array(z.string().max(MAX_SCREENSHOT_BASE64_LENGTH))
    .max(3)
    .optional(),
});

export const BugReportSubmitSchema = z.object({
  title: z.string().min(1).max(256),
  body: z.string().min(1).max(65536),
});

// ─── 统一供应商 (V4) ────────────────────────────────────────

export const UnifiedProviderCreateSchema = z
  .object({
    name: z.string().min(1).max(64),
    type: z.enum(['official', 'third_party']),
    apiType: z.enum(['claude', 'openai-chat', 'openai-responses']).optional(),
    anthropicBaseUrl: z.string().max(2000).optional(),
    anthropicAuthToken: z.string().max(2000).optional(),
    anthropicModel: z.string().max(128).optional(),
    models: z
      .array(
        z.object({
          id: z.string().min(1).max(256),
          displayName: z.string().min(1).max(256).optional(),
        }),
      )
      .max(256)
      .optional(),
    anthropicApiKey: z.string().max(2000).optional(),
    claudeCodeOauthToken: z.string().max(2000).optional(),
    claudeOAuthCredentials: ClaudeOAuthCredentialsSchema.optional(),
    customEnv: z.record(z.string().max(256), z.string().max(4096)).optional(),
    weight: z.number().int().min(1).max(100).optional(),
    enabled: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    if (
      data.type === 'third_party' &&
      !data.anthropicBaseUrl?.trim() &&
      !data.anthropicAuthToken?.trim()
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['anthropicBaseUrl'],
        message: '第三方供应商需要提供 Base URL 或 Auth Token',
      });
    }
  });

export const ModelDiscoveryRequestSchema = z.object({
  apiType: z.enum(['claude', 'openai-chat', 'openai-responses']),
  baseUrl: z.string().max(2000),
  token: z.string().min(1).max(2000),
});

export const UnifiedProviderPatchSchema = z
  .object({
    name: z.string().min(1).max(64).optional(),
    apiType: z.enum(['claude', 'openai-chat', 'openai-responses']).optional(),
    anthropicBaseUrl: z.string().max(2000).optional(),
    anthropicModel: z.string().max(128).optional(),
    customEnv: z.record(z.string().max(256), z.string().max(4096)).optional(),
    weight: z.number().int().min(1).max(100).optional(),
  })
  .refine(
    (data) =>
      data.name !== undefined ||
      data.apiType !== undefined ||
      data.anthropicBaseUrl !== undefined ||
      data.anthropicModel !== undefined ||
      data.customEnv !== undefined ||
      data.weight !== undefined,
    { message: 'At least one field must be provided' },
  );

export const UnifiedProviderSecretsSchema = z
  .object({
    anthropicAuthToken: z.string().max(2000).optional(),
    clearAnthropicAuthToken: z.boolean().optional(),
    anthropicApiKey: z.string().max(2000).optional(),
    clearAnthropicApiKey: z.boolean().optional(),
    claudeCodeOauthToken: z.string().max(2000).optional(),
    clearClaudeCodeOauthToken: z.boolean().optional(),
    claudeOAuthCredentials: ClaudeOAuthCredentialsSchema.optional(),
    clearClaudeOAuthCredentials: z.boolean().optional(),
  })
  .refine(
    (data) => {
      return (
        typeof data.anthropicAuthToken === 'string' ||
        data.clearAnthropicAuthToken === true ||
        typeof data.anthropicApiKey === 'string' ||
        data.clearAnthropicApiKey === true ||
        typeof data.claudeCodeOauthToken === 'string' ||
        data.clearClaudeCodeOauthToken === true ||
        data.claudeOAuthCredentials !== undefined ||
        data.clearClaudeOAuthCredentials === true
      );
    },
    { message: 'At least one secret field must be provided' },
  );

export const BalancingConfigSchema = z.object({
  strategy: z
    .enum(['round-robin', 'weighted-round-robin', 'failover'])
    .optional(),
  unhealthyThreshold: z.number().int().min(1).max(20).optional(),
  recoveryIntervalMs: z.number().int().min(30000).max(3600000).optional(),
});

export const WeChatConfigSchema = z.object({
  enabled: z.boolean().optional(),
  clearBotToken: z.boolean().optional(),
  bypassProxy: z.boolean().optional(),
});

export const DingTalkConfigSchema = z
  .object({
    clientId: z.string().max(2000).optional(),
    clientSecret: z.string().max(2000).optional(),
    clearClientSecret: z.boolean().optional(),
    enabled: z.boolean().optional(),
    streamingMode: z.enum(['card', 'text']).optional(),
  })
  .refine(
    (data) =>
      typeof data.clientId === 'string' ||
      typeof data.clientSecret === 'string' ||
      data.clearClientSecret === true ||
      typeof data.enabled === 'boolean' ||
      typeof data.streamingMode === 'string',
    { message: 'At least one config field must be provided' },
  );

export const DiscordConfigSchema = z
  .object({
    botToken: z.string().max(2000).optional(),
    clearBotToken: z.boolean().optional(),
    enabled: z.boolean().optional(),
    streamingMode: z.enum(['edit', 'off']).optional(),
  })
  .refine(
    (data) =>
      typeof data.botToken === 'string' ||
      data.clearBotToken === true ||
      typeof data.enabled === 'boolean' ||
      typeof data.streamingMode === 'string',
    { message: 'At least one config field must be provided' },
  );

export const WhatsAppConfigSchema = z
  .object({
    accountId: z.string().max(64).optional(),
    phoneNumber: z.string().max(32).optional(),
    enabled: z.boolean().optional(),
    /** 标记 Baileys 扫码完成 — 由后续 PR 在登录回调中写入，前端不应直接发 true */
    paired: z.boolean().optional(),
  })
  .refine(
    (data) =>
      typeof data.accountId === 'string' ||
      typeof data.phoneNumber === 'string' ||
      typeof data.enabled === 'boolean' ||
      typeof data.paired === 'boolean',
    { message: 'At least one config field must be provided' },
  );
