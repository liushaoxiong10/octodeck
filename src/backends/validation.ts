/**
 * Custom-backend safety validation.
 *
 * 自定义 CLI backend 是 admin 直接配置的「外部进程入口」，必须把所有可能的
 * 命令注入 / 任意代码执行 / env 劫持点全部堵死。所有 mutating 路由 + dynamic.ts
 * 在加载阶段都会调这些函数。
 */

const ALLOWED_PLACEHOLDER_KEYS_ARRAY = [
  'prompt',
  'sessionId',
  'cwd',
  'folder',
  'backendId',
  'model',
] as const;

export type PlaceholderKey = (typeof ALLOWED_PLACEHOLDER_KEYS_ARRAY)[number];

export const ALLOWED_PLACEHOLDER_KEYS: ReadonlySet<PlaceholderKey> = new Set(
  ALLOWED_PLACEHOLDER_KEYS_ARRAY,
);

const PLACEHOLDER_RE = /\{([a-zA-Z]+)\}/g;
const BAD_BINARY_CHARS = /[\s;|&><`$"'\\]/;
const PURE_COMMAND_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const RESERVED_CLAUDE_ENV_KEYS = new Set([
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_MODEL',
]);

const DANGEROUS_ENV_VARS = new Set([
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  'NODE_OPTIONS',
  'JAVA_TOOL_OPTIONS',
  'PERL5OPT',
  'PATH',
  'PYTHONPATH',
  'RUBYLIB',
  'PERL5LIB',
  'GIT_EXEC_PATH',
  'CDPATH',
  'BASH_ENV',
  'ENV',
  'PROMPT_COMMAND',
  'ZDOTDIR',
  'EDITOR',
  'VISUAL',
  'PAGER',
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_ASKPASS',
  'HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'HAPPYCLAW_WORKSPACE_GROUP',
  'HAPPYCLAW_WORKSPACE_GLOBAL',
  'HAPPYCLAW_WORKSPACE_IPC',
  'CLAUDE_CONFIG_DIR',
]);

const MAX_BINARY_LEN = 512;
const MAX_ARGV_ITEMS = 64;
const MAX_ARGV_ITEM_LEN = 1000;
const MAX_ENV_ENTRIES = 50;
const MAX_ENV_KEY_LEN = 256;
const MAX_ENV_VALUE_LEN = 4096;

export interface ValidationResult {
  ok: boolean;
  error?: string;
}

export function validateBinaryPath(binary: string): ValidationResult {
  if (typeof binary !== 'string' || !binary.trim()) {
    return { ok: false, error: 'binary 不能为空' };
  }
  if (binary.length > MAX_BINARY_LEN) {
    return { ok: false, error: `binary 长度不能超过 ${MAX_BINARY_LEN}` };
  }
  if (BAD_BINARY_CHARS.test(binary)) {
    return {
      ok: false,
      error: 'binary 不允许包含空格 / shell 元字符 (;|&><`$"\'\\)',
    };
  }
  // 绝对路径 OR 纯命令名（PATH lookup）
  if (binary.startsWith('/')) {
    // 绝对路径 - 文件存在性 runtime 再校验，这里只看格式
    return { ok: true };
  }
  if (binary.includes('/')) {
    return {
      ok: false,
      error: 'binary 必须是绝对路径或纯命令名，不允许相对路径',
    };
  }
  if (!PURE_COMMAND_RE.test(binary)) {
    return {
      ok: false,
      error: 'binary 命令名必须匹配 [A-Za-z0-9_.-]{1,64}',
    };
  }
  return { ok: true };
}

export function validateArgvTemplate(template: unknown): ValidationResult {
  if (!Array.isArray(template)) {
    return { ok: false, error: 'argvTemplate 必须是数组' };
  }
  if (template.length === 0 || template.length > MAX_ARGV_ITEMS) {
    return {
      ok: false,
      error: `argvTemplate 长度必须在 1..${MAX_ARGV_ITEMS}`,
    };
  }
  let hasPrompt = false;
  for (let i = 0; i < template.length; i++) {
    const item = template[i];
    if (typeof item !== 'string') {
      return { ok: false, error: `argvTemplate[${i}] 必须是字符串` };
    }
    if (item.length > MAX_ARGV_ITEM_LEN) {
      return {
        ok: false,
        error: `argvTemplate[${i}] 长度超过 ${MAX_ARGV_ITEM_LEN}`,
      };
    }
    let m: RegExpExecArray | null;
    PLACEHOLDER_RE.lastIndex = 0;
    while ((m = PLACEHOLDER_RE.exec(item)) !== null) {
      const key = m[1] as PlaceholderKey;
      if (!ALLOWED_PLACEHOLDER_KEYS.has(key)) {
        return {
          ok: false,
          error: `argvTemplate[${i}] 包含未知占位符 {${m[1]}}（合法：${ALLOWED_PLACEHOLDER_KEYS_ARRAY.join(', ')}）`,
        };
      }
      if (key === 'prompt') hasPrompt = true;
    }
  }
  if (!hasPrompt) {
    return {
      ok: false,
      error: 'argvTemplate 必须至少包含一个 {prompt} 占位符',
    };
  }
  return { ok: true };
}

export function validateSessionArgvTemplate(template: unknown): ValidationResult {
  if (template === undefined || template === null) return { ok: true };
  if (!Array.isArray(template)) {
    return { ok: false, error: 'sessionArgvTemplate 必须是数组' };
  }
  if (template.length > MAX_ARGV_ITEMS) {
    return {
      ok: false,
      error: `sessionArgvTemplate 长度不能超过 ${MAX_ARGV_ITEMS}`,
    };
  }
  for (let i = 0; i < template.length; i++) {
    const item = template[i];
    if (typeof item !== 'string') {
      return { ok: false, error: `sessionArgvTemplate[${i}] 必须是字符串` };
    }
    if (item.length > MAX_ARGV_ITEM_LEN) {
      return {
        ok: false,
        error: `sessionArgvTemplate[${i}] 长度超过 ${MAX_ARGV_ITEM_LEN}`,
      };
    }
    let m: RegExpExecArray | null;
    PLACEHOLDER_RE.lastIndex = 0;
    while ((m = PLACEHOLDER_RE.exec(item)) !== null) {
      const key = m[1] as PlaceholderKey;
      if (!ALLOWED_PLACEHOLDER_KEYS.has(key)) {
        return {
          ok: false,
          error: `sessionArgvTemplate[${i}] 包含未知占位符 {${m[1]}}（合法：${ALLOWED_PLACEHOLDER_KEYS_ARRAY.join(', ')}）`,
        };
      }
    }
  }
  return { ok: true };
}

export function validateResumeArgvTemplate(template: unknown): ValidationResult {
  if (template === undefined || template === null) return { ok: true };
  if (!Array.isArray(template)) {
    return { ok: false, error: 'resumeArgvTemplate 必须是数组' };
  }
  if (template.length === 0 || template.length > MAX_ARGV_ITEMS) {
    return {
      ok: false,
      error: `resumeArgvTemplate 长度必须在 1..${MAX_ARGV_ITEMS}`,
    };
  }
  let hasPrompt = false;
  let hasSessionId = false;
  for (let i = 0; i < template.length; i++) {
    const item = template[i];
    if (typeof item !== 'string') {
      return { ok: false, error: `resumeArgvTemplate[${i}] 必须是字符串` };
    }
    if (item.length > MAX_ARGV_ITEM_LEN) {
      return {
        ok: false,
        error: `resumeArgvTemplate[${i}] 长度超过 ${MAX_ARGV_ITEM_LEN}`,
      };
    }
    let m: RegExpExecArray | null;
    PLACEHOLDER_RE.lastIndex = 0;
    while ((m = PLACEHOLDER_RE.exec(item)) !== null) {
      const key = m[1] as PlaceholderKey;
      if (!ALLOWED_PLACEHOLDER_KEYS.has(key)) {
        return {
          ok: false,
          error: `resumeArgvTemplate[${i}] 包含未知占位符 {${m[1]}}（合法：${ALLOWED_PLACEHOLDER_KEYS_ARRAY.join(', ')}）`,
        };
      }
      if (key === 'prompt') hasPrompt = true;
      if (key === 'sessionId') hasSessionId = true;
    }
  }
  if (!hasPrompt) {
    return {
      ok: false,
      error: 'resumeArgvTemplate 必须至少包含一个 {prompt} 占位符',
    };
  }
  if (!hasSessionId) {
    return {
      ok: false,
      error: 'resumeArgvTemplate 必须至少包含一个 {sessionId} 占位符',
    };
  }
  return { ok: true };
}

export function validateBackendEnv(
  env: unknown,
): ValidationResult {
  if (env === undefined || env === null) return { ok: true };
  if (typeof env !== 'object' || Array.isArray(env)) {
    return { ok: false, error: 'env 必须是对象' };
  }
  const entries = Object.entries(env as Record<string, unknown>);
  if (entries.length > MAX_ENV_ENTRIES) {
    return {
      ok: false,
      error: `env 最多 ${MAX_ENV_ENTRIES} 条`,
    };
  }
  for (const [k, v] of entries) {
    if (k.length > MAX_ENV_KEY_LEN || !ENV_KEY_RE.test(k)) {
      return { ok: false, error: `env key 非法：${k}` };
    }
    if (RESERVED_CLAUDE_ENV_KEYS.has(k) || DANGEROUS_ENV_VARS.has(k)) {
      return { ok: false, error: `env key 被禁用：${k}` };
    }
    if (typeof v !== 'string') {
      return { ok: false, error: `env[${k}] 必须是字符串` };
    }
    if (v.length > MAX_ENV_VALUE_LEN) {
      return { ok: false, error: `env[${k}] 长度超过 ${MAX_ENV_VALUE_LEN}` };
    }
  }
  return { ok: true };
}

export interface PlaceholderCtx {
  prompt: string;
  sessionId?: string;
  cwd: string;
  folder: string;
  backendId: string;
  model?: string;
}

/**
 * 仅替换白名单 placeholder。未识别 {xxx} 保持字面量（不抛错），
 * 因为校验阶段已经把未知 placeholder 拒掉，运行时再遇到只可能是
 * runtime 数据本身就含 `{...}` 的字面量。
 */
export function renderArgv(template: string[], ctx: PlaceholderCtx): string[] {
  return template.map((item) =>
    item.replace(PLACEHOLDER_RE, (match, rawKey: string) => {
      const key = rawKey as PlaceholderKey;
      switch (key) {
        case 'prompt':
          return ctx.prompt ?? '';
        case 'sessionId':
          return ctx.sessionId ?? '';
        case 'cwd':
          return ctx.cwd;
        case 'folder':
          return ctx.folder;
        case 'backendId':
          return ctx.backendId;
        case 'model':
          return ctx.model ?? '';
        default:
          return match;
      }
    }),
  );
}
