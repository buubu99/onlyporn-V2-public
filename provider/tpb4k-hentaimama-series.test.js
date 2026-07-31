'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createHentaiMamaSeriesAdapter,
  episodeId,
  hasHentaiCatalogEvidence,
  htmlUsable,
  parseSeriesDetail,
  seriesId,
} = require('./tpb4k/hentaimama-series');

function response(body = '', status = 200, contentType = 'text/html', extraHeaders = {}) {
  const text = String(body);
  const headers = new Map(Object.entries({
    'content-type': contentType,
    'content-length': String(Buffer.byteLength(text)),
    ...extraHeaders,
  }).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get(name) { return headers.get(String(name).toLowerCase()) || ''; } },
    body: { async cancel() {} },
    async text() { return text; },
    async arrayBuffer() { return Buffer.from(text); },
  };
}

const catalogHtml = `
<article class="item tvshows">
  <a href="https://hentaimama.io/tvshows/eroriman-2/" title="Eroriman 2">
    <img data-src="https://images.example/eroriman.jpg" alt="Eroriman 2">
  </a>
  <h3>Eroriman 2</h3>
</article>`;

const seriesHtml = `
<meta property="og:title" content="Eroriman 2">
<meta property="og:image" content="https://images.example/eroriman.jpg">
<meta property="og:description" content="Series description">
<div class="date">2026</div>
<a href="/studio/hentaimama/">HentaiMama</a>
<a rel="tag" href="/genre/3d/">3D</a>
<a href="/episodes/eroriman-2-episode-1/">Eroriman 2 Episode 1</a>
<a href="/episodes/eroriman-2-episode-2/">Eroriman 2 Episode 2</a>`;

const episodeTwoHtml = `
<script>jQuery.post('/wp-admin/admin-ajax.php',{action:'get_player_contents',a:'202'});</script>`;

function fixtureFetch(url, options = {}) {
  const parsed = new URL(String(url));
  if (parsed.hostname === 'hentaimama.io' && parsed.pathname === '/hentai-series/') {
    return Promise.resolve(response(catalogHtml));
  }
  if (parsed.hostname === 'hentaimama.io' && parsed.pathname === '/tvshows/eroriman-2/') {
    return Promise.resolve(response(seriesHtml));
  }
  if (parsed.hostname === 'hentaimama.io' && parsed.pathname === '/episodes/eroriman-2-episode-2/') {
    return Promise.resolve(response(episodeTwoHtml));
  }
  if (parsed.hostname === 'hentaimama.io' && parsed.pathname === '/episodes/eroriman-2-episode-1/') {
    return Promise.resolve(response("<script>file:'https://gdvid.info/eroriman-e1-720p.mp4'</script>"));
  }
  if (parsed.hostname === 'hentaimama.io' && parsed.pathname === '/wp-admin/admin-ajax.php') {
    assert.equal(options.method, 'POST');
    assert.match(String(options.body), /action=get_player_contents/);
    assert.match(String(options.body), /a=202/);
    return Promise.resolve(response(JSON.stringify([
      '<iframe src="https://player.javprovider.com/p1"></iframe>',
      '<iframe src="https://player.javprovider.com/p2"></iframe>',
    ]), 200, 'application/json'));
  }
  if (parsed.hostname === 'player.javprovider.com' && parsed.pathname === '/p1') {
    return Promise.resolve(response('<script>file: "https://gdvid.info/eroriman-e2-1080p.mp4"</script>'));
  }
  if (parsed.hostname === 'player.javprovider.com' && parsed.pathname === '/p2') {
    return Promise.resolve(response('<script>source: "https://gdvid.info/eroriman-e2-720p.mp4"</script>'));
  }
  if (parsed.hostname === 'gdvid.info') {
    const size = parsed.pathname.includes('1080p') ? '900000000' : '450000000';
    return Promise.resolve(response('', 200, 'video/mp4', { 'content-length': size }));
  }
  return Promise.resolve(response('', 404));
}

function config() {
  return {
    requestTimeoutMs: 5_000,
    discoveryMaxResponseBytes: 2_000_000,
    discoveryCacheTtlMs: 60_000,
    discoveryNegativeTtlMs: 1_000,
    discoveryCacheMaxEntries: 100,
  };
}



test('HentaiMama catalog accepts benign challenge-script markers only when real series-card evidence is present', async () => {
  const benignCatalog = `<!doctype html><html><body><script src="/cdn-cgi/challenge-platform/h/b/scripts/benign.js"></script>
  <article class="item tvshows infinite-item"><a href="https://hentaimama.io/tvshows/eroriman-2/"><img src="https://images.example/eroriman.jpg"></a><h3>Eroriman 2</h3></article></body></html>`;
  const realChallenge = '<html><head><title>Just a moment...</title></head><body><form id="challenge-form"></form></body></html>';
  assert.equal(hasHentaiCatalogEvidence(benignCatalog), true);
  assert.equal(htmlUsable(benignCatalog, { allowCatalogEvidence: true }), benignCatalog);
  assert.equal(htmlUsable(realChallenge, { allowCatalogEvidence: true }), '');

  const adapter = createHentaiMamaSeriesAdapter({
    config: config(),
    fetchImpl: url => {
      const parsed = new URL(String(url));
      if (parsed.pathname === '/hentai-series/') return Promise.resolve(response(benignCatalog));
      return Promise.resolve(response('', 404));
    },
    checkDns: false,
    minRequestIntervalMs: 0,
    maxRetries: 0,
  });
  const items = await adapter.catalog({ catalog: { id: 'tpb4k.hentai.all', mode: 'all' }, skip: 0, limit: 40 });
  assert.equal(items.length, 1);
  assert.equal(items[0].sourceId, 'hmm-eroriman-2');
});

test('HentaiMama series metadata preserves every episode with stable hmm IDs', () => {
  const parsed = parseSeriesDetail(seriesHtml, 'eroriman-2');
  assert.equal(parsed.sourceId, 'hmm-eroriman-2');
  assert.equal(parsed.title, 'Eroriman 2');
  assert.equal(parsed.videos.length, 2);
  assert.deepEqual(parsed.videos.map(video => video.id), [
    'hmm-eroriman-2:1:1',
    'hmm-eroriman-2:1:2',
  ]);
  assert.equal(parsed.poster, 'https://images.example/eroriman.jpg');
});

test('HentaiMama adapter keeps catalog, meta, and exact episode resolution separate from studio torrents', async () => {
  const adapter = createHentaiMamaSeriesAdapter({
    config: config(),
    fetchImpl: fixtureFetch,
    checkDns: false,
    minRequestIntervalMs: 0,
    maxRetries: 0,
  });
  const catalog = await adapter.catalog({ catalog: { id: 'tpb4k.hentai.all', mode: 'all' }, skip: 0, limit: 40 });
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].sourceId, seriesId('eroriman-2'));

  const meta = await adapter.meta({ sourceId: seriesId('eroriman-2') });
  assert.equal(meta.videos.length, 2);
  assert.equal(meta.videos[1].id, episodeId('eroriman-2', 2));

  const streams = await adapter.resolve({ sourceId: episodeId('eroriman-2', 2) });
  assert.equal(streams.length, 2);
  assert.deepEqual(streams.map(stream => stream.resolution).sort(), ['1080p', '720p']);
  assert.equal(streams.every(stream => stream.url.includes('eroriman-e2-')), true);
  assert.equal(streams.some(stream => stream.url.includes('e1')), false);
  assert.equal(streams.every(stream => stream.validated && stream.size > 0), true);
  assert.equal(streams.every(stream => !stream.infoHash), true);
});

test('legacy Hentai series IDs remain compatible but resolve only the selected exact episode for new IDs', async () => {
  const adapter = createHentaiMamaSeriesAdapter({
    config: config(), fetchImpl: fixtureFetch, checkDns: false, minRequestIntervalMs: 0, maxRetries: 0,
  });
  const episodeOne = await adapter.resolve({ sourceId: episodeId('eroriman-2', 1) });
  const episodeTwo = await adapter.resolve({ sourceId: episodeId('eroriman-2', 2) });
  assert.equal(episodeOne.length, 1);
  assert.match(episodeOne[0].url, /e1-720p/);
  assert.equal(episodeTwo.length, 2);
  assert.equal(episodeTwo.every(stream => /e2-/.test(stream.url)), true);
});
