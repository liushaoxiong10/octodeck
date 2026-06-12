import { getSession } from '../agent-link/registry.js';
import { invokeRemoteTool } from '../agent-link/tool-rpc.js';
import { verifyAgentToolToken } from '../config.js';
import { LONG_RUNNING_LOCAL_CLI_TIMEOUT_MS } from '../runtime-config.js';
import {
  getAgentLinkById,
  getCloudSkill,
  getManagedRepoById,
  getRepoKnowledgeChunk,
  getRepoKnowledgeContext,
  getRepoKnowledgeIndex,
  listRepoKnowledgeGraphEdges,
  listRelatedRepoKnowledge,
  listCloudSkillsByUser,
  listManagedReposByUser,
  listRepoKnowledgeChunks,
  searchRepoKnowledge,
} from '../db.js';
import { listRepoKnowledgePlugins } from '../repo-knowledge-plugins.js';
import { listRepoKnowledgeSearchBackends } from '../repo-knowledge-search.js';
import type { RepoKnowledgeChunkKind, RepoKnowledgeGraphEdgeKind } from '../types.js';
import {
  appendCloudMemory,
  getCloudMemory,
  putCloudMemory,
  searchCloudMemory,
  syncClientAgentMemory,
  listCloudMemories,
  type CloudMemoryType,
} from '../memory-store.js';

interface ToolHttpBody {
  linkId?: string;
  toolName?: string;
  input?: unknown;
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

interface MemoryHttpBody {
  userId?: string;
  operation?: string;
  memoryType?: CloudMemoryType;
  groupFolder?: string;
  deviceLinkId?: string;
  agentId?: string;
  path?: string;
  content?: string;
  query?: string;
  expectedRevision?: number;
  limit?: number;
}

interface CloudSkillToolBody {
  userId?: string;
  operation?: string;
  skillId?: string;
  query?: string;
}

interface RepoKnowledgeToolBody {
  userId?: string;
  operation?: string;
  repoId?: string;
  query?: string;
  path?: string;
  kind?: RepoKnowledgeChunkKind;
  language?: string;
  pathPrefix?: string;
  edgeKind?: RepoKnowledgeGraphEdgeKind;
  chunkId?: string;
  limit?: number;
  includeRelated?: boolean;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function getToolAuthUserId(request: Request): string | null {
  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
  return token ? verifyAgentToolToken(token)?.userId ?? null : null;
}

export async function handleAgentLinkToolHttpRequest(
  request: Request,
): Promise<Response> {
  const authUserId = getToolAuthUserId(request);
  if (!authUserId) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'method_not_allowed' }, 405);
  }

  let body: ToolHttpBody;
  try {
    body = (await request.json()) as ToolHttpBody;
  } catch {
    return jsonResponse({ error: 'invalid_json' }, 400);
  }

  if (!body.linkId || !body.toolName || !body.cwd) {
    return jsonResponse({ error: 'missing_required_fields' }, 400);
  }

  const session = getSession(body.linkId);
  if (!session || session.state !== 'open') {
    return jsonResponse({ error: 'link_offline' }, 409);
  }
  const link = getAgentLinkById(body.linkId);
  if (!link || link.userId !== authUserId || link.revokedAt) {
    return jsonResponse({ error: 'link_not_found' }, 404);
  }

  try {
    const result = await invokeRemoteTool(session, {
      linkId: body.linkId,
      toolName: body.toolName,
      input: body.input ?? {},
      cwd: body.cwd,
      timeoutMs:
        body.timeoutMs && body.timeoutMs > 0
          ? body.timeoutMs
          : LONG_RUNNING_LOCAL_CLI_TIMEOUT_MS,
      maxOutputBytes:
        body.maxOutputBytes && body.maxOutputBytes > 0
          ? body.maxOutputBytes
          : 1_048_576,
    });
    return jsonResponse(result);
  } catch (err) {
    return jsonResponse(
      { error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
}

export async function handleCloudMemoryToolHttpRequest(
  request: Request,
): Promise<Response> {
  const authUserId = getToolAuthUserId(request);
  if (!authUserId)
    return jsonResponse({ error: 'unauthorized' }, 401);
  if (request.method !== 'POST')
    return jsonResponse({ error: 'method_not_allowed' }, 405);

  let body: MemoryHttpBody;
  try {
    body = (await request.json()) as MemoryHttpBody;
  } catch {
    return jsonResponse({ error: 'invalid_json' }, 400);
  }

  if (!body.operation)
    return jsonResponse({ error: 'missing_required_fields' }, 400);
  body.userId = authUserId;

  try {
    switch (body.operation) {
      case 'list': {
        const limit = Math.max(1, Math.min(body.limit ?? 200, 500));
        const memories = listCloudMemories(body.userId).filter((memory) => {
          if (body.memoryType && memory.memoryType !== body.memoryType)
            return false;
          if (body.groupFolder && memory.groupFolder !== body.groupFolder)
            return false;
          if (body.deviceLinkId && memory.deviceLinkId !== body.deviceLinkId)
            return false;
          if (body.agentId && memory.agentId !== body.agentId) return false;
          return true;
        });
        return jsonResponse({ memories: memories.slice(0, limit) });
      }
      case 'search':
        if (!body.query) return jsonResponse({ error: 'query_required' }, 400);
        return jsonResponse({
          memories: searchCloudMemory({
            userId: body.userId,
            query: body.query,
            memoryType: body.memoryType,
          }),
        });
      case 'get':
        if (!body.memoryType || !body.path)
          return jsonResponse({ error: 'memoryType_path_required' }, 400);
        return jsonResponse({
          memory:
            getCloudMemory({
              userId: body.userId,
              memoryType: body.memoryType,
              groupFolder: body.groupFolder,
              deviceLinkId: body.deviceLinkId,
              agentId: body.agentId,
              path: body.path,
            }) ?? null,
        });
      case 'append':
        if (!body.memoryType || !body.path || typeof body.content !== 'string')
          return jsonResponse(
            { error: 'memoryType_path_content_required' },
            400,
          );
        return jsonResponse({
          memory: appendCloudMemory({
            userId: body.userId,
            memoryType: body.memoryType,
            groupFolder: body.groupFolder,
            path: body.path,
            content: body.content,
            source: 'cloud_sdk',
            updatedBy: body.userId,
          }),
        });
      case 'update':
        if (!body.memoryType || !body.path || typeof body.content !== 'string')
          return jsonResponse(
            { error: 'memoryType_path_content_required' },
            400,
          );
        return jsonResponse({
          memory: putCloudMemory({
            userId: body.userId,
            memoryType: body.memoryType,
            groupFolder: body.groupFolder,
            path: body.path,
            content: body.content,
            expectedRevision: body.expectedRevision,
            source: 'cloud_sdk',
            updatedBy: body.userId,
          }),
        });
      case 'client_sync':
        if (
          !body.deviceLinkId ||
          !body.agentId ||
          !body.path ||
          typeof body.content !== 'string'
        )
          return jsonResponse(
            { error: 'deviceLinkId_agentId_path_content_required' },
            400,
          );
        {
          const link = getAgentLinkById(body.deviceLinkId);
          if (!link || link.userId !== authUserId || link.revokedAt) {
            return jsonResponse({ error: 'device_not_found' }, 404);
          }
        }
        return jsonResponse({
          memory: syncClientAgentMemory({
            userId: body.userId,
            deviceLinkId: body.deviceLinkId,
            agentId: body.agentId,
            path: body.path,
            content: body.content,
            source: 'client_sync',
            updatedBy: body.deviceLinkId,
          }),
        });
      default:
        return jsonResponse({ error: 'unsupported_operation' }, 400);
    }
  } catch (err) {
    return jsonResponse(
      { error: err instanceof Error ? err.message : String(err) },
      400,
    );
  }
}

export async function handleCloudSkillToolHttpRequest(
  request: Request,
): Promise<Response> {
  const authUserId = getToolAuthUserId(request);
  if (!authUserId)
    return jsonResponse({ error: 'unauthorized' }, 401);
  if (request.method !== 'POST')
    return jsonResponse({ error: 'method_not_allowed' }, 405);

  let body: CloudSkillToolBody;
  try {
    body = (await request.json()) as CloudSkillToolBody;
  } catch {
    return jsonResponse({ error: 'invalid_json' }, 400);
  }
  if (!body.operation)
    return jsonResponse({ error: 'missing_required_fields' }, 400);
  body.userId = authUserId;

  if (body.operation === 'list' || body.operation === 'search') {
    const query = body.query?.trim().toLowerCase();
    const skills = listCloudSkillsByUser(body.userId)
      .filter((skill) => skill.enabled)
      .filter(
        (skill) =>
          !query ||
          skill.skillId.toLowerCase().includes(query) ||
          skill.name.toLowerCase().includes(query) ||
          skill.description.toLowerCase().includes(query) ||
          (skill.packageName ?? '').toLowerCase().includes(query),
      )
      .map((skill) => ({
        id: skill.skillId,
        name: skill.name,
        description: skill.description,
        packageName: skill.packageName,
        sourceProvider: skill.sourceProvider,
        updatedAt: skill.updatedAt,
      }));
    return jsonResponse({ skills });
  }

  if (body.operation === 'get') {
    if (!body.skillId) return jsonResponse({ error: 'skillId_required' }, 400);
    const skill = getCloudSkill(body.userId, body.skillId);
    if (!skill || !skill.enabled)
      return jsonResponse({ error: 'skill_not_found' }, 404);
    return jsonResponse({
      skill: {
        id: skill.skillId,
        name: skill.name,
        description: skill.description,
        packageName: skill.packageName,
        sourceProvider: skill.sourceProvider,
        content: skill.content,
        updatedAt: skill.updatedAt,
      },
    });
  }

  return jsonResponse({ error: 'unsupported_operation' }, 400);
}

export async function handleRepoKnowledgeToolHttpRequest(
  request: Request,
): Promise<Response> {
  const authUserId = getToolAuthUserId(request);
  if (!authUserId)
    return jsonResponse({ error: 'unauthorized' }, 401);
  if (request.method !== 'POST')
    return jsonResponse({ error: 'method_not_allowed' }, 405);

  let body: RepoKnowledgeToolBody;
  try {
    body = (await request.json()) as RepoKnowledgeToolBody;
  } catch {
    return jsonResponse({ error: 'invalid_json' }, 400);
  }
  if (!body.operation)
    return jsonResponse({ error: 'missing_required_fields' }, 400);
  body.userId = authUserId;

  if (body.operation === 'list_repos') {
    return jsonResponse({
      repos: listManagedReposByUser(body.userId).map((repo) => ({
        id: repo.id,
        name: repo.name,
        kind: repo.kind,
        gitUrl: repo.gitUrl,
        devicePath: repo.devicePath,
        knowledge: getRepoKnowledgeIndex(repo.id, body.userId!) ?? null,
      })),
    });
  }

  if (body.operation === 'plugins') {
    return jsonResponse({ plugins: listRepoKnowledgePlugins() });
  }

  if (body.operation === 'search_backends') {
    return jsonResponse({ backends: listRepoKnowledgeSearchBackends() });
  }

  if (body.repoId) {
    const repo = getManagedRepoById(body.repoId);
    if (!repo || repo.createdBy !== body.userId) {
      return jsonResponse({ error: 'repo_not_found' }, 404);
    }
  }

  switch (body.operation) {
    case 'status':
      if (!body.repoId) return jsonResponse({ error: 'repoId_required' }, 400);
      return jsonResponse({ index: getRepoKnowledgeIndex(body.repoId, body.userId) ?? null });
    case 'search':
      if (!body.query) return jsonResponse({ error: 'query_required' }, 400);
      return jsonResponse({
        hits: searchRepoKnowledge({
          repoId: body.repoId,
          userId: body.userId,
          query: body.query,
          limit: body.limit,
          kind: body.kind,
          language: body.language,
          pathPrefix: body.pathPrefix,
          includeRelated: body.includeRelated,
        }),
      });
    case 'list_chunks':
      if (!body.repoId) return jsonResponse({ error: 'repoId_required' }, 400);
      return jsonResponse({
        chunks: listRepoKnowledgeChunks({
          repoId: body.repoId,
          userId: body.userId,
          path: body.path,
          kind: body.kind,
          language: body.language,
          pathPrefix: body.pathPrefix,
          limit: body.limit,
        }),
      });
    case 'get_chunk':
      if (!body.chunkId) return jsonResponse({ error: 'chunkId_required' }, 400);
      return jsonResponse({ chunk: getRepoKnowledgeChunk(body.chunkId, body.userId) ?? null });
    case 'graph':
      if (!body.repoId) return jsonResponse({ error: 'repoId_required' }, 400);
      return jsonResponse({
        edges: listRepoKnowledgeGraphEdges({
          repoId: body.repoId,
          userId: body.userId,
          path: body.path,
          edgeKind: body.edgeKind,
          limit: body.limit,
        }),
      });
    case 'related':
      if (!body.repoId) return jsonResponse({ error: 'repoId_required' }, 400);
      return jsonResponse(listRelatedRepoKnowledge({
        repoId: body.repoId,
        userId: body.userId,
        path: body.path,
        chunkId: body.chunkId,
        limit: body.limit,
      }));
    case 'context':
      if (!body.repoId) return jsonResponse({ error: 'repoId_required' }, 400);
      return jsonResponse({ context: getRepoKnowledgeContext({
        repoId: body.repoId,
        userId: body.userId,
        chunkId: body.chunkId,
        path: body.path,
        query: body.query,
        limit: body.limit,
      }) });
    default:
      return jsonResponse({ error: 'unsupported_operation' }, 400);
  }
}
