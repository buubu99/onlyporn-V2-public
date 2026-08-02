'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Provider = require('./provider');
const {
  createLegacyCatalogStore,
  legacyCatalogKey,
} = require('./catalog-last-known-good');

function memoryStore() {
  const values = new Map();
  return {
    get(key) {
      return values.get(key) || null;
    },
    set(key, value) {
      values.set(key, {
        key,
        savedAt: Date.now(),
        value,
      });
      return true;
    },
  };
}

class FixtureProvider extends Provider {
  constructor(options = {}) {
    super('https://example.com', 'fixture', 10, options);
    this.mode = 'success';
    this.fetches = [];
  }

  getInitialUrl() {
    return 'https://example.com/root/';
  }

  getCatalogFallbackUrls() {
    return ['https://example.com/fallback/'];
  }

  async fetchHtml(url) {
    this.fetches.push(url);
    if (this.mode === 'error') throw new Error('HTTP 403');
    if (this.mode === 'primary-error' && url.includes('/root/')) {
      throw new Error('HTTP 403');
    }
    return this.mode === 'empty' ? 'empty' : 'success';
  }

  getCatalogMetas(html) {
    if (html === 'empty') return [];
    return Array.from({ length: 8 }, (_, index) => ({
      id: `https://example.com/video/${index + 1}`,
      type: 'movie',
      name: `Fixture ${index + 1}`,
    }));
  }
}

test('legacy catalog key separates skip, search, and genre variants', () => {
  const base = { type: 'movie', id: 'fixture', extra: {} };
  const keys = new Set([
    legacyCatalogKey('fixture', base),
    legacyCatalogKey('fixture', { ...base, extra: { skip: 10 } }),
    legacyCatalogKey('fixture', { ...base, extra: { search: 'alpha' } }),
    legacyCatalogKey('fixture', { ...base, extra: { genre: 'new' } }),
  ]);
  assert.equal(keys.size, 4);
});

test('provider returns permanent last-known-good after a later HTTP 403', async () => {
  let now = 1_000_000;
  const store = memoryStore();
  const provider = new FixtureProvider({
    catalogResponseStore: store,
    now: () => now,
    catalogCacheTtlMs: 15 * 60 * 1000,
  });
  const args = { type: 'movie', id: 'fixture', extra: {} };

  const first = await provider.handleCatalog(args);
  assert.equal(first.metas.length, 8);

  now += 16 * 60 * 1000;
  provider.mode = 'error';
  const stale = await provider.handleCatalog(args);
  assert.equal(stale.metas.length, 8);

  await new Promise(resolve => setImmediate(resolve));
  const again = await provider.handleCatalog(args);
  assert.equal(again.metas.length, 8);
});

test('empty or severely regressed refresh never overwrites a healthy root row', async () => {
  let now = 2_000_000;
  const provider = new FixtureProvider({
    catalogResponseStore: memoryStore(),
    now: () => now,
    catalogCacheTtlMs: 1_000,
  });
  const args = { type: 'movie', id: 'fixture', extra: {} };

  assert.equal((await provider.handleCatalog(args)).metas.length, 8);
  now += 2_000;
  provider.mode = 'empty';
  assert.equal((await provider.handleCatalog(args)).metas.length, 8);
});

test('provider tries an approved fallback route on a cold primary 403', async () => {
  const provider = new FixtureProvider({
    catalogResponseStore: memoryStore(),
  });
  provider.mode = 'primary-error';

  const result = await provider.handleCatalog({
    type: 'movie',
    id: 'fixture',
    extra: {},
  });

  assert.equal(result.metas.length, 8);
  assert.deepEqual(provider.fetches, [
    'https://example.com/root/',
    'https://example.com/fallback/',
  ]);
});

test('legacy catalog last-known-good survives a new provider instance', async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'onlyporn-legacy-lkg-')
  );
  const filePath = path.join(directory, 'legacy.json');

  try {
    const args = { type: 'movie', id: 'fixture', extra: {} };
    const firstStore = createLegacyCatalogStore({
      enabled: true,
      filePath,
    });
    const firstProvider = new FixtureProvider({
      catalogResponseStore: firstStore,
    });
    assert.equal((await firstProvider.handleCatalog(args)).metas.length, 8);

    const secondStore = createLegacyCatalogStore({
      enabled: true,
      filePath,
    });
    const secondProvider = new FixtureProvider({
      catalogResponseStore: secondStore,
    });
    secondProvider.mode = 'error';

    assert.equal((await secondProvider.handleCatalog(args)).metas.length, 8);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
