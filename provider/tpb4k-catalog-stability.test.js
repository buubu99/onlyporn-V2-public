'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  Tpb4kProvider,
  catalogCacheKey,
  legacyCatalogCacheSuffix,
} = require('./tpb4k');

const {
  createCatalogResponseStore,
} = require('./tpb4k/catalog-response-store');

const ARGS = Object.freeze({
  type: 'movie',
  id: 'tpb4k.studio.vixen.top',
  extra: Object.freeze({ skip: 0 }),
});

test('catalog cache keys use a compatibility revision, not package version', () => {
  assert.equal(catalogCacheKey(ARGS), 'r7:movie:tpb4k.studio.vixen.top:0');
  assert.equal(legacyCatalogCacheSuffix(ARGS), ':r7:movie:tpb4k.studio.vixen.top:0');
  assert.doesNotMatch(catalogCacheKey(ARGS), /2\.7\.0-alpha/);
});

test('persistent store selects newest compatible prior-release record', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyporn-catalog-cache-'));
  const filePath = path.join(directory, 'catalog-responses-v1.json');
  let current = 1_000_000;

  try {
    const store = createCatalogResponseStore({
      filePath,
      enabled: true,
      ttlMs: 60 * 60 * 1000,
      now: () => current,
    });

    const stableKey = catalogCacheKey(ARGS);
    store.set(`2.7.0-alpha.24:${stableKey}`, { metas: [{ id: 'older' }] });
    current += 1;
    store.set(`2.7.0-alpha.25:${stableKey}`, { metas: [{ id: 'newer' }] });

    const record = store.findByKeySuffix(`:${stableKey}`);
    assert.equal(record.key, `2.7.0-alpha.25:${stableKey}`);
    assert.equal(record.value.metas[0].id, 'newer');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('provider migrates prior-release last-known-good without rebuilding', async () => {
  const stableKey = catalogCacheKey(ARGS);
  const legacyValue = Object.freeze({
    metas: Object.freeze([{ id: 'cached-vixen' }]),
  });
  const writes = [];

  const store = {
    get() { return null; },
    findByKeySuffix(suffix) {
      assert.equal(suffix, `:${stableKey}`);
      return Object.freeze({
        key: `2.7.0-alpha.25:${stableKey}`,
        savedAt: Date.now(),
        value: legacyValue,
      });
    },
    set(key, value) {
      writes.push([key, value]);
      return true;
    },
    findMeta() { return null; },
    findMetaByIdentity() { return null; },
  };

  const provider = new Tpb4kProvider({
    env: { TPB4K_ENABLED: 'true' },
    installBuiltIns: false,
    catalogResponseStore: store,
  });

  let rebuilds = 0;
  provider._handleCatalogFresh = async () => {
    rebuilds += 1;
    return { metas: [] };
  };

  const result = await provider.handleCatalog(ARGS);

  assert.equal(rebuilds, 0);
  assert.equal(result.metas[0].id, 'cached-vixen');
  assert.deepEqual(writes, [[stableKey, legacyValue]]);
});
