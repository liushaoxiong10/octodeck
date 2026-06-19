import { beforeEach, describe, expect, test, vi } from 'vitest';

type MockRequest = { url: string };

type MockCache = {
  keys: ReturnType<typeof vi.fn<() => Promise<MockRequest[]>>>;
  delete: ReturnType<typeof vi.fn<(req: MockRequest) => Promise<boolean>>>;
};

function makeCache(keys: string[]): MockCache {
  const requests = keys.map((url) => ({ url }));
  return {
    keys: vi.fn(async () => requests),
    delete: vi.fn(async () => true),
  };
}

describe('pwa cache invalidation', () => {
  let cachesMock: {
    open: ReturnType<typeof vi.fn<(name: string) => Promise<MockCache>>>;
  };
  let cacheByName: Map<string, MockCache>;

  beforeEach(() => {
    cacheByName = new Map([
      [
        'api-groups-cache',
        makeCache([
          'https://octodeck.test/api/groups/web%3Amain/messages',
          'https://octodeck.test/api/other',
        ]),
      ],
      [
        'api-core-cache',
        makeCache([
          'https://octodeck.test/api/groups',
          'https://octodeck.test/api/auth/me',
        ]),
      ],
    ]);
    cachesMock = {
      open: vi.fn(async (name: string) => {
        const cache = cacheByName.get(name);
        if (!cache) throw new Error(`unknown cache ${name}`);
        return cache;
      }),
    };
    vi.stubGlobal('window', { caches: cachesMock });
    vi.stubGlobal('caches', cachesMock);
  });

  test('invalidateGroupsListCache deletes /api/groups from the actual core cache', async () => {
    const { invalidateGroupsListCache } = await import('../web/src/utils/pwaCache.js');

    await invalidateGroupsListCache();

    expect(cachesMock.open).toHaveBeenCalledWith('api-groups-cache');
    expect(cachesMock.open).toHaveBeenCalledWith('api-core-cache');
    expect(cacheByName.get('api-core-cache')?.delete).toHaveBeenCalledWith({
      url: 'https://octodeck.test/api/groups',
    });
    expect(cacheByName.get('api-groups-cache')?.delete).not.toHaveBeenCalled();
  });
});
