import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

export const REMOTE_LOCAL_TOOL_NAMES = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'Glob',
  'Grep',
  'LS',
  'NotebookEdit',
];

export interface RemoteMcpToolOptions {
  linkId: string;
  cwd: string;
  serverBaseUrl: string;
  secret: string;
  timeoutMs: number;
  maxOutputBytes: number;
  fetchImpl?: typeof fetch;
}

interface RemoteBridgeResponse {
  ok?: boolean;
  result?: unknown;
  error?: string | null;
  durationMs?: number;
}

function remoteToolTimeoutMs(defaultTimeoutMs: number, input: unknown): number {
  if (!input || typeof input !== 'object') return defaultTimeoutMs;
  const timeout = (input as { timeout_ms?: unknown }).timeout_ms;
  return typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0
    ? timeout
    : defaultTimeoutMs;
}

function stringifyResult(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.content === 'string') return obj.content;
    if (typeof obj.stdout === 'string' || typeof obj.stderr === 'string') {
      return [obj.stdout, obj.stderr].filter(Boolean).join('');
    }
  }
  return JSON.stringify(value, null, 2);
}

export function createRemoteMcpTools(opts: RemoteMcpToolOptions): SdkMcpToolDefinition<any>[] {
  const fetcher = opts.fetchImpl ?? fetch;
  const callRemote = async (toolName: string, input: unknown) => {
    const url = new URL('/api/agent-link/tool', opts.serverBaseUrl).toString();
    const res = await fetcher(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${opts.secret}`,
      },
      body: JSON.stringify({
        linkId: opts.linkId,
        toolName,
        input,
        cwd: opts.cwd,
        timeoutMs: remoteToolTimeoutMs(opts.timeoutMs, input),
        maxOutputBytes: opts.maxOutputBytes,
      }),
    });
    const body = (await res.json()) as RemoteBridgeResponse;
    if (!res.ok || body.ok === false) {
      return {
        content: [{ type: 'text' as const, text: body.error || `remote ${toolName} failed` }],
        isError: true,
      };
    }
    return { content: [{ type: 'text' as const, text: stringifyResult(body.result) }] };
  };

  return [
    tool('remote_bash', 'Run a shell command on the connected octodeck-daemon client machine.', {
      command: z.string(),
      timeout_ms: z.number().int().positive().optional(),
    }, (args) => callRemote('Bash', args)),
    tool('remote_read', 'Read a file from the connected octodeck-daemon client workspace.', {
      file_path: z.string(),
      offset: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().optional(),
    }, (args) => callRemote('Read', args)),
    tool('remote_write', 'Write a file on the connected octodeck-daemon client workspace.', {
      file_path: z.string(),
      content: z.string(),
    }, (args) => callRemote('Write', args)),
    tool('remote_edit', 'Edit a file on the connected octodeck-daemon client workspace by replacing text.', {
      file_path: z.string(),
      old_string: z.string(),
      new_string: z.string(),
      replace_all: z.boolean().optional(),
    }, (args) => callRemote('Edit', args)),
    tool('remote_glob', 'Find files by glob pattern on the connected octodeck-daemon client workspace.', {
      pattern: z.string(),
      path: z.string().optional(),
    }, (args) => callRemote('Glob', args)),
    tool('remote_grep', 'Search file contents on the connected octodeck-daemon client workspace.', {
      pattern: z.string(),
      path: z.string().optional(),
      glob: z.string().optional(),
      head_limit: z.number().int().positive().optional(),
    }, (args) => callRemote('Grep', args)),
    tool('remote_ls', 'List a directory on the connected octodeck-daemon client workspace.', {
      path: z.string(),
    }, (args) => callRemote('LS', args)),
    tool('remote_web_fetch', 'Fetch a URL from the connected octodeck-daemon client network.', {
      url: z.string(),
      raw: z.boolean().optional(),
    }, (args) => callRemote('WebFetch', args)),
    tool('remote_web_search', 'Search the web from the connected octodeck-daemon client network.', {
      query: z.string(),
    }, (args) => callRemote('WebSearch', args)),
  ];
}
