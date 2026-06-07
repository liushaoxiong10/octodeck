import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { getSession } from './agent-link/registry.js';
import { invokeRemoteTool } from './agent-link/tool-rpc.js';
import { DATA_DIR } from './config.js';
import SqliteDatabase from './sqlite-compat.js';
import {
  createRepoKnowledgeRun,
  getRepoKnowledgeIndex,
  isRepoKnowledgeFtsAvailable,
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
  provider?: 'builtin' | 'auto' | 'graphify' | 'codegraph';
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
  provider: 'graphify' | 'codegraph';
}

function clampOptions(opts: RepoKnowledgeGenerateOptions = {}) {
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
    cwd: repo.devicePath,
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

function stableChunkId(repoId: string, kind: RepoKnowledgeChunkKind, key: string): string {
  const digest = crypto.createHash('sha1').update(`${repoId}:${kind}:${key}`).digest('hex').slice(0, 16);
  return `rk_${digest}`;
}

function stableEdgeId(repoId: string, edgeKind: RepoKnowledgeGraphEdgeKind, key: string): string {
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
  const add = (target: string, source: string) => {
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
    if (pluginSelection.provider === 'graphify' || pluginSelection.provider === 'codegraph') {
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
    const finalIndex = await generateRepoKnowledgeWithOfflineRetry(repo, userId, options);
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
