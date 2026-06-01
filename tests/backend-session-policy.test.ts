import { describe, expect, test } from 'vitest';

import { shouldInjectHistoryContext } from '../src/backends/session-policy.js';
import type { AgentBackend } from '../src/backends/types.js';

function backend(overrides: Partial<AgentBackend>): AgentBackend {
  return {
    id: 'test-backend',
    displayName: 'Test Backend',
    usesProviderPool: false,
    supportsExecutionMode: () => true,
    run: async () => ({ status: 'success', result: 'ok' }),
    ...overrides,
  };
}

describe('backend session policy', () => {
  test('keeps legacy history prompt injection for non-native backends', () => {
    expect(shouldInjectHistoryContext(backend({ supportsNativeSessions: false }))).toBe(true);
    expect(shouldInjectHistoryContext(backend({}))).toBe(true);
  });

  test('skips history prompt injection for backends with native sessions', () => {
    expect(shouldInjectHistoryContext(backend({ supportsNativeSessions: true }))).toBe(false);
  });
});
