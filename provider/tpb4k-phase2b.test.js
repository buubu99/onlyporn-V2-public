'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readTpb4kConfig, publicConfigStatus } = require('./tpb4k/config');
const { parseJsonFeed, parseRssFeed } = require('./tpb4k/discovery-normalize');
const { SourceHttpClient, validateConfiguredEndpoint } = require('./tpb4k/source-http');
const { createStripchatGateAdapter } = require('./tpb4k/adapters/discovery');
const { clearAdapters, installBuiltInAdapters, listAdapters } = require('./tpb4k/index');
const { tpb4kCatalogs } = require('../catalog/tpb4k');

function response(body, contentType) {
  return { status: 200, headers: { get: name => name.toLowerCase() === 'content-type' ? contentType : '' }, async text() { return body; } };
}

const rssBody = `<?xml version="1.0"?><rss><channel><item><guid>suke-a</guid><title>Release A 2160p</title><link>https://sukebei.example/view/1</link><nyaa:seeders>12</nyaa:seeders></item></channel></rss>`;

test('configured optional endpoints require credential-free HTTPS and reject secret query keys', () => {
  assert.match(validateConfiguredEndpoint('https://example.com/feed?mode=recent'), /^https:/);
  assert.throws(() => validateConfiguredEndpoint('http://example.com/feed'), /HTTPS/);
  assert.throws(() => validateConfiguredEndpoint('https://example.com/feed?api_key=x'), /secret-bearing/);
});

test('Phase 2B status exposes source names but never endpoint URLs or API credentials', () => {
  const config = readTpb4kConfig({ TPB4K_ENABLED: 'true', TPDB_API_KEY: 'tpdb-secret', STASHDB_API_KEY: 'stash-secret' });
  const status = publicConfigStatus(config);
  assert.deepEqual(status.configuredDiscoverySources, ['hentai', 'pornrips', 'sukebei', 'yesporn']);
  assert.equal(JSON.stringify(status).includes('secret'), false);
  assert.equal(JSON.stringify(status).includes('pornrips.to'), false);
  assert.equal(status.stripchatPhaseRequired, 7);
});

test('source HTTP client rejects HTML placeholders when HTML was not explicitly enabled', async () => {
  const client = new SourceHttpClient({ id: 'test', endpoint: 'https://feed.example/catalog', fetchImpl: async () => response('<html>no</html>', 'application/json'), checkDns: false });
  assert.equal(await client.fetchText(client.buildUrl({ skip: 0, limit: 10 })), '');
});

test('source HTTP client permits HTML only for an exact-origin native adapter', async () => {
  const client = new SourceHttpClient({ id: 'native', endpoint: 'https://native.example/', fetchImpl: async () => response('<!doctype html><article>ok</article>', 'text/html'), checkDns: false, allowHtml: true, allowedContentTypes: ['text/html'] });
  assert.match(await client.fetchText('https://native.example/page/2/'), /article/);
  await assert.rejects(() => client.fetchText('https://lookalike.example/page/2/'), /not approved/);
});

test('JSON and RSS parsers remain metadata-only and never invent playable candidates', () => {
  assert.equal(parseJsonFeed('{"items":[{"title":"A"}]}').length, 1);
  const rss = parseRssFeed(rssBody);
  assert.equal(rss.length, 1);
  for (const key of ['magnet', 'infoHash', 'directUrl']) assert.equal(key in rss[0], false);
});

test('Stripchat remains an explicit Phase 7 gate with no partial catalog or playback output', async () => {
  const stripchat = createStripchatGateAdapter();
  assert.equal(stripchat.phase, 7);
  assert.deepEqual(await stripchat.catalog({}), []);
  assert.equal(await stripchat.meta({}), null);
  assert.deepEqual(await stripchat.resolve({}), []);
});

test('built-in adapter registry covers every Phase 2 source while preserving the Stripchat gate', () => {
  clearAdapters();
  const installed = installBuiltInAdapters({ env: { TPB4K_ENABLED: 'true' }, fetchImpl: async url => String(url).includes('sukebei') ? response(rssBody, 'application/rss+xml') : response('<html></html>', 'text/html'), checkDns: false });
  assert.deepEqual(listAdapters(), ['hentai', 'pornrips', 'stripchat', 'sukebei', 'torrent-index', 'tpdb', 'yesporn']);
  assert.equal(installed.phaseGates.stripchat, 7);
  assert.deepEqual(installed.configuredDiscoverySources, ['hentai', 'pornrips', 'sukebei', 'yesporn']);
});

test('discovery and native smoke scripts are present and do not contain configured secrets', () => {
  for (const name of ['scripts/tpb4k-discovery-smoke.js', 'scripts/tpb4k-native-smoke.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
    assert.match(source, /TPB4K/);
    assert.doesNotMatch(source, /tpdb-secret|stash-secret/);
  }
});

test('all 28 TPB4K catalog IDs remain unique and unified-resolution', () => {
  assert.equal(tpb4kCatalogs.length, 28);
  assert.equal(new Set(tpb4kCatalogs.map(item => item.id)).size, 28);
  assert.equal(tpb4kCatalogs.some(item => /\.(?:2160p|1080p|4k)\./i.test(item.id.replace(/^tpb4k\./, ''))), false);
});

test('Phase 2B release wiring remains included under alpha.5', () => {
  assert.equal(require('../package.json').version, '2.7.0-alpha.7');
  assert.match(require('../package.json').scripts['test:release'], /tpb4k-phase2b\.test\.js/);
});
