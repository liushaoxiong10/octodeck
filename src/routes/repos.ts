import { Hono } from 'hono';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  appendRepoKnowledgeRunTimeline,
  createManagedRepo,
  deleteManagedRepo,
  getAgentLinkById,
  getManagedRepoById,
  getRepoKnowledgeContext,
  getRepoKnowledgeIndex,
  getRepoKnowledgeRun,
  getRepoKnowledgeRunByUploadTokenHash,
  listRepoKnowledgeGraphEdges,
  listRepoKnowledgeRuns,
  listRelatedRepoKnowledge,
  listRepoKnowledgeChunks,
  listManagedReposByUser,
  replaceRepoKnowledgeChunks,
  searchRepoKnowledge,
  updateRepoKnowledgeRun,
  upsertRepoKnowledgeIndex,
} from '../db.js';
import { getSession } from '../agent-link/registry.js';
import { invokeRemoteTool } from '../agent-link/tool-rpc.js';
import { DATA_DIR, PROJECT_ROOT } from '../config.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  RepoCreateSchema,
  RepoKnowledgeGenerateSchema,
  RepoKnowledgeSearchSchema,
  RepoKnowledgeUploadSchema,
} from '../schemas.js';
import {
  ingestRepoKnowledgeUpload,
  startRepoKnowledgeGenerationTask,
  stableChunkId,
  stableEdgeId,
} from '../repo-knowledge.js';
import { listRepoKnowledgePlugins } from '../repo-knowledge-plugins.js';
import { listRepoKnowledgeSearchBackends } from '../repo-knowledge-search.js';
import type {
  RepoKnowledgeChunkKind,
  RepoKnowledgeGraphEdge,
  RepoKnowledgeGraphEdgeKind,
  RepoKnowledgeRunMilestone,
} from '../types.js';
import type { AuthUser, ManagedRepo } from '../types.js';
import type { Variables } from '../web-context.js';

const repoRoutes = new Hono<{ Variables: Variables }>();

function toPayload(repo: ManagedRepo) {
  return {
    id: repo.id,
    name: repo.name,
    kind: repo.kind,
    git_url: repo.gitUrl,
    main_branch: repo.mainBranch,
    device_path: repo.devicePath,
    device_link_id: repo.deviceLinkId,
    created_by: repo.createdBy,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    knowledge: getRepoKnowledgeIndex(repo.id, repo.createdBy) ?? null,
  };
}

function isValidMainBranchName(value: string | undefined): boolean {
  if (!value) return true;
  if (/\s/.test(value)) return false;
  if (value.startsWith('-') || value.startsWith('/') || value.endsWith('/')) {
    return false;
  }
  if (
    value.includes('..') ||
    value.includes('//') ||
    value.includes('@{') ||
    value.endsWith('.') ||
    value.endsWith('.lock')
  ) {
    return false;
  }
  return /^[A-Za-z0-9._/-]+$/.test(value);
}

interface DeviceDirectoryPayload {
  currentPath?: string | null;
  parentPath?: string | null;
  directories?: unknown[];
  hasAllowlist?: boolean;
}

function isUnsupportedListDirectories(
  error: string | null | undefined,
): boolean {
  return !!error && /unsupported tool:\s*ListDirectories/i.test(error);
}

function bashDirectoryListCommand(targetPath?: string): string {
  const pathArg = JSON.stringify(targetPath || '');
  return `python3 - <<'PY'
import json, os, sys
requested = ${pathArg}
base = requested or os.path.expanduser('~')
base = os.path.realpath(base)
if not os.path.isdir(base):
    raise SystemExit('path is not a directory: ' + base)
parent = os.path.dirname(base)
if parent == base:
    parent = None
dirs = []
try:
    names = sorted(os.listdir(base))
except Exception as exc:
    raise SystemExit(str(exc))
for name in names[:500]:
    if name.startswith('.'):
        continue
    full = os.path.join(base, name)
    try:
        real = os.path.realpath(full)
        if not os.path.isdir(real):
            continue
        has_children = any(
            (not child.startswith('.')) and os.path.isdir(os.path.join(real, child))
            for child in os.listdir(real)
        )
    except Exception:
        continue
    dirs.append({'name': name, 'path': real, 'hasChildren': has_children})
    if len(dirs) >= 200:
        break
print(json.dumps({'currentPath': base, 'parentPath': parent, 'directories': dirs, 'hasAllowlist': False}))
PY`;
}

async function listDeviceDirectoriesWithBashFallback(
  linkId: string,
  targetPath?: string,
) {
  const session = getSession(linkId);
  if (!session || session.state !== 'open') {
    return {
      ok: false as const,
      status: 409 as const,
      error: 'Device is offline',
    };
  }
  try {
    const result = await invokeRemoteTool(session, {
      linkId,
      toolName: 'Bash',
      input: { command: bashDirectoryListCommand(targetPath) },
      cwd: targetPath || '/',
      timeoutMs: 8_000,
      maxOutputBytes: 128 * 1024,
    });
    if (!result.ok) {
      return {
        ok: false as const,
        status: 400 as const,
        error: result.error || 'Failed to list device directories',
      };
    }
    const stdout =
      typeof (result.result as { stdout?: unknown } | null)?.stdout === 'string'
        ? (result.result as { stdout: string }).stdout
        : '';
    return {
      ok: true as const,
      payload: JSON.parse(stdout) as DeviceDirectoryPayload,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false as const,
      status: message === 'tool_timeout' ? (504 as const) : (409 as const),
      error: message,
    };
  }
}

export async function listDeviceDirectories(
  linkId: string,
  targetPath?: string,
) {
  const session = getSession(linkId);
  if (!session || session.state !== 'open') {
    return {
      ok: false as const,
      status: 409 as const,
      error: 'Device is offline',
    };
  }
  try {
    const result = await invokeRemoteTool(session, {
      linkId,
      toolName: 'ListDirectories',
      input: targetPath ? { path: targetPath } : {},
      cwd: '/',
      timeoutMs: 8_000,
      maxOutputBytes: 128 * 1024,
    });
    if (!result.ok) {
      if (isUnsupportedListDirectories(result.error)) {
        return listDeviceDirectoriesWithBashFallback(linkId, targetPath);
      }
      return {
        ok: false as const,
        status: 400 as const,
        error: result.error || 'Failed to list device directories',
      };
    }
    return {
      ok: true as const,
      payload: result.result as DeviceDirectoryPayload,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false as const,
      status: message === 'tool_timeout' ? (504 as const) : (409 as const),
      error: message,
    };
  }
}

repoRoutes.get('/', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  return c.json({ repos: listManagedReposByUser(user.id).map(toPayload) });
});

repoRoutes.post('/knowledge/search', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));
  const validation = RepoKnowledgeSearchSchema.safeParse(body);
  if (!validation.success)
    return c.json({ error: 'Invalid request body' }, 400);
  const { repo_id, query, limit, kind, language, path_prefix, include_related } = validation.data;
  if (repo_id) {
    const repo = getManagedRepoById(repo_id);
    if (!repo || repo.createdBy !== user.id) return c.json({ error: 'Repo not found' }, 404);
  }
  return c.json({ hits: searchRepoKnowledge({ repoId: repo_id, userId: user.id, query, limit, kind, language, pathPrefix: path_prefix, includeRelated: include_related }) });
});

repoRoutes.get('/knowledge/plugins', authMiddleware, (c) => {
  return c.json({ plugins: listRepoKnowledgePlugins(c.req.query('provider')) });
});

repoRoutes.get('/knowledge/search-backends', authMiddleware, () => {
  return new Response(JSON.stringify({ backends: listRepoKnowledgeSearchBackends() }), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
});

repoRoutes.get('/:id/knowledge', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const repo = getManagedRepoById(c.req.param('id'));
  if (!repo || repo.createdBy !== user.id) return c.json({ error: 'Repo not found' }, 404);
  return c.json({ index: getRepoKnowledgeIndex(repo.id, user.id) ?? null });
});

repoRoutes.get('/:id/knowledge/runs', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const repo = getManagedRepoById(c.req.param('id'));
  if (!repo || repo.createdBy !== user.id) return c.json({ error: 'Repo not found' }, 404);
  const rawLimit = Number(c.req.query('limit') || '20');
  return c.json({
    runs: listRepoKnowledgeRuns({
      repoId: repo.id,
      userId: user.id,
      limit: Number.isFinite(rawLimit) ? rawLimit : 20,
    }),
  });
});

repoRoutes.post('/:id/knowledge/generate', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const repo = getManagedRepoById(c.req.param('id'));
  if (!repo || repo.createdBy !== user.id) return c.json({ error: 'Repo not found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const validation = RepoKnowledgeGenerateSchema.safeParse(body);
  if (!validation.success)
    return c.json({ error: 'Invalid request body' }, 400);
  const executionDeviceLinkId = validation.data.execution_device_link_id;
  if (validation.data.provider === 'agent') {
    const effectiveSourceKind = validation.data.source_kind ?? repo.kind;
    if (effectiveSourceKind === 'git' && !executionDeviceLinkId) {
      return c.json({ error: 'provider=agent 的 Git 源必须指定 execution_device_link_id' }, 400);
    }
  }
  if (executionDeviceLinkId) {
    const link = getAgentLinkById(executionDeviceLinkId);
    if (!link || link.userId !== user.id || link.revokedAt) {
      return c.json({ error: 'execution_device_link_id not found' }, 400);
    }
    if (repo.kind === 'device_path' && repo.deviceLinkId !== executionDeviceLinkId) {
      return c.json({ error: 'Device Path repo can only use its bound device' }, 400);
    }
  }
  const task = startRepoKnowledgeGenerationTask(repo, user.id, {
    includePatterns: validation.data.include_patterns,
    excludePatterns: validation.data.exclude_patterns,
    maxFiles: validation.data.max_files,
    maxFileBytes: validation.data.max_file_bytes,
    provider: validation.data.provider,
    plugins: validation.data.plugins,
    useExternalGraph: validation.data.use_external_graph,
    fallbackBuiltin: validation.data.fallback_builtin,
    includeDocs: validation.data.include_docs,
    includeDependencies: validation.data.include_dependencies,
    includeImportGraph: validation.data.include_import_graph,
    searchBackend: validation.data.search_backend,
    sourceKind: validation.data.source_kind,
    sourceGitUrl: validation.data.source_git_url,
    sourceMainBranch: validation.data.source_main_branch,
    sourceDevicePath: validation.data.source_device_path,
    sourceDeviceLinkId: validation.data.source_device_link_id,
    executionDeviceLinkId,
    enabledSkills: validation.data.enabled_skills,
    agentPrompt: validation.data.agent_prompt,
    agentTimeoutMs: validation.data.agent_timeout_ms,
  });
  return c.json({
    index: task.index,
    task: {
      id: task.taskId,
      status: task.alreadyRunning ? 'running' : 'queued',
    },
  }, 202);
});

// ────────── builtin-graph-scan Python 脚本（device 端 agent 可直接 curl 拉取）───
// 无鉴权：脚本本身就是 repo 开源内容，device 端 agent 可能没有 session cookie。
// 带强 ETag + Cache-Control 避免每次下载 80KB 都重传。
//
// device 端 agent 使用模板（来自 buildDeviceAgentPrompt）：
//   curl -fsSL "$OCTODECK_PUBLIC_BASE_URL/api/repos/knowledge/builtin-script" \
//        -o /tmp/builtin_graph_scan.py
//   python3 /tmp/builtin_graph_scan.py --repo . --output-dir .octodeck/knowledge ...
const BUILTIN_SCRIPT_PATH = path.join(
  PROJECT_ROOT,
  'container',
  'skills',
  'builtin-graph-scan',
  'scripts',
  'builtin_graph_scan.py',
);
let _builtinScriptCache: { mtimeMs: number; etag: string; body: Uint8Array } | null = null;
repoRoutes.get('/knowledge/builtin-script', (c) => {
  try {
    const st = fs.statSync(BUILTIN_SCRIPT_PATH);
    const fresh =
      _builtinScriptCache &&
      Math.abs(_builtinScriptCache.mtimeMs - st.mtimeMs) < 0.001;
    if (!fresh) {
      const body = fs.readFileSync(BUILTIN_SCRIPT_PATH);
      const etag = '"' + crypto.createHash('sha1').update(body).digest('hex').slice(0, 16) + '"';
      _builtinScriptCache = { mtimeMs: st.mtimeMs, etag, body };
    }
    const cache = _builtinScriptCache!;
    const ifNoneMatch = c.req.header('If-None-Match');
    if (ifNoneMatch && ifNoneMatch.split(',').map((s) => s.trim()).includes(cache.etag)) {
      return c.body(null, 304);
    }
    c.header('ETag', cache.etag);
    c.header('Cache-Control', 'public, max-age=300');
    c.header('Content-Type', 'text/x-python; charset=utf-8');
    c.header('Content-Length', String(cache.body.length));
    return c.body(cache.body as never, 200);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'builtin script not available', detail: msg }, 500);
  }
});

// ────────── 单个 run 查询（给前端观测面板用 ────────────────────────────────
repoRoutes.get('/knowledge/runs/:runId', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const run = getRepoKnowledgeRun(c.req.param('runId'), user.id);
  if (!run) return c.json({ error: 'Run not found' }, 404);
  // 不回传 token hash
  const { uploadTokenHash: _uploadTokenHash, ...safe } = run;
  return c.json({ run: safe });
});

// ────────── 产物上传端点（agent 主动上传，Bearer: <upload token>）───────────
// 支持两种 Content-Type：
//   1. application/json          — 符合 RepoKnowledgeUploadSchema 的 JSON
//   2. multipart/form-data       — 文件字段：chunks.json / edges.json / summary.md / stats.json / run.log
const UPLOAD_MAX_BYTES = 128 * 1024 * 1024; // 128MB 总上限
repoRoutes.post('/knowledge/runs/:runId/upload', async (c) => {
  const authz = c.req.header('Authorization') ?? '';
  const token = /^Bearer\s+(.+)$/i.exec(authz)?.[1]?.trim();
  if (!token) return c.json({ error: 'missing upload token' }, 401);
  const runId = c.req.param('runId');
  const expectedHash = crypto.createHash('sha256').update(token).digest('hex');
  const run = getRepoKnowledgeRunByUploadTokenHash(expectedHash);
  if (!run) return c.json({ error: 'run not found or token invalid' }, 401);
  if (run.id !== runId) return c.json({ error: 'run id mismatch' }, 400);

  // token 一次性使用：立即清空，防止重放
  updateRepoKnowledgeRun(run.id, run.userId, {
    status: 'uploading',
    uploadTokenHash: null,
  });

  const timelinePush = (kind: RepoKnowledgeRunMilestone['kind'], label: string, detail?: Record<string, unknown>) =>
    appendRepoKnowledgeRunTimeline(run.id, run.userId, { kind, label, detail });
  timelinePush('upload', 'agent 开始上传产物');

  let payload: {
    chunks?: unknown;
    edges?: unknown;
    summary?: unknown;
    stats?: unknown;
    runLog?: unknown;
  } = {};
  try {
    const ctype = c.req.header('content-type') ?? '';
    if (ctype.startsWith('application/json')) {
      const raw = (await c.req.raw.text()) ?? '';
      if (new Blob([raw]).size > UPLOAD_MAX_BYTES) {
        return c.json({ error: 'payload too large' }, 413);
      }
      payload = JSON.parse(raw) as typeof payload;
    } else if (ctype.startsWith('multipart/form-data')) {
      const form = await c.req.formData();
      const pickText = async (name: string): Promise<string | undefined> => {
        const entry = form.get(name);
        if (!entry) return undefined;
        if (typeof entry === 'string') return entry;
        if (entry instanceof Blob) {
          if (entry.size > UPLOAD_MAX_BYTES) throw new Error(`field too large: ${name}`);
          return await (entry as File).text();
        }
        return undefined;
      };
      const resolved: { chunks?: unknown; edges?: unknown; summary?: unknown; stats?: unknown; runLog?: unknown } = {};
      const pickJson = async (name: string) => {
        const entry = form.get(name);
        if (!entry) return undefined;
        const text = typeof entry === 'string' ? entry : entry instanceof Blob ? await (entry as File).text() : undefined;
        if (text === undefined) return undefined;
        if (text.length > UPLOAD_MAX_BYTES) throw new Error(`field too large: ${name}`);
        return JSON.parse(text);
      };
      resolved.chunks = await pickJson('chunks.json');
      resolved.edges = await pickJson('edges.json');
      resolved.summary = await pickText('summary.md');
      resolved.stats = await pickJson('stats.json');
      resolved.runLog = await pickText('run.log');
      payload = resolved;
    } else {
      return c.json({ error: 'unsupported content-type' }, 415);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    timelinePush('error', '上传解析失败', { error: msg });
    updateRepoKnowledgeRun(run.id, run.userId, { error: msg, status: 'error' });
    return c.json({ error: msg }, 400);
  }

  // zod 校验
  const validated = RepoKnowledgeUploadSchema.safeParse({
    chunks: payload.chunks,
    edges: payload.edges,
    summary: typeof payload.summary === 'string' ? payload.summary : undefined,
    stats: typeof payload.stats === 'object' && payload.stats !== null && !Array.isArray(payload.stats)
      ? payload.stats as Record<string, unknown>
      : undefined,
    runLog: typeof payload.runLog === 'string' ? payload.runLog : undefined,
  });
  if (!validated.success) {
    const msg = validated.error.issues[0]?.message ?? 'schema validation failed';
    timelinePush('error', '产物 schema 校验失败', { error: msg, zod: validated.error.flatten() });
    updateRepoKnowledgeRun(run.id, run.userId, { error: msg, status: 'error' });
    return c.json({ error: msg, details: validated.error.flatten() }, 400);
  }

  // 持久化原始产物（data/repo-knowledge/runs/<runId>/），供排查
  try {
    const runDir = path.join(DATA_DIR, 'repo-knowledge', 'runs', run.id);
    fs.mkdirSync(runDir, { recursive: true });
    if (validated.data.chunks) fs.writeFileSync(path.join(runDir, 'chunks.json'), JSON.stringify(validated.data.chunks));
    if (validated.data.edges) fs.writeFileSync(path.join(runDir, 'edges.json'), JSON.stringify(validated.data.edges));
    if (validated.data.summary) fs.writeFileSync(path.join(runDir, 'summary.md'), validated.data.summary);
    if (validated.data.stats) fs.writeFileSync(path.join(runDir, 'stats.json'), JSON.stringify(validated.data.stats));
    if (validated.data.runLog) fs.writeFileSync(path.join(runDir, 'run.log'), validated.data.runLog);
  } catch (err) {
    // 原始产物落盘失败不中断主流程，只记 timeline
    const msg = err instanceof Error ? err.message : String(err);
    timelinePush('warn', '原始产物落盘失败', { error: msg });
  }

  // 入库
  try {
    const repo = getManagedRepoById(run.repoId);
    if (!repo || repo.createdBy !== run.userId) throw new Error('repo owner mismatch');
    const result = ingestRepoKnowledgeUpload(repo, run.userId, {
      chunks: validated.data.chunks ?? [],
      edges: validated.data.edges ?? [],
      summary: validated.data.summary,
      stats: validated.data.stats,
    });
    updateRepoKnowledgeRun(run.id, run.userId, {
      status: 'ready',
      filesUploadedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      error: null,
      stats: {
        ...(run.stats ?? {}),
        uploaded: {
          chunks: validated.data.chunks?.length ?? 0,
          edges: validated.data.edges?.length ?? 0,
          merged: result.merged,
          skipped: result.skipped,
          from: 'agent-upload',
        },
      },
    });
    timelinePush('upload', '产物已上传并入知识图谱索引', {
      chunks: validated.data.chunks?.length ?? 0,
      edges: validated.data.edges?.length ?? 0,
      merged: result.merged,
      skipped: result.skipped,
    });
    upsertRepoKnowledgeIndex({
      repoId: repo.id,
      userId: run.userId,
      status: 'ready',
      summary: validated.data.summary ?? undefined,
      stats: result.stats,
      generatedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    return c.json({
      ok: true,
      merged: result.merged,
      skipped: result.skipped,
      stats: result.stats,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    timelinePush('error', '产物入库失败', { error: msg });
    updateRepoKnowledgeRun(run.id, run.userId, { error: msg, status: 'error' });
    return c.json({ error: msg }, 500);
  }
});

repoRoutes.get('/:id/knowledge/chunks', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const repo = getManagedRepoById(c.req.param('id'));
  if (!repo || repo.createdBy !== user.id) return c.json({ error: 'Repo not found' }, 404);
  const rawLimit = Number(c.req.query('limit') || '100');
  return c.json({
    chunks: listRepoKnowledgeChunks({
      repoId: repo.id,
      userId: user.id,
      path: c.req.query('path'),
      kind: c.req.query('kind') as RepoKnowledgeChunkKind | undefined,
      language: c.req.query('language') || undefined,
      pathPrefix: c.req.query('path_prefix') || undefined,
      limit: Number.isFinite(rawLimit) ? rawLimit : 100,
    }),
  });
});

repoRoutes.get('/:id/knowledge/graph', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const repo = getManagedRepoById(c.req.param('id'));
  if (!repo || repo.createdBy !== user.id) return c.json({ error: 'Repo not found' }, 404);
  const rawLimit = Number(c.req.query('limit') || '100');
  return c.json({
    edges: listRepoKnowledgeGraphEdges({
      repoId: repo.id,
      userId: user.id,
      path: c.req.query('path') || undefined,
      edgeKind: c.req.query('edge_kind') as RepoKnowledgeGraphEdgeKind | undefined,
      packageName: c.req.query('package_name') || undefined,
      limit: Number.isFinite(rawLimit) ? rawLimit : 100,
    }),
  });
});

repoRoutes.get('/:id/knowledge/related', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const repo = getManagedRepoById(c.req.param('id'));
  if (!repo || repo.createdBy !== user.id) return c.json({ error: 'Repo not found' }, 404);
  const rawLimit = Number(c.req.query('limit') || '30');
  return c.json(listRelatedRepoKnowledge({
    repoId: repo.id,
    userId: user.id,
    path: c.req.query('path') || undefined,
    chunkId: c.req.query('chunk_id') || undefined,
    limit: Number.isFinite(rawLimit) ? rawLimit : 30,
  }));
});

repoRoutes.get('/:id/knowledge/context', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const repo = getManagedRepoById(c.req.param('id'));
  if (!repo || repo.createdBy !== user.id) return c.json({ error: 'Repo not found' }, 404);
  const rawLimit = Number(c.req.query('limit') || '20');
  return c.json({ context: getRepoKnowledgeContext({
    repoId: repo.id,
    userId: user.id,
    chunkId: c.req.query('chunk_id') || undefined,
    path: c.req.query('path') || undefined,
    query: c.req.query('query') || undefined,
    limit: Number.isFinite(rawLimit) ? rawLimit : 20,
  }) });
});

repoRoutes.get('/:id/knowledge/dependencies', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const repo = getManagedRepoById(c.req.param('id'));
  if (!repo || repo.createdBy !== user.id) return c.json({ error: 'Repo not found' }, 404);
  return c.json({
    chunks: listRepoKnowledgeChunks({ repoId: repo.id, userId: user.id, kind: 'dependency', limit: 200 }),
    edges: listRepoKnowledgeGraphEdges({ repoId: repo.id, userId: user.id, edgeKind: 'depends_on', limit: 300 }),
  });
});

repoRoutes.get('/device-directories', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const linkId = c.req.query('link_id');
  const targetPath = c.req.query('path');
  if (!linkId) return c.json({ error: 'link_id is required' }, 400);

  const link = getAgentLinkById(linkId);
  if (!link || link.userId !== user.id || link.revokedAt) {
    return c.json({ error: 'Device not found' }, 404);
  }
  const session = getSession(linkId);
  if (!session || session.state !== 'open') {
    return c.json({ error: 'Device is offline' }, 409);
  }

  const result = await listDeviceDirectories(linkId, targetPath);
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json(result.payload);
});

repoRoutes.post('/', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));
  const validation = RepoCreateSchema.safeParse(body);
  if (!validation.success)
    return c.json({ error: 'Invalid request body' }, 400);

  const { name, kind, git_url, main_branch, device_link_id } = validation.data;
  let { device_path } = validation.data;
  if (kind === 'git') {
    if (!git_url) return c.json({ error: 'git_url is required' }, 400);
    let url: URL;
    try {
      url = new URL(git_url);
    } catch {
      return c.json({ error: 'git_url is not a valid URL' }, 400);
    }
    if (url.protocol !== 'https:')
      return c.json({ error: 'git_url must use https protocol' }, 400);
    if (!isValidMainBranchName(main_branch)) {
      return c.json({ error: 'main_branch is not a valid branch name' }, 400);
    }
  }

  if (kind === 'device_path') {
    if (!device_path) return c.json({ error: 'device_path is required' }, 400);
    if (!path.isAbsolute(device_path))
      return c.json({ error: 'device_path must be an absolute path' }, 400);
    if (!device_link_id)
      return c.json({ error: 'device_link_id is required' }, 400);
    const link = getAgentLinkById(device_link_id);
    if (!link || link.userId !== user.id || link.revokedAt) {
      return c.json({ error: 'device_link_id not found' }, 400);
    }
    device_path = path.normalize(device_path);
  }

  const repo = createManagedRepo({
    name,
    kind,
    gitUrl: kind === 'git' ? git_url : undefined,
    mainBranch: kind === 'git' ? main_branch : undefined,
    devicePath: kind === 'device_path' ? device_path : undefined,
    deviceLinkId: kind === 'device_path' ? device_link_id : undefined,
    createdBy: user.id,
  });
  return c.json({ repo: toPayload(repo) });
});

repoRoutes.delete('/:id', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const ok = deleteManagedRepo(c.req.param('id'), user.id);
  if (!ok) return c.json({ error: 'Repo not found' }, 404);
  return c.json({ ok: true });
});

export default repoRoutes;
