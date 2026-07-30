'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { catalogDefinitions } = require('../catalog/tpb4k');
const { clearAdapters, getAdapter, installBuiltInAdapters, listAdapters } = require('./tpb4k/index');
const { decodeTpb4kId } = require('./tpb4k/id-codec');
const { Tpb4kProvider } = require('./tpb4k');
const {
  DEFAULT_TPB_MIRRORS,
  buildStudioSearchPath,
  createTorrentIndexAdapter,
  extractInfoHash,
  parseTpbSearchPage,
} = require('./tpb4k/torrent-index');
const { readTpb4kConfig } = require('./tpb4k/config');

const HASH_A = '0123456789abcdef0123456789abcdef01234567';
const HASH_B = '89abcdef0123456789abcdef0123456789abcdef';

function page(rows = []) {
  return `<!doctype html><html><body><table id="searchResult">
  <tr><th>Type</th><th>Name</th><th>SE</th><th>LE</th></tr>
  ${rows.map((row, index) => `<tr>
    <td class="vertTh"><center><a>UHD Movies</a></center></td>
    <td><div class="detName"><a class="detLink" href="/torrent/${index + 1}/${row.slug || 'scene'}">${row.title}</a></div>
      <a href="magnet:?xt=urn:btih:${row.hash}&dn=${encodeURIComponent(row.title)}">magnet</a>
      <font class="detDesc">Uploaded ${row.date || '07-29 2026'}, Size ${row.size || '8.5 GiB'}, ULed by uploader</font></td>
    <td>${row.seeders ?? 12}</td><td>${row.leechers ?? 2}</td>
  </tr>`).join('')}
  </table></body></html>`;
}

function response(body, status = 200, contentType = 'text/html; charset=UTF-8') {
  return {
    status,
    headers: { get: name => String(name).toLowerCase() === 'content-type' ? contentType : '' },
    async text() { return body; },
  };
}

function env(extra = {}) {
  return {
    TPB4K_ENABLED: 'true',
    TPB4K_CATALOG_LIMIT: '2',
    TPB4K_REQUEST_TIMEOUT_MS: '15000',
    ...extra,
  };
}

test.afterEach(() => clearAdapters());

test('studio catalogs use the original TPB 4K/top search contract', () => {
  assert.equal(buildStudioSearchPath('BrazzersExxtra', 1), '/search/BrazzersExxtra/1/7/507');
  assert.equal(buildStudioSearchPath('Tokyo Hot', 2), '/search/Tokyo%20Hot/2/7/507');
  assert.deepEqual(DEFAULT_TPB_MIRRORS, [
    'https://thehiddenbay.com',
    'https://thepiratebay0.org',
    'https://piratebay.live',
  ]);
});

test('TPB HTML parser extracts torrent identity, size, seeders, detail URL, and quality', () => {
  const parsed = parseTpbSearchPage(page([
    { title: 'Vixen Scene One 2160p', hash: HASH_A, seeders: 44, size: '9.1 GiB' },
  ]), 'https://thehiddenbay.com');
  assert.equal(parsed.tablePresent, true);
  assert.equal(parsed.records.length, 1);
  assert.match(parsed.records[0].sourceId, /^hiddenbay:[a-f0-9]{40}$/);
  assert.notEqual(parsed.records[0].sourceId, `hiddenbay:${HASH_A}`);
  assert.equal(parsed.records[0].infoHash, HASH_A);
  assert.equal(parsed.records[0].seeders, 44);
  assert.equal(parsed.records[0].size, '9.1 GiB');
  assert.equal(parsed.records[0].resolution, '4K');
  assert.equal(parsed.records[0].detailUrl, 'https://thehiddenbay.com/torrent/1/scene');
  assert.equal(extractInfoHash(parsed.records[0].magnetLink), HASH_A);
});

test('torrent adapter fails over on block HTML and never exposes magnets in catalog metadata', async () => {
  const calls = [];
  const config = readTpb4kConfig(env());
  const adapter = createTorrentIndexAdapter({
    config,
    checkDns: false,
    minRequestIntervalMs: 0,
    fetchImpl: async url => {
      calls.push(String(url));
      if (String(url).startsWith('https://thehiddenbay.com')) {
        return response('<html><body>Just a moment...</body></html>');
      }
      if (String(url).startsWith('https://thepiratebay0.org')) {
        return response(page([
          { title: 'Vixen Scene One 2160p', hash: HASH_A, seeders: 35 },
          { title: 'Vixen Scene Two 4K', hash: HASH_B, seeders: 20 },
        ]));
      }
      throw new Error(`Unexpected mirror: ${url}`);
    },
  });
  const items = await adapter.catalog({
    catalog: { id: 'tpb4k.studio.vixen.top', studio: 'Vixen' },
    skip: 0,
    limit: 2,
  });
  assert.equal(items.length, 2);
  assert.equal(calls.length, 2);
  assert.match(items[0].sourceId, /^hiddenbay:[a-f0-9]{40}$/);
  assert.notEqual(items[0].sourceId, `hiddenbay:${HASH_A}`);
  assert.equal(items[0].studio, 'Vixen');
  assert.equal(items[0].resolution, '4K');
  assert.equal(items[0].seeders, 35);
  for (const item of items) {
    assert.equal('magnet' in item, false);
    assert.equal('magnetLink' in item, false);
    assert.equal('infoHash' in item, false);
  }
  assert.equal(adapter.diagnostics().pages[0].mirror, 'https://thepiratebay0.org');
  assert.equal(adapter.privateRecordCount(), 2);
  assert.deepEqual(await adapter.resolve({ sourceId: items[0].sourceId }), []);
});

test('a genuine empty TPB result table does not fall through to another mirror', async () => {
  const calls = [];
  const adapter = createTorrentIndexAdapter({
    config: readTpb4kConfig(env()),
    checkDns: false,
    minRequestIntervalMs: 0,
    fetchImpl: async url => {
      calls.push(String(url));
      return response(page([]));
    },
  });
  assert.deepEqual(await adapter.catalog({
    catalog: { id: 'tpb4k.studio.vixen.top', studio: 'Vixen' },
    skip: 0,
    limit: 2,
  }), []);
  assert.equal(calls.length, 1);
});

test('all 19 selected studio definitions are independent TPB 4K/top catalogs', () => {
  const studios = catalogDefinitions.filter(item => item.mode === 'studio-top');
  assert.equal(studios.length, 19);
  assert.equal(studios.every(item => item.source === 'torrent-index'), true);
  assert.equal(new Set(studios.map(item => item.studio)).size, 19);
});

test('built-in provider exposes TPB studio catalog cards but keeps streams empty', async () => {
  const html = page([
    { title: 'Vixen Scene One 2160p', hash: HASH_A, seeders: 35 },
    { title: 'Vixen Scene Two 4K', hash: HASH_B, seeders: 20 },
  ]);
  const fetchImpl = async url => {
    const host = new URL(String(url)).hostname;
    if (['thehiddenbay.com', 'thepiratebay0.org', 'piratebay.live'].includes(host)) return response(html);
    if (host.includes('sukebei')) return response('<?xml version="1.0"?><rss><channel></channel></rss>', 200, 'application/rss+xml');
    return response('<html></html>');
  };
  clearAdapters();
  installBuiltInAdapters({ env: env(), fetchImpl, checkDns: false, minRequestIntervalMs: 0 });
  assert.equal(listAdapters().includes('torrent-index'), true);
  const adapter = getAdapter('torrent-index');
  assert.equal(adapter.category, '507');
  assert.equal(adapter.sort, '7');

  const provider = new Tpb4kProvider({ env: env(), fetchImpl, installBuiltIns: false });
  const catalog = await provider.handleCatalog({
    type: 'movie',
    id: 'tpb4k.studio.vixen.top',
    extra: { skip: 0 },
  });
  assert.equal(catalog.metas.length, 2);
  assert.equal(catalog.metas[0].posterShape, 'poster');
  assert.match(catalog.metas[0].poster, /^https:\/\/raw\.githubusercontent\.com\//);
  assert.match(catalog.metas[0].poster, /vixen\.png$/);
  assert.equal(catalog.metas[0].genres.includes('Vixen'), true);
  assert.match(catalog.metas[0].description, /Seeders: 35/);
  const decoded = decodeTpb4kId(catalog.metas[0].id);
  assert.equal(decoded.source, 'torrent-index');
  assert.match(decoded.sourceId, /^hiddenbay:/);
  const meta = await provider.handleMeta({ type: 'movie', id: catalog.metas[0].id });
  assert.equal(meta.meta.name, 'Vixen Scene One 2160p');
  assert.match(meta.meta.poster, /vixen\.png$/);
  assert.equal(meta.meta.posterShape, 'poster');
  assert.deepEqual(await provider.handleStream({ type: 'movie', id: catalog.metas[0].id }), { streams: [] });
});
