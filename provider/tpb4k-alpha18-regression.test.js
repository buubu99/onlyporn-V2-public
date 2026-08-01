'use strict';
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { studioSearchQueries } = require('./tpb4k/studio-aliases');
const { bindStudioPlayback } = require('./tpb4k/studio-playback-binding');
const {
  createHentaiMamaSeriesAdapter,
  hasHentaiEpisodeEvidence,
  hasHentaiSeriesEvidence,
  htmlUsable,
  topTaxonomyRecord,
} = require('./tpb4k/hentaimama-series');

const HASH = '0123456789abcdef0123456789abcdef01234567';
function response(body = '', status = 200, contentType = 'text/html', extra = {}) {
  const headers = new Map(Object.entries({ 'content-type': contentType, 'content-length': String(Buffer.byteLength(String(body))), ...extra }).map(([k,v]) => [k.toLowerCase(), String(v)]));
  return { ok: status >= 200 && status < 300, status, headers: { get(n) { return headers.get(String(n).toLowerCase()) || ''; } }, body: { async cancel() {} }, async text() { return String(body); }, async arrayBuffer() { return Buffer.from(String(body)); } };
}
function config() { return { requestTimeoutMs: 5000, discoveryMaxResponseBytes: 2_000_000, discoveryCacheTtlMs: 60_000, discoveryNegativeTtlMs: 1000, discoveryCacheMaxEntries: 100 }; }

test('studio alias searches cover the two disappeared catalogues', () => {
  assert.deepEqual(studioSearchQueries({ studio: 'DigitalPlayground', playbackBindingPool: true }), ['DigitalPlayground', 'Digital Playground', 'Digital Playground 4K']);
  assert.deepEqual(studioSearchQueries({ studio: 'XVideosRED', playbackBindingPool: true }), ['XVideosRED', 'XVideos RED', 'XVideosRed', 'XVideos.com RED']);
});

test('release date and performer evidence cannot bind an unrelated torrent', () => {
  const result = bindStudioPlayback({
    catalog: { id: 'tpb4k.studio.vixen.top', studio: 'Vixen' },
    metadataItems: [{ sourceId: 'tpdb:one', title: 'Editorial Title With No Torrent Words', studio: 'Vixen', releaseDate: '2026-07-31', performers: ['Jane Doe'], poster: 'https://img.example/one.jpg' }],
    torrentItems: [{ sourceId: 'knaben:one', title: 'Vixen 2026 07 31 Jane Doe Totally Unrelated Release 2160p', studio: 'Vixen', infoHash: HASH, seeders: 99 }],
  });
  assert.equal(result.items.length, 0);
  assert.equal(result.stats.rejectedDateOnly, true);
});

test('exact title and studio-supported title overlap remain playable', () => {
  const metadata = { sourceId: 'tpdb:two', title: 'A Very Distinctive Scene Name', studio: 'DigitalPlayground', releaseDate: '2026-07-31', poster: 'https://img.example/two.jpg' };
  const exact = bindStudioPlayback({ catalog: { studio: 'DigitalPlayground' }, metadataItems: [metadata], torrentItems: [{ sourceId: 'knaben:two', title: 'A Very Distinctive Scene Name', infoHash: HASH, seeders: 10 }] });
  assert.equal(exact.items.length, 1);
  const overlap = bindStudioPlayback({ catalog: { studio: 'DigitalPlayground' }, metadataItems: [metadata], torrentItems: [{ sourceId: 'knaben:three', title: 'Digital Playground 2026 07 31 A Very Distinctive Scene Name 2160p', infoHash: HASH, seeders: 10 }] });
  assert.equal(overlap.items.length, 1);
});

test('Hentai Top rejects taxonomy cards while All/New remain unmodified fast catalogue paths', async () => {
  assert.equal(topTaxonomyRecord({ title: '3D' }, '3d'), true);
  const list = `<article><a href="/tvshows/3d/"><img src="https://img.example/3d.jpg"></a><h3>3D</h3></article>
  <article><a href="/tvshows/eroriman-2/"><img src="https://img.example/e.jpg"></a><h3>Eroriman 2</h3></article>`;
  const series = `<meta property="og:title" content="Eroriman 2"><a href="/episodes/eroriman-2-episode-1/">Episode 1</a>`;
  const calls = [];
  const fetchImpl = url => {
    const parsed = new URL(String(url)); calls.push(parsed.pathname);
    if (parsed.pathname === '/hentai-series/' || parsed.pathname === '/hentai-series/page/2/' || parsed.pathname === '/hentai-series/page/3/') return Promise.resolve(response(parsed.pathname === '/hentai-series/' ? list : ''));
    if (parsed.pathname === '/tvshows/eroriman-2/') return Promise.resolve(response(series));
    return Promise.resolve(response('', 404));
  };
  const top = createHentaiMamaSeriesAdapter({ config: config(), fetchImpl, checkDns: false, minRequestIntervalMs: 0, maxRetries: 0 });
  const topItems = await top.catalog({ catalog: { id: 'tpb4k.hentai.top', mode: 'top' }, limit: 40 });
  assert.deepEqual(topItems.map(item => item.sourceId), ['ophtop-eroriman-2']);
  assert.equal(calls.includes('/tvshows/3d/'), false);
  assert.equal(calls.includes('/tvshows/eroriman-2/'), true);

  calls.length = 0;
  const all = createHentaiMamaSeriesAdapter({ config: config(), fetchImpl, checkDns: false, minRequestIntervalMs: 0, maxRetries: 0 });
  const allItems = await all.catalog({ catalog: { id: 'tpb4k.hentai.all', mode: 'all' }, limit: 2 });
  assert.equal(allItems.length, 2);
  assert.equal(calls.includes('/tvshows/eroriman-2/'), false, 'All/New catalogue speed path must not be changed');
});

test('All/New metadata survives a detail page with no episodes while playback remains empty', async () => {
  const list = '<article><a href="/tvshows/hentai-a/"><img src="https://img.example/a.jpg"></a><h3>Hentai A</h3></article>';
  const detail = '<meta property="og:title" content="Detailed Scene"><meta property="og:image" content="https://img.example/detail.jpg"><meta property="og:description" content="Metadata without episode anchors">';
  const fetchImpl = url => {
    const parsed = new URL(String(url));
    if (parsed.pathname === '/hentai-series/') return Promise.resolve(response(list));
    if (parsed.pathname === '/tvshows/hentai-a/' || parsed.pathname === '/hentai-series/hentai-a/') return Promise.resolve(response(detail));
    return Promise.resolve(response('', 404));
  };
  const adapter = createHentaiMamaSeriesAdapter({ config: config(), fetchImpl, checkDns: false, minRequestIntervalMs: 0, maxRetries: 0 });
  const items = await adapter.catalog({ catalog: { id: 'tpb4k.hentai.all', mode: 'all' }, limit: 40 });
  assert.equal(items.length, 1);
  const meta = await adapter.meta({ sourceId: items[0].sourceId });
  assert.equal(meta.sourceId, items[0].sourceId);
  assert.equal(meta.title, 'Detailed Scene');
  assert.deepEqual(await adapter.resolve({ sourceId: items[0].sourceId }), []);
});

test('page-specific benign challenge evidence is accepted and challenge-only HTML remains blocked', () => {
  const marker = '<script src="/cdn-cgi/challenge-platform/benign.js"></script>';
  const series = `${marker}<meta property="og:title" content="Real Series"><a href="/episodes/real-episode-1/">Episode 1</a>`;
  const episode = `${marker}<script>jQuery.post('/wp-admin/admin-ajax.php',{action:'get_player_contents',a:'123'});</script>`;
  const challenge = '<title>Just a moment...</title><form id="challenge-form"></form>';
  assert.equal(hasHentaiSeriesEvidence(series), true);
  assert.equal(hasHentaiEpisodeEvidence(episode), true);
  assert.equal(htmlUsable(series, { allowSeriesEvidence: true }), series);
  assert.equal(htmlUsable(episode, { allowEpisodeEvidence: true }), episode);
  assert.equal(htmlUsable(challenge, { allowSeriesEvidence: true }), '');
});

test('Alpha.19 preserves broad pools, isolates Sukebei RSS, and owns its resource namespace', () => {
  const provider = fs.readFileSync(path.join(__dirname, 'tpb4k.js'), 'utf8');
  const torrent = fs.readFileSync(path.join(__dirname, 'tpb4k', 'torrent-index.js'), 'utf8');
  const sukebei = fs.readFileSync(path.join(__dirname, 'tpb4k', 'sukebei-metadata.js'), 'utf8');
  const addon = fs.readFileSync(path.join(__dirname, '..', 'addon.js'), 'utf8');
  assert.match(provider, /\['xvideosred', 'digitalplayground'\]\.includes\(weakStudioKey\)/);
  assert.match(provider, /\? 60/);
  assert.match(provider, /limit: discoveryPoolLimit/);
  assert.match(provider, /recoverStudioPlayback/);
  assert.match(torrent, /studioSearchQueries/);
  assert.match(torrent, /knaben-targeted/);
  assert.match(sukebei, /catalogDefinition\?\.mode === 'top'/);
  assert.match(sukebei, /sukebeiRssPosterUrl/);
  assert.match(addon, /idPrefixes: \['onlyporn:', 'ophmm-', 'ophtop-'\]/);
  assert.doesNotMatch(addon, /(['"`])hmm-/);
});
