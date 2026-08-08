'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  activeCatalogsFromManifest,
  normalizeBaseUrl,
  readSchedulerConfig,
  requestCatalogForPass,
  runCatalogPrewarm,
} = require('./catalog-prewarm');

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body);
    },
  };
}

const silentLogger = Object.freeze({
  info() {},
  warn() {},
  error() {},
});

test('catalog prewarm selects exactly 35 active catalogs and excludes only Stripchat', () => {
  const catalogs = Array.from({ length: 35 }, (_, index) => ({
    id: `active.${index + 1}`,
    type: 'movie',
  }));
  catalogs.push(
    { id: 'tpb4k.stripchat.girls', type: 'movie' },
    { id: 'tpb4k.stripchat.couples', type: 'movie' }
  );

  const active = activeCatalogsFromManifest({ catalogs });
  assert.equal(active.length, 35);
  assert.equal(active.some(item => item.id.includes('stripchat')), false);
});

test('catalog prewarm retries only missing rows and verifies the complete state', async () => {
  const manifest = {
    version: 'test',
    catalogs: [
      { id: 'catalog.a', type: 'movie' },
      { id: 'catalog.b', type: 'movie' },
      { id: 'catalog.c', type: 'movie' },
      { id: 'tpb4k.stripchat.girls', type: 'movie' },
      { id: 'tpb4k.stripchat.couples', type: 'movie' },
    ],
  };
  const calls = new Map();

  const fetchImpl = async url => {
    if (url.includes('/manifest.json')) return response(manifest);

    const match = url.match(/\/catalog\/movie\/(.+)\.json\?/);
    assert.ok(match, `Unexpected URL: ${url}`);
    const id = decodeURIComponent(match[1]);
    const count = (calls.get(id) || 0) + 1;
    calls.set(id, count);

    if (id === 'catalog.a') return response({ metas: [{ id: 'a' }] });
    if (id === 'catalog.b') {
      return response({ metas: count >= 2 ? [{ id: 'b' }] : [] });
    }
    if (id === 'catalog.c') {
      return response({ metas: count >= 3 ? [{ id: 'c' }] : [] });
    }
    throw new Error(`Unexpected catalog: ${id}`);
  };

  const result = await runCatalogPrewarm({
    baseUrl: 'http://127.0.0.1:10000/manifest.json',
    fetchImpl,
    logger: silentLogger,
    concurrency: 2,
    maxPasses: 4,
    retryDelayMs: 0,
    requestTimeoutMs: 1_000,
    expectedActiveCatalogs: 3,
    verificationPasses: 1,
  });

  assert.equal(result.success, true);
  assert.deepEqual(result.missingCatalogs, []);
  assert.equal(calls.get('catalog.a'), 2);
  assert.equal(calls.get('catalog.b'), 3);
  assert.equal(calls.get('catalog.c'), 4);
});

test('Sukebei receives one immediate retry before the rest of the startup pass finishes', async () => {
  let calls = 0;
  const posters = Array.from({ length: 24 }, (_, index) => ({
    id: `sukebei-${index}`,
    poster: `https://example.invalid/onlyporn/poster/metatube/${index}`,
  }));
  const result = await requestCatalogForPass({
    baseUrl: 'http://127.0.0.1:10000',
    catalog: { id: 'tpb4k.sukebei.top', type: 'movie' },
    runId: 'startup-test',
    pass: 1,
    fetchImpl: async () => {
      calls += 1;
      return response({ metas: calls === 1 ? [] : posters });
    },
    requestTimeoutMs: 1_000,
    immediateRetryDelayMs: 0,
  });

  assert.equal(calls, 2);
  assert.equal(result.healthy, true);
  assert.equal(result.metas, 24);
  assert.equal(result.immediateRetry.attempted, true);
  assert.equal(result.immediateRetry.firstMetas, 0);
});

test('scheduler defaults are enabled, bounded, and run every 23 hours', () => {
  const config = readSchedulerConfig({});
  assert.equal(config.enabled, true);
  assert.equal(config.concurrency, 3);
  assert.equal(config.intervalMs, 23 * 60 * 60 * 1000);
  assert.equal(config.expectedActiveCatalogs, 33);
  assert.equal(config.maxPasses, 6);
});

test('base URL normalization accepts the server manifest URL', () => {
  assert.equal(
    normalizeBaseUrl('http://127.0.0.1:10000/manifest.json'),
    'http://127.0.0.1:10000'
  );
});
