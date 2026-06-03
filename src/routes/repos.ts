import { Hono } from 'hono';
import path from 'node:path';

import {
  createManagedRepo,
  deleteManagedRepo,
  getAgentLinkById,
  listManagedReposByUser,
} from '../db.js';
import { getSession } from '../agent-link/registry.js';
import { invokeRemoteTool } from '../agent-link/tool-rpc.js';
import { authMiddleware } from '../middleware/auth.js';
import { RepoCreateSchema } from '../schemas.js';
import type { AuthUser, ManagedRepo } from '../types.js';
import type { Variables } from '../web-context.js';

const repoRoutes = new Hono<{ Variables: Variables }>();

function toPayload(repo: ManagedRepo) {
  return {
    id: repo.id,
    name: repo.name,
    kind: repo.kind,
    git_url: repo.gitUrl,
    device_path: repo.devicePath,
    device_link_id: repo.deviceLinkId,
    created_by: repo.createdBy,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
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

  const { name, kind, git_url, device_link_id } = validation.data;
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
    const result = await listDeviceDirectories(device_link_id, device_path);
    if (!result.ok) return c.json({ error: result.error }, result.status);
    if (!result.payload.currentPath)
      return c.json({ error: 'device_path is not a directory' }, 400);
    device_path = result.payload.currentPath;
  }

  const repo = createManagedRepo({
    name,
    kind,
    gitUrl: kind === 'git' ? git_url : undefined,
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
