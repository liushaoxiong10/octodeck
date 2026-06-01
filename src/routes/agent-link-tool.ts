import { getSession } from '../agent-link/registry.js';
import { invokeRemoteTool } from '../agent-link/tool-rpc.js';

interface ToolHttpBody {
  linkId?: string;
  toolName?: string;
  input?: unknown;
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export async function handleAgentLinkToolHttpRequest(request: Request): Promise<Response> {
  const secret = process.env.HAPPYCLAW_AGENT_RUNNER_SECRET;
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
      timeoutMs: body.timeoutMs && body.timeoutMs > 0 ? body.timeoutMs : 120_000,
      maxOutputBytes: body.maxOutputBytes && body.maxOutputBytes > 0 ? body.maxOutputBytes : 1_048_576,
    });
    return jsonResponse(result);
  } catch (err) {
    return jsonResponse(
      { error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
}
