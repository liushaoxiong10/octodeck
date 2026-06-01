import { describe, expect, test } from 'vitest';

import { ModelDiscoveryRequestSchema, UnifiedProviderCreateSchema } from '../src/schemas.js';
import { providerToConfig, type UnifiedProvider } from '../src/runtime-config.js';
import {
  convertAnthropicToOpenAIChat,
  convertAnthropicToOpenAIResponses,
  convertOpenAIChatToAnthropic,
  convertOpenAIResponsesToAnthropic,
} from '../src/model-endpoint/adapter.js';
import { discoverProviderModels } from '../src/model-endpoint/discovery.js';

describe('model endpoint api types', () => {
  test('accepts OpenAI chat and responses endpoint types in provider schema', () => {
    expect(
      UnifiedProviderCreateSchema.parse({
        name: 'OpenAI Chat',
        type: 'third_party',
        apiType: 'openai-chat',
        anthropicBaseUrl: 'https://api.openai.com/v1',
        anthropicAuthToken: 'sk-test',
        anthropicModel: 'gpt-5',
      }).apiType,
    ).toBe('openai-chat');

    expect(
      UnifiedProviderCreateSchema.parse({
        name: 'OpenAI Responses',
        type: 'third_party',
        apiType: 'openai-responses',
        anthropicBaseUrl: 'https://api.openai.com/v1',
        anthropicAuthToken: 'sk-test',
        anthropicModel: 'gpt-5',
      }).apiType,
    ).toBe('openai-responses');
  });

  test('routes non-Claude endpoint through local model proxy for cloud access', () => {
    const provider: UnifiedProvider = {
      id: 'p_openai',
      name: 'OpenAI',
      type: 'third_party',
      apiType: 'openai-chat',
      enabled: true,
      weight: 1,
      anthropicBaseUrl: 'https://api.openai.com/v1',
      anthropicAuthToken: 'sk-test',
      anthropicApiKey: '',
      claudeCodeOauthToken: '',
      claudeOAuthCredentials: null,
      anthropicModel: 'gpt-5',
      customEnv: {},
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    const config = providerToConfig(provider, { proxyBaseUrl: 'http://127.0.0.1:3000' });

    expect(config.anthropicBaseUrl).toBe('http://127.0.0.1:3000/api/model-proxy/p_openai');
    expect(config.anthropicApiKey).toBeTruthy();
    expect(config.anthropicAuthToken).toBe('');
    expect(config.anthropicModel).toBe('gpt-5');
  });
});

describe('OpenAI endpoint conversion', () => {
  test('converts Anthropic messages request to OpenAI Chat Completions request', () => {
    const converted = convertAnthropicToOpenAIChat({
      model: 'claude-ignored',
      system: 'Be concise',
      max_tokens: 256,
      stream: false,
      messages: [{ role: 'user', content: 'hello' }],
    }, 'gpt-5');

    expect(converted).toEqual({
      model: 'gpt-5',
      messages: [
        { role: 'system', content: 'Be concise' },
        { role: 'user', content: 'hello' },
      ],
      max_tokens: 256,
      stream: false,
    });
  });

  test('converts OpenAI Chat Completions response to Anthropic message response', () => {
    const converted = convertOpenAIChatToAnthropic({
      id: 'chatcmpl_1',
      model: 'gpt-5',
      choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    });

    expect(converted).toMatchObject({
      id: 'chatcmpl_1',
      type: 'message',
      role: 'assistant',
      model: 'gpt-5',
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 3, output_tokens: 2 },
    });
  });

  test('converts Anthropic messages request to OpenAI Responses request', () => {
    const converted = convertAnthropicToOpenAIResponses({
      model: 'claude-ignored',
      system: 'Use tools carefully',
      max_tokens: 128,
      stream: true,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'list files' }] }],
    }, 'gpt-5');

    expect(converted).toEqual({
      model: 'gpt-5',
      instructions: 'Use tools carefully',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'list files' }] }],
      max_output_tokens: 128,
      stream: true,
    });
  });

  test('converts OpenAI Responses response to Anthropic message response', () => {
    const converted = convertOpenAIResponsesToAnthropic({
      id: 'resp_1',
      model: 'gpt-5',
      output: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
      ],
      usage: { input_tokens: 5, output_tokens: 1 },
    });

    expect(converted).toMatchObject({
      id: 'resp_1',
      type: 'message',
      role: 'assistant',
      model: 'gpt-5',
      content: [{ type: 'text', text: 'done' }],
      usage: { input_tokens: 5, output_tokens: 1 },
    });
  });
});

describe('model endpoint discovery', () => {
  test('validates ad-hoc model discovery request for provider creation', () => {
    const parsed = ModelDiscoveryRequestSchema.parse({
      apiType: 'openai-chat',
      baseUrl: 'https://api.example.com/v1',
      token: 'sk-test',
    });

    expect(parsed).toEqual({
      apiType: 'openai-chat',
      baseUrl: 'https://api.example.com/v1',
      token: 'sk-test',
    });
  });

  test('accepts fetched models when creating a provider', () => {
    const parsed = UnifiedProviderCreateSchema.parse({
      name: 'OpenAI',
      type: 'third_party',
      apiType: 'openai-chat',
      anthropicBaseUrl: 'https://api.example.com/v1',
      anthropicAuthToken: 'sk-test',
      anthropicModel: 'gpt-5',
      models: [{ id: 'gpt-5', displayName: 'GPT-5' }],
    });

    expect(parsed.models).toEqual([{ id: 'gpt-5', displayName: 'GPT-5' }]);
  });

  test('discovers OpenAI-compatible models from /models', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const models = await discoverProviderModels(
      {
        apiType: 'openai-chat',
        baseUrl: 'https://api.example.com/v1/',
        token: 'sk-test',
      },
      async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({
          data: [
            { id: 'gpt-5' },
            { id: 'gpt-4.1', display_name: 'GPT 4.1' },
          ],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    );

    expect(calls[0].url).toBe('https://api.example.com/v1/models');
    expect(calls[0].init?.headers).toMatchObject({ authorization: 'Bearer sk-test' });
    expect(models).toEqual([
      { id: 'gpt-5', displayName: 'gpt-5' },
      { id: 'gpt-4.1', displayName: 'GPT 4.1' },
    ]);
  });

  test('discovers Anthropic models from /v1/models with Anthropic headers', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const models = await discoverProviderModels(
      {
        apiType: 'claude',
        baseUrl: 'https://api.anthropic.com',
        token: 'sk-ant-test',
      },
      async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({
          data: [{ id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5' }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    );

    expect(calls[0].url).toBe('https://api.anthropic.com/v1/models');
    expect(calls[0].init?.headers).toMatchObject({
      'x-api-key': 'sk-ant-test',
      'anthropic-version': '2023-06-01',
    });
    expect(models).toEqual([{ id: 'claude-sonnet-4-5', displayName: 'Claude Sonnet 4.5' }]);
  });
});
