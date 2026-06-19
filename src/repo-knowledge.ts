import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { resolveBackend } from './backends/registry.js';
import { runViaAgentLink } from './backends/agent-link-driver.js';
import type { HostCliDriverConfig } from './backends/host-cli-driver.js';
import { getSession } from './agent-link/registry.js';
import { invokeRemoteTool } from './agent-link/tool-rpc.js';
import type { ContainerOutput, ContainerInput } from './container-runner.js';
import type { RegisteredGroup, RepoKnowledgeRunMilestone } from './types.js';
import { DATA_DIR, OCTODECK_PUBLIC_BASE_URL } from './config.js';
import SqliteDatabase from './sqlite-compat.js';
import {
  appendRepoKnowledgeRunTimeline,
  createRepoKnowledgeRun,
  getRepoKnowledgeIndex,
  getRepoKnowledgeRun,
  getUserHomeGroup,
  isRepoKnowledgeFtsAvailable,
  listRepoKnowledgeChunks,
  listRepoKnowledgeGraphEdges,
  replaceRepoKnowledgeChunks,
  updateRepoKnowledgeRun,
  upsertRepoKnowledgeIndex,
} from './db.js';
import type {
  ManagedRepo,
  RepoKnowledgeChunk,
  RepoKnowledgeChunkKind,
  RepoKnowledgeGraphEdge,
  RepoKnowledgeGraphEdgeKind,
  RepoKnowledgeIndex,
} from './types.js';
import { getRepoKnowledgePluginBin, selectRepoKnowledgePlugin } from './repo-knowledge-plugins.js';
import { resolveRepoKnowledgeSearchBackend } from './repo-knowledge-search.js';

const execFileAsync = promisify(execFile);
const KNOWLEDGE_SOURCE_DIR = path.join(DATA_DIR, 'repo-knowledge', 'sources');
const DEFAULT_MAX_FILES = 800;
const DEFAULT_MAX_FILE_BYTES = 64 * 1024;
const MAX_REMOTE_OUTPUT_BYTES = 20 * 1024 * 1024;
const MAX_REMOTE_COLLECT_CONTENT_BYTES = 700 * 1024;
const MAX_EXTERNAL_GRAPH_NODES = 1500;
const MAX_EXTERNAL_GRAPH_EDGES = 4000;
const MAX_REMOTE_EXTERNAL_GRAPH_NODES = 500;
const MAX_REMOTE_EXTERNAL_GRAPH_EDGES = 1200;
const DEVICE_OFFLINE_RETRY_MS = 15_000;

const DEFAULT_EXCLUDE_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  'vendor',
  'target',
  '__pycache__',
]);

const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.mdx',
  '.py', '.go', '.rs', '.java', '.kt', '.kts', '.c', '.cc', '.cpp', '.h', '.hpp',
  '.cs', '.php', '.rb', '.swift', '.scala', '.sh', '.bash', '.zsh', '.fish',
  '.yaml', '.yml', '.toml', '.ini', '.css', '.scss', '.less', '.html', '.vue',
  '.svelte', '.sql', '.graphql', '.proto', '.dockerfile', '.gradle', '.xml',
]);

const SENSITIVE_FILE_NAMES = new Set([
  '.env', '.npmrc', '.netrc', 'id_rsa', 'id_ed25519', 'credentials.json',
]);

const SENSITIVE_DIRS = new Set([
  '.ssh', '.aws', '.gcloud', '.azure', '.kube', '.terraform',
]);

const SENSITIVE_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx', '.sqlite', '.db']);

const SECRET_CONTENT_PATTERNS = [
  /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /(?:password|passwd|secret|api[_-]?key|access[_-]?token)\s*=\s*['\"]?[^'\"\s]{16,}/i,
];

export interface RepoKnowledgeGenerateOptions {
  includePatterns?: string[];
  excludePatterns?: string[];
  maxFiles?: number;
  maxFileBytes?: number;
  provider?: 'builtin' | 'auto' | 'graphify' | 'codegraph' | 'agent';
  plugins?: string[];
  useExternalGraph?: boolean;
  fallbackBuiltin?: boolean;
  includeDocs?: boolean;
  includeDependencies?: boolean;
  includeImportGraph?: boolean;
  searchBackend?: 'auto' | 'sqlite' | 'postgres' | 'mongo';
  sourceKind?: 'repo' | 'git' | 'device_path';
  sourceGitUrl?: string;
  sourceMainBranch?: string;
  sourceDevicePath?: string;
  sourceDeviceLinkId?: string;
  executionDeviceLinkId?: string;
  /** agent provider: 启用的 skills 清单；不填则默认启用 builtin-graph-scan（若 provider=agent） */
  enabledSkills?: string[];
  /** agent provider: 绑定到哪个 owner 的 home 容器执行；不填则用 repo.createdBy */
  agentOwnerUserId?: string;
  /** agent provider: 覆盖默认 prompt */
  agentPrompt?: string;
  /** agent provider: 单次任务超时（毫秒）；默认 60min */
  agentTimeoutMs?: number;
  /** 关联到的 RepoKnowledgeRun id，agent provider 模式下会写入一次性 upload token + 观测 timeline */
  runId?: string;
  /** @internal 服务端自身可访问的绝对 base URL，用于给 device 组装上传地址 */
  serverBaseUrl?: string;
}

export interface RepoKnowledgeGenerationTask {
  taskId: string;
  index: RepoKnowledgeIndex;
  alreadyRunning: boolean;
}

interface SourceFile {
  path: string;
  content: string;
  size: number;
}

interface SourceCollectionStats {
  skippedSensitiveFiles: number;
  skippedSecretFiles: number;
  skippedLargeFiles: number;
  skippedBinaryFiles: number;
}

const emptyCollectionStats = (): SourceCollectionStats => ({
  skippedSensitiveFiles: 0,
  skippedSecretFiles: 0,
  skippedLargeFiles: 0,
  skippedBinaryFiles: 0,
});

const runningRepoKnowledgeTasks = new Map<string, { taskId: string; promise: Promise<RepoKnowledgeIndex> }>();

function repoKnowledgeTaskKey(repoId: string, userId: string): string {
  return `${userId}:${repoId}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isDeviceOfflineError(message: string | undefined): boolean {
  return !!message && /\blink_offline\b|Device is offline|device.*offline|session.*offline/i.test(message);
}

interface CollectedSourceFiles {
  files: SourceFile[];
  stats: SourceCollectionStats;
}

interface BuiltRepoKnowledge {
  chunks: Array<Omit<RepoKnowledgeChunk, 'repoId' | 'userId' | 'updatedAt'>>;
  edges: Array<Omit<RepoKnowledgeGraphEdge, 'repoId' | 'userId' | 'updatedAt'>>;
  summary: string;
  stats: Record<string, unknown>;
}

interface ExternalGraphResult extends BuiltRepoKnowledge {
  provider: 'graphify' | 'codegraph' | 'agent';
}

function clampOptions(opts: RepoKnowledgeGenerateOptions = {}) {
  const DEFAULT_ENABLED_SKILLS_AGENT = ['builtin-graph-scan'] as const;
  return {
    includePatterns: opts.includePatterns?.map((p) => p.trim()).filter(Boolean) ?? [],
    excludePatterns: opts.excludePatterns?.map((p) => p.trim()).filter(Boolean) ?? [],
    maxFiles: Math.max(1, Math.min(opts.maxFiles ?? DEFAULT_MAX_FILES, 5000)),
    maxFileBytes: Math.max(512, Math.min(opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES, 512 * 1024)),
    provider: opts.provider ?? 'builtin',
    fallbackBuiltin: opts.fallbackBuiltin ?? true,
    includeDocs: opts.includeDocs ?? true,
    includeDependencies: opts.includeDependencies ?? true,
    includeImportGraph: opts.includeImportGraph ?? true,
    searchBackend: opts.searchBackend ?? 'auto',
    sourceKind: opts.sourceKind ?? 'repo',
    sourceGitUrl: opts.sourceGitUrl?.trim() || undefined,
    sourceMainBranch: opts.sourceMainBranch?.trim() || undefined,
    sourceDevicePath: opts.sourceDevicePath?.trim() || undefined,
    sourceDeviceLinkId: opts.sourceDeviceLinkId?.trim() || undefined,
    executionDeviceLinkId: opts.executionDeviceLinkId?.trim() || undefined,
    agentOwnerUserId: opts.agentOwnerUserId?.trim() || undefined,
    agentPrompt: typeof opts.agentPrompt === 'string' && opts.agentPrompt.trim() ? opts.agentPrompt : undefined,
    agentTimeoutMs: opts.agentTimeoutMs ?? 60 * 60_000, // 60min
    runId: typeof opts.runId === 'string' && opts.runId.trim() ? opts.runId.trim() : undefined,
    serverBaseUrl:
      typeof opts.serverBaseUrl === 'string' && opts.serverBaseUrl.trim()
        ? opts.serverBaseUrl.replace(/\/+$/, '')
        : undefined,
    enabledSkills:
      Array.isArray(opts.enabledSkills) && opts.enabledSkills.length > 0
        ? [...new Set(opts.enabledSkills.map((s) => String(s).trim()).filter(Boolean))].slice(0, 20)
        : opts.provider === 'agent'
          ? [...DEFAULT_ENABLED_SKILLS_AGENT]
          : [],
  };
}

function matchesSimplePattern(filePath: string, patterns: string[]): boolean {
  if (patterns.length === 0) return false;
  return patterns.some((pattern) => {
    const normalized = pattern.replace(/\\/g, '/').replace(/^\*\*\//, '');
    if (!normalized) return false;
    if (normalized.includes('*')) {
      const escaped = normalized
        .split('*')
        .map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, '\\$&'))
        .join('.*');
      return new RegExp(`^${escaped}$`).test(filePath);
    }
    return filePath === normalized || filePath.includes(normalized);
  });
}

function shouldIncludeFile(filePath: string, opts: ReturnType<typeof clampOptions>): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('/');
  if (parts.some((part) => DEFAULT_EXCLUDE_DIRS.has(part))) return false;
  if (isSensitivePath(normalized)) return false;
  if (matchesSimplePattern(normalized, opts.excludePatterns)) return false;
  if (opts.includePatterns.length > 0 && !matchesSimplePattern(normalized, opts.includePatterns)) return false;
  const base = path.basename(normalized).toLowerCase();
  if (base === 'dockerfile' || base === 'makefile' || base === 'rakefile') return true;
  return TEXT_EXTENSIONS.has(path.extname(base));
}

function isSensitivePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('/').map((part) => part.toLowerCase());
  const base = parts[parts.length - 1] || '';
  if (parts.some((part) => SENSITIVE_DIRS.has(part))) return true;
  if (SENSITIVE_FILE_NAMES.has(base)) return true;
  if (base.startsWith('.env.')) return true;
  if (/^service-account.*\.json$/i.test(base)) return true;
  return SENSITIVE_EXTENSIONS.has(path.extname(base));
}

function containsSecret(content: string): boolean {
  return SECRET_CONTENT_PATTERNS.some((pattern) => pattern.test(content));
}

function languageForFile(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase();
  const byExt: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'typescript-react', '.js': 'javascript', '.jsx': 'javascript-react',
    '.py': 'python', '.go': 'go', '.rs': 'rust', '.java': 'java', '.kt': 'kotlin', '.cs': 'csharp',
    '.rb': 'ruby', '.php': 'php', '.swift': 'swift', '.md': 'markdown', '.json': 'json',
    '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml', '.css': 'css', '.scss': 'scss', '.html': 'html',
    '.vue': 'vue', '.svelte': 'svelte', '.sql': 'sql', '.proto': 'protobuf', '.sh': 'shell',
  };
  return byExt[ext];
}

function walkLocalFiles(root: string, opts: ReturnType<typeof clampOptions>): CollectedSourceFiles {
  const out: SourceFile[] = [];
  const stats = emptyCollectionStats();
  const visit = (dir: string) => {
    if (out.length >= opts.maxFiles) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (out.length >= opts.maxFiles) break;
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        if (SENSITIVE_DIRS.has(entry.name.toLowerCase())) continue;
        if (!DEFAULT_EXCLUDE_DIRS.has(entry.name) && !matchesSimplePattern(rel, opts.excludePatterns)) visit(full);
      } else if (entry.isFile() && shouldIncludeFile(rel, opts)) {
        if (isSensitivePath(rel)) {
          stats.skippedSensitiveFiles += 1;
          continue;
        }
        const stat = fs.statSync(full);
        if (stat.size > opts.maxFileBytes) {
          stats.skippedLargeFiles += 1;
          continue;
        }
        const content = fs.readFileSync(full, 'utf8');
        if (content.includes('\0')) {
          stats.skippedBinaryFiles += 1;
          continue;
        }
        if (containsSecret(content)) {
          stats.skippedSecretFiles += 1;
          continue;
        }
        out.push({ path: rel, content, size: stat.size });
      }
    }
  };
  visit(root);
  return { files: out, stats };
}

function gitCommandOutput(err: unknown): string {
  const value = err as { message?: unknown; stderr?: unknown; stdout?: unknown };
  const processOutput = [value.stderr, value.stdout]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join('\n')
    .trim();
  if (processOutput) return processOutput;
  return typeof value.message === 'string' ? value.message.trim() : '';
}

function gitHostFromUrl(gitUrl: string): string | undefined {
  try {
    return new URL(gitUrl).hostname || undefined;
  } catch {
    const sshLike = gitUrl.match(/^[^@]+@([^:/]+)[:/]/);
    return sshLike?.[1];
  }
}

function gitFailureHint(gitUrl: string, output: string): string {
  const host = gitHostFromUrl(gitUrl);
  if (/Could not resolve host|Name or service not known|Temporary failure in name resolution/i.test(output)) {
    return [
      `git_host_unreachable: OctoDeck server cannot resolve ${host ?? 'the Git host'}.`,
      'This usually happens when the repository is on an internal network (for example code.byted.org) but the OctoDeck server/container is outside that DNS/VPN.',
      'Fix options: run OctoDeck in the same network/VPN, configure container DNS/proxy, use a reachable mirror URL, or create this repo as a Device Path repo on a machine that can access it.',
    ].join(' ');
  }
  if (/Authentication failed|could not read Username|Permission denied|Repository not found|not authorized/i.test(output)) {
    return [
      'git_auth_failed: OctoDeck server cannot authenticate to this repository.',
      'Use a clone URL reachable by the server with credentials, configure Git credentials/SSH key in the runtime, or use a Device Path repo from an authenticated machine.',
    ].join(' ');
  }
  if (/Connection timed out|Failed to connect|Connection refused|Network is unreachable/i.test(output)) {
    return [
      `git_network_unreachable: OctoDeck server cannot connect to ${host ?? 'the Git host'}.`,
      'Check network/VPN/proxy/firewall from the OctoDeck runtime, or use a Device Path repo on a reachable machine.',
    ].join(' ');
  }
  return 'git_clone_failed: Failed to prepare Git source. Check that the clone URL is reachable from the OctoDeck server/runtime.';
}

function conciseGitOutput(output: string): string {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('Command failed:'))
    .slice(-4)
    .join('\n');
}

async function runGit(args: string[], opts: { timeout: number; gitUrl?: string }): Promise<{ stdout: string }> {
  try {
    const { stdout } = await execFileAsync('git', args, { timeout: opts.timeout });
    return { stdout };
  } catch (err) {
    const output = gitCommandOutput(err);
    const hint = opts.gitUrl ? gitFailureHint(opts.gitUrl, output) : 'git_command_failed: Git command failed.';
    const concise = conciseGitOutput(output);
    throw new Error(`${hint}\nCommand: git ${args.join(' ')}${concise ? `\n${concise}` : ''}`.trim());
  }
}

async function prepareGitSource(repo: ManagedRepo): Promise<{ root: string; revision?: string }> {
  if (!repo.gitUrl) throw new Error('git_url is required');
  fs.mkdirSync(KNOWLEDGE_SOURCE_DIR, { recursive: true });
  const root = path.join(KNOWLEDGE_SOURCE_DIR, repo.id);
  if (fs.existsSync(path.join(root, '.git'))) {
    const currentRemote = await runGit(['-C', root, 'config', '--get', 'remote.origin.url'], { timeout: 15_000, gitUrl: repo.gitUrl }).catch(() => ({ stdout: '' }));
    if (currentRemote.stdout.trim() && currentRemote.stdout.trim() !== repo.gitUrl) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
  if (!fs.existsSync(path.join(root, '.git'))) {
    fs.rmSync(root, { recursive: true, force: true });
    await runGit(['clone', '--depth=1', repo.gitUrl, root], { timeout: 120_000, gitUrl: repo.gitUrl });
  } else {
    await runGit(['-C', root, 'fetch', '--depth=1', 'origin'], { timeout: 120_000, gitUrl: repo.gitUrl });
  }
  if (repo.mainBranch) {
    await runGit(['-C', root, 'checkout', repo.mainBranch], { timeout: 60_000, gitUrl: repo.gitUrl });
    await runGit(['-C', root, 'pull', '--ff-only', 'origin', repo.mainBranch], { timeout: 120_000, gitUrl: repo.gitUrl }).catch(() => undefined);
  }
  const { stdout } = await runGit(['-C', root, 'rev-parse', 'HEAD'], { timeout: 15_000, gitUrl: repo.gitUrl });
  return { root, revision: stdout.trim() || undefined };
}

export function remoteCollectCommand(repoPath: string, opts: ReturnType<typeof clampOptions>): string {
  return `python3 - <<'PY'
import json, os, re
root = os.path.realpath(${JSON.stringify(repoPath)})
max_files = ${opts.maxFiles}
max_file_bytes = ${opts.maxFileBytes}
max_total_content_bytes = ${MAX_REMOTE_COLLECT_CONTENT_BYTES}
include_patterns = ${JSON.stringify(opts.includePatterns)}
exclude_patterns = ${JSON.stringify(opts.excludePatterns)}
exclude_dirs = ${JSON.stringify(Array.from(DEFAULT_EXCLUDE_DIRS))}
sensitive_dirs = ${JSON.stringify(Array.from(SENSITIVE_DIRS))}
sensitive_names = ${JSON.stringify(Array.from(SENSITIVE_FILE_NAMES))}
sensitive_exts = ${JSON.stringify(Array.from(SENSITIVE_EXTENSIONS))}
text_exts = ${JSON.stringify(Array.from(TEXT_EXTENSIONS))}
secret_patterns = [
    r'-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----',
    r'\bAKIA[0-9A-Z]{16}\b',
    r'\bgh[pousr]_[A-Za-z0-9_]{30,}\b',
    r'\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b',
    r"(?:password|passwd|secret|api[_-]?key|access[_-]?token)\\s*=\\s*['\\\"]?[^'\\\"\\s]{16,}",
]
def match(path, patterns):
    return any(p and (p.strip('*') in path or path == p.strip()) for p in patterns)
def sensitive(rel):
    parts = [p.lower() for p in rel.split('/')]
    base = parts[-1] if parts else ''
    if any(p in sensitive_dirs for p in parts): return True
    if base in sensitive_names or base.startswith('.env.'): return True
    if re.match(r'^service-account.*\.json$', base): return True
    return os.path.splitext(base)[1] in sensitive_exts
def has_secret(content):
    return any(re.search(p, content, re.I) for p in secret_patterns)
def include(rel):
    parts = rel.split('/')
    if any(p in exclude_dirs for p in parts): return False
    if sensitive(rel): return False
    if match(rel, exclude_patterns): return False
    if include_patterns and not match(rel, include_patterns): return False
    base = os.path.basename(rel).lower()
    return base in ('dockerfile','makefile','rakefile') or os.path.splitext(base)[1] in text_exts
files=[]
total_content_bytes = 0
stats={'skippedSensitiveFiles': 0, 'skippedSecretFiles': 0, 'skippedLargeFiles': 0, 'skippedBinaryFiles': 0, 'truncatedByOutputBudget': False, 'outputBudgetBytes': max_total_content_bytes}
for cur, dirs, names in os.walk(root):
    dirs[:] = [d for d in dirs if d not in exclude_dirs and d.lower() not in sensitive_dirs]
    stop = False
    for name in sorted(names):
        rel = os.path.relpath(os.path.join(cur, name), root).replace(os.sep, '/')
        if sensitive(rel):
            stats['skippedSensitiveFiles'] += 1
            continue
        if not include(rel): continue
        full = os.path.join(cur, name)
        try:
            size = os.path.getsize(full)
            if size > max_file_bytes:
                stats['skippedLargeFiles'] += 1
                continue
            with open(full, 'r', encoding='utf-8', errors='ignore') as f:
                content = f.read()
            if chr(0) in content:
                stats['skippedBinaryFiles'] += 1
                continue
            if has_secret(content):
                stats['skippedSecretFiles'] += 1
                continue
            content_bytes = len(content.encode('utf-8', errors='ignore'))
            if total_content_bytes + content_bytes > max_total_content_bytes:
                stats['truncatedByOutputBudget'] = True
                stop = True
                break
            files.append({'path': rel, 'size': size, 'content': content})
            total_content_bytes += content_bytes
            if len(files) >= max_files:
                stop = True
                break
        except Exception:
            pass
    if stop:
        break
print(json.dumps({'files': files, 'stats': stats}, ensure_ascii=False))
PY`;
}

export function remoteCollectGitCommand(repo: ManagedRepo, opts: ReturnType<typeof clampOptions>): string {
  if (!repo.gitUrl) throw new Error('git_url is required');
  const branch = repo.mainBranch?.trim() || '';
  const gitSetup = `git_url = ${JSON.stringify(repo.gitUrl)}
branch = ${JSON.stringify(branch)}
def run_git(args, cwd=None):
    import subprocess
    p = subprocess.run(['git'] + args, cwd=cwd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if p.returncode != 0:
        raise RuntimeError((p.stderr or p.stdout or 'git command failed').strip())
    return p.stdout.strip()
cache_base = os.path.join(os.getcwd(), 'git-cache')
os.makedirs(cache_base, exist_ok=True)
cache_name = hashlib.sha1(git_url.encode('utf-8')).hexdigest()[:24]
root = os.path.join(cache_base, cache_name)
if os.path.isdir(os.path.join(root, '.git')):
    current_remote = run_git(['config', '--get', 'remote.origin.url'], cwd=root)
    if current_remote and current_remote != git_url:
        shutil.rmtree(root, ignore_errors=True)
if not os.path.isdir(os.path.join(root, '.git')):
    tmp = root + '.tmp'
    shutil.rmtree(tmp, ignore_errors=True)
    clone_args = ['clone', '--depth=1']
    if branch:
        clone_args += ['--branch', branch]
    clone_args += [git_url, tmp]
    run_git(clone_args)
    os.replace(tmp, root)
else:
    if branch:
        run_git(['fetch', '--depth=1', 'origin', branch], cwd=root)
        run_git(['checkout', '-B', branch, 'FETCH_HEAD'], cwd=root)
    else:
        run_git(['fetch', '--depth=1', 'origin'], cwd=root)
        run_git(['pull', '--ff-only'], cwd=root)
revision = run_git(['rev-parse', 'HEAD'], cwd=root)`;
  return remoteCollectCommand('__OCTODECK_GIT_ROOT__', opts)
    .replace('import json, os, re', 'import json, os, re\nimport hashlib, shutil')
    .replace('root = os.path.realpath("__OCTODECK_GIT_ROOT__")', gitSetup)
    .replace(
      "print(json.dumps({'files': files, 'stats': stats}, ensure_ascii=False))",
      "print(json.dumps({'files': files, 'stats': stats, 'revision': revision, 'root': root}, ensure_ascii=False))",
    );
}

async function collectDeviceFiles(repo: ManagedRepo, opts: ReturnType<typeof clampOptions>): Promise<CollectedSourceFiles> {
  if (!repo.devicePath || !repo.deviceLinkId) throw new Error('device_path and device_link_id are required');
  const session = getSession(repo.deviceLinkId);
  if (!session || session.state !== 'open') throw new Error('Device is offline');
  const result = await invokeRemoteTool(session, {
    linkId: repo.deviceLinkId,
    toolName: 'Bash',
    input: { command: remoteCollectCommand(repo.devicePath, opts) },
    cwd: 'octodeck-tmp://repo-knowledge',
    timeoutMs: 120_000,
    maxOutputBytes: MAX_REMOTE_OUTPUT_BYTES,
  });
  if (!result.ok) throw new Error(result.error || 'Failed to collect device repo files');
  const stdout = typeof (result.result as { stdout?: unknown } | null)?.stdout === 'string'
    ? (result.result as { stdout: string }).stdout
    : '';
  const parsed = JSON.parse(stdout || '{}') as { files?: SourceFile[]; stats?: Partial<SourceCollectionStats> };
  return {
    files: (parsed.files ?? []).filter((file) => typeof file.path === 'string' && typeof file.content === 'string'),
    stats: { ...emptyCollectionStats(), ...(parsed.stats ?? {}) },
  };
}

async function collectGitFilesOnDevice(
  repo: ManagedRepo,
  deviceLinkId: string,
  opts: ReturnType<typeof clampOptions>,
): Promise<CollectedSourceFiles & { revision?: string; root?: string }> {
  const session = getSession(deviceLinkId);
  if (!session || session.state !== 'open') throw new Error('Device is offline');
  const result = await invokeRemoteTool(session, {
    linkId: deviceLinkId,
    toolName: 'Bash',
    input: { command: remoteCollectGitCommand(repo, opts) },
    cwd: 'octodeck-tmp://repo-knowledge',
    timeoutMs: 180_000,
    maxOutputBytes: MAX_REMOTE_OUTPUT_BYTES,
  });
  if (!result.ok) throw new Error(result.error || 'Failed to collect git repo files on device');
  const stdout = typeof (result.result as { stdout?: unknown } | null)?.stdout === 'string'
    ? (result.result as { stdout: string }).stdout
    : '';
  const parsed = JSON.parse(stdout || '{}') as { files?: SourceFile[]; stats?: Partial<SourceCollectionStats>; revision?: string; root?: string };
  return {
    files: (parsed.files ?? []).filter((file) => typeof file.path === 'string' && typeof file.content === 'string'),
    stats: { ...emptyCollectionStats(), ...(parsed.stats ?? {}) },
    revision: parsed.revision,
    root: parsed.root,
  };
}

export function stableChunkId(repoId: string, kind: RepoKnowledgeChunkKind, key: string): string {
  const digest = crypto.createHash('sha1').update(`${repoId}:${kind}:${key}`).digest('hex').slice(0, 16);
  return `rk_${digest}`;
}

export function stableEdgeId(repoId: string, edgeKind: RepoKnowledgeGraphEdgeKind, key: string): string {
  const digest = crypto.createHash('sha1').update(`${repoId}:${edgeKind}:${key}`).digest('hex').slice(0, 16);
  return `rke_${digest}`;
}

function extractSymbols(file: SourceFile, repoId: string): Array<Omit<RepoKnowledgeChunk, 'repoId' | 'userId' | 'updatedAt'>> {
  const lines = file.content.split(/\r?\n/);
  const symbols: Array<Omit<RepoKnowledgeChunk, 'repoId' | 'userId' | 'updatedAt'>> = [];
  const symbolRe = /^\s*(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$-]*)|^\s*(?:def|class)\s+([A-Za-z_][\w]*)|^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/;
  lines.forEach((line, idx) => {
    const match = line.match(symbolRe);
    const name = match?.[1] || match?.[2] || match?.[3];
    if (!name) return;
    const start = Math.max(0, idx - 4);
    const end = Math.min(lines.length, idx + 36);
    symbols.push({
      id: stableChunkId(repoId, 'symbol', `${file.path}:${idx + 1}:${name}`),
      path: file.path,
      kind: 'symbol',
      name,
      language: languageForFile(file.path),
      startLine: start + 1,
      endLine: end,
      content: lines.slice(start, end).join('\n'),
      keywords: name,
      metadata: {
        symbolKind: line.includes('class ') ? 'class' : line.includes('interface ') ? 'interface' : line.includes('type ') ? 'type' : 'function',
        signature: line.trim(),
        exported: /\bexport\b/.test(line),
        confidence: /\.(ts|tsx|js|jsx)$/i.test(file.path) ? 'heuristic' : 'heuristic',
      },
    });
  });
  return symbols.slice(0, 40);
}

/**
 * 将 agent 上传的产物追加写入仓库知识库索引：
 *   - 生成稳定 id（前缀 `upload:`，与其它生成器命名空间隔离）
 *   - 按 id 去重（本次上传内部的重复 + 与已存条目的重复都忽略）
 *   - 不删除已有的 builtin / 旧 upload 条目，只追加
 * 返回 merged=新增条目数，skipped=被去重跳过的条目数，stats=汇总信息
 */
export function ingestRepoKnowledgeUpload(
  repo: ManagedRepo,
  userId: string,
  input: {
    chunks: Array<{
      key: string;
      path: string;
      kind: RepoKnowledgeChunkKind;
      name?: string;
      language?: string;
      startLine?: number;
      endLine?: number;
      content: string;
      keywords?: string;
      metadata?: Record<string, unknown>;
    }>;
    edges: Array<{
      key: string;
      fromPath: string;
      toPath?: string;
      edgeKind: RepoKnowledgeGraphEdgeKind;
      symbol?: string;
      packageName?: string;
      source?: string;
      confidence?: number;
      runId?: string;
      metadata?: Record<string, unknown>;
    }>;
    summary?: string;
    stats?: Record<string, unknown>;
  },
): { merged: number; skipped: number; stats: Record<string, unknown> } {
  const now = new Date().toISOString();
  const mergedChunks: Array<Omit<RepoKnowledgeChunk, 'repoId' | 'userId' | 'updatedAt'>> = [];
  const mergedEdges: Array<Omit<RepoKnowledgeGraphEdge, 'repoId' | 'userId' | 'updatedAt'>> = [];
  const seenChunkIds = new Set<string>();
  const seenEdgeIds = new Set<string>();
  let skippedChunks = 0;
  let skippedEdges = 0;

  for (const c of input.chunks) {
    const id = stableChunkId(repo.id, c.kind, `upload:${c.key}`);
    if (seenChunkIds.has(id)) { skippedChunks++; continue; }
    seenChunkIds.add(id);
    mergedChunks.push({
      id,
      path: c.path,
      kind: c.kind,
      name: c.name,
      language: c.language,
      startLine: c.startLine,
      endLine: c.endLine,
      content: c.content,
      keywords: c.keywords,
      metadata: { ...(c.metadata ?? {}), _source: 'agent-upload' },
    });
  }
  for (const e of input.edges) {
    const id = stableEdgeId(repo.id, e.edgeKind, `upload:${e.key}`);
    if (seenEdgeIds.has(id)) { skippedEdges++; continue; }
    seenEdgeIds.add(id);
    mergedEdges.push({
      id,
      fromPath: e.fromPath,
      toPath: e.toPath,
      edgeKind: e.edgeKind,
      symbol: e.symbol,
      packageName: e.packageName,
      source: e.source && e.source.trim() ? `agent:${e.source}` : 'agent',
      confidence: typeof e.confidence === 'number' ? Math.max(0, Math.min(1, e.confidence)) : undefined,
      runId: e.runId,
      metadata: { ...(e.metadata ?? {}), _source: 'agent-upload' },
    });
  }

  // 追加写入：不删旧的（保留 builtin 基础层）
  const mergedCounts = appendRepoKnowledgeChunks(repo.id, userId, {
    chunks: mergedChunks,
    edges: mergedEdges,
    updatedAt: now,
  });

  return {
    merged: mergedCounts.mergedChunks + mergedCounts.mergedEdges,
    skipped: skippedChunks + skippedEdges,
    stats: {
      ...(input.stats ?? {}),
      uploadedChunks: mergedCounts.mergedChunks,
      uploadedEdges: mergedCounts.mergedEdges,
      skippedChunks,
      skippedEdges,
    },
  };
}

/**
 * 追加写入知识库条目（不删除已有）：先读旧条目中 agent 以外的基础层（含 builtin、graphify、
 * codegraph），与本次新条目合并后，用 replaceRepoKnowledgeChunks 全量回写。
 * agent 的 `_source: 'agent-upload'` 条目按 id 幂等替换，避免同 key 反复上传产生重复。
 * 与 replaceRepoKnowledgeChunks 的"先删后写"语义互补，用于 agent 上传追加。
 */
function appendRepoKnowledgeChunks(
  repoId: string,
  userId: string,
  input: {
    chunks: Array<Omit<RepoKnowledgeChunk, 'repoId' | 'userId' | 'updatedAt'>>;
    edges?: Array<Omit<RepoKnowledgeGraphEdge, 'repoId' | 'userId' | 'updatedAt'>>;
    updatedAt?: string;
  },
): { mergedChunks: number; mergedEdges: number } {
  const inputChunkCount = input.chunks.length;
  const inputEdgeCount = input.edges?.length ?? 0;
  if (inputChunkCount === 0 && inputEdgeCount === 0) {
    return { mergedChunks: 0, mergedEdges: 0 };
  }
  // 读已有 → 合并（保留非 agent 的 builtin 基础层 + 旧 agent upload 中 key 未冲突者）→ 全量 replace
  const existingChunks = (listRepoKnowledgeChunksInternal({ repoId, userId, limit: 200_000 }) ?? []) as unknown as
    Array<Omit<RepoKnowledgeChunk, 'repoId' | 'userId' | 'updatedAt'>>;
  const existingEdges = (listRepoKnowledgeEdgesInternal({ repoId, userId, limit: 500_000 }) ?? []) as unknown as
    Array<Omit<RepoKnowledgeGraphEdge, 'repoId' | 'userId' | 'updatedAt'>>;
  const newChunkIds = new Set(input.chunks.map((c) => c.id));
  const newEdgeIds = new Set((input.edges ?? []).map((e) => e.id));
  const keptChunks = existingChunks.filter((c) => !newChunkIds.has(c.id));
  const keptEdges = existingEdges.filter((e) => !newEdgeIds.has(e.id));
  const mergedChunks = [...keptChunks, ...input.chunks];
  const mergedEdges = [...keptEdges, ...(input.edges ?? [])];
  replaceRepoKnowledgeChunks({ repoId, userId, chunks: mergedChunks, edges: mergedEdges });
  return {
    mergedChunks: mergedChunks.length - keptChunks.length,
    mergedEdges: mergedEdges.length - keptEdges.length,
  };
}

// 占位引用，确保 db.ts 未来 export 后能无缝切换
import {
  listRepoKnowledgeChunks as listRepoKnowledgeChunksInternal,
  listRepoKnowledgeGraphEdges as listRepoKnowledgeEdgesInternal,
} from './db.js';

function packageNameFromSpecifier(specifier: string): string {
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/');
  return specifier.split('/')[0] || specifier;
}

function packageNameFromDependency(dependency: string): string {
  if (dependency.startsWith('@')) {
    const parts = dependency.split('@');
    return parts.length >= 3 ? `@${parts[1]}` : dependency;
  }
  return dependency.split('@')[0] || dependency;
}

function resolveInternalTarget(fromPath: string, target: string, filePathSet: Set<string>): string | undefined {
  if (!target.startsWith('.') && !target.startsWith('/')) return undefined;
  const base = target.startsWith('/')
    ? target.replace(/^\/+/, '')
    : path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), target));
  const candidates = [
    base,
    `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.mjs`, `${base}.cjs`,
    `${base}.py`, `${base}.go`, `${base}.rs`, `${base}.java`, `${base}.kt`, `${base}.md`, `${base}.mdx`,
    path.posix.join(base, 'index.ts'), path.posix.join(base, 'index.tsx'), path.posix.join(base, 'index.js'), path.posix.join(base, 'index.jsx'),
  ];
  return candidates.find((candidate) => filePathSet.has(candidate));
}

function extractImportEdges(file: SourceFile, repoId: string, filePathSet: Set<string>): Array<Omit<RepoKnowledgeGraphEdge, 'repoId' | 'userId' | 'updatedAt'>> {
  const edges: Array<Omit<RepoKnowledgeGraphEdge, 'repoId' | 'userId' | 'updatedAt'>> = [];
  const seen = new Set<string>();
  const add = (target: string, source: string) => {
    // dedupe by (target, source); multiple regex patterns may hit the same import.
    const key = `${target}\0${source}`;
    if (seen.has(key)) return;
    seen.add(key);
    const resolvedTarget = resolveInternalTarget(file.path, target, filePathSet);
    const isInternal = target.startsWith('.') || target.startsWith('/');
    edges.push({
      id: stableEdgeId(repoId, 'imports', `${file.path}:${target}:${source}`),
      fromPath: file.path,
      toPath: resolvedTarget,
      edgeKind: 'imports',
      packageName: isInternal ? undefined : packageNameFromSpecifier(target),
      source,
      metadata: { rawTarget: target, resolved: !!resolvedTarget },
    });
  };
  const patterns = [
    /(?:import|export)\s+(?:[^'\"]*\s+from\s+)?['\"]([^'\"]+)['\"]/g,
    /require\(\s*['\"]([^'\"]+)['\"]\s*\)/g,
    /from\s+([A-Za-z0-9_\.]+)\s+import\s+/g,
    /^\s*import\s+([A-Za-z0-9_\.]+)/gm,
    /^\s*use\s+([A-Za-z0-9_:]+)/gm,
  ];
  for (const pattern of patterns) {
    for (const match of file.content.matchAll(pattern)) {
      if (match[1]) add(match[1], 'builtin');
    }
  }
  return edges.slice(0, 120);
}

function buildReverseImportEdges(repoId: string, edges: Array<Omit<RepoKnowledgeGraphEdge, 'repoId' | 'userId' | 'updatedAt'>>): Array<Omit<RepoKnowledgeGraphEdge, 'repoId' | 'userId' | 'updatedAt'>> {
  return edges
    .filter((edge) => edge.edgeKind === 'imports' && !!edge.toPath)
    .map((edge) => ({
      id: stableEdgeId(repoId, 'imported_by', `${edge.toPath}:${edge.fromPath}`),
      fromPath: edge.toPath!,
      toPath: edge.fromPath,
      edgeKind: 'imported_by' as const,
      source: edge.source,
      metadata: { reverseOf: edge.id },
    }));
}

function buildDocReferenceEdges(file: SourceFile, repoId: string, filePathSet: Set<string>): Array<Omit<RepoKnowledgeGraphEdge, 'repoId' | 'userId' | 'updatedAt'>> {
  if (!/\.mdx?$/i.test(file.path)) return [];
  const edges: Array<Omit<RepoKnowledgeGraphEdge, 'repoId' | 'userId' | 'updatedAt'>> = [];
  for (const target of Array.from(file.content.matchAll(/\[[^\]]+\]\(([^)#?]+)(?:[#?][^)]*)?\)/g))
    .map((match) => match[1]?.trim())
    .filter((target): target is string => !!target && !/^https?:\/\//i.test(target) && !target.startsWith('mailto:'))) {
    const resolvedTarget = resolveInternalTarget(file.path, target, filePathSet) ?? (filePathSet.has(target) ? target : undefined);
    if (!resolvedTarget) continue;
    edges.push({
      id: stableEdgeId(repoId, 'documents', `${file.path}:${target}`),
      fromPath: file.path,
      toPath: resolvedTarget,
      edgeKind: 'documents',
      source: 'builtin',
      metadata: { rawTarget: target },
    });
    if (edges.length >= 80) break;
  }
  return edges;
}

function dependencyEntries(file: SourceFile): string[] {
  const base = path.basename(file.path).toLowerCase();
  try {
    if (base === 'package.json') {
      const pkg = JSON.parse(file.content) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      return Object.entries({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }).map(([name, version]) => `${name}@${version}`);
    }
  } catch {
    return [];
  }
  if (base === 'requirements.txt') return file.content.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#')).slice(0, 200);
  if (base === 'go.mod') return Array.from(file.content.matchAll(/^\s*([\w.-]+\/[\w./-]+)\s+v[^\s]+/gm)).map((m) => m[1]);
  if (base === 'cargo.toml') return Array.from(file.content.matchAll(/^([A-Za-z0-9_-]+)\s*=/gm)).map((m) => m[1]);
  return [];
}

function buildDocChunks(file: SourceFile, repoId: string): Array<Omit<RepoKnowledgeChunk, 'repoId' | 'userId' | 'updatedAt'>> {
  if (!/\.mdx?$/i.test(file.path)) return [];
  const lines = file.content.split(/\r?\n/);
  const headingIndexes = lines.map((line, idx) => ({ line, idx })).filter(({ line }) => /^#{1,6}\s+/.test(line));
  if (headingIndexes.length === 0) {
    return [{
      id: stableChunkId(repoId, 'doc', file.path),
      path: file.path,
      kind: 'doc',
      name: path.basename(file.path),
      language: 'markdown',
      startLine: 1,
      endLine: lines.length,
      content: file.content,
      keywords: file.path,
      metadata: { heading: path.basename(file.path), level: 0 },
    }];
  }
  return headingIndexes.slice(0, 40).map(({ line, idx }, order) => {
    const next = headingIndexes[order + 1]?.idx ?? lines.length;
    const heading = line.replace(/^#{1,6}\s+/, '').trim();
    return {
      id: stableChunkId(repoId, 'doc', `${file.path}:${idx + 1}:${heading}`),
      path: file.path,
      kind: 'doc' as const,
      name: heading,
      language: 'markdown',
      startLine: idx + 1,
      endLine: next,
      content: lines.slice(idx, next).join('\n'),
      keywords: `${file.path} ${heading}`,
      metadata: {
        heading,
        level: line.match(/^#+/)?.[0].length ?? 1,
        links: Array.from(lines.slice(idx, next).join('\n').matchAll(/\[[^\]]+\]\(([^)]+)\)/g)).map((m) => m[1]).slice(0, 20),
      },
    };
  });
}

function buildChunks(repo: ManagedRepo, files: SourceFile[], revision: string | undefined, options: ReturnType<typeof clampOptions>): BuiltRepoKnowledge {
  const languages = new Map<string, number>();
  for (const file of files) {
    const lang = languageForFile(file.path) ?? 'text';
    languages.set(lang, (languages.get(lang) ?? 0) + 1);
  }
  const topFiles = files.slice(0, 80).map((file) => `- ${file.path}`).join('\n');
  const summary = [
    `Repo: ${repo.name}`,
    `Kind: ${repo.kind}`,
    revision ? `Revision: ${revision}` : undefined,
    `Indexed files: ${files.length}`,
    `Languages: ${Array.from(languages.entries()).map(([k, v]) => `${k}(${v})`).join(', ')}`,
    'Key files:',
    topFiles,
  ].filter(Boolean).join('\n');
  const chunks: Array<Omit<RepoKnowledgeChunk, 'repoId' | 'userId' | 'updatedAt'>> = [
    {
      id: stableChunkId(repo.id, 'overview', 'overview'),
      path: '__overview__',
      kind: 'overview',
      name: repo.name,
      content: summary,
      keywords: `${repo.name} ${Array.from(languages.keys()).join(' ')}`,
    },
  ];
  const edges: Array<Omit<RepoKnowledgeGraphEdge, 'repoId' | 'userId' | 'updatedAt'>> = [];
  const filePathSet = new Set(files.map((file) => file.path));
  let symbolCount = 0;
  let dependencyCount = 0;
  let docCount = 0;
  for (const file of files) {
    const language = languageForFile(file.path);
    chunks.push({
      id: stableChunkId(repo.id, 'file', file.path),
      path: file.path,
      kind: 'file',
      name: path.basename(file.path),
      language,
      startLine: 1,
      endLine: file.content.split(/\r?\n/).length,
      content: file.content,
      keywords: `${file.path} ${language ?? ''}`,
      metadata: { size: file.size },
    });
    const symbols = extractSymbols(file, repo.id);
    symbolCount += symbols.length;
    chunks.push(...symbols);
    if (options.includeImportGraph) edges.push(...extractImportEdges(file, repo.id, filePathSet));
    if (options.includeDependencies) {
      const deps = dependencyEntries(file);
      if (deps.length > 0) {
        dependencyCount += deps.length;
        chunks.push({
          id: stableChunkId(repo.id, 'dependency', file.path),
          path: file.path,
          kind: 'dependency',
          name: path.basename(file.path),
          language,
          startLine: 1,
          endLine: file.content.split(/\r?\n/).length,
          content: deps.join('\n'),
          keywords: deps.join(' '),
          metadata: { dependencyCount: deps.length },
        });
        for (const dep of deps.slice(0, 200)) {
          const packageName = packageNameFromDependency(dep);
          edges.push({
            id: stableEdgeId(repo.id, 'depends_on', `${file.path}:${dep}`),
            fromPath: file.path,
            edgeKind: 'depends_on',
            packageName,
            source: 'builtin',
            metadata: { dependency: dep },
          });
        }
      }
    }
    if (options.includeDocs) {
      const docs = buildDocChunks(file, repo.id);
      docCount += docs.length;
      chunks.push(...docs);
      edges.push(...buildDocReferenceEdges(file, repo.id, filePathSet));
    }
  }
  if (options.includeImportGraph) edges.push(...buildReverseImportEdges(repo.id, edges));
  return {
    chunks,
    edges,
    summary,
    stats: {
      fileCount: files.length,
      chunkCount: chunks.length,
      symbolCount,
      dependencyCount,
      docCount,
      importEdgeCount: edges.filter((edge) => edge.edgeKind === 'imports').length,
      graphEdgeCount: edges.length,
      languages: Object.fromEntries(languages),
      totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    },
  };
}

function normalizeRepoRelativePath(root: string, filePath: unknown): string | undefined {
  if (typeof filePath !== 'string' || !filePath.trim()) return undefined;
  const normalized = filePath.replace(/\\/g, '/');
  if (path.isAbsolute(filePath)) {
    const rel = path.relative(root, filePath).replace(/\\/g, '/');
    if (!rel.startsWith('..') && rel !== '') return rel;
  }
  return normalized.replace(/^\.\//, '');
}

function parseLineLocation(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(1, Math.floor(value));
  if (typeof value !== 'string') return undefined;
  const match = value.match(/L(\d+)/i) ?? value.match(/^(\d+)$/);
  return match?.[1] ? Number(match[1]) : undefined;
}

function mapExternalEdgeKind(kind: unknown): RepoKnowledgeGraphEdgeKind {
  const value = String(kind || '').toLowerCase();
  if (value === 'imports' || value === 'imports_from' || value === 'import') return 'imports';
  if (value === 'imported_by') return 'imported_by';
  if (value === 'exports' || value === 'export') return 'exports';
  if (value === 'depends_on' || value === 'dependency') return 'depends_on';
  if (value === 'documents' || value === 'documented_by') return 'documents';
  return 'references';
}

function remoteExternalGraphCommand(provider: 'graphify' | 'codegraph', repoPath: string, opts: ReturnType<typeof clampOptions>): string {
  const includeDocs = opts.includeDocs && process.env.REPO_KNOWLEDGE_GRAPHIFY_INCLUDE_SEMANTIC === '1';
  return `python3 - <<'PY'
import json, os, shutil, sqlite3, subprocess, sys, tempfile

provider = ${JSON.stringify(provider)}
root = os.path.realpath(${JSON.stringify(repoPath)})
max_nodes = ${MAX_REMOTE_EXTERNAL_GRAPH_NODES}
max_edges = ${MAX_REMOTE_EXTERNAL_GRAPH_EDGES}
include_docs = ${JSON.stringify(includeDocs)}

def rel(path):
    if not path:
        return None
    path = str(path).replace('\\\\', '/')
    if os.path.isabs(path):
        try:
            path = os.path.relpath(path, root)
        except Exception:
            pass
    path = path.replace('\\\\', '/').lstrip('./')
    return path or None

def compact(*parts):
    text = '\\n'.join(str(p) for p in parts if p is not None and str(p).strip())
    return text[:4096]

def map_edge_kind(kind):
    value = str(kind or '').lower()
    if value in ('imports', 'imports_from', 'import'):
        return 'imports'
    if value == 'imported_by':
        return 'imported_by'
    if value in ('exports', 'export'):
        return 'exports'
    if value in ('depends_on', 'dependency'):
        return 'depends_on'
    if value in ('documents', 'documented_by'):
        return 'documents'
    return 'references'

def run(args, timeout):
    p = subprocess.run(args, cwd=root, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout, env={**os.environ, 'CI': os.environ.get('CI', '1'), 'NO_COLOR': '1'})
    if p.returncode != 0:
        msg = '\\n'.join((p.stderr or p.stdout or 'external graph command failed').splitlines()[-8:])
        raise RuntimeError(msg)
    return p

def build_codegraph():
    db_path = os.path.join(root, '.codegraph', 'codegraph.db')
    if os.path.exists(db_path):
        run(['codegraph', 'index', root, '--force', '--quiet'], 180)
    else:
        run(['codegraph', 'init', root, '-i'], 180)
    if not os.path.exists(db_path):
        raise RuntimeError('codegraph index database not found: ' + db_path)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        nodes = conn.execute('''SELECT id, kind, name, qualified_name, file_path, language, start_line, end_line,
                                      docstring, signature, visibility, is_exported, is_async, is_static
                               FROM nodes ORDER BY file_path ASC, start_line ASC LIMIT ?''', (max_nodes,)).fetchall()
        edges = conn.execute('''SELECT e.id, e.source, e.target, e.kind, e.metadata, e.line, e.col, e.provenance,
                                      s.file_path AS source_file_path, s.name AS source_name,
                                      t.file_path AS target_file_path, t.name AS target_name
                               FROM edges e
                               LEFT JOIN nodes s ON s.id = e.source
                               LEFT JOIN nodes t ON t.id = e.target
                               ORDER BY e.id ASC LIMIT ?''', (max_edges,)).fetchall()
        out_chunks = []
        for n in nodes:
            name = n['name'] or n['qualified_name'] or n['id'] or 'symbol'
            out_chunks.append({
                'key': 'codegraph:' + str(n['id']),
                'path': rel(n['file_path']) or '__codegraph__',
                'kind': 'symbol',
                'name': name,
                'language': n['language'],
                'startLine': n['start_line'],
                'endLine': n['end_line'],
                'content': compact(n['signature'] or n['qualified_name'] or name, n['docstring']),
                'keywords': compact(name, n['qualified_name'], n['kind']),
                'metadata': {'provider': 'codegraph', 'externalId': n['id'], 'symbolKind': n['kind'], 'qualifiedName': n['qualified_name'], 'visibility': n['visibility'], 'exported': bool(n['is_exported']), 'async': bool(n['is_async']), 'static': bool(n['is_static'])},
            })
        out_edges = []
        for e in edges:
            from_path = rel(e['source_file_path'])
            if not from_path:
                continue
            edge_kind = map_edge_kind(e['kind'])
            out_edges.append({
                'key': 'codegraph:' + str(e['id']),
                'fromPath': from_path,
                'toPath': rel(e['target_file_path']),
                'edgeKind': edge_kind,
                'symbol': e['target_name'],
                'source': 'codegraph',
                'metadata': {'provider': 'codegraph', 'externalSource': e['source'], 'externalTarget': e['target'], 'externalKind': e['kind'], 'sourceName': e['source_name'], 'targetName': e['target_name'], 'line': e['line'], 'column': e['col'], 'provenance': e['provenance']},
            })
        return {'provider': 'codegraph', 'chunks': out_chunks, 'edges': out_edges, 'summary': f'CodeGraph indexed {len(nodes)} symbols and {len(edges)} relationships.', 'stats': {'provider': 'codegraph', 'symbolCount': len(nodes), 'graphEdgeCount': len(edges), 'indexPath': db_path, 'remote': True, 'truncated': len(nodes) >= max_nodes or len(edges) >= max_edges}}
    finally:
        conn.close()

def line(value):
    if not value:
        return None
    import re
    m = re.search(r'L(\\d+)', str(value), re.I) or re.search(r'^(\\d+)$', str(value))
    return int(m.group(1)) if m else None

def build_graphify():
    out_root = tempfile.mkdtemp(prefix='octodeck-graphify-')
    try:
        args = ['graphify', 'extract', root, '--out', out_root, '--no-cluster', '--exclude', 'graphify-out/**']
        if not include_docs:
            args += ['--exclude', '*.md', '--exclude', '**/*.md', '--exclude', '*.mdx', '--exclude', '**/*.mdx']
        run(args, 240)
        graph_path = os.path.join(out_root, 'graphify-out', 'graph.json')
        with open(graph_path, 'r', encoding='utf-8') as f:
            raw = json.load(f)
        all_nodes = raw.get('nodes') or []
        all_links = raw.get('links') or raw.get('edges') or []
        nodes = all_nodes[:max_nodes]
        links = all_links[:max_edges]
        node_by_id = {str(n.get('id')): n for n in all_nodes if n.get('id') is not None}
        out_chunks = []
        for n in nodes:
            name = str(n.get('label') or n.get('id') or 'node')
            loc = line(n.get('source_location'))
            out_chunks.append({
                'key': 'graphify:' + str(n.get('id')),
                'path': rel(n.get('source_file')) or '__graphify__',
                'kind': 'graph',
                'name': name,
                'startLine': loc,
                'endLine': loc,
                'content': compact(name, 'type: ' + str(n.get('file_type')) if n.get('file_type') else None, 'location: ' + str(n.get('source_location')) if n.get('source_location') else None),
                'keywords': compact(name, n.get('file_type')),
                'metadata': {'provider': 'graphify', 'externalId': n.get('id'), 'fileType': n.get('file_type'), 'community': n.get('community'), 'rawLabel': n.get('label')},
            })
        out_edges = []
        for idx, e in enumerate(links):
            src = str(e.get('source') or '')
            tgt = str(e.get('target') or '')
            sn = node_by_id.get(src) or {}
            tn = node_by_id.get(tgt) or {}
            from_path = rel(sn.get('source_file') or e.get('source_file'))
            if not from_path:
                continue
            edge_kind = map_edge_kind(e.get('relation'))
            out_edges.append({
                'key': f'graphify:{idx}:{src}:{tgt}:{e.get("relation") or ""}:{e.get("source_location") or ""}',
                'fromPath': from_path,
                'toPath': rel(tn.get('source_file')),
                'edgeKind': edge_kind,
                'symbol': tn.get('label') or tgt or None,
                'source': 'graphify',
                'metadata': {'provider': 'graphify', 'externalSource': src, 'externalTarget': tgt, 'relation': e.get('relation'), 'confidence': e.get('confidence'), 'confidenceScore': e.get('confidence_score'), 'context': e.get('context'), 'weight': e.get('weight'), 'sourceLocation': e.get('source_location'), 'targetLabel': tn.get('label')},
            })
        return {'provider': 'graphify', 'chunks': out_chunks, 'edges': out_edges, 'summary': f'Graphify indexed {len(nodes)} nodes and {len(links)} relationships.', 'stats': {'provider': 'graphify', 'nodeCount': len(nodes), 'graphEdgeCount': len(links), 'remote': True, 'directed': raw.get('directed'), 'truncated': len(all_nodes) > len(nodes) or len(all_links) > len(links)}}
    finally:
        shutil.rmtree(out_root, ignore_errors=True)

try:
    result = build_codegraph() if provider == 'codegraph' else build_graphify()
    print(json.dumps(result, ensure_ascii=False))
except Exception as exc:
    print(json.dumps({'error': str(exc)}, ensure_ascii=False))
    sys.exit(1)
PY`;
}

function compactExternalChunkContent(parts: Array<unknown>): string {
  return parts
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join('\n')
    .slice(0, 4096);
}

function externalToolError(err: unknown): string {
  const value = err as { message?: unknown; stderr?: unknown; stdout?: unknown };
  const output = [value.stderr, value.stdout]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join('\n')
    .split(/\r?\n/)
    .slice(-8)
    .join('\n')
    .trim();
  return output || (typeof value.message === 'string' ? value.message : String(err));
}

async function runExternalCommand(bin: string, args: string[], cwd: string, timeout: number): Promise<void> {
  try {
    await execFileAsync(bin, args, {
      cwd,
      timeout,
      maxBuffer: MAX_REMOTE_OUTPUT_BYTES,
      env: { ...process.env, CI: process.env.CI || '1', NO_COLOR: '1' },
    });
  } catch (err) {
    throw new Error(externalToolError(err));
  }
}

async function buildCodeGraphKnowledge(repo: ManagedRepo, sourceRoot: string): Promise<ExternalGraphResult> {
  const bin = getRepoKnowledgePluginBin('codegraph');
  const dbPath = path.join(sourceRoot, '.codegraph', 'codegraph.db');
  if (fs.existsSync(dbPath)) {
    await runExternalCommand(bin, ['index', sourceRoot, '--force', '--quiet'], sourceRoot, 180_000);
  } else {
    await runExternalCommand(bin, ['init', sourceRoot, '-i'], sourceRoot, 180_000);
  }
  if (!fs.existsSync(dbPath)) throw new Error(`codegraph index database not found: ${dbPath}`);

  const db = new SqliteDatabase(dbPath);
  try {
    const nodeRows = db.prepare(
      `SELECT id, kind, name, qualified_name, file_path, language, start_line, end_line,
              docstring, signature, visibility, is_exported, is_async, is_static
       FROM nodes
       ORDER BY file_path ASC, start_line ASC
       LIMIT ?`,
    ).all(MAX_EXTERNAL_GRAPH_NODES) as Array<Record<string, unknown>>;
    const edgeRows = db.prepare(
      `SELECT e.id, e.source, e.target, e.kind, e.metadata, e.line, e.col, e.provenance,
              s.file_path AS source_file_path, s.name AS source_name,
              t.file_path AS target_file_path, t.name AS target_name
       FROM edges e
       LEFT JOIN nodes s ON s.id = e.source
       LEFT JOIN nodes t ON t.id = e.target
       ORDER BY e.id ASC
       LIMIT ?`,
    ).all(MAX_EXTERNAL_GRAPH_EDGES) as Array<Record<string, unknown>>;

    const chunks = nodeRows.map((node) => {
      const filePath = normalizeRepoRelativePath(sourceRoot, node.file_path) ?? '__codegraph__';
      const name = String(node.name || node.qualified_name || node.id || 'symbol');
      const startLine = typeof node.start_line === 'number' ? node.start_line : undefined;
      const endLine = typeof node.end_line === 'number' ? node.end_line : startLine;
      return {
        id: stableChunkId(repo.id, 'symbol', `codegraph:${String(node.id)}`),
        path: filePath,
        kind: 'symbol' as const,
        name,
        language: typeof node.language === 'string' ? node.language : languageForFile(filePath),
        startLine,
        endLine,
        content: compactExternalChunkContent([
          String(node.signature || node.qualified_name || name),
          node.docstring,
        ]),
        keywords: `${name} ${String(node.qualified_name || '')} ${String(node.kind || '')}`.trim(),
        metadata: {
          provider: 'codegraph',
          externalId: node.id,
          symbolKind: node.kind,
          qualifiedName: node.qualified_name,
          visibility: node.visibility,
          exported: !!node.is_exported,
          async: !!node.is_async,
          static: !!node.is_static,
        },
      };
    });

    const edges = edgeRows
      .map((edge): Omit<RepoKnowledgeGraphEdge, 'repoId' | 'userId' | 'updatedAt'> | undefined => {
        const fromPath = normalizeRepoRelativePath(sourceRoot, edge.source_file_path);
        if (!fromPath) return undefined;
        const toPath = normalizeRepoRelativePath(sourceRoot, edge.target_file_path);
        const edgeKind = mapExternalEdgeKind(edge.kind);
        return {
          id: stableEdgeId(repo.id, edgeKind, `codegraph:${String(edge.id)}`),
          fromPath,
          toPath,
          edgeKind,
          symbol: typeof edge.target_name === 'string' ? edge.target_name : undefined,
          source: 'codegraph',
          metadata: {
            provider: 'codegraph',
            externalSource: edge.source,
            externalTarget: edge.target,
            externalKind: edge.kind,
            sourceName: edge.source_name,
            targetName: edge.target_name,
            line: edge.line,
            column: edge.col,
            provenance: edge.provenance,
            metadata: edge.metadata,
          },
        };
      })
      .filter((edge): edge is Omit<RepoKnowledgeGraphEdge, 'repoId' | 'userId' | 'updatedAt'> => !!edge);

    return {
      provider: 'codegraph',
      chunks,
      edges,
      summary: `CodeGraph indexed ${nodeRows.length} symbols and ${edgeRows.length} relationships from ${repo.name}.`,
      stats: {
        provider: 'codegraph',
        symbolCount: nodeRows.length,
        graphEdgeCount: edgeRows.length,
        indexPath: dbPath,
        truncated: nodeRows.length >= MAX_EXTERNAL_GRAPH_NODES || edgeRows.length >= MAX_EXTERNAL_GRAPH_EDGES,
      },
    };
  } finally {
    (db as { close?: () => void }).close?.();
  }
}

async function buildGraphifyKnowledge(repo: ManagedRepo, sourceRoot: string, opts: ReturnType<typeof clampOptions>): Promise<ExternalGraphResult> {
  const bin = getRepoKnowledgePluginBin('graphify');
  const outRoot = path.join(DATA_DIR, 'repo-knowledge', 'external', repo.id, 'graphify');
  fs.rmSync(outRoot, { recursive: true, force: true });
  fs.mkdirSync(outRoot, { recursive: true });
  const args = [
    'extract',
    sourceRoot,
    '--out',
    outRoot,
    '--no-cluster',
    '--exclude',
    'graphify-out/**',
  ];
  const allowGraphifySemantic = process.env.REPO_KNOWLEDGE_GRAPHIFY_INCLUDE_SEMANTIC === '1';
  if (!opts.includeDocs || !allowGraphifySemantic) {
    args.push('--exclude', '*.md', '--exclude', '**/*.md', '--exclude', '*.mdx', '--exclude', '**/*.mdx');
  }
  await runExternalCommand(bin, args, sourceRoot, 240_000);
  const graphPath = path.join(outRoot, 'graphify-out', 'graph.json');
  const raw = JSON.parse(fs.readFileSync(graphPath, 'utf8')) as {
    nodes?: Array<Record<string, unknown>>;
    edges?: Array<Record<string, unknown>>;
    links?: Array<Record<string, unknown>>;
    directed?: boolean;
  };
  const nodeRows = (raw.nodes ?? []).slice(0, MAX_EXTERNAL_GRAPH_NODES);
  const linkRows = (raw.links ?? raw.edges ?? []).slice(0, MAX_EXTERNAL_GRAPH_EDGES);
  const nodeById = new Map<string, Record<string, unknown>>();
  for (const node of raw.nodes ?? []) {
    if (typeof node.id === 'string') nodeById.set(node.id, node);
  }

  const chunks = nodeRows
    .map((node) => {
      const filePath = normalizeRepoRelativePath(sourceRoot, node.source_file) ?? '__graphify__';
      const line = parseLineLocation(node.source_location);
      const name = String(node.label || node.id || 'node');
      return {
        id: stableChunkId(repo.id, 'graph', `graphify:${String(node.id)}`),
        path: filePath,
        kind: 'graph' as const,
        name,
        language: languageForFile(filePath),
        startLine: line,
        endLine: line,
        content: compactExternalChunkContent([
          name,
          typeof node.file_type === 'string' ? `type: ${node.file_type}` : undefined,
          typeof node.source_location === 'string' ? `location: ${node.source_location}` : undefined,
        ]),
        keywords: `${name} ${String(node.file_type || '')}`.trim(),
        metadata: {
          provider: 'graphify',
          externalId: node.id,
          fileType: node.file_type,
          community: node.community,
          rawLabel: node.label,
        },
      };
    });

  const edges = linkRows
    .map((link, index): Omit<RepoKnowledgeGraphEdge, 'repoId' | 'userId' | 'updatedAt'> | undefined => {
      const sourceId = String(link.source || '');
      const targetId = String(link.target || '');
      const sourceNode = nodeById.get(sourceId);
      const targetNode = nodeById.get(targetId);
      const fromPath = normalizeRepoRelativePath(sourceRoot, sourceNode?.source_file ?? link.source_file);
      if (!fromPath) return undefined;
      const toPath = normalizeRepoRelativePath(sourceRoot, targetNode?.source_file);
      const edgeKind = mapExternalEdgeKind(link.relation);
      return {
        id: stableEdgeId(repo.id, edgeKind, `graphify:${index}:${sourceId}:${targetId}:${String(link.relation || '')}:${String(link.source_location || '')}`),
        fromPath,
        toPath,
        edgeKind,
        symbol: typeof targetNode?.label === 'string' ? targetNode.label : targetId || undefined,
        source: 'graphify',
        metadata: {
          provider: 'graphify',
          externalSource: sourceId,
          externalTarget: targetId,
          relation: link.relation,
          confidence: link.confidence,
          confidenceScore: link.confidence_score,
          context: link.context,
          weight: link.weight,
          sourceLocation: link.source_location,
          targetLabel: targetNode?.label,
        },
      };
    })
    .filter((edge): edge is Omit<RepoKnowledgeGraphEdge, 'repoId' | 'userId' | 'updatedAt'> => !!edge);

  return {
    provider: 'graphify',
    chunks,
    edges,
    summary: `Graphify indexed ${nodeRows.length} nodes and ${linkRows.length} relationships from ${repo.name}.`,
    stats: {
      provider: 'graphify',
      nodeCount: nodeRows.length,
      graphEdgeCount: linkRows.length,
      graphPath,
      directed: raw.directed,
      truncated: (raw.nodes?.length ?? 0) > nodeRows.length || (raw.links ?? raw.edges ?? []).length > linkRows.length,
    },
  };
}

async function buildExternalGraphKnowledge(
  provider: 'graphify' | 'codegraph',
  repo: ManagedRepo,
  sourceRoot: string,
  opts: ReturnType<typeof clampOptions>,
): Promise<ExternalGraphResult> {
  return provider === 'codegraph'
    ? buildCodeGraphKnowledge(repo, sourceRoot)
    : buildGraphifyKnowledge(repo, sourceRoot, opts);
}

function parseRemoteExternalGraphResult(repo: ManagedRepo, raw: Record<string, unknown>): ExternalGraphResult {
  if (typeof raw.error === 'string' && raw.error) throw new Error(raw.error);
  const provider = raw.provider === 'codegraph' ? 'codegraph' : 'graphify';
  const chunks = Array.isArray(raw.chunks)
    ? raw.chunks.map((item): Omit<RepoKnowledgeChunk, 'repoId' | 'userId' | 'updatedAt'> | undefined => {
      if (!item || typeof item !== 'object') return undefined;
      const chunk = item as Record<string, unknown>;
      const kind: RepoKnowledgeChunkKind = chunk.kind === 'symbol' ? 'symbol' : 'graph';
      const key = typeof chunk.key === 'string' ? chunk.key : `${provider}:${String(chunk.path || '')}:${String(chunk.name || '')}`;
      return {
        id: stableChunkId(repo.id, kind, key),
        path: typeof chunk.path === 'string' && chunk.path ? chunk.path : `__${provider}__`,
        kind,
        name: typeof chunk.name === 'string' ? chunk.name : undefined,
        language: typeof chunk.language === 'string' ? chunk.language : languageForFile(typeof chunk.path === 'string' ? chunk.path : ''),
        startLine: typeof chunk.startLine === 'number' ? chunk.startLine : undefined,
        endLine: typeof chunk.endLine === 'number' ? chunk.endLine : undefined,
        content: typeof chunk.content === 'string' ? chunk.content : '',
        keywords: typeof chunk.keywords === 'string' ? chunk.keywords : undefined,
        metadata: chunk.metadata && typeof chunk.metadata === 'object' ? chunk.metadata as Record<string, unknown> : { provider },
      };
    }).filter((chunk): chunk is Omit<RepoKnowledgeChunk, 'repoId' | 'userId' | 'updatedAt'> => !!chunk)
    : [];
  const edges = Array.isArray(raw.edges)
    ? raw.edges.map((item): Omit<RepoKnowledgeGraphEdge, 'repoId' | 'userId' | 'updatedAt'> | undefined => {
      if (!item || typeof item !== 'object') return undefined;
      const edge = item as Record<string, unknown>;
      if (typeof edge.fromPath !== 'string' || !edge.fromPath) return undefined;
      const edgeKind = mapExternalEdgeKind(edge.edgeKind);
      const key = typeof edge.key === 'string' ? edge.key : `${provider}:${edge.fromPath}:${String(edge.toPath || '')}:${edgeKind}:${String(edge.symbol || '')}`;
      return {
        id: stableEdgeId(repo.id, edgeKind, key),
        fromPath: edge.fromPath,
        toPath: typeof edge.toPath === 'string' && edge.toPath ? edge.toPath : undefined,
        edgeKind,
        symbol: typeof edge.symbol === 'string' ? edge.symbol : undefined,
        packageName: typeof edge.packageName === 'string' ? edge.packageName : undefined,
        source: typeof edge.source === 'string' ? edge.source : provider,
        metadata: edge.metadata && typeof edge.metadata === 'object' ? edge.metadata as Record<string, unknown> : { provider },
      };
    }).filter((edge): edge is Omit<RepoKnowledgeGraphEdge, 'repoId' | 'userId' | 'updatedAt'> => !!edge)
    : [];
  return {
    provider,
    chunks,
    edges,
    summary: typeof raw.summary === 'string' ? raw.summary : `${provider} indexed ${chunks.length} chunks and ${edges.length} edges.`,
    stats: raw.stats && typeof raw.stats === 'object' ? raw.stats as Record<string, unknown> : { provider, remote: true },
  };
}

async function buildExternalGraphKnowledgeOnDevice(
  provider: 'graphify' | 'codegraph',
  repo: ManagedRepo,
  deviceLinkId: string,
  repoPath: string,
  opts: ReturnType<typeof clampOptions>,
): Promise<ExternalGraphResult> {
  const session = getSession(deviceLinkId);
  if (!session || session.state !== 'open') throw new Error('Device is offline');
  const result = await invokeRemoteTool(session, {
    linkId: deviceLinkId,
    toolName: 'Bash',
    input: { command: remoteExternalGraphCommand(provider, repoPath, opts) },
    cwd: repoPath,
    timeoutMs: 300_000,
    maxOutputBytes: MAX_REMOTE_OUTPUT_BYTES,
  });
  if (!result.ok) throw new Error(result.error || `Failed to run ${provider} on device`);
  const stdout = typeof (result.result as { stdout?: unknown } | null)?.stdout === 'string'
    ? (result.result as { stdout: string }).stdout
    : '';
  const parsed = JSON.parse(stdout || '{}') as Record<string, unknown>;
  return parseRemoteExternalGraphResult(repo, parsed);
}

const AGENT_KNOWLEDGE_TIMEOUT_MS = 15 * 60_000;

function buildAgentKnowledgePrompt(
  repo: ManagedRepo,
  opts: ReturnType<typeof clampOptions>,
  files: Array<{ path: string; size: number; language?: string }>,
): string {
  if (opts.agentPrompt) return opts.agentPrompt;
  const topList = files.slice(0, 120)
    .map((f) => `- ${f.path}${f.language ? `  [${f.language}]` : ''}  (${f.size}B)`)
    .join('\n');
  return `你是仓库知识图谱构建专家。请用仓库根目录下全部代码 / 文档生成结构化知识图谱，\
并在最后用一个 JSON 代码块（\`\`\`json ... \`\`\`）输出结果，不要有额外文字。

## 执行策略（按优先级）
1. **builtin-graph-scan（强烈推荐）**：项目自带确定性 Python 扫描脚本（零依赖、python3>=3.8），直接调用：
   \`\`\`bash
   OUT_DIR="<repo>/.octodeck/knowledge"
   mkdir -p "$OUT_DIR"
   <builtin-graph-scan 或 builtin_graph_scan.py 路径> --repo . --output-dir "$OUT_DIR" --max-files 1500 --pretty
   \`\`\`
   脚本完成后会在 $OUT_DIR 生成 chunks.json / edges.json / stats.json / summary.md / run.log 五件套。
2. **外挂 graph Skill**（repo-knowledge-graph / graphify / codegraph）：如已挂载，按各自说明执行并把产物对齐为上面 5 文件格式。
3. **手工流程（兜底）**：Bash find + 语言正则提取 + LLM 语义补齐。

## 上下文
- 仓库名: ${repo.name}
- 仓库 ID: ${repo.id}
- 工作目录: 即为仓库源码根
- 扫描到的入口文件（仅列前 ${Math.min(files.length, 120)} 个，完整文件列表请自行遍历工作区）:
${topList}

## 可选外挂 Skill
如果挂载了 repo-knowledge-graph / graphify / codegraph 等 Skill，请优先调用；\
builtin-graph-scan 未安装时也可以用 Bash + 语言分析 + LLM 语义理解自行生成。

## 输出 JSON 规范（根级对象，字段都可省略但建议尽量填充）
{
  "summary": "一句话 + 小节的仓库语义摘要",
  "chunks": [
    {
      "kind": "symbol" | "dependency" | "doc" | "graph",
      "key": "本 chunk 的稳定唯一标识字符串（路径+符号/标题等，会用来生成稳定 chunk_id）",
      "path": "相对仓库根的文件路径",
      "name": "符号名或标题",
      "language": "ts/tsx/py/go/rs/.../markdown",
      "startLine": 1,
      "endLine": 40,
      "content": "chunk 文本内容",
      "keywords": "空格分隔的关键词",
      "metadata": { "任意字段": "任意值" }
    }
  ],
  "edges": [
    {
      "edgeKind": "imports" | "imported_by" | "depends_on" | "exports" | "documents" | "references",
      "key": "本边的稳定唯一标识",
      "fromPath": "起点相对路径（必填）",
      "toPath": "终点相对路径（选填）",
      "symbol": "边关联的符号名（选填）",
      "packageName": "当 fromPath 依赖第三方包时填包名（选填）",
      "source": "来源标识，比如 'agent' / 'agent:repo-knowledge-graph-skill'",
      "metadata": { "任意字段": "任意值" }
    }
  ],
  "stats": { "任意指标": "任意值" }
}

要求:
1. chunks 覆盖关键类 / 函数 / 模块 / 配置 / 文档章节，数量 200~800；
2. edges 覆盖 import、依赖、调用、文档交叉引用、模块关系，数量 200~2000；
3. 只输出一个 JSON 代码块，不要额外说明文字。`;
}

type AgentGraphRawChunk = {
  kind?: string;
  key?: string;
  path?: string;
  name?: string;
  language?: string;
  startLine?: number;
  endLine?: number;
  content?: string;
  keywords?: string;
  metadata?: Record<string, unknown>;
};

type AgentGraphRawEdge = {
  edgeKind?: string;
  key?: string;
  fromPath?: string;
  toPath?: string;
  symbol?: string;
  packageName?: string;
  source?: string;
  metadata?: Record<string, unknown>;
};

function sanitizeChunkKind(kind: unknown): RepoKnowledgeChunkKind {
  switch (kind) {
    case 'symbol': case 'dependency': case 'doc': case 'graph': case 'overview': case 'file':
      return kind;
    default:
      return 'graph';
  }
}

function sanitizeEdgeKind(kind: unknown): RepoKnowledgeGraphEdgeKind {
  switch (kind) {
    case 'imports': case 'imported_by': case 'depends_on': case 'exports': case 'documents': case 'references':
      return kind;
    default:
      return 'references';
  }
}

function extractLastJsonBlock(text: string): unknown {
  const open = text.lastIndexOf('```json');
  if (open >= 0) {
    const start = open + 7;
    const close = text.indexOf('```', start);
    const body = close >= 0 ? text.slice(start, close) : text.slice(start);
    return JSON.parse(body.trim());
  }
  const bare = text.trim();
  if (bare.startsWith('{')) return JSON.parse(bare);
  throw new Error('Agent 未输出 ```json 代码块');
}

/** 生成 32 字节十六进制一次性上传 token。 */
function generateUploadToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

function appendTimeline(runId: string | undefined, userId: string, kind: RepoKnowledgeRunMilestone['kind'], label: string, detail?: Record<string, unknown>) {
  if (!runId) return;
  try {
    appendRepoKnowledgeRunTimeline(runId, userId, { kind, label, detail });
  } catch {
    // ignore — timeline 写入失败不影响主流程
  }
}

/**
 * 通过 agent.link 在 device 上拉起一个 task agent：
 *   - daemon 会基于 RegisteredGroup.repoGitUrl / repoDevicePath 自动 resolve 为 git worktree / 目录快照
 *   - 通过 env 注入上传地址 / 一次性 token / 输出目录
 *   - 把 onOutput 的流式事件写进 timeline
 *   - 完成时若 run.filesUploadedAt 为空，主动通过 Read/Bash 工具拉回 .octodeck/knowledge/*
 */
async function runDeviceKnowledgeAgent(
  repo: ManagedRepo,
  ownerUserId: string,
  opts: ReturnType<typeof clampOptions>,
  files: SourceFile[],
): Promise<ExternalGraphResult> {
  const linkId = opts.executionDeviceLinkId ?? (repo.kind === 'device_path' ? repo.deviceLinkId : undefined);
  if (!linkId) throw new Error('agent provider (device): execution device link id 未指定');
  const session = getSession(linkId);
  if (!session || session.state !== 'open') throw new Error(`Device is offline: ${linkId}`);
  const home = getUserHomeGroup(ownerUserId);
  const ownerHomeFolder = home?.folder ?? 'main';
  const runId = opts.runId;
  const serverBase = opts.serverBaseUrl ?? OCTODECK_PUBLIC_BASE_URL;

  // ── 一次性上传 token ──────────────────────────────────────────────────────
  const uploadToken = generateUploadToken();
  const uploadTokenHash = crypto.createHash('sha256').update(uploadToken).digest('hex');
  const uploadUrl = `${serverBase}/api/repos/knowledge/runs/${encodeURIComponent(runId ?? '')}/upload`;
  const OUTPUT_DIR = '.octodeck/knowledge';
  if (runId) {
    updateRepoKnowledgeRun(runId, ownerUserId, {
      uploadTokenHash,
      enabledSkills: opts.enabledSkills,
      executionDeviceLinkId: linkId,
    });
  }
  appendTimeline(runId, ownerUserId, 'milestone', `下发 agent.run.request 到 device (${linkId})`, {
    uploadUrl,
    outputDir: OUTPUT_DIR,
    enabledSkills: opts.enabledSkills,
    timeoutMs: opts.agentTimeoutMs,
  });

  // ── 构造 Repo spec：让 daemon 以 worktree 打开 git / 目录快照 ─────────────────
  const agentGroup: RegisteredGroup = {
    name: `RepoKnowledge Agent: ${repo.name}`,
    folder: ownerHomeFolder,
    added_at: new Date().toISOString(),
    containerConfig: { timeout: opts.agentTimeoutMs },
    executionMode: 'host',
    created_by: ownerUserId,
    is_home: false,
    repoId: repo.id,
    repoGitUrl: repo.kind === 'git' ? repo.gitUrl : undefined,
    repoMainBranch: repo.kind === 'git' ? repo.mainBranch : undefined,
    repoDevicePath: repo.kind === 'device_path' ? repo.devicePath : undefined,
    visibleRepoMode: 'selected',
    visibleRepoIds: [repo.id],
    executionNode: linkId,
  };

  const fileIndex = files.map((f) => ({ path: f.path, size: f.size, language: languageForFile(f.path) ?? undefined }));
  const prompt = buildDeviceAgentPrompt(repo, opts, fileIndex, {
    uploadUrl,
    uploadToken,
    outputDir: OUTPUT_DIR,
  });

  const customEnv: Record<string, string> = {
    OCTODECK_PUBLIC_BASE_URL: OCTODECK_PUBLIC_BASE_URL,
    OCTODECK_REPO_KNOWLEDGE_OUTPUT_DIR: OUTPUT_DIR,
    OCTODECK_REPO_KNOWLEDGE_UPLOAD_URL: uploadUrl,
    OCTODECK_REPO_KNOWLEDGE_UPLOAD_TOKEN: uploadToken,
    OCTODECK_REPO_ID: repo.id,
    OCTODECK_REPO_NAME: repo.name,
    OCTODECK_ENABLED_SKILLS: opts.enabledSkills.length > 0 ? opts.enabledSkills.join(',') : '',
  };

  const cfg: HostCliDriverConfig = {
    backendId: 'octodeck-repo-knowledge',
    // 即使 fallback 到 server-side（理论不会到这里），也要有 resolveBinary
    resolveBinary: () => null,
    // 走 agent.runtime 模式时由 daemon 选 binary（parseAgentLinkTarget 指定 agentClientId）
    buildArgv: () => [],
    outputProtocol: 'jsonline-stream-json',
    timeoutMs: opts.agentTimeoutMs,
    maxOutputBytes: 10 * 1024 * 1024,
    envOverrides: customEnv,
    runtime: 'local-device',
  };
  const input: ContainerInput = {
    prompt,
    groupFolder: ownerHomeFolder,
    chatJid: `system:repo-knowledge:${repo.id}`,
    isMain: false,
    isHome: false,
    isAdminHome: false,
    sessionId: undefined,
    isScheduledTask: true,
    scheduledTaskHasWorkspace: true,
    taskRunId: runId,
    messageTaskId: runId,
  };

  let streamedOutputText = '';
  const onOutput = async (out: ContainerOutput): Promise<void> => {
    if (out.status === 'stream') {
      const ev = out.streamEvent;
      if (ev && runId) {
        try {
          switch (ev.eventType) {
            case 'tool_use_start':
              appendTimeline(runId, ownerUserId, 'tool_start', `tool_use_start: ${ev.toolName}`, {
                tool: ev.toolName,
                summary: typeof ev.toolInputSummary === 'string' ? ev.toolInputSummary.slice(0, 500) : undefined,
              });
              break;
            case 'tool_use_end':
              appendTimeline(runId, ownerUserId, 'tool_end', `tool_use_end: ${ev.toolName}`, {
                tool: ev.toolName,
                isError: typeof ev.statusText === 'string' && /error|fail/i.test(ev.statusText) ? ev.statusText.slice(0, 200) : undefined,
              });
              break;
            case 'thinking_delta':
              // thinking 不逐条刷 timeline，避免 500 条上限过快耗尽
              break;
            case 'text_delta':
              streamedOutputText += typeof ev.text === 'string' ? ev.text : '';
              break;
            default:
              appendTimeline(runId, ownerUserId, 'agent_event', ev.eventType, {
                text: typeof ev.text === 'string' ? ev.text.slice(0, 500) : undefined,
                sessionId: ev.sessionId,
              });
          }
        } catch {
          // ignore
        }
      } else if (ev && ev.eventType === 'text_delta' && typeof ev.text === 'string') {
        streamedOutputText += ev.text;
      }
    }
  };

  let output: ContainerOutput;
  try {
    output = await runViaAgentLink(
      {
        group: agentGroup,
        input,
        executionMode: 'host',
        onProcess: () => undefined,
        onOutput,
        signal: undefined,
      },
      cfg,
      linkId,
    );
  } catch (err) {
    appendTimeline(runId, ownerUserId, 'error', 'agent.run 请求失败', {
      error: err instanceof Error ? err.message : String(err),
    });
    throw new Error(`agent provider (device): 启动失败: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (output.status !== 'success') {
    appendTimeline(runId, ownerUserId, 'error', 'agent 任务失败', {
      error: output.error,
      result: typeof output.result === 'string' ? output.result.slice(0, 1000) : undefined,
    });
    throw new Error(`agent provider (device): 任务失败: ${output.error ?? output.result ?? 'unknown'}`);
  }

  const finalText = streamedOutputText || (typeof output.result === 'string' ? output.result : '');

  // ── 检查是否已主动上传；否则 fallback pull ────────────────────────────────
  const runAfter = runId ? getRepoKnowledgeRun(runId, ownerUserId) : undefined;
  const alreadyUploaded = !!runAfter?.filesUploadedAt;
  appendTimeline(runId, ownerUserId, 'milestone', alreadyUploaded ? 'agent 已主动上传产物' : 'agent 完成，开始 pull 产物', {
    usage: output.streamEvent?.usage ?? undefined,
  });

  if (!alreadyUploaded) {
    const pulled = await pullKnowledgeOutputsOnDevice(linkId, OUTPUT_DIR);
    if (pulled) {
      appendTimeline(runId, ownerUserId, 'upload', 'fallback pull 完成，入库中', {
        chunks: pulled.chunks.length,
        edges: pulled.edges.length,
      });
      const runRow = runId ? getRepoKnowledgeRun(runId, ownerUserId) : undefined;
      // 把 runId 记录到 run stats；ingest 内部通过 run.filesUploadedAt 判断是否需要写上传完成时间，但我们 fallback pull 里手动改
      if (runRow) {
        ingestRepoKnowledgeUpload(repo, ownerUserId, {
          chunks: pulled.chunks.map((c, idx): {
            key: string; path: string; kind: RepoKnowledgeChunkKind; name?: string; language?: string;
            startLine?: number; endLine?: number; content: string; keywords?: string; metadata?: Record<string, unknown>;
          } => ({
            key: typeof c.key === 'string' && c.key ? c.key : `pull:chunk:${idx}`,
            path: typeof c.path === 'string' && c.path ? c.path : '__agent__',
            kind: sanitizeChunkKind(c.kind),
            name: c.name,
            language: c.language,
            startLine: c.startLine,
            endLine: c.endLine,
            content: typeof c.content === 'string' ? c.content : '',
            keywords: c.keywords,
            metadata: c.metadata,
          })),
          edges: pulled.edges.map((e, idx): {
            key: string; fromPath: string; toPath?: string; edgeKind: RepoKnowledgeGraphEdgeKind;
            symbol?: string; packageName?: string; source?: string; metadata?: Record<string, unknown>;
          } => ({
            key: typeof e.key === 'string' && e.key ? e.key : `pull:edge:${idx}`,
            fromPath: typeof e.fromPath === 'string' ? e.fromPath : '',
            toPath: e.toPath,
            edgeKind: sanitizeEdgeKind(e.edgeKind),
            symbol: e.symbol,
            packageName: e.packageName,
            source: e.source,
            metadata: e.metadata,
          })),
          summary: pulled.summary,
          stats: pulled.stats,
        });
        updateRepoKnowledgeRun(runId!, ownerUserId, {
          filesUploadedAt: new Date().toISOString(),
          error: null,
        });
      }
      return {
        provider: 'agent',
        chunks: normalizeRawChunks(repo, pulled.chunks, 'agent'),
        edges: normalizeRawEdges(repo, pulled.edges, 'agent'),
        summary: pulled.summary ?? `Device agent (fallback pull) 生成 ${pulled.chunks.length} chunks + ${pulled.edges.length} edges.`,
        stats: {
          provider: 'agent',
          delivery: 'fallback-pull',
          chunkCount: pulled.chunks.length,
          edgeCount: pulled.edges.length,
          ...(pulled.stats ?? {}),
        },
      };
    }
    // fallback pull 也没找到文件，回退到解析回复里的最后一个 JSON 块
    appendTimeline(runId, ownerUserId, 'warn', 'fallback pull 未发现产物，尝试解析回复 JSON');
  }

  // 已主动上传：直接从 run.stats 读取 summary 即可，后续调用者会把 repoKnowledgeChunks 已入库的条目（builtin +
  // graph 其他来源）作为 base，ExternalGraphResult 语义是"再加新条目"—— 这里给一个空集，避免把已经 ingest 的 chunks 再次双写。
  if (alreadyUploaded) {
    return {
      provider: 'agent',
      chunks: [],
      edges: [],
      summary: `Device agent 主动上传成功。`,
      stats: { provider: 'agent', delivery: 'agent-upload' },
    };
  }

  // 最后兜底：解析 agent 回复文本中最后一个 ```json``` 块
  const parsed = extractLastJsonBlock(finalText) as Record<string, unknown>;
  if (!parsed || typeof parsed !== 'object') throw new Error('agent provider (device): 回复中未找到 JSON 且未上传产物');
  return extractExternalGraphFromJsonReply(repo, parsed);
}

/**
 * 在 device 上通过 Bash/Read 工具扫描 OUTPUT_DIR 下的产物文件并拉回。
 * 返回 null 表示"完全没找到文件"。
 */
async function pullKnowledgeOutputsOnDevice(
  linkId: string,
  outputDir: string,
): Promise<{
  chunks: AgentGraphRawChunk[];
  edges: AgentGraphRawEdge[];
  summary?: string;
  stats?: Record<string, unknown>;
  runLog?: string;
} | null> {
  const session = getSession(linkId);
  if (!session || session.state !== 'open') return null;
  // ── 列出目录下文件（用 Bash ls + jq 或直接 python cat）
  const glob = await invokeRemoteTool(session, {
    linkId,
    toolName: 'Bash',
    input: {
      command: `python3 - <<'PY'\nimport json, os\nbase = os.path.abspath(${JSON.stringify(outputDir)})\nout=[]\nif os.path.isdir(base):\n    for name in sorted(os.listdir(base)):\n        p = os.path.join(base, name)\n        if os.path.isfile(p):\n            out.append({'name': name, 'size': os.path.getsize(p)})\nprint(json.dumps(out))\nPY`,
    },
    cwd: 'octodeck-tmp://repo-knowledge',
    timeoutMs: 30_000,
    maxOutputBytes: 2 * 1024 * 1024,
  });
  if (!glob.ok) return null;
  const stdout = (glob.result as { stdout?: unknown } | null)?.stdout;
  let files: Array<{ name: string; size?: number }> = [];
  try {
    files = JSON.parse(typeof stdout === 'string' ? stdout : '[]') as typeof files;
  } catch {
    return null;
  }
  const names = new Set(files.map((f) => f.name));
  if (names.size === 0) return null;

  const readFile = async (name: string, maxBytes: number): Promise<string | null> => {
    if (!names.has(name)) return null;
    const r = await invokeRemoteTool(session, {
      linkId,
      toolName: 'Bash',
      input: {
        command: `python3 - <<'PY'\nimport json, os, sys\np = os.path.abspath(${JSON.stringify(`${outputDir}/${name}`)})\nif not os.path.isfile(p): sys.exit(0)\nwith open(p, 'r', encoding='utf-8', errors='replace') as f:\n    data = f.read()\nprint(json.dumps(data))\nPY`,
      },
      cwd: 'octodeck-tmp://repo-knowledge',
      timeoutMs: 60_000,
      maxOutputBytes: Math.max(2 * 1024 * 1024, maxBytes + 4096),
    });
    if (!r.ok) return null;
    const out = (r.result as { stdout?: unknown } | null)?.stdout;
    try {
      const v = JSON.parse(typeof out === 'string' ? out : 'null') as unknown;
      return typeof v === 'string' ? v : null;
    } catch {
      return null;
    }
  };
  const chunksRaw = await readFile('chunks.json', 64 * 1024 * 1024);
  const edgesRaw = await readFile('edges.json', 64 * 1024 * 1024);
  const summary = await readFile('summary.md', 128 * 1024);
  const statsRaw = await readFile('stats.json', 16 * 1024 * 1024);
  const runLog = await readFile('run.log', 4 * 1024 * 1024);
  if (!chunksRaw && !edgesRaw && !summary) return null;
  let chunks: AgentGraphRawChunk[] = [];
  let edges: AgentGraphRawEdge[] = [];
  let stats: Record<string, unknown> | undefined;
  if (chunksRaw) {
    try {
      const parsed = JSON.parse(chunksRaw) as unknown;
      if (Array.isArray(parsed)) chunks = parsed as AgentGraphRawChunk[];
    } catch {
      chunks = [];
    }
  }
  if (edgesRaw) {
    try {
      const parsed = JSON.parse(edgesRaw) as unknown;
      if (Array.isArray(parsed)) edges = parsed as AgentGraphRawEdge[];
    } catch {
      edges = [];
    }
  }
  if (statsRaw) {
    try {
      const parsed = JSON.parse(statsRaw) as unknown;
      if (parsed && typeof parsed === 'object') stats = parsed as Record<string, unknown>;
    } catch {
      stats = undefined;
    }
  }
  return { chunks, edges, summary: summary ?? undefined, stats, runLog: runLog ?? undefined };
}

/** 把 agent 回复的 JSON → ExternalGraphResult。 */
function extractExternalGraphFromJsonReply(
  repo: ManagedRepo,
  parsed: Record<string, unknown>,
): ExternalGraphResult {
  const rawChunks = Array.isArray(parsed.chunks) ? (parsed.chunks as AgentGraphRawChunk[]) : [];
  const chunks = normalizeRawChunks(repo, rawChunks, 'agent');
  const rawEdges = Array.isArray(parsed.edges) ? (parsed.edges as AgentGraphRawEdge[]) : [];
  const edges = normalizeRawEdges(repo, rawEdges, 'agent');
  const summary = typeof parsed.summary === 'string'
    ? parsed.summary
    : `Agent indexed ${chunks.length} chunks and ${edges.length} edges.`;
  const stats = parsed.stats && typeof parsed.stats === 'object'
    ? { ...(parsed.stats as Record<string, unknown>), provider: 'agent', chunkCount: chunks.length, edgeCount: edges.length }
    : { provider: 'agent', chunkCount: chunks.length, edgeCount: edges.length };
  return { provider: 'agent', chunks, edges, summary, stats };
}

function normalizeRawChunks(
  repo: ManagedRepo,
  raw: AgentGraphRawChunk[],
  sourcePrefix: 'agent',
): Array<Omit<RepoKnowledgeChunk, 'repoId' | 'userId' | 'updatedAt'>> {
  type _Out = Omit<RepoKnowledgeChunk, 'repoId' | 'userId' | 'updatedAt'>;
  const out: _Out[] = [];
  const seen = new Set<string>();
  for (const [i, item] of raw.entries()) {
    if (!item || typeof item !== 'object') continue;
    const kind = sanitizeChunkKind(item.kind);
    const key = typeof item.key === 'string' && item.key ? item.key : `${kind}:${item.path ?? ''}:${item.name ?? i}`;
    const p = typeof item.path === 'string' && item.path ? item.path : '__agent__';
    const content = typeof item.content === 'string' ? item.content : '';
    if (!content && !(typeof item.name === 'string' && item.name)) continue;
    const id = stableChunkId(repo.id, kind, `agent:${key}`);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      path: p,
      kind,
      name: typeof item.name === 'string' ? item.name : undefined,
      language: typeof item.language === 'string' ? item.language : p ? (languageForFile(p) ?? undefined) : undefined,
      startLine: typeof item.startLine === 'number' ? item.startLine : undefined,
      endLine: typeof item.endLine === 'number' ? item.endLine : undefined,
      content,
      keywords: typeof item.keywords === 'string' ? item.keywords : `${p} ${item.name ?? ''}`.trim(),
      metadata: item.metadata && typeof item.metadata === 'object' ? { ...item.metadata, provider: 'agent' } : { provider: 'agent', source: sourcePrefix },
    });
  }
  return out;
}

function normalizeRawEdges(
  repo: ManagedRepo,
  raw: AgentGraphRawEdge[],
  sourcePrefix: 'agent',
): Array<Omit<RepoKnowledgeGraphEdge, 'repoId' | 'userId' | 'updatedAt'>> {
  type _Out = Omit<RepoKnowledgeGraphEdge, 'repoId' | 'userId' | 'updatedAt'>;
  const out: _Out[] = [];
  const seen = new Set<string>();
  for (const [i, item] of raw.entries()) {
    if (!item || typeof item !== 'object') continue;
    const edgeKind = sanitizeEdgeKind(item.edgeKind);
    const fromPath = typeof item.fromPath === 'string' ? item.fromPath : '';
    if (!fromPath) continue;
    const key = typeof item.key === 'string' && item.key
      ? item.key
      : `${edgeKind}:${fromPath}:${item.toPath ?? ''}:${item.symbol ?? i}`;
    const id = stableEdgeId(repo.id, edgeKind, `agent:${key}`);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      fromPath,
      toPath: typeof item.toPath === 'string' ? item.toPath : undefined,
      edgeKind,
      symbol: typeof item.symbol === 'string' ? item.symbol : undefined,
      packageName: typeof item.packageName === 'string' ? item.packageName : undefined,
      source: typeof item.source === 'string' && item.source ? `agent:${item.source}` : 'agent',
      metadata: item.metadata && typeof item.metadata === 'object' ? { ...item.metadata, provider: 'agent' } : { provider: 'agent', source: sourcePrefix },
    });
  }
  return out;
}

/**
 * Device 端 task agent 的提示词：
 *   - 告知输出目录、上传 URL/Token
 *   - 列出推荐 skills（builtin-graph-scan 等）
 *   - 明确鼓励把结果落盘并主动上传；提示"最后也可以用一个 ```json``` 块兜底"
 */
function buildDeviceAgentPrompt(
  repo: ManagedRepo,
  opts: ReturnType<typeof clampOptions>,
  files: Array<{ path: string; size: number; language?: string }>,
  env: { uploadUrl: string; uploadToken: string; outputDir: string },
): string {
  if (opts.agentPrompt) return opts.agentPrompt;
  const topList = files.slice(0, 120)
    .map((f) => `- ${f.path}${f.language ? `  [${f.language}]` : ''}  (${f.size}B)`)
    .join('\n');
  const skillList = opts.enabledSkills.length > 0
    ? opts.enabledSkills.map((s) => `- ${s}`).join('\n')
    : '- builtin-graph-scan（Python 内置：Bash 调脚本，输出 chunks.json/edges.json/stats.json/summary.md/run.log）';
  return [
    '你是仓库知识图谱构建专家。当前工作区即对应仓库源码根（daemon 已基于 git worktree / 设备目录快照准备好）。',
    '你的任务是：遍历源码和文档，生成 chunks（符号/文档/依赖/文件摘要）与 edges（import/dependency/文档引用/调用等），',
    `并把产物写入 \`${env.outputDir}/\` 目录并主动上传到服务端。`,
    '',
    '## 执行策略（三选一，按优先级从高到低）',
    '1. **builtin-graph-scan（默认，强烈推荐）**：项目自带的确定性 Python 扫描脚本，纯标准库（python3>=3.8，零依赖）。',
    '   从服务端拉取脚本到本地临时目录后执行（下方命令**真实可直接复制运行**）：',
    '   ```bash',
    `   BUILTIN_SCRIPT_URL=\${OCTODECK_PUBLIC_BASE_URL%/}/api/repos/knowledge/builtin-script`,
    `   BUILTIN_SCRIPT_PATH="/tmp/builtin_graph_scan_\$(date +%s).py"`,
    '   echo "下载 builtin-graph-scan 脚本到 $BUILTIN_SCRIPT_PATH"',
    '   if ! curl -fsSL --max-time 30 "$BUILTIN_SCRIPT_URL" -o "$BUILTIN_SCRIPT_PATH"; then',
    `     echo "[WARN] curl 下载脚本失败，尝试用 wget"; wget -q --timeout=30 -O "$BUILTIN_SCRIPT_PATH" "$BUILTIN_SCRIPT_URL" || echo "[ERROR] 无法下载脚本，跳过第 1 级"`,
    '   fi',
    `   OUT_DIR="${env.outputDir}"`,
    '   mkdir -p "$OUT_DIR"',
    `   if [ -s "$BUILTIN_SCRIPT_PATH" ] && python3 -c "import py_compile; py_compile.compile('$BUILTIN_SCRIPT_PATH', doraise=True)" 2>/dev/null; then`,
    '     python3 "$BUILTIN_SCRIPT_PATH" \\',
    '       --repo . \\',
    `       --output-dir "$OUT_DIR" \\`,
    `       --repo-name "${repo.name.replace(/"/g, '\\"')}" \\`,
    '       --max-files 2000 \\',
    '       --max-output-mb 32 \\',
    '       --pretty \\',
    '       2>&1 | tee -a "$OUT_DIR/run.log"',
    '     SCAN_EXIT="${PIPESTATUS[0]}"',
    '     echo "builtin-graph-scan exit=$SCAN_EXIT"',
    '   else',
    '     echo "[ERROR] 脚本下载损坏或语法异常，回退到第 2/3 级"',
    '     SCAN_EXIT=1',
    '   fi',
    '   ```',
    '   - 变量 `OCTODECK_PUBLIC_BASE_URL` 已由服务端通过环境变量注入（如未设置请自行补全）。',
    '   - 执行成功（SCAN_EXIT=0）后请直接跳到下方「输出目录与上传」执行 curl 上传；失败则回退到下一级。',
    '',
    '2. **其它外挂 graph skill**（graphify / codegraph / 自定义）：如检测到已安装，按各自说明调用，最终把产物对齐写入 `chunks.json / edges.json / stats.json / summary.md` 四个文件。',
    '',
    '3. **手工流程（仅当以上两者均不可用时才回退）**：用 Bash find + grep/AST 脚本自行生成 chunks/edges（格式见下）。',
    '',
    `## 仓库上下文`,
    `- 仓库名: ${repo.name}`,
    `- 仓库 ID: ${repo.id}`,
    `- 仓库源: ${repo.kind === 'git' ? (repo.gitUrl ?? '') : (repo.devicePath ?? '')}`,
    `- 入口文件预览（前 ${Math.min(files.length, 120)} 个，完整列表请自行遍历工作区）:`,
    topList,
    '',
    `## 输出目录与上传`,
    `- 输出目录（请自行 mkdir -p）：\`${env.outputDir}/\``,
    '  - `chunks.json`  — JSON 数组，元素形如 {key, path, kind, name, language, startLine, endLine, content, keywords, metadata}',
    '  - `edges.json`   — JSON 数组，元素形如 {key, fromPath, toPath?, edgeKind, symbol?, packageName?, source?, metadata?}',
    '  - `summary.md`  — 人类可读的仓库语义摘要',
    '  - `stats.json`  — 统计指标（chunk/edge 数量、语言分布、耗时、跳过文件数等）',
    '  - `run.log`     — 执行过程日志，由 skill 或你的 Bash 输出写入',
    `- chunk.kind 枚举：overview | file | symbol | dependency | doc | graph`,
    `- edge.edgeKind 枚举：imports | imported_by | depends_on | exports | documents | references`,
    `- 落盘完成后，用 Bash curl 把产物 multipart POST 到服务端（下方是**真实可直接执行**的完整命令，直接 copy 运行即可）：`,
    '  ```bash',
    `  OUT_DIR="${env.outputDir}"`,
    `  UPLOAD_URL="${env.uploadUrl}"`,
    `  TOKEN="${env.uploadToken}"`,
    '  curl -sS --max-time 300 --retry 2 --retry-delay 3 -X POST "$UPLOAD_URL" \\',
    '       -H "Authorization: Bearer $TOKEN" \\',
    '       -F "chunks.json=@$OUT_DIR/chunks.json;type=application/json" \\',
    '       -F "edges.json=@$OUT_DIR/edges.json;type=application/json" \\',
    '       -F "summary.md=@$OUT_DIR/summary.md;type=text/markdown" \\',
    '       -F "stats.json=@$OUT_DIR/stats.json;type=application/json" \\',
    '       -F "run.log=@$OUT_DIR/run.log;type=text/plain"',
    '  ```',
    `- 如 curl 返回非 2xx，**不要**删除 \`${env.outputDir}/\` 下的文件 —— 服务端会通过 fallback pull 自动把它们拉回。`,
    '',
    '## 可用外挂 Skill',
    skillList,
    '',
    '## 手工流程（仅回退时）',
    '1. 扫目录：Bash find + 文件大小过滤，排除 .git / node_modules / dist / build / coverage / vendor / target / __pycache__ / .next / .turbo / .cache',
    '2. 语言分析：TS/JS/TSX/JSX 抽取类/函数/接口/类型/常量；Python 抽 def/class；Go 抽 func；Rust 抽 fn/struct/enum；Java/Kotlin 抽 class/interface/enum；每个符号写一条 symbol chunk，content 为定义行 ±36 行（≤ 4KB）。',
    '3. 依赖：从 package.json、requirements.txt、go.mod、Cargo.toml、pyproject.toml、pom.xml、build.gradle 抽 dependencies 写 dependency chunk + depends_on 边。',
    '4. 引用图：从 import/require/from import/use 抽 imports，对内部路径解析到 repo 内真实文件；对每条内部 imports 写反向 imported_by 边。',
    '5. 文档：从 README.md / docs/**/*.md 按 #~###### 标题切 doc chunk；相对路径链接写 documents 边。',
    '6. 扫密：.env / .pem / .key / id_rsa / credentials.json / AKIA / ghp_ / JWT / password= 匹配到的文件整份跳过，不要进入 content 字段。',
    '',
    '## 质量约束',
    '- chunks 总数目标 200–8000；edges 200–20000',
    '- 单个 chunk.content ≤ 128KB；chunks.json 整体尽量 ≤ 64MB，edges.json ≤ 16MB',
    '- chunk.key / edge.key **必须稳定**（同一代码位置每次运行都生成一致字符串），基于 `repo_name:path:kind:name` 的 hash，否则会造成知识库条目重复膨胀。',
    '- 不要把 .env / 密钥 / 数据库密码写进任何 chunk.content 或 metadata。',
    '',
    '## 完成判定',
    '完成后请用一句话汇报：builtin-graph-scan 成功/自定义 skill 成功/已按手工流程生成，并附上 curl 上传的 HTTP 响应码（或上传失败的错误信息）。**不要**在回复里再粘贴 chunks/edges JSON —— 文件已被上传或会被服务端拉回。',
  ].join('\n');
}

async function runAgentKnowledgeTask(
  repo: ManagedRepo,
  sourceRoot: string,
  sourceDeviceLinkId: string | undefined,
  ownerUserId: string,
  opts: ReturnType<typeof clampOptions>,
  files: SourceFile[],
): Promise<ExternalGraphResult> {
  // 有明确 device 链接 → device 端 task agent（worktree + upload + fallback pull + timeline）
  const useDevice =
    !!opts.executionDeviceLinkId ||
    !!sourceDeviceLinkId ||
    (repo.kind === 'git' && opts.provider === 'agent'); // git 源 + agent 模式强制 device（路由层已经校验，这里双保险）
  if (useDevice) {
    return runDeviceKnowledgeAgent(repo, ownerUserId, opts, files);
  }

  // 没有 device：服务端走 container/host backend.run 兼容老路径，最终解析回复中的 ```json```
  const home = getUserHomeGroup(ownerUserId);
  const ownerHomeFolder = home?.folder ?? 'main';
  const runId = opts.runId;
  appendTimeline(runId, ownerUserId, 'milestone', '服务端 agent 启动（本地 container/host）');
  const agentGroup: RegisteredGroup = {
    name: `RepoKnowledge Agent: ${repo.name}`,
    folder: ownerHomeFolder,
    added_at: new Date().toISOString(),
    containerConfig: { timeout: Math.min(opts.agentTimeoutMs, AGENT_KNOWLEDGE_TIMEOUT_MS) },
    executionMode: 'container',
    created_by: ownerUserId,
    is_home: false,
  };
  const backend = resolveBackend(agentGroup);
  const resolvedExecutionMode: 'host' | 'container' = backend.supportsExecutionMode(agentGroup.executionMode ?? 'container')
    ? (agentGroup.executionMode ?? 'container')
    : 'host';
  const fileIndex = files.map((f) => ({ path: f.path, size: f.size, language: languageForFile(f.path) ?? undefined }));
  const prompt = buildAgentKnowledgePrompt(repo, opts, fileIndex);
  const turnId = `rk-agent-${repo.id}-${crypto.randomBytes(6).toString('hex')}`;

  let output: ContainerOutput;
  try {
    output = await backend.run({
      group: agentGroup,
      executionMode: resolvedExecutionMode,
      input: {
        prompt,
        groupFolder: ownerHomeFolder,
        chatJid: `system:repo-knowledge:${repo.id}`,
        isMain: false,
        isHome: false,
        isAdminHome: false,
        turnId,
        agentId: `repo-knowledge-agent`,
        sessionId: undefined,
        remoteExecutionLinkId: sourceDeviceLinkId,
        remoteToolCwd: sourceRoot,
        executionProfile: 'single-turn-json',
      },
      onProcess: () => undefined,
      signal: undefined,
    });
  } catch (err) {
    appendTimeline(runId, ownerUserId, 'error', '服务端 agent 启动失败', {
      error: err instanceof Error ? err.message : String(err),
    });
    throw new Error(`agent provider: 启动失败: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (output.status !== 'success') {
    appendTimeline(runId, ownerUserId, 'error', '服务端 agent 任务失败', {
      error: output.error,
    });
    throw new Error(`agent provider: 任务失败: ${output.error ?? output.result ?? 'unknown'}`);
  }
  const rawText = output.result ?? '';
  const parsed = extractLastJsonBlock(rawText) as Record<string, unknown>;
  if (!parsed || typeof parsed !== 'object') {
    appendTimeline(runId, ownerUserId, 'error', 'agent 回复中未找到 JSON 代码块');
    throw new Error('agent provider: 未输出 ```json``` 代码块');
  }
  appendTimeline(runId, ownerUserId, 'milestone', '解析回复 JSON 完成');
  return extractExternalGraphFromJsonReply(repo, parsed);
}

async function buildAgentGraphKnowledge(
  repo: ManagedRepo,
  sourceRoot: string,
  sourceDeviceLinkId: string | undefined,
  ownerUserId: string,
  opts: ReturnType<typeof clampOptions>,
  files: SourceFile[],
): Promise<ExternalGraphResult> {
  return runAgentKnowledgeTask(repo, sourceRoot, sourceDeviceLinkId, ownerUserId, opts, files);
}

function resolveKnowledgeSourceRepo(repo: ManagedRepo, opts: ReturnType<typeof clampOptions>): { repo: ManagedRepo; sourceMode: string } {
  if (opts.sourceKind === 'git') {
    if (!opts.sourceGitUrl) throw new Error('source_git_url is required when source_kind=git');
    return {
      sourceMode: 'git_override',
      repo: {
        ...repo,
        kind: 'git',
        gitUrl: opts.sourceGitUrl,
        mainBranch: opts.sourceMainBranch,
        devicePath: undefined,
        deviceLinkId: undefined,
      },
    };
  }
  if (opts.sourceKind === 'device_path') {
    if (!opts.sourceDevicePath || !opts.sourceDeviceLinkId) {
      throw new Error('source_device_path and source_device_link_id are required when source_kind=device_path');
    }
    return {
      sourceMode: 'device_path_override',
      repo: {
        ...repo,
        kind: 'device_path',
        gitUrl: undefined,
        mainBranch: undefined,
        devicePath: opts.sourceDevicePath,
        deviceLinkId: opts.sourceDeviceLinkId,
      },
    };
  }
  return { repo, sourceMode: repo.kind };
}

export async function generateRepoKnowledge(
  repo: ManagedRepo,
  userId: string,
  options: RepoKnowledgeGenerateOptions = {},
): Promise<RepoKnowledgeIndex> {
  const opts = clampOptions(options);
  upsertRepoKnowledgeIndex({
    repoId: repo.id,
    userId,
    status: 'indexing',
    stats: getRepoKnowledgeIndex(repo.id, userId)?.stats ?? {},
  });
  try {
    let files: SourceFile[];
    let collectionStats = emptyCollectionStats();
    let revision: string | undefined;
    let localSourceRoot: string | undefined;
    let remoteSourceRoot: string | undefined;
    let remoteSourceDeviceLinkId: string | undefined;
    const source = resolveKnowledgeSourceRepo(repo, opts);
    const sourceRepo = source.repo;
    const willRunOnDevice = sourceRepo.kind === 'device_path' || !!opts.executionDeviceLinkId;
    const pluginSelection = selectRepoKnowledgePlugin({ provider: opts.provider, fallbackBuiltin: opts.fallbackBuiltin, allowRemote: willRunOnDevice });
    const requested = pluginSelection.requestedProvider;
    const requestedStatus = pluginSelection.statuses.find((status) => status.id === requested);
    if ((requested === 'graphify' || requested === 'codegraph') && !requestedStatus?.available && !opts.fallbackBuiltin && !willRunOnDevice) {
      throw new Error(requestedStatus?.reason || `Repo knowledge provider ${requested} is not available`);
    }
    if (sourceRepo.kind === 'git') {
      if (opts.executionDeviceLinkId) {
        const collected = await collectGitFilesOnDevice(sourceRepo, opts.executionDeviceLinkId, opts);
        files = collected.files;
        collectionStats = collected.stats;
        revision = collected.revision;
        remoteSourceRoot = collected.root;
        remoteSourceDeviceLinkId = opts.executionDeviceLinkId;
      } else {
        const prepared = await prepareGitSource(sourceRepo);
        const collected = walkLocalFiles(prepared.root, opts);
        files = collected.files;
        collectionStats = collected.stats;
        revision = prepared.revision;
        localSourceRoot = prepared.root;
      }
    } else {
      if (opts.executionDeviceLinkId && opts.executionDeviceLinkId !== sourceRepo.deviceLinkId) {
        throw new Error('Device Path repo can only generate knowledge on its bound device');
      }
      const collected = await collectDeviceFiles(sourceRepo, opts);
      files = collected.files;
      collectionStats = collected.stats;
      revision = sourceRepo.devicePath;
      remoteSourceRoot = sourceRepo.devicePath;
      remoteSourceDeviceLinkId = sourceRepo.deviceLinkId;
    }
    const built = buildChunks(repo, files, revision, opts);
    let chunks = built.chunks;
    let edges = built.edges;
    let summary = built.summary;
    let stats = built.stats;
    let externalGraphStats: Record<string, unknown> | undefined;
    if (pluginSelection.provider === 'agent') {
      try {
        const ownerUserId = opts.agentOwnerUserId ?? repo.createdBy;
        const sourceRoot = localSourceRoot ?? remoteSourceRoot;
        const effectiveSourceRoot: string = sourceRoot
          ?? (repo.kind === 'git' && repo.gitUrl ? (await prepareGitSource(sourceRepo)).root : '');
        if (!effectiveSourceRoot && !remoteSourceDeviceLinkId) {
          throw new Error('agent provider: 无法确定仓库源码根目录');
        }
        const external = await buildAgentGraphKnowledge(
          repo,
          effectiveSourceRoot,
          remoteSourceDeviceLinkId,
          ownerUserId,
          opts,
          files,
        );
        chunks = [...chunks, ...external.chunks];
        edges = [...edges, ...external.edges];
        summary = `${summary}\n\nAI Agent graph:\n${external.summary}`;
        stats = {
          ...stats,
          chunkCount: chunks.length,
          graphEdgeCount: edges.length,
        };
        externalGraphStats = {
          ...external.stats,
          applied: true,
        };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        if (!opts.fallbackBuiltin) throw new Error(error);
        externalGraphStats = {
          provider: 'agent',
          applied: false,
          error,
        };
      }
    } else if (pluginSelection.provider === 'graphify' || pluginSelection.provider === 'codegraph') {
      if (!localSourceRoot && (!remoteSourceRoot || !remoteSourceDeviceLinkId)) {
        const error = 'external_graph_source_unavailable: external graph providers require a local repo root or a device repo path';
        if (!opts.fallbackBuiltin) throw new Error(error);
        externalGraphStats = {
          provider: pluginSelection.provider,
          applied: false,
          error,
        };
      } else {
        try {
          const external = localSourceRoot
            ? await buildExternalGraphKnowledge(pluginSelection.provider, repo, localSourceRoot, opts)
            : await buildExternalGraphKnowledgeOnDevice(pluginSelection.provider, repo, remoteSourceDeviceLinkId!, remoteSourceRoot!, opts);
          chunks = [...chunks, ...external.chunks];
          edges = [...edges, ...external.edges];
          summary = `${summary}\n\nExternal graph (${external.provider}):\n${external.summary}`;
          stats = {
            ...stats,
            chunkCount: chunks.length,
            graphEdgeCount: edges.length,
          };
          externalGraphStats = {
            ...external.stats,
            applied: true,
          };
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          if (!opts.fallbackBuiltin) throw new Error(error);
          externalGraphStats = {
            provider: pluginSelection.provider,
            applied: false,
            error,
          };
        }
      }
    }
    const selectedBackend = opts.searchBackend === 'auto' ? resolveRepoKnowledgeSearchBackend() : opts.searchBackend;
    const mergedStats = {
      ...stats,
      security: collectionStats,
      generator: {
        provider: pluginSelection.provider,
        requestedProvider: pluginSelection.requestedProvider,
        fallbackBuiltin: pluginSelection.provider === 'builtin' && pluginSelection.requestedProvider !== 'builtin',
        availablePlugins: pluginSelection.statuses,
      },
      externalGraph: externalGraphStats,
      searchBackend: selectedBackend,
      searchIndex: {
        sqliteFts: isRepoKnowledgeFtsAvailable(),
        mode: selectedBackend === 'sqlite' && isRepoKnowledgeFtsAvailable() ? 'fts5' : 'like-fallback',
      },
      source: {
        mode: source.sourceMode,
        kind: sourceRepo.kind,
        gitUrl: sourceRepo.gitUrl,
        devicePath: sourceRepo.devicePath,
        deviceLinkId: sourceRepo.deviceLinkId,
        executionDeviceLinkId: opts.executionDeviceLinkId,
      },
      options: {
        includeDocs: opts.includeDocs,
        includeDependencies: opts.includeDependencies,
        includeImportGraph: opts.includeImportGraph,
      },
    };
    replaceRepoKnowledgeChunks({ repoId: repo.id, userId, chunks, edges });
    const now = new Date().toISOString();
    return upsertRepoKnowledgeIndex({
      repoId: repo.id,
      userId,
      status: 'ready',
      sourceRevision: revision,
      summary,
      stats: mergedStats,
      generatedAt: now,
      updatedAt: now,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isDeviceOfflineError(message)) {
      const nextRetryAt = new Date(Date.now() + DEVICE_OFFLINE_RETRY_MS).toISOString();
      return upsertRepoKnowledgeIndex({
        repoId: repo.id,
        userId,
        status: 'indexing',
        stats: {
          ...(getRepoKnowledgeIndex(repo.id, userId)?.stats ?? {}),
          waitingForDevice: true,
          lastRetryError: message,
          nextRetryAt,
        },
      });
    }
    return upsertRepoKnowledgeIndex({
      repoId: repo.id,
      userId,
      status: 'error',
      stats: {},
      error: message,
    });
  }
}

async function generateRepoKnowledgeWithOfflineRetry(
  repo: ManagedRepo,
  userId: string,
  options: RepoKnowledgeGenerateOptions = {},
): Promise<RepoKnowledgeIndex> {
  for (;;) {
    const index = await generateRepoKnowledge(repo, userId, options);
    const lastRetryError = index.stats?.lastRetryError;
    if (index.status !== 'indexing' || !isDeviceOfflineError(typeof lastRetryError === 'string' ? lastRetryError : undefined)) {
      return index;
    }
    await sleep(DEVICE_OFFLINE_RETRY_MS);
  }
}

export function startRepoKnowledgeGenerationTask(
  repo: ManagedRepo,
  userId: string,
  options: RepoKnowledgeGenerateOptions = {},
): RepoKnowledgeGenerationTask {
  const key = repoKnowledgeTaskKey(repo.id, userId);
  const existing = runningRepoKnowledgeTasks.get(key);
  if (existing) {
    return {
      taskId: existing.taskId,
      index: getRepoKnowledgeIndex(repo.id, userId) ?? upsertRepoKnowledgeIndex({
        repoId: repo.id,
        userId,
        status: 'indexing',
        stats: {},
      }),
      alreadyRunning: true,
    };
  }

  const taskId = `repo_knowledge_${crypto.randomUUID()}`;
  const queuedAt = new Date().toISOString();
  createRepoKnowledgeRun({
    id: taskId,
    repoId: repo.id,
    userId,
    status: 'queued',
    sourceKind: options.sourceKind ?? repo.kind,
    executionDeviceLinkId: options.executionDeviceLinkId,
    stats: { options: clampOptions(options) },
    queuedAt,
  });
  const previous = getRepoKnowledgeIndex(repo.id, userId);
  const index = upsertRepoKnowledgeIndex({
    repoId: repo.id,
    userId,
    status: 'indexing',
    stats: {
      ...(previous?.stats ?? {}),
      backgroundTask: {
        id: taskId,
        queuedAt,
      },
    },
    updatedAt: queuedAt,
  });

  const promise = (async () => {
    const startedAt = new Date().toISOString();
    updateRepoKnowledgeRun(taskId, userId, { status: 'running', startedAt, updatedAt: startedAt });
    const runOptions: RepoKnowledgeGenerateOptions = {
      ...options,
      runId: taskId,
      serverBaseUrl: OCTODECK_PUBLIC_BASE_URL,
    };
    const finalIndex = await generateRepoKnowledgeWithOfflineRetry(repo, userId, runOptions);
    const completedAt = new Date().toISOString();
    updateRepoKnowledgeRun(taskId, userId, {
      status: finalIndex.status === 'ready' ? 'ready' : finalIndex.status === 'error' ? 'error' : 'running',
      stats: finalIndex.stats,
      error: finalIndex.error ?? null,
      completedAt: finalIndex.status === 'ready' || finalIndex.status === 'error' ? completedAt : null,
      updatedAt: completedAt,
    });
    return finalIndex;
  })();
  runningRepoKnowledgeTasks.set(key, { taskId, promise });
  const cleanup = () => {
    if (runningRepoKnowledgeTasks.get(key)?.taskId === taskId) {
      runningRepoKnowledgeTasks.delete(key);
    }
  };
  void promise.then(cleanup, cleanup);

  return { taskId, index, alreadyRunning: false };
}
