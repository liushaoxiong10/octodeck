import { Hono } from 'hono';

import { AGENT_RUNNER_SECRET } from '../config.js';
import { logger } from '../logger.js';
import { getProviders } from '../runtime-config.js';
import type { Variables } from '../web-context.js';
import {
  convertAnthropicRequest,
  convertToAnthropicResponse,
  type ModelEndpointApiType,
} from '../model-endpoint/adapter.js';

const modelProxyRoutes = new Hono<{ Variables: Variables }>();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function authOk(auth: string | null): boolean {
  return !!AGENT_RUNNER_SECRET && auth === `Bearer ${AGENT_RUNNER_SECRET}`;
}

function joinUrl(baseUrl: string, suffix: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${suffix}`;
}

function upstreamPath(apiType: ModelEndpointApiType): string {
  if (apiType === 'openai-chat') return '/chat/completions';
  if (apiType === 'openai-responses') return '/responses';
  return '/v1/messages';
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function* readSseLines(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trimEnd();
      buf = buf.slice(idx + 1);
      yield line;
    }
  }
  if (buf.trim()) yield buf.trim();
}

function convertStream(
  apiType: ModelEndpointApiType,
  upstream: ReadableStream<Uint8Array>,
  model: string,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = (chunk: string) => controller.enqueue(encoder.encode(chunk));
      push(
        sseEvent('message_start', {
          type: 'message_start',
          message: {
            id: `msg_${Date.now()}`,
            type: 'message',
            role: 'assistant',
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        }),
      );
      push(
        sseEvent('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        }),
      );
      try {
        for await (const line of readSseLines(upstream)) {
          if (!line.startsWith('data:')) continue;
          const raw = line.slice(5).trim();
          if (!raw || raw === '[DONE]') continue;
          let parsed: any;
          try {
            parsed = JSON.parse(raw);
          } catch {
            continue;
          }
          const delta =
            apiType === 'openai-chat'
              ? parsed?.choices?.[0]?.delta?.content
              : (parsed?.delta ?? parsed?.item?.content?.[0]?.text);
          if (typeof delta === 'string' && delta) {
            push(
              sseEvent('content_block_delta', {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: delta },
              }),
            );
          }
        }
        push(
          sseEvent('content_block_stop', {
            type: 'content_block_stop',
            index: 0,
          }),
        );
        push(
          sseEvent('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: 0 },
          }),
        );
        push(sseEvent('message_stop', { type: 'message_stop' }));
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
}

modelProxyRoutes.all('/:providerId/*', async (c) => {
  if (!authOk(c.req.header('authorization') ?? null)) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  if (c.req.method !== 'POST') {
    return c.json({ error: 'method_not_allowed' }, 405);
  }
  const providerId = c.req.param('providerId');
  const provider = getProviders().find((p) => p.id === providerId);
  if (!provider || !provider.enabled) {
    return c.json({ error: 'model endpoint not found' }, 404);
  }
  const apiType = provider.apiType || 'claude';
  const token = provider.anthropicAuthToken || provider.anthropicApiKey;
  if (apiType === 'claude') {
    return c.json({ error: 'claude endpoint should not use model proxy' }, 400);
  }
  if (!provider.anthropicBaseUrl || !token) {
    return c.json({ error: 'model endpoint missing baseUrl or token' }, 400);
  }

  let anthropicBody: any;
  try {
    anthropicBody = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const upstreamBody = convertAnthropicRequest(
    apiType,
    anthropicBody,
    provider.anthropicModel || anthropicBody.model || '',
  );
  const upstreamUrl = joinUrl(provider.anthropicBaseUrl, upstreamPath(apiType));
  try {
    const upstream = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(upstreamBody),
    });
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => upstream.statusText);
      return new Response(text, {
        status: upstream.status,
        headers: {
          'content-type': upstream.headers.get('content-type') || 'text/plain',
        },
      });
    }
    if (anthropicBody.stream && upstream.body) {
      return new Response(
        convertStream(apiType, upstream.body, provider.anthropicModel || ''),
        {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
          },
        },
      );
    }
    const body = await upstream.json();
    return json(convertToAnthropicResponse(apiType, body));
  } catch (err) {
    logger.warn({ err, providerId }, 'model proxy request failed');
    return c.json(
      { error: err instanceof Error ? err.message : 'model proxy failed' },
      502,
    );
  }
});

export default modelProxyRoutes;
