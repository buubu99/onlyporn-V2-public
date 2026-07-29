'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readTpb4kConfig, publicConfigStatus } = require('./tpb4k/config');
const { SourceHttpClient } = require('./tpb4k/source-http');
const { createDiscoveryAdapters } = require('./tpb4k/adapters/discovery');
const {
  buildCatalogUrl,
  parseDetail,
  parseHentaiCatalog,
  parsePornripsCatalog,
  parseYespornCatalog,
} = require('./tpb4k/native-discovery');
const { decodeStablePathId } = require('./tpb4k/native-html');
const { clearAdapters, installBuiltInAdapters } = require('./tpb4k/index');
const { Tpb4kProvider } = require('./tpb4k');

const pornripsList = `<!doctype html><html><body>
<article class="post"><header><h2 class="entry-title"><a href="https://pornrips.to/vixen-scene-one/">Vixen.Scene.One.2160p</a></h2></header><img data-src="https://pornrips.to/media/one.jpg"><time datetime="2026-07-29"></time><a href="https://pornrips.to/category/vixen/">Vixen</a><p>File Size: 8.4 GB Duration: 01:22:03</p></article>
<article class="post"><h2 class="entry-title"><a href="https://pornrips.to/scene-two/">Scene Two 1080p</a></h2><img src="https://pornrips.to/media/two.jpg"></article>
</body></html>`;
const yespornList = `<!doctype html><html><body>
<div class="thumb thumb_rel item"><a href="/video/123/scene-one/"><span>HD</span><span class="time">12:34</span><img class="lazy-load" data-original="https://yesporn.vip/images/one.jpg" alt="Yes Scene One"><strong class="title">Yes Scene One</strong></a></div>
<div class="thumb thumb_rel item"><a href="/video/124/scene-two/"><img src="https://yesporn.vip/images/two.jpg" alt="Yes Scene Two"><div class="time">01:02:03</div></a></div>
</body></html>`;
const hentaiList = `<!doctype html><html><body><script src="/cdn-cgi/challenge-platform/h/b/scripts/benign.js"></script>
<article class="item tvshows infinite-item pop_info"><div class="poster"><img data-lazy-src="https://hentaimama.io/img/a.jpg" alt="Hentai A"><a href="https://hentaimama.io/tvshows/hentai-a/"></a><div class="rating">8.7</div></div><div class="data"><h3><a href="https://hentaimama.io/tvshows/hentai-a/">Hentai A</a></h3><span>2023</span></div></article>
<article class="tvshows item pop_info infinite-item"><div class="poster" style="background-image:url('/img/b.jpg')"><a href="/tvshows/hentai-b/"></a></div><div class="data"><h3><a href="/tvshows/hentai-b/">Hentai B</a></h3><span>2024</span></div></article>
</body></html>`;
const detail = `<!doctype html><html><head><meta property="og:title" content="Detailed Scene"><meta property="og:image" content="https://pornrips.to/media/detail.jpg"><meta property="og:description" content="Full native metadata"></head><body><time datetime="2026-07-29"></time><a href="/studio/vixen/">Vixen</a><a href="/performer/jane-doe/">Jane Doe</a><p>Duration 01:30:00</p></body></html>`;

function response(body, contentType = 'text/html', status = 200) {
  return {
    status,
    headers: { get: name => name.toLowerCase() === 'content-type' ? contentType : '' },
    async text() { return body; },
  };
}

function nativeFetch(url) {
  const parsed = new URL(String(url));
  if (parsed.hostname === 'pornrips.to') return Promise.resolve(response(parsed.pathname.includes('vixen-scene-one') ? detail : pornripsList));
  if (parsed.hostname === 'yesporn.vip') return Promise.resolve(response(parsed.pathname.startsWith('/video/') ? detail.replaceAll('pornrips.to', 'yesporn.vip') : yespornList));
  if (parsed.hostname === 'hentaimama.io') return Promise.resolve(response(parsed.pathname.startsWith('/tvshows/') ? detail.replaceAll('pornrips.to', 'hentaimama.io') : hentaiList));
  if (parsed.hostname.includes('sukebei')) return Promise.resolve(response('<?xml version="1.0"?><rss><channel></channel></rss>', 'application/rss+xml'));
  throw new Error(`Unexpected URL: ${url}`);
}

function env() {
  return { TPB4K_ENABLED: 'true', TPB4K_CATALOG_LIMIT: '40', TPB4K_REQUEST_TIMEOUT_MS: '15000' };
}

test('native source origins are built into code and obsolete feed variables are ignored', () => {
  const config = readTpb4kConfig({ ...env(), TPB4K_PORNRIPS_CATALOG_URL: 'https://evil.example/feed' });
  assert.equal(config.discovery.pornrips, 'https://pornrips.to/');
  assert.equal(config.discovery.yesporn, 'https://yesporn.vip/');
  assert.equal(config.discovery.hentai, 'https://hentaimama.io/');
  assert.deepEqual(publicConfigStatus(config).configuredDiscoverySources, ['hentai', 'pornrips', 'sukebei', 'torrent-index', 'yesporn']);
});

test('PornRips native parser returns opaque metadata records and no playable fields', () => {
  const items = parsePornripsCatalog(pornripsList);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'Vixen.Scene.One.2160p');
  assert.equal(items[0].studio, 'Vixen');
  assert.equal(items[0].duration, 4923);
  assert.equal(decodeStablePathId('pornrips', items[0].sourceId), '/vixen-scene-one/');
  for (const key of ['magnet', 'infoHash', 'directUrl']) assert.equal(key in items[0], false);
});

test('YesPorn native parser reads video cards, lazy posters, durations, and stable paths', () => {
  const items = parseYespornCatalog(yespornList);
  assert.equal(items.length, 2);
  assert.equal(items[0].poster, 'https://yesporn.vip/images/one.jpg');
  assert.equal(items[0].duration, 754);
  assert.equal(decodeStablePathId('yesporn', items[0].sourceId), '/video/123/scene-one/');
});

test('HentaiMama native parser reads series cards without confusing Yomi or torrents', () => {
  const items = parseHentaiCatalog(hentaiList);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'Hentai A');
  assert.match(items[0].description, /8\.7/);
  assert.equal(decodeStablePathId('hentai', items[0].sourceId), '/tvshows/hentai-a/');
  assert.equal('infoHash' in items[0], false);
});

test('native page builders implement deterministic pagination and distinct Hentai modes', () => {
  assert.equal(buildCatalogUrl('pornrips', { mode: 'recent' }, 2), 'https://pornrips.to/page/2/');
  assert.equal(buildCatalogUrl('yesporn', { mode: 'recent' }, 3), 'https://yesporn.vip/latest-updates/3/');
  assert.equal(buildCatalogUrl('hentai', { mode: 'all' }, 1), 'https://hentaimama.io/hentai-series/');
  assert.equal(buildCatalogUrl('hentai', { mode: 'new' }, 2), 'https://hentaimama.io/hentai-series/page/2/?filter=latest');
  assert.equal(buildCatalogUrl('hentai', { mode: 'top' }, 2), 'https://hentaimama.io/hentai-series/page/2/?filter=rating');
});

test('detail parser enriches an opaque source path without changing source identity', () => {
  const item = parsePornripsCatalog(pornripsList)[0];
  const enriched = parseDetail('pornrips', detail, item.sourceId);
  assert.equal(enriched.sourceId, item.sourceId);
  assert.equal(enriched.title, 'Detailed Scene');
  assert.deepEqual(enriched.performers, ['Jane Doe']);
  assert.equal(enriched.studio, 'Vixen');
  assert.equal(enriched.duration, 5400);
});

test('native adapters are always configured, fetch exact origins, paginate, and resolve no streams', async () => {
  const bundle = createDiscoveryAdapters({ config: readTpb4kConfig(env()), fetchImpl: nativeFetch, checkDns: false, minRequestIntervalMs: 0 });
  assert.deepEqual(bundle.configuredSources, ['hentai', 'pornrips', 'sukebei', 'torrent-index', 'yesporn']);
  for (const [id, catalog] of [
    ['pornrips', { id: 'tpb4k.pornrips.recent', mode: 'recent' }],
    ['yesporn', { id: 'tpb4k.yesporn.recent', mode: 'recent' }],
    ['hentai', { id: 'tpb4k.hentai.all', mode: 'all' }],
  ]) {
    const adapter = bundle.adapters.find(item => item.id === id);
    const items = await adapter.catalog({ catalog, skip: 0, limit: 40 });
    assert.equal(items.length, 2, id);
    const meta = await adapter.meta({ sourceId: items[0].sourceId });
    assert.equal(meta.sourceId, items[0].sourceId, id);
    assert.deepEqual(await adapter.resolve({ sourceId: items[0].sourceId }), [], id);
  }
});

test('provider exposes native catalog and meta responses while keeping streams empty', async () => {
  clearAdapters();
  installBuiltInAdapters({ env: env(), fetchImpl: nativeFetch, checkDns: false, minRequestIntervalMs: 0 });
  const provider = new Tpb4kProvider({ env: env(), fetchImpl: nativeFetch, installBuiltIns: false });
  for (const id of ['tpb4k.pornrips.recent', 'tpb4k.yesporn.recent', 'tpb4k.hentai.all']) {
    const catalog = await provider.handleCatalog({ type: 'movie', id, extra: { skip: 0 } });
    assert.equal(catalog.metas.length, 2, id);
    const meta = await provider.handleMeta({ type: 'movie', id: catalog.metas[0].id });
    assert.equal(meta.meta.name, 'Detailed Scene', id);
    assert.deepEqual(await provider.handleStream({ type: 'movie', id: catalog.metas[0].id }), { streams: [] }, id);
  }
});


test('live-shaped selectors accept only exact YesPorn and HentaiMama content paths', () => {
  const yesporn = parseYespornCatalog(`${yespornList}<div class="thumb item"><a href="/videos/not-valid/">Navigation</a></div>`);
  assert.equal(yesporn.length, 2);
  assert.equal(yesporn[0].title, 'Yes Scene One');
  assert.equal(yesporn[0].poster, 'https://yesporn.vip/images/one.jpg');
  const hentai = parseHentaiCatalog(`${hentaiList}<article class="item tvshows"><a href="/hentai-series/">Series navigation</a></article>`);
  assert.equal(hentai.length, 2);
  assert.equal(hentai[0].title, 'Hentai A');
  assert.equal(hentai[0].poster, 'https://hentaimama.io/img/a.jpg');
  assert.equal(hentai[1].poster, 'https://hentaimama.io/img/b.jpg');
});

test('native source client deduplicates concurrent calls, spaces uncached requests, and retries one 5xx', async () => {
  let now = 0;
  let calls = 0;
  const sleeps = [];
  const client = new SourceHttpClient({
    id: 'native-reliability',
    endpoint: 'https://native.example/',
    checkDns: false,
    allowHtml: true,
    allowedContentTypes: ['text/html'],
    minRequestIntervalMs: 350,
    maxRetries: 1,
    retryBaseDelayMs: 25,
    now: () => now,
    sleep: async milliseconds => { sleeps.push(milliseconds); now += milliseconds; },
    fetchImpl: async () => {
      calls += 1;
      if (calls === 2) return response('temporary', 'text/html', 503);
      return response('<!doctype html><article>ok</article>');
    },
  });
  const [first, duplicate] = await Promise.all([
    client.fetchText('https://native.example/page/1/', { cacheKey: 'page-one' }),
    client.fetchText('https://native.example/page/1/', { cacheKey: 'page-one' }),
  ]);
  assert.equal(first, duplicate);
  assert.equal(calls, 1);
  assert.match(await client.fetchText('https://native.example/page/2/', { cacheKey: 'page-two' }), /article/);
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [350, 25]);
});

test('challenge HTML and lookalike links fail closed instead of becoming catalog records', () => {
  const challenge = '<html><head><title>Just a moment...</title></head><body><form id="challenge-form"></form></body></html>';
  assert.equal(parsePornripsCatalog(challenge).length, 0);
  const lookalike = '<article><h2><a href="https://pornrips.to.evil.example/x/">Bad</a></h2></article>';
  assert.equal(parsePornripsCatalog(lookalike).length, 0);
});

test('alpha.10 release wiring keeps native live smoke, TPDB REST, and adds the original TPB studio catalog transport', () => {
  const root = path.join(__dirname, '..');
  const pkg = require('../package.json');
  assert.equal(pkg.version, '2.7.0-alpha.10');
  assert.match(pkg.scripts['test:release'], /tpb4k-phase2c\.test\.js/);
  assert.equal(pkg.scripts['smoke:tpb4k-native'], 'node scripts/tpb4k-native-smoke.js');
  assert.equal(pkg.scripts['smoke:tpb4k-hentai'], 'node scripts/tpb4k-hentai-live-smoke.js');
  for (const name of ['.env.example', 'README.md', 'provider/tpb4k/config.js']) {
    const source = fs.readFileSync(path.join(root, name), 'utf8');
    assert.doesNotMatch(source, /TPB4K_(?:PORNRIPS|YESPORN|HENTAI)_CATALOG_URL/);
  }
});
