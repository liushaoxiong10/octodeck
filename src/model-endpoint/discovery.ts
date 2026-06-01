import type { ModelEndpointApiType } from './adapter.js';

export interface ProviderModelInfo {
  id: string;
  displayName: string;
}

export interface ProviderModelDiscoveryInput {
  apiType: ModelEndpointApiType;
  baseUrl: string;
  token: string;
}

type FetchLike = typeof fetch;

function joinUrl(baseUrl: string, suffix: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${suffix}`;
}

function modelsPath(apiType: ModelEndpointApiType): string {
  return apiType === 'claude' ? '/v1/models' : '/models';
}

function normalizeModelEntry(entry: unknown): ProviderModelInfo | null {
  if (!entry || typeof entry !== 'object') return null;
  const raw = entry as Record<string, unknown>;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id) return null;
  const displayName =
    (typeof raw.display_name === 'string' && raw.display_name.trim()) ||
    (typeof raw.displayName === 'string' && raw.displayName.trim()) ||
    (typeof raw.name === 'string' && raw.name.trim()) ||
    id;
  return { id, displayName };
}

export async function discoverProviderModels(
  input: ProviderModelDiscoveryInput,
  fetchImpl: FetchLike = fetch,
): Promise<ProviderModelInfo[]> {
  const baseUrl = input.baseUrl.trim() || 'https://api.anthropic.com';
  const url = joinUrl(baseUrl, modelsPath(input.apiType));
  const headers: Record<string, string> = { accept: 'application/json' };
  if (input.apiType === 'claude') {
    headers['x-api-key'] = input.token;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    headers.authorization = `Bearer ${input.token}`;
  }

  const response = await fetchImpl(url, { method: 'GET', headers });
  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(`models_fetch_failed:${response.status}:${text.slice(0, 200)}`);
  }

  const body = (await response.json()) as unknown;
  const data = Array.isArray((body as any)?.data)
    ? (body as any).data
    : Array.isArray(body)
      ? body
      : [];
  const seen = new Set<string>();
  const models: ProviderModelInfo[] = [];
  for (const entry of data) {
    const model = normalizeModelEntry(entry);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  return models;
}
