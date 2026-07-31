'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { catalogDefinitions } = require('../catalog/tpb4k');
const {
  clearAdapters,
  getAdapter,
  installBuiltInAdapters,
  listAdapters,
  registerAdapter,
} = require('./tpb4k/index');
const { decodeTpb4kId } = require('./tpb4k/id-codec');
const { Tpb4kProvider } = require('./tpb4k');
const {
  build1337SearchPath,
  DEFAULT_1337X_MIRRORS,
  DEFAULT_TPB_MIRRORS,
  buildStudioSearchPath,
  createTorrentIndexAdapter,
  extractInfoHash,
  parse1337SearchPage,
  parseTorrentDetailPage,
  parseTpbSearchPage,
} = require('./tpb4k/torrent-index');
const { SourceHttpClient } = require('./tpb4k/source-http');
const { createSukebeiMetadataAdapter } = require('./tpb4k/sukebei-metadata');
const { readTpb4kConfig } = require('./tpb4k/config');
const { buildSceneIdentity } = require('./tpb4k/identity');

const HASH_A = '0123456789abcdef0123456789abcdef01234567';
const HASH_B = '89abcdef0123456789abcdef0123456789abcdef';
const HASH_C = 'fedcba9876543210fedcba9876543210fedcba98';

function page(rows = []) {
  return `<!doctype html><html><body><table id="searchResult">
  <tr><th>Type</th><th>Name</th><th>SE</th><th>LE</th></tr>
  ${rows.map((row, index) => `<tr>
    <td class="vertTh"><center><a>UHD Movies</a></center></td>
    <td><div class="detName"><a class="detLink" href="/torrent/${index + 1}/${row.slug || 'scene'}">${row.title}</a></div>
      ${row.magnet === false ? '' : `<a href="magnet:?xt=urn:btih:${row.hash}&dn=${encodeURIComponent(row.title)}">magnet</a>`}
      <font class="detDesc">Uploaded ${row.date || '07-29 2026'}, Size ${row.size || '8.5 GiB'}, ULed by uploader</font></td>
    <td>${row.seeders ?? 12}</td><td>${row.leechers ?? 2}</td>
  </tr>`).join('')}
  </table></body></html>`;
}

function response(body, status = 200, contentType = 'text/html; charset=UTF-8', headers = {}) {
  return {
    status,
    headers: {
      get: name => {
        const key = String(name).toLowerCase();
        if (key === 'content-type') return contentType;
        return headers[key] || '';
      },
    },
    async text() { return body; },
  };
}

function x1337Page(rows = []) {
  return `<!doctype html><html><body><table class="table-list"><tbody>
  ${rows.map((row, index) => `<tr>
    <td class="coll-1 name"><span>XXX</span><a href="/cat/xxx">XXX</a>
      <a href="/torrent/${index + 1}/${row.slug || 'scene'}/">${row.title}</a></td>
    <td class="coll-2 seeds">${row.seeders ?? 10}</td>
    <td class="coll-3 leeches">${row.leechers ?? 1}</td>
    <td class="coll-4 size">${row.size || '4.2 GB'}</td>
    <td class="coll-date">today</td><td class="coll-5">uploader</td>
  </tr>`).join('')}
  </tbody></table></body></html>`;
}

function detail(magnet = '') {
  return `<!doctype html><html><body><h1>Torrent detail</h1>
    ${magnet ? `<a href="${magnet.replace(/&/g, '&amp;')}">Magnet</a>` : '<p>No magnet here</p>'}
  </body></html>`;
}

function env(extra = {}) {
  return {
    TPB4K_ENABLED: 'true',
    TPB4K_CATALOG_LIMIT: '2',
    TPB4K_REQUEST_TIMEOUT_MS: '15000',
    TPB4K_KNABEN_ENABLED: 'false',
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
  assert.deepEqual(DEFAULT_1337X_MIRRORS, [
    'https://1337x.to',
    'https://1337x.st',
    'https://x1337x.ws',
    'https://x1337x.eu',
    'https://x1337x.cc',
  ]);
});

test('scene identity rejects sentence numbers and opaque ID fragments as false scene codes', () => {
  assert.equal(buildSceneIdentity({
    title: 'Fun With 40-Year-Old Mom',
    sourceId: 'tpdb:fd-54-12345678',
  }).sceneCode, '');
  assert.equal(buildSceneIdentity({
    title: 'Her Name Has Changed, But 71-Year-Old Performer',
    sourceId: 'tpdb:ae-92-87654321',
  }).sceneCode, '');
  assert.equal(buildSceneIdentity({ title: '[FHD] MIMK-285 Scene' }).sceneCode, 'MIMK-285');
  assert.equal(buildSceneIdentity({
    title: 'My Audition',
    sceneCode: 'dac 39063',
  }).sceneCode, 'DAC-39063');
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

test('1337x search records remain intermediate until a valid detail-page magnet is resolved', () => {
  assert.equal(build1337SearchPath('Vixen Scene', 2), '/search/Vixen%20Scene/2/');
  const parsed = parse1337SearchPage(x1337Page([
    { title: 'Vixen Scene One 1080p', seeders: 21, size: '3.5 GB' },
  ]), 'https://1337x.to');
  assert.equal(parsed.tablePresent, true);
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.records[0].infoHash, '');
  assert.equal(parsed.records[0].detailUrl, 'https://1337x.to/torrent/1/scene/');
  assert.equal(parsed.records[0].seeders, 21);
  assert.equal(parsed.records[0].resolution, '1080p');

  const resolved = parseTorrentDetailPage(detail(
    `magnet:?xt=urn:btih:${HASH_A}&dn=Vixen.Scene.One.1080p&tr=udp%3A%2F%2Ftracker.example%3A80%2Fannounce`
  ));
  assert.equal(resolved.infoHash, HASH_A);
  assert.equal(resolved.filename, 'Vixen.Scene.One.1080p');
  assert.deepEqual(resolved.trackers, ['udp://tracker.example:80/announce']);
  assert.equal(parseTorrentDetailPage(detail()), null);
  assert.equal(parseTorrentDetailPage(detail('magnet:?xt=urn:btih:not-a-hash')), null);
});

test('torrent scene resolution aggregates indexers, retains lower resolutions, and merges exact hashes', async () => {
  const adapter = createTorrentIndexAdapter({
    config: readTpb4kConfig(env()),
    checkDns: false,
    minRequestIntervalMs: 0,
    fetchImpl: async url => {
      const parsed = new URL(String(url));
      if (parsed.hostname === 'thehiddenbay.com' && parsed.pathname.startsWith('/search/')) {
        return response(page([
          { title: 'Vixen Scene One 2160p', hash: HASH_A, seeders: 8 },
          { title: 'Vixen Scene One 1080p', hash: HASH_B, seeders: 20 },
        ]));
      }
      if (parsed.hostname === '1337x.to' && parsed.pathname.startsWith('/search/')) {
        return response(x1337Page([
          { title: 'Vixen Scene One 2160p', seeders: 50 },
          { title: 'Vixen Scene One 720p', seeders: 9 },
        ]));
      }
      if (parsed.hostname === '1337x.to' && parsed.pathname.includes('/torrent/1/')) {
        return response(detail(
          `magnet:?xt=urn:btih:${HASH_A}&dn=Vixen.Scene.One.2160p&tr=udp%3A%2F%2Ftracker.example%3A80%2Fannounce`
        ));
      }
      if (parsed.hostname === '1337x.to' && parsed.pathname.includes('/torrent/2/')) {
        return response(detail(`magnet:?xt=urn:btih:${HASH_C}&dn=Vixen.Scene.One.720p`));
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });
  const candidates = await adapter.resolve({
    sourceId: 'tpdb:vixen-one',
    catalogId: 'tpb4k.studio.vixen.top',
    catalog: { id: 'tpb4k.studio.vixen.top', studio: 'Vixen' },
    item: { sourceId: 'tpdb:vixen-one', title: 'Scene One', studio: 'Vixen' },
  });
  assert.deepEqual(candidates.map(item => item.infoHash).sort(), [HASH_A, HASH_B, HASH_C].sort());
  const duplicate = candidates.find(item => item.infoHash === HASH_A);
  assert.equal(duplicate.seeders, 50);
  assert.deepEqual([...duplicate.provenance].sort(), ['1337x', 'hiddenbay']);
  assert.deepEqual(duplicate.trackers, ['udp://tracker.example:80/announce']);
  assert.equal(candidates.some(item => item.resolution === '1080p'), true);
  assert.equal(candidates.some(item => item.resolution === '720p'), true);
  assert.equal(candidates.some(item => Object.hasOwn(item, 'cached')), false);
});

test('one failed indexer does not suppress another indexer valid result', async () => {
  const adapter = createTorrentIndexAdapter({
    config: readTpb4kConfig(env()),
    checkDns: false,
    minRequestIntervalMs: 0,
    maxRetries: 0,
    fetchImpl: async url => {
      const parsed = new URL(String(url));
      if (parsed.hostname !== '1337x.to') throw new Error('fixture indexer unavailable');
      if (parsed.pathname.startsWith('/search/')) {
        return response(x1337Page([
          { title: 'Vixen Scene One 1080p', seeders: 17 },
        ]));
      }
      return response(detail(`magnet:?xt=urn:btih:${HASH_C}&dn=Vixen.Scene.One.1080p`));
    },
  });
  const candidates = await adapter.resolve({
    sourceId: 'tpdb:vixen-one',
    catalogId: 'tpb4k.studio.vixen.top',
    catalog: { studio: 'Vixen' },
    item: { title: 'Scene One', studio: 'Vixen' },
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].infoHash, HASH_C);
});

test('one timed-out indexer does not suppress another indexer valid result', async () => {
  const adapter = createTorrentIndexAdapter({
    config: {
      ...readTpb4kConfig(env()),
      requestTimeoutMs: 1_000,
    },
    mirrors: ['https://thehiddenbay.com'],
    checkDns: false,
    minRequestIntervalMs: 0,
    maxRetries: 0,
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(String(url));
      if (parsed.hostname === 'thehiddenbay.com') {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(response(page([]))), 5_000);
          options.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            const error = new Error('fixture request timed out');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
      }
      if (parsed.pathname.startsWith('/search/')) {
        return response(x1337Page([
          { title: 'Vixen Scene One 1080p', seeders: 17 },
        ]));
      }
      return response(detail(`magnet:?xt=urn:btih:${HASH_C}&dn=Vixen.Scene.One.1080p`));
    },
  });
  const startedAt = Date.now();
  const candidates = await adapter.resolve({
    sourceId: 'tpdb:vixen-one',
    catalogId: 'tpb4k.studio.vixen.top',
    catalog: { studio: 'Vixen' },
    item: { title: 'Scene One', studio: 'Vixen' },
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].infoHash, HASH_C);
  assert.ok(Date.now() - startedAt < 2_000);
});

test('TPB detail resolution falls back across approved mirrors until a valid magnet is found', async () => {
  const calls = [];
  const adapter = createTorrentIndexAdapter({
    config: readTpb4kConfig(env()),
    checkDns: false,
    minRequestIntervalMs: 0,
    maxRetries: 0,
    fetchImpl: async url => {
      const parsed = new URL(String(url));
      calls.push(`${parsed.hostname}${parsed.pathname}`);
      if (parsed.hostname === 'thehiddenbay.com' && parsed.pathname.startsWith('/search/')) {
        return response(page([
          { title: 'Vixen Scene One 2160p', magnet: false, seeders: 23 },
        ]));
      }
      if (parsed.hostname === '1337x.to' && parsed.pathname.startsWith('/search/')) {
        return response(x1337Page([]));
      }
      if (parsed.hostname === 'thehiddenbay.com' && parsed.pathname.startsWith('/torrent/')) {
        return response(detail());
      }
      if (parsed.hostname === 'thepiratebay0.org' && parsed.pathname.startsWith('/torrent/')) {
        return response(detail(`magnet:?xt=urn:btih:${HASH_B}&dn=Vixen.Scene.One.2160p`));
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });
  const candidates = await adapter.resolve({
    sourceId: 'tpdb:vixen-one',
    catalogId: 'tpb4k.studio.vixen.top',
    catalog: { studio: 'Vixen' },
    item: { title: 'Scene One', studio: 'Vixen' },
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].infoHash, HASH_B);
  assert.equal(calls.includes('thehiddenbay.com/torrent/1/scene'), true);
  assert.equal(calls.includes('thepiratebay0.org/torrent/1/scene'), true);
});

test('a 1337x detail page without a valid magnet produces no playable candidate', async () => {
  const adapter = createTorrentIndexAdapter({
    config: readTpb4kConfig(env()),
    checkDns: false,
    minRequestIntervalMs: 0,
    maxRetries: 0,
    fetchImpl: async url => {
      const parsed = new URL(String(url));
      if (parsed.hostname !== '1337x.to') throw new Error('fixture indexer unavailable');
      if (parsed.pathname.startsWith('/search/')) {
        return response(x1337Page([
          { title: 'Vixen Scene One 1080p', seeders: 18 },
        ]));
      }
      return response(detail());
    },
  });
  const candidates = await adapter.resolve({
    sourceId: 'tpdb:vixen-one',
    catalogId: 'tpb4k.studio.vixen.top',
    catalog: { studio: 'Vixen' },
    item: { title: 'Scene One', studio: 'Vixen' },
  });
  assert.deepEqual(candidates, []);
});

test('safe HTML client follows same-origin redirects and rejects lookalike and private hosts', async () => {
  const calls = [];
  const sameOrigin = new SourceHttpClient({
    id: 'redirect-fixture',
    endpoint: 'https://1337x.to/',
    checkDns: false,
    minRequestIntervalMs: 0,
    allowHtml: true,
    allowedContentTypes: ['text/html'],
    fetchImpl: async url => {
      calls.push(String(url));
      if (calls.length === 1) {
        return response('', 302, 'text/html', { location: '/final/' });
      }
      return response('<html><body>safe</body></html>');
    },
  });
  assert.match(await sameOrigin.fetchText('https://1337x.to/start/'), /safe/);
  assert.equal(calls.at(-1), 'https://1337x.to/final/');

  const lookalike = new SourceHttpClient({
    id: 'lookalike-fixture',
    endpoint: 'https://1337x.to/',
    checkDns: false,
    minRequestIntervalMs: 0,
    allowHtml: true,
    allowedContentTypes: ['text/html'],
    fetchImpl: async () => response('', 302, 'text/html', {
      location: 'https://1337x.to.evil.example/torrent/1/',
    }),
  });
  await assert.rejects(
    () => lookalike.fetchText('https://1337x.to/start/'),
    /not approved/
  );

  const privateHost = new SourceHttpClient({
    id: 'private-fixture',
    endpoint: 'https://127.0.0.1/',
    fetchImpl: async () => response('<html></html>'),
  });
  await assert.rejects(
    () => privateHost.fetchText('https://127.0.0.1/'),
    /private or reserved/i
  );
});

test('torrent adapter fails over on block HTML and binds hashes without exposing magnets', async () => {
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
    assert.match(item.infoHash, /^[a-f0-9]{40}$/);
  }
  assert.equal(
    adapter.diagnostics().pages.find(item => item.source === 'hiddenbay')?.mirror,
    'https://thepiratebay0.org'
  );
  assert.equal(adapter.privateRecordCount(), 2);
  const candidates = await adapter.resolve({ sourceId: items[0].sourceId });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].infoHash, HASH_A);
  assert.equal(candidates[0].seeders, 35);
  assert.equal(candidates[0].cached, undefined);
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

test('Sukebei RSS infoHash becomes an honest P2P candidate without a detail-page round trip', async () => {
  const rss = `<?xml version="1.0"?><rss><channel><item>
    <guid>https://sukebei.example/view/77</guid>
    <title>ABP-123 Sample 1080p</title>
    <link>https://sukebei.example/download/77.torrent</link>
    <media:thumbnail url="https://images.example/abp-123.jpg"/>
    <nyaa:infoHash>${HASH_B}</nyaa:infoHash>
    <nyaa:seeders>31</nyaa:seeders>
    <nyaa:size>2.8 GiB</nyaa:size>
  </item></channel></rss>`;
  let requests = 0;
  const baseConfig = readTpb4kConfig(env());
  const adapter = createSukebeiMetadataAdapter({
    config: {
      ...baseConfig,
      sukebeiRssPages: 1,
      sukebeiEnrichmentDeadlineMs: 4_000,
    },
    endpoint: 'https://sukebei.example/?page=rss&c=0_0&f=0',
    metadataClients: {},
    checkDns: false,
    fetchImpl: async () => {
      requests += 1;
      return response(rss, 200, 'application/rss+xml');
    },
  });
  const items = await adapter.catalog({ skip: 0, limit: 1 });
  assert.equal(items.length, 1);
  const candidates = await adapter.resolve({ sourceId: items[0].sourceId });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].infoHash, HASH_B);
  assert.equal(candidates[0].seeders, 31);
  assert.equal(candidates[0].resolution, '1080p');
  assert.equal(Object.hasOwn(candidates[0], 'cached'), false);
  assert.equal(requests, 1);
});

test('catalog-time version-2 binding avoids a second title search', async () => {
  let resolverCalls = 0;
  registerAdapter({
    id: 'studio-metadata',
    configured: true,
    async catalog() {
      return [{
        sourceId: 'tpdb:vixen-one',
        title: 'Scene One',
        studio: 'Vixen',
        releaseDate: '2026-07-29',
        poster: 'https://images.example/vixen-one.jpg',
        lookupSource: 'torrent-index',
      }];
    },
    async meta({ sourceId }) {
      return {
        sourceId,
        title: 'Scene One',
        studio: 'Vixen',
        releaseDate: '2026-07-29',
        poster: 'https://images.example/vixen-one.jpg',
        lookupSource: 'torrent-index',
      };
    },
    async resolve() {
      throw new Error('metadata adapter must not resolve studio torrents');
    },
  });
  const torrent = {
    sourceId: 'knaben:vixen-one',
    title: 'Vixen 2026 07 29 Scene One 2160p',
    studio: 'Vixen',
    filename: 'Vixen.Scene.One.2160p.mkv',
    infoHash: HASH_A,
    resolution: '4K',
    indexer: 'knaben',
    seeders: 14,
    size: '6.5 GiB',
  };
  registerAdapter({
    id: 'torrent-index',
    configured: true,
    async catalog() { return [torrent]; },
    async catalogTorrents() { return [torrent]; },
    async meta() { return null; },
    async resolve() {
      resolverCalls += 1;
      throw new Error('bound cards must not perform click-time searches');
    },
  });
  const provider = new Tpb4kProvider({
    env: env({ TPB4K_CATALOG_LIMIT: '1', TPB4K_MINIMUM_SEEDERS: '3' }),
    installBuiltIns: false,
  });
  const catalog = await provider.handleCatalog({
    type: 'movie',
    id: 'tpb4k.studio.vixen.top',
    extra: {},
  });
  assert.equal(catalog.metas.length, 1);
  const decoded = decodeTpb4kId(catalog.metas[0].id);
  assert.equal(decoded.version, 2);
  assert.equal(decoded.torrent.infoHash, HASH_A);
  const result = await provider.handleStream({ type: 'movie', id: catalog.metas[0].id });
  assert.equal(resolverCalls, 0);
  assert.equal(result.streams.length, 1);
  assert.equal(result.streams[0].infoHash, HASH_A);
  assert.equal(result.streams[0].title, 'Vixen.Scene.One.2160p.mkv');
  assert.equal(result.streams[0].behaviorHints.filename, 'Vixen.Scene.One.2160p.mkv');
  assert.equal(result.streams[0].behaviorHints.videoSize, 6.5 * 1024 ** 3);
  assert.match(result.streams[0].description, /👤 14/);
  assert.match(result.streams[0].description, /🔎 knaben/);
});
test('18 studio rows are metadata-first and OnlyFans uses a metadata-first/torrent hybrid with retained TPB provenance', () => {
  const studios = catalogDefinitions.filter(item => item.mode === 'studio-top');
  assert.equal(studios.length, 19);
  assert.equal(studios.filter(item => item.studio !== 'OnlyFans').every(item => item.source === 'studio-metadata'), true);
  assert.equal(studios.find(item => item.studio === 'OnlyFans')?.source, 'platform-hybrid');
  assert.equal(studios.every(item => item.lookupSource === 'torrent-index'), true);
  assert.equal(new Set(studios.map(item => item.studio)).size, 19);
});

test('built-in provider exposes only playable metadata-first version-2 studio cards', async () => {
  const metadataScenes = [
    {
      id: 'vixen-1', title: 'Scene One', date: '2026-07-29', site: { name: 'Vixen' },
      tags: [{ name: 'Romantic' }],
      images: [{ url: 'https://images.example/vixen-1.jpg', width: 600, height: 900 }],
    },
    {
      id: 'vixen-2', title: 'Scene Two', date: '2026-07-28', site: { name: 'Vixen' },
      tags: [{ name: 'Outdoor' }],
      images: [{ url: 'https://images.example/vixen-2.jpg', width: 600, height: 900 }],
    },
  ];
  const fetchImpl = async (url, request = {}) => {
    const parsed = new URL(String(url));
    if (parsed.hostname === 'api.theporndb.example') {
      const match = parsed.pathname.match(/\/scenes\/([^/]+)$/);
      const data = match
        ? metadataScenes.find(item => item.id === decodeURIComponent(match[1]))
        : metadataScenes;
      const body = JSON.stringify({ data });
      return {
        ok: true,
        status: 200,
        headers: { get: name => String(name).toLowerCase() === 'content-type' ? 'application/json' : String(name).toLowerCase() === 'content-length' ? String(Buffer.byteLength(body)) : '' },
        async text() { return body; },
      };
    }
    if (parsed.hostname === 'thehiddenbay.com' && parsed.pathname.startsWith('/search/')) {
      return response(page([
        { title: 'Vixen 2026 07 29 Scene One 2160p', hash: HASH_A, seeders: 35 },
        { title: 'Vixen 2026 07 28 Scene Two 2160p', hash: HASH_B, seeders: 20 },
      ]));
    }
    if (parsed.hostname.includes('sukebei')) {
      return response('<?xml version="1.0"?><rss><channel></channel></rss>', 200, 'application/rss+xml');
    }
    return response('<html></html>');
  };
  const runtimeEnv = env({
    TPDB_API_KEY: 'fixture-key',
    TPDB_REST_API_URL: 'https://api.theporndb.example',
  });
  clearAdapters();
  installBuiltInAdapters({ env: runtimeEnv, fetchImpl, checkDns: false, minRequestIntervalMs: 0 });
  assert.equal(listAdapters().includes('torrent-index'), true);
  assert.equal(listAdapters().includes('studio-metadata'), true);
  const torrentAdapter = getAdapter('torrent-index');
  assert.equal(torrentAdapter.category, '507');
  assert.equal(torrentAdapter.sort, '7');
  const provider = new Tpb4kProvider({ env: runtimeEnv, fetchImpl, installBuiltIns: false });
  const catalog = await provider.handleCatalog({
    type: 'movie', id: 'tpb4k.studio.vixen.top', extra: { skip: 0 },
  });
  assert.equal(catalog.metas.length, 2);
  for (const item of catalog.metas) {
    assert.equal(item.posterShape, 'poster');
    assert.match(item.poster, /^https:\/\/images\.example\//);
    assert.doesNotMatch(item.poster, /assets\/tpb4k\/studios/);
    const decoded = decodeTpb4kId(item.id);
    assert.equal(decoded.version, 2);
    assert.equal(decoded.source, 'studio-metadata');
    assert.match(decoded.sourceId, /^tpdb:/);
    assert.match(decoded.torrent.infoHash, /^[a-f0-9]{40}$/);
    const stream = await provider.handleStream({ type: 'movie', id: item.id });
    assert.equal(stream.streams.length, 1);
    assert.equal(stream.streams[0].infoHash, decoded.torrent.infoHash);
  }
  const meta = await provider.handleMeta({ type: 'movie', id: catalog.metas[0].id });
  assert.match(meta.meta.poster, /^https:\/\/images\.example\//);
  assert.equal(meta.meta.posterShape, 'poster');
  assert.equal(meta.meta.extra.onlyporn.lookupSource, 'torrent-index');
});
