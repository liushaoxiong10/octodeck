export type ModelEndpointApiType = 'claude' | 'openai-chat' | 'openai-responses';

type AnthropicContent = string | Array<Record<string, unknown>>;

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicContent;
}

interface AnthropicRequest {
  model?: string;
  system?: string | Array<Record<string, unknown>>;
  messages?: AnthropicMessage[];
  max_tokens?: number;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  tools?: unknown;
  tool_choice?: unknown;
}

function contentToText(content: AnthropicContent | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (part?.type === 'text' && typeof part.text === 'string') return part.text;
      if (part?.type === 'tool_result') return JSON.stringify(part.content ?? '');
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function systemToText(system: AnthropicRequest['system']): string | undefined {
  if (typeof system === 'string') return system;
  const text = contentToText(system as AnthropicContent);
  return text || undefined;
}

function finishReason(reason: string | null | undefined): string {
  switch (reason) {
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'stop':
    default:
      return 'end_turn';
  }
}

export function convertAnthropicToOpenAIChat(req: AnthropicRequest, model: string): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];
  const system = systemToText(req.system);
  if (system) messages.push({ role: 'system', content: system });
  for (const msg of req.messages ?? []) {
    messages.push({ role: msg.role, content: contentToText(msg.content) });
  }
  return {
    model,
    messages,
    ...(req.max_tokens !== undefined ? { max_tokens: req.max_tokens } : {}),
    ...(req.stream !== undefined ? { stream: req.stream } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.top_p !== undefined ? { top_p: req.top_p } : {}),
    ...(req.stop_sequences ? { stop: req.stop_sequences } : {}),
  };
}

function anthropicInputContent(content: AnthropicContent): Array<Record<string, unknown>> {
  if (typeof content === 'string') return [{ type: 'input_text', text: content }];
  return content
    .map((part) => {
      if (part.type === 'text') return { type: 'input_text', text: part.text ?? '' };
      return null;
    })
    .filter(Boolean) as Array<Record<string, unknown>>;
}

export function convertAnthropicToOpenAIResponses(req: AnthropicRequest, model: string): Record<string, unknown> {
  return {
    model,
    ...(systemToText(req.system) ? { instructions: systemToText(req.system) } : {}),
    input: (req.messages ?? []).map((msg) => ({
      role: msg.role,
      content: anthropicInputContent(msg.content),
    })),
    ...(req.max_tokens !== undefined ? { max_output_tokens: req.max_tokens } : {}),
    ...(req.stream !== undefined ? { stream: req.stream } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.top_p !== undefined ? { top_p: req.top_p } : {}),
  };
}

export function convertOpenAIChatToAnthropic(resp: any): Record<string, unknown> {
  const choice = resp?.choices?.[0] ?? {};
  const text = choice?.message?.content ?? '';
  return {
    id: resp?.id ?? `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: resp?.model ?? '',
    content: [{ type: 'text', text }],
    stop_reason: finishReason(choice?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: resp?.usage?.prompt_tokens ?? resp?.usage?.input_tokens ?? 0,
      output_tokens: resp?.usage?.completion_tokens ?? resp?.usage?.output_tokens ?? 0,
    },
  };
}

export function convertOpenAIResponsesToAnthropic(resp: any): Record<string, unknown> {
  const output = Array.isArray(resp?.output) ? resp.output : [];
  const texts: string[] = [];
  for (const item of output) {
    for (const part of item?.content ?? []) {
      if (part?.type === 'output_text' && typeof part.text === 'string') texts.push(part.text);
    }
  }
  return {
    id: resp?.id ?? `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: resp?.model ?? '',
    content: [{ type: 'text', text: texts.join('') }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: resp?.usage?.input_tokens ?? 0,
      output_tokens: resp?.usage?.output_tokens ?? 0,
    },
  };
}

export function convertAnthropicRequest(apiType: ModelEndpointApiType, req: AnthropicRequest, model: string): Record<string, unknown> {
  if (apiType === 'openai-chat') return convertAnthropicToOpenAIChat(req, model);
  if (apiType === 'openai-responses') return convertAnthropicToOpenAIResponses(req, model);
  return { ...req, model };
}

export function convertToAnthropicResponse(apiType: ModelEndpointApiType, resp: unknown): Record<string, unknown> {
  if (apiType === 'openai-chat') return convertOpenAIChatToAnthropic(resp);
  if (apiType === 'openai-responses') return convertOpenAIResponsesToAnthropic(resp);
  return resp as Record<string, unknown>;
}
