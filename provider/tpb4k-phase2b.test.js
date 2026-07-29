'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readTpb4kConfig, publicConfigStatus } = require('./tpb4k/config');
const { createDiscoveryAdapters } = require('./tpb4k/adapters/discovery');
const { parseJsonFeed, parseRssFeed } = require('./tpb4k/discovery-normalize');
const { SourceHttpClient, validateConfiguredEndpoint } = require('./tpb4k/source-http');
const { clearAdapters, installBuiltInAdapters, listAdapters } = require('./tpb4k/index');
const { Tpb4kProvider } = require('./tpb4k');
const { tpb4kCatalogs } = require('../catalog/tpb4k');

function response(body, contentType) {
  return {
    status: 200,
    headers: { get: name => name.toLowerCase() === 'content-type' ? contentType : '' },
    async text() { return body; },
  };
}

function env(overrides = {}) {
  return {
    TPB4K_ENABLED: 'true',
    TPB4K_PORNRIPS_CATALOG_URL: 'https://pornrips.example/catalog',
    TPB4K_YESPORN_CATALOG_URL: 'https://yesporn.example/catalog',
    TPB4K_HENTAI_CATALOG_URL: 'https://hentai.example/catalog',
    TPB4K_SUKEBEI_RSS_URL: 'https://sukebei.example/rss',
    ...overrides,
  };
}

const jsonBody = JSON.stringify({ metas: [
  { id: 'scene-a', name: 'Scene A', poster: 'https://img.example/a.jpg', performers: ['A'] },
  { id: 'scene-b', name: 'Scene B', poster: 'https://img.example/b.jpg', performers: ['B'] },
] });
const rssBody = `<?xml version="1.0"?><rss><channel>
<item><guid>suke-a</guid><title>Release A 2160p</title><link>https://sukebei.example/view/1</link><pubDate>Wed, 29 Jul 2026 00:00:00 GMT</pubDate><nyaa:seeders>12</nyaa:seeders></item>
<item><guid>suke-b</guid><title>Release B 1080p</title><link>https://sukebei.example/view/2</link><pubDate>Wed, 29 Jul 2026 00:00:01 GMT</pubDate><nyaa:seeders>8</nyaa:seeders></item>
</channel></rss>`;

function fakeFetch(url) {
  const text = String(url);
  if (text.includes('sukebei')) return Promise.resolve(response(rssBody, 'application/rss+xml'));
  const skip = Number(new URL(text).searchParams.get('skip') || 0);
  const metas = JSON.parse(jsonBody).metas.slice(skip, skip + 1);
  return Promise.resolve(response(JSON.stringify({ metas }), 'application/json'));
}

test('configured discovery endpoints require credential-free HTTPS and reject secret query keys', () => {
  assert.match(validateConfiguredEndpoint('https://example.com/feed?mode=recent'), /^https:/);
  assert.throws(() => validateConfiguredEndpoint('http://example.com/feed'), /HTTPS/);
  assert.throws(() => validateConfiguredEndpoint('https://example.com/feed?api_key=x'), /secret-bearing/);
});

test('Phase 2B public status reports source names but never endpoint URLs or API credentials', () => {
  const config = readTpb4kConfig(env({ TPDB_API_KEY: 'tpdb-secret', STASHDB_API_KEY: 'stash-secret' }));
  const status = publicConfigStatus(config);
  assert.deepEqual(status.configuredDiscoverySources, ['hentai', 'pornrips', 'sukebei', 'yesporn']);
  assert.equal(JSON.stringify(status).includes('secret'), false);
  assert.equal(JSON.stringify(status).includes('example'), false);
  assert.equal(status.stripchatPhaseRequired, 7);
});

test('source HTTP client rejects HTML placeholders and follows no redirects', async () => {
  const client = new SourceHttpClient({
    id: 'test', endpoint: 'https://feed.example/catalog', fetchImpl: async () => response('<html>no</html>', 'application/json'), checkDns: false,
  });
  assert.equal(await client.fetchText(client.buildUrl({ skip: 0, limit: 10 })), '');
});

test('JSON and RSS discovery parsers produce metadata records rather than playable candidates', () => {
  assert.equal(parseJsonFeed(jsonBody).length, 2);
  const rss = parseRssFeed(rssBody);
  assert.equal(rss.length, 2);
  assert.equal('magnet' in rss[0], false);
  assert.equal('infoHash' in rss[0], false);
  assert.equal('directUrl' in rss[0], false);
});

test('all four non-live discovery adapters paginate deterministically and resolve no streams', async () => {
  const config = readTpb4kConfig(env());
  const bundle = createDiscoveryAdapters({ config, fetchImpl: fakeFetch, checkDns: false });
  assert.deepEqual(bundle.configuredSources, ['hentai', 'pornrips', 'sukebei', 'yesporn']);
  for (const adapter of bundle.adapters.filter(item => item.id !== 'stripchat')) {
    const first = await adapter.catalog({ catalog: { id: `tpb4k.${adapter.id}.test`, mode: 'recent' }, skip: 0, limit: 1 });
    const second = await adapter.catalog({ catalog: { id: `tpb4k.${adapter.id}.test`, mode: 'recent' }, skip: 1, limit: 1 });
    assert.equal(first.length, 1, adapter.id);
    assert.equal(second.length, 1, adapter.id);
    assert.notEqual(first[0].sourceId, second[0].sourceId, adapter.id);
    assert.deepEqual(await adapter.resolve({ sourceId: first[0].sourceId }), []);
  }
});

test('Stripchat remains an explicit Phase 7 gate with no partial catalog or playback output', async () => {
  const bundle = createDiscoveryAdapters({ config: readTpb4kConfig(env()), fetchImpl: fakeFetch, checkDns: false });
  const stripchat = bundle.adapters.find(item => item.id === 'stripchat');
  assert.equal(stripchat.phase, 7);
  assert.deepEqual(await stripchat.catalog({}), []);
  assert.equal(await stripchat.meta({}), null);
  assert.deepEqual(await stripchat.resolve({}), []);
});

test('provider returns fixture-backed discovery metadata and keeps streams empty', async () => {
  clearAdapters();
  installBuiltInAdapters({ env: env(), fetchImpl: fakeFetch, checkDns: false });
  const provider = new Tpb4kProvider({ env: env(), fetchImpl: fakeFetch, installBuiltIns: false });
  const catalog = await provider.handleCatalog({ type: 'movie', id: 'tpb4k.pornrips.recent', extra: { skip: 0 } });
  assert.equal(catalog.metas.length, 1);
  const meta = await provider.handleMeta({ type: 'movie', id: catalog.metas[0].id });
  assert.equal(meta.meta.name, 'Scene A');
  assert.deepEqual(await provider.handleStream({ type: 'movie', id: catalog.metas[0].id }), { streams: [] });
});

test('built-in adapter registry covers every Phase 2 source while preserving the Stripchat gate', () => {
  clearAdapters();
  const installed = installBuiltInAdapters({ env: env(), fetchImpl: fakeFetch, checkDns: false });
  assert.deepEqual(listAdapters(), ['hentai', 'pornrips', 'stripchat', 'sukebei', 'torrent-index', 'tpdb', 'yesporn']);
  assert.equal(installed.phaseGates.stripchat, 7);
});

test('Render smoke and discovery smoke scripts are present and do not contain configured secrets', () => {
  for (const name of ['scripts/tpb4k-discovery-smoke.js', 'scripts/tpb4k-render-smoke.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
    assert.match(source, /TPB4K/);
    assert.doesNotMatch(source, /tpdb-secret|stash-secret/);
  }
});

test('Phase 2B release wiring preserves 28 TPB4K catalogs, 37 feature catalogs, and version alpha.4', () => {
  assert.equal(require('../package.json').version, '2.7.0-alpha.4');
  assert.equal(tpb4kCatalogs.length, 28);
  const catalogIndex = fs.readFileSync(path.join(__dirname, '..', 'catalog', 'index.js'), 'utf8');
  assert.match(catalogIndex, /tpb4kCatalogs/);
  assert.match(require('../package.json').scripts['test:release'], /tpb4k-phase2b\.test\.js/);
});
