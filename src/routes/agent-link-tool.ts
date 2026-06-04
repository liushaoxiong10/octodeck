import { getSession } from '../agent-link/registry.js';
import { invokeRemoteTool } from '../agent-link/tool-rpc.js';
import { LONG_RUNNING_LOCAL_CLI_TIMEOUT_MS } from '../runtime-config.js';
import { getCloudSkill, listCloudSkillsByUser } from '../db.js';
import {
  appendCloudMemory,
  getCloudMemory,
  putCloudMemory,
  searchCloudMemory,
  syncClientAgentMemory,
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
}

interface CloudSkillToolBody {
  userId?: string;
  operation?: string;
  skillId?: string;
  query?: string;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export async function handleAgentLinkToolHttpRequest(
  request: Request,
): Promise<Response> {
  const secret = process.env.OCTODECK_AGENT_RUNNER_SECRET;
  const auth = request.headers.get('authorization') || '';
  if (!secret || auth !== `Bearer ${secret}`) {
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
  const secret = process.env.OCTODECK_AGENT_RUNNER_SECRET;
  const auth = request.headers.get('authorization') || '';
  if (!secret || auth !== `Bearer ${secret}`)
    return jsonResponse({ error: 'unauthorized' }, 401);
  if (request.method !== 'POST')
    return jsonResponse({ error: 'method_not_allowed' }, 405);

  let body: MemoryHttpBody;
  try {
    body = (await request.json()) as MemoryHttpBody;
  } catch {
    return jsonResponse({ error: 'invalid_json' }, 400);
  }

  if (!body.userId || !body.operation)
    return jsonResponse({ error: 'missing_required_fields' }, 400);

  try {
    switch (body.operation) {
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
  const secret = process.env.OCTODECK_AGENT_RUNNER_SECRET;
  const auth = request.headers.get('authorization') || '';
  if (!secret || auth !== `Bearer ${secret}`)
    return jsonResponse({ error: 'unauthorized' }, 401);
  if (request.method !== 'POST')
    return jsonResponse({ error: 'method_not_allowed' }, 405);

  let body: CloudSkillToolBody;
  try {
    body = (await request.json()) as CloudSkillToolBody;
  } catch {
    return jsonResponse({ error: 'invalid_json' }, 400);
  }
  if (!body.userId || !body.operation)
    return jsonResponse({ error: 'missing_required_fields' }, 400);

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
