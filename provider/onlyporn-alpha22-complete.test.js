'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  creatorKey,
  externalPosterValid,
  mergeTorrentFirstStudio,
  shouldUseTorrentFirst,
} = require('./tpb4k/torrent-first-studio');
const {
  dooplayAjaxEndpoint,
  dooplayPlayerOptions,
  mediaUrls,
  nestedPlayerUrls,
  parseAjaxFields,
} = require('./tpb4k/hentaimama-series');
const {
  createSukebeiArtworkStore,
  STORE_VERSION,
} = require('./tpb4k/sukebei-artwork-store');
const {
  createCatalogResponseStore,
  STORE_VERSION: CATALOG_STORE_VERSION,
} = require('./tpb4k/catalog-response-store');

const H1 = '1111111111111111111111111111111111111111';
const H2 = '2222222222222222222222222222222222222222';

function torrent(hash, title, poster, extra = {}) {
  return {
    source: 'torrent-index',
    sourceId: `knaben:${hash}`,
    infoHash: hash,
    title,
    filename: title,
    poster,
    background: poster,
    resolution: extra.resolution || '1080p',
    seeders: extra.seeders || 10,
    indexer: extra.indexer || 'knaben',
    studio: 'OnlyFans',
    lookupSource: extra.lookupSource || 'torrent-index-poster-enrichment',
    ...extra,
  };
}

test('normal studios keep the stable binder while only four weak catalogues can use torrent-first recovery', () => {
  const provider = fs.readFileSync(require.resolve('./tpb4k'), 'utf8');
  assert.match(provider, /TORRENT_FIRST_STUDIOS = new Set\(\['onlyfans', 'digitalplayground', 'xvideosred', 'sexmex'\]\)/);
  assert.match(provider, /this\.catalogResponseCache = new Map\(\)/);
  assert.match(provider, /this\.catalogInFlight = new Map\(\)/);
  assert.doesNotMatch(provider, /const catalogResponseCache = new Map\(\)/);
  assert.doesNotMatch(provider, /const catalogInFlight = new Map\(\)/);
  assert.match(provider, /weakStudioKey === 'onlyfans' \? 600/);
  assert.equal(shouldUseTorrentFirst({ studio: 'OnlyFans' }, 39), true);
  assert.equal(shouldUseTorrentFirst({ studio: 'OnlyFans' }, 40), false);
  assert.equal(shouldUseTorrentFirst({ studio: 'DigitalPlayground' }, 19), true);
  assert.equal(shouldUseTorrentFirst({ studio: 'DigitalPlayground' }, 20), false);
  assert.equal(shouldUseTorrentFirst({ studio: 'Vixen' }, 0), false);
  assert.equal(shouldUseTorrentFirst({ studio: 'SexArt' }, 0), false);
});

test('OnlyFans keeps all hashes and upgrades a generated card to the best real poster', () => {
  const internal = 'https://onlyporn.example/onlyporn/poster/studio-release/abc.svg';
  const real = 'https://images.example/alice-real.jpg';
  assert.equal(externalPosterValid({ poster: internal, lookupSource: 'torrent-index-poster-enrichment' }), false);
  assert.equal(externalPosterValid({ poster: real, lookupSource: 'torrent-index-poster-enrichment' }), true);
  const result = mergeTorrentFirstStudio({
    catalog: { id: 'tpb4k.studio.onlyfans.top', studio: 'OnlyFans' },
    existingItems: [],
    metadataItems: [],
    torrentItems: [
      torrent(H1, 'Alice Wonderland Private Shower OnlyFans 1080p', internal, { resolution: '1080p', seeders: 50 }),
      torrent(H2, 'Alice Wonderland Private Shower OnlyFans 2160p', real, { resolution: '2160p', seeders: 20 }),
    ],
    limit: 40,
    config: { posterAssetBaseUrl: 'https://onlyporn.example' },
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].poster, real);
  assert.deepEqual(new Set(result.items[0].playbackCandidates.map(item => item.infoHash)), new Set([H1, H2]));
});

test('OnlyFans explicit creator identity remains stable across release title noise', () => {
  const catalog = { studio: 'OnlyFans' };
  assert.equal(creatorKey({ creator: 'Alice Wonderland', title: 'OnlyFans Alice Wonderland Private Shower 2160p' }, catalog), 'alicewonderland');
  assert.equal(creatorKey({ username: '@alice_wonderland', title: '[OnlyFans] Alice Wonderland Private Shower' }, catalog), 'alicewonderland');
});


test('catalogue last-known-good store is atomic, bounded and reloadable without cross-provider globals', () => {
  assert.equal(CATALOG_STORE_VERSION, 1);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'op-a22-complete-catalog-'));
  const filePath = path.join(directory, 'catalog.json');
  try {
    const first = createCatalogResponseStore({ filePath, env: {}, maxEntries: 8 });
    assert.equal(first.set('movie:tpb4k.studio.vixen.top:0', { metas: [{ id: 'one' }] }), true);
    const second = createCatalogResponseStore({ filePath, env: {}, maxEntries: 8 });
    assert.deepEqual(second.get('movie:tpb4k.studio.vixen.top:0')?.value?.metas, [{ id: 'one' }]);
    assert.equal(fs.readdirSync(directory).some(name => name.endsWith('.tmp')), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Sukebei version 3 rejects ImageTwist on write and on rehydrate', () => {
  assert.equal(STORE_VERSION, 3);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'op-a22-complete-sukebei-'));
  const filePath = path.join(directory, 'art.json');
  try {
    fs.writeFileSync(filePath, JSON.stringify({
      version: 3,
      records: [{ sourceId: 'bad', poster: 'https://imagetwist.com/error.jpg', savedAt: Date.now() }],
    }));
    const store = createSukebeiArtworkStore({ filePath, env: {} });
    assert.equal(store.get('bad'), null);
    assert.equal(store.set({ sourceId: 'bad2', poster: 'https://imgtwist.com/hotlink.jpg', lookupSource: 'sukebei-detail' }), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('HentaiMama Dooplay mirror options and AJAX endpoint are extracted from current WordPress player markup', () => {
  const html = `
    <script>var dtAjax={url:'https://hentaimama.io/wp-admin/admin-ajax.php'};</script>
    <ul>
      <li data-post="98765" data-nume="1" data-type="tv" data-nonce="abc">Mirror 1</li>
      <li data-type='tv' data-nume='2' data-post='98765'>Mirror 2</li>
    </ul>`;
  assert.equal(dooplayAjaxEndpoint(html), 'https://hentaimama.io/wp-admin/admin-ajax.php');
  assert.deepEqual(dooplayPlayerOptions(html), [
    { post: '98765', nume: '1', type: 'tv', nonce: 'abc' },
    { post: '98765', nume: '2', type: 'tv', nonce: '' },
  ]);
});

test('HentaiMama AJAX response and nested player markup preserve direct media candidates', () => {
  const ajax = JSON.stringify({ embed_url: '<iframe src="https://player.example/embed/42"></iframe>' });
  const ajaxFields = parseAjaxFields(ajax);
  assert.deepEqual(ajaxFields.flatMap(field => nestedPlayerUrls(field, 'https://hentaimama.io/episodes/example-episode-1/')), [
    'https://player.example/embed/42',
  ]);
  const player = String.raw`window.sources=[{file:'https:\/\/cdn.example\/hls\/master.m3u8'}]`;
  assert.deepEqual(mediaUrls(player, 'https://player.example/embed/42'), [
    'https://cdn.example/hls/master.m3u8',
  ]);
});

test('the single Sukebei Top catalogue rejects invalid final posters and owns its bounded fallback', () => {
  const provider = fs.readFileSync(require.resolve('./tpb4k'), 'utf8');
  assert.match(provider, /definition\.id !== 'tpb4k\.sukebei\.top' \|\| Boolean\(safePoster\(item\.poster\)\)/);
  const source = fs.readFileSync(require.resolve('./tpb4k/sukebei-metadata'), 'utf8');
  assert.match(source, /catalogDefinition\?\.mode === 'top'/);
  assert.match(source, /Math\.min\(safeSkip \+ safeLimit, 8\)/);
});
