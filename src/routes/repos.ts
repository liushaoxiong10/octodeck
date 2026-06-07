import { Hono } from 'hono';
import path from 'node:path';

import {
  createManagedRepo,
  deleteManagedRepo,
  getAgentLinkById,
  getManagedRepoById,
  getRepoKnowledgeContext,
  getRepoKnowledgeIndex,
  listRepoKnowledgeGraphEdges,
  listRepoKnowledgeRuns,
  listRelatedRepoKnowledge,
  listRepoKnowledgeChunks,
  listManagedReposByUser,
  searchRepoKnowledge,
} from '../db.js';
import { getSession } from '../agent-link/registry.js';
import { invokeRemoteTool } from '../agent-link/tool-rpc.js';
import { authMiddleware } from '../middleware/auth.js';
import { RepoCreateSchema, RepoKnowledgeGenerateSchema, RepoKnowledgeSearchSchema } from '../schemas.js';
import { startRepoKnowledgeGenerationTask } from '../repo-knowledge.js';
import { listRepoKnowledgePlugins } from '../repo-knowledge-plugins.js';
import { listRepoKnowledgeSearchBackends } from '../repo-knowledge-search.js';
import type { RepoKnowledgeChunkKind, RepoKnowledgeGraphEdgeKind } from '../types.js';
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
  });
  return c.json({
    index: task.index,
    task: {
      id: task.taskId,
      status: task.alreadyRunning ? 'running' : 'queued',
    },
  }, 202);
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
