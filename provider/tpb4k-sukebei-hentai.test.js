'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const { getCatalogDefinition } = require('../catalog/tpb4k');
const { profileOptions } = require('../catalog/discovery-profiles');
const { createSukebeiHentaiSqliteStore } = require('./sukebei-hentai-sqlite');
const { decodeTpb4kId } = require('./tpb4k/id-codec');
const { decodeTorrent } = require('./tpb4k/native-discovery');
const {
  buildSeriesRecords,
  createSukebeiHentaiAdapter,
  episodeFromSourceId,
  matchReleases,
  normalizeRelease,
  rssUrl,
} = require('./tpb4k/sukebei-hentai');
const {
  classifyRelease,
  extractEpisodeNumber,
  selectEpisodeFile,
  titleSimilarity,
} = require('./tpb4k/sukebei-hentai-title');

function bencode(value) {
  if (Buffer.isBuffer(value)) return Buffer.concat([Buffer.from(`${value.length}:`), value]);
  if (typeof value === 'string') return bencode(Buffer.from(value));
  if (Number.isInteger(value)) return Buffer.from(`i${value}e`);
  if (Array.isArray(value)) return Buffer.concat([Buffer.from('l'), ...value.map(bencode), Buffer.from('e')]);
  const keys = Object.keys(value).sort();
  return Buffer.concat([
    Buffer.from('d'),
    ...keys.flatMap(key => [bencode(key), bencode(value[key])]),
    Buffer.from('e'),
  ]);
}

function episodeTorrent(title) {
  return bencode({
    announce: 'udp://tracker.example:80/announce',
    info: {
      files: [
        { length: 40_000_000, path: [`${title} S01E01 1080p.mkv`] },
        { length: 42_000_000, path: [`${title} S01E02 1080p.mkv`] },
        { length: 1_000, path: ['readme.txt'] },
      ],
      name: title,
      'piece length': 262144,
      pieces: Buffer.alloc(20),
    },
  });
}

function metadataItem(number) {
  return {
    sourceId: `anilist:${1_000 + number}`,
    provider: 'anilist',
    externalId: String(1_000 + number),
    title: `Fixture Series ${number}`,
    englishTitle: `Fixture Series ${number}`,
    nativeTitle: `フィクスチャー ${number}`,
    synonyms: [],
    poster: `https://images.example/series-${number}.jpg`,
    background: `https://images.example/series-${number}-background.jpg`,
    description: `Fixture adult animation ${number}`,
    episodes: 2,
    genres: ['Fantasy'],
    tags: ['Hentai'],
    studios: ['Fixture Studio'],
    adult: true,
    releaseDate: '2026-08-01T00:00:00.000Z',
    popularity: 1_000 - number,
    averageScore: 80,
    ranks: { latest: number, trending: number, top: number },
  };
}

function rssItem(number, infoHash) {
  return `<item>
    <guid>https://sukebei.nyaa.si/view/${8_000 + number}</guid>
    <title>[FixtureSubs] Fixture Series ${number} Episode 1-2 Complete Uncensored English Subs 1080p</title>
    <link>https://sukebei.nyaa.si/view/${8_000 + number}</link>
    <pubDate>Fri, 08 Aug 2026 10:00:00 GMT</pubDate>
    <nyaa:infoHash>${infoHash}</nyaa:infoHash>
    <nyaa:seeders>${30 - number}</nyaa:seeders>
    <nyaa:size>80 MiB</nyaa:size>
    <category>Art - Anime</category>
  </item>`;
}

function rssDocument(items) {
  return `<?xml version="1.0"?><rss xmlns:nyaa="https://nyaa.si/xmlns/nyaa"><channel>${items.join('')}</channel></rss>`;
}

function response(body, contentType) {
  return new Response(body, { status: 200, headers: { 'content-type': contentType } });
}

test('new catalog is an isolated series route with source-specific discovery facets', () => {
  assert.deepEqual(getCatalogDefinition('tpb4k.sukebei.hentai'), {
    id: 'tpb4k.sukebei.hentai',
    type: 'series',
    name: 'OnlyPorn: Sukebei Hentai',
    source: 'sukebei-hentai',
    mode: 'playable-series',
  });
  assert.equal(getCatalogDefinition('tpb4k.sukebei.top').source, 'sukebei');
  const labels = profileOptions('tpb4k.sukebei.hentai').map(row => row.label);
  assert.deepEqual(labels, [
    'Newest', 'Seeded', 'Uncensored',
    'English Subs', 'Complete', '1080p',
  ]);
});

test('Sukebei Anime URL cannot drift into the live-action category', () => {
  const url = new URL(rssUrl('https://sukebei.nyaa.si/?page=rss&c=0_0&f=0', 'Fixture Series'));
  assert.equal(url.searchParams.get('page'), 'rss');
  assert.equal(url.searchParams.get('c'), '1_1');
  assert.equal(url.searchParams.get('f'), '0');
  assert.equal(url.searchParams.get('q'), 'Fixture Series');
});

test('release parsing recognizes uncensored, subtitles, complete batches, resolution, and exact episodes', () => {
  const classification = classifyRelease('[Team] Show S01E02 1080p Uncensored English Subs Complete');
  assert.equal(classification.episode, 2);
  assert.equal(classification.uncensored, true);
  assert.equal(classification.englishSubtitles, true);
  assert.equal(classification.complete, true);
  assert.equal(classification.resolution, '1080p');
  assert.equal(extractEpisodeNumber('Show 第03話.mkv'), 3);
  assert.ok(titleSimilarity('Show Episode 2 1080p', 'Show') >= 0.9);
  assert.deepEqual(decodeTorrent(episodeTorrent('Tracker Fixture')).trackers, [
    'udp://tracker.example:80/announce',
  ]);
});

test('metadata matching is confidence-gated and exact episode file selection never chooses the largest wrong episode', () => {
  const metadata = metadataItem(1);
  const matching = normalizeRelease({
    id: 'https://sukebei.nyaa.si/view/1',
    title: '[Team] Fixture Series 1 Episode 2 1080p',
    link: 'https://sukebei.nyaa.si/view/1',
    infoHash: '1'.repeat(40),
    seeders: 10,
  });
  const unrelated = normalizeRelease({
    id: 'https://sukebei.nyaa.si/view/2',
    title: 'Entirely Different Animation 1080p',
    link: 'https://sukebei.nyaa.si/view/2',
    infoHash: '2'.repeat(40),
    seeders: 100,
  });
  assert.deepEqual(matchReleases(metadata, [unrelated, matching]).map(row => row.infoHash), ['1'.repeat(40)]);
  const selected = selectEpisodeFile([
    { index: 0, path: 'Show S01E01.mkv', length: 900_000_000 },
    { index: 1, path: 'Show S01E02.mkv', length: 500_000_000 },
  ], 2);
  assert.equal(selected.index, 1);
});

test('isolated SQLite persists series, episodes, releases, metadata and a completed build state under /tmp', async t => {
  const runtime = fs.mkdtempSync('/tmp/onlyporn-sukebei-hentai-test-');
  const store = createSukebeiHentaiSqliteStore({
    env: {
      ...process.env,
      ONLYPORN_RUNTIME_DIR: runtime,
      ONLYPORN_DISABLE_PERSISTENT_CACHE: '',
      ONLYPORN_SUKEBEI_HENTAI_MIN_FREE_BYTES: '1',
    },
  });
  t.after(() => store.close());
  const release = {
    infoHash: 'a'.repeat(40), parentId: 'anilist:1', episode: 1, title: 'Fixture',
    release: { infoHash: 'a'.repeat(40), title: 'Fixture' },
  };
  const item = { sourceId: 'anilist:1', title: 'Fixture', poster: 'https://images.example/1.jpg' };
  const episode = { sourceId: 'anilist:1:episode:1', title: 'Fixture E1' };
  const result = await store.replaceIndex({
    seriesItems: [{ sourceId: item.sourceId, parentId: item.sourceId, title: item.title, searchText: 'fixture uncensored', sortDate: 10, seeders: 5, item }],
    episodeItems: [{ sourceId: episode.sourceId, parentId: item.sourceId, title: episode.title, searchText: 'fixture e1', sortDate: 10, seeders: 5, item: episode }],
    releases: [release],
    build: { status: 'complete', cards: 1 },
  });
  assert.equal(result.written, true);
  assert.equal((await store.listSeries({ query: 'uncensored' })).length, 1);
  assert.equal((await store.getItem(episode.sourceId)).title, 'Fixture E1');
  await store.putMetadata('anilist', 'fixture', [item]);
  assert.equal((await store.getMetadata('anilist', 'fixture'))[0].sourceId, 'anilist:1');
  assert.equal((await store.state()).value.status, 'complete');
  const stats = await store.stats();
  assert.equal(stats.seriesRows, 1);
  assert.equal(stats.episodeRows, 1);
  assert.equal(stats.releaseRows, 1);
  assert.equal(stats.metadataRows, 1);
  assert.ok(stats.dbPath.startsWith('/private/tmp/') || stats.dbPath.startsWith('/tmp/'));
});

test('adapter builds a playable six-series index and resolves the selected episode from torrent contents', async () => {
  const rows = Array.from({ length: 6 }, (_, index) => metadataItem(index + 1));
  const torrents = new Map(rows.map((row, index) => {
    const body = episodeTorrent(row.title);
    return [index + 1, { body, hash: decodeTorrent(body).infoHash }];
  }));
  const rss = rssDocument([...torrents.entries()].map(([number, value]) => rssItem(number, value.hash)));
  const requests = [];
  const store = {
    enabled: false,
    async getMetadata() { return null; },
    async putMetadata() { return null; },
    async state() { return null; },
    async listSeries() { return []; },
    async getItem() { return null; },
    async replaceIndex() { return null; },
  };
  const adapter = createSukebeiHentaiAdapter({
    config: {
      discovery: { sukebeiHentai: 'https://sukebei.nyaa.si/?page=rss&c=1_1&f=0' },
      requestTimeoutMs: 5_000,
      discoveryMaxResponseBytes: 2_000_000,
      discoveryCacheTtlMs: 60_000,
      discoveryNegativeTtlMs: 1_000,
      discoveryCacheMaxEntries: 100,
    },
    env: {
      ONLYPORN_SUKEBEI_HENTAI_MIN_CARDS: '6',
      ONLYPORN_SUKEBEI_HENTAI_BUILD_CANDIDATES: '20',
      ONLYPORN_SUKEBEI_HENTAI_BUILD_BUDGET_MS: '30000',
    },
    checkDns: false,
    minRequestIntervalMs: 0,
    maxRetries: 0,
    sukebeiHentaiStore: store,
    sukebeiHentaiMetadataClients: {
      anilist: { configured: true, async catalog() { return rows; }, async search() { return []; } },
      jikan: { configured: true, async search() { return []; } },
    },
    fetchImpl: async value => {
      const url = new URL(String(value));
      requests.push(url);
      if (url.pathname.startsWith('/download/')) {
        const number = Number(url.pathname.match(/\/(\d+)\.torrent$/)?.[1]) - 8_000;
        return response(torrents.get(number).body, 'application/x-bittorrent');
      }
      assert.equal(url.searchParams.get('c'), '1_1');
      return response(rss, 'application/rss+xml');
    },
  });

  const catalog = await adapter.catalog({
    catalog: { id: 'tpb4k.sukebei.hentai', mode: 'playable-series' },
    skip: 0,
    limit: 40,
  });
  assert.equal(catalog.length, 6);
  assert.equal(catalog.every(item => item.videos.length === 2), true);
  assert.equal(catalog.every(item => item.tags.includes('Uncensored')), true);
  assert.equal(catalog.every(item => item.tags.includes('English Subtitles')), true);
  const identity = decodeTpb4kId(catalog[0].videos[1].id);
  assert.equal(identity.source, 'sukebei-hentai');
  assert.equal(identity.catalogId, 'tpb4k.sukebei.hentai');
  assert.equal(episodeFromSourceId(identity.sourceId), 2);
  assert.ok(identity.torrents.length >= 1);
  assert.equal(identity.torrents.every(row => Number.isInteger(row.fileIdx)), true);
  assert.equal(identity.torrents[0].fileIdx, 1);
  const torrentRequestsBeforeResolve = requests.filter(url => url.pathname.startsWith('/download/')).length;
  const episodeItem = await adapter.meta({ sourceId: identity.sourceId });
  const streams = await adapter.resolve({ sourceId: identity.sourceId, item: episodeItem });
  assert.ok(streams.length >= 1);
  assert.equal(streams[0].fileIdx, 1);
  assert.match(streams[0].filename, /S01E02/);
  assert.equal(
    requests.filter(url => url.pathname.startsWith('/download/')).length,
    torrentRequestsBeforeResolve
  );
  assert.equal(requests.every(url => url.hostname === 'sukebei.nyaa.si'), true);
});

test('stale multi-release playback fallback inspects torrents concurrently inside the Stremio budget', async () => {
  const torrentRows = Array.from({ length: 3 }, (_, index) => {
    const number = index + 1;
    const body = episodeTorrent(`Parallel Fixture ${number}`);
    return {
      number,
      body,
      release: normalizeRelease({
        id: `https://sukebei.nyaa.si/view/${9_000 + number}`,
        title: `[Team ${number}] Parallel Fixture Episode 1-2 Complete 1080p`,
        link: `https://sukebei.nyaa.si/view/${9_000 + number}`,
        infoHash: decodeTorrent(body).infoHash,
        seeders: 20 - number,
      }),
    };
  });
  let inFlight = 0;
  let maxInFlight = 0;
  const adapter = createSukebeiHentaiAdapter({
    config: {
      discovery: { sukebeiHentai: 'https://sukebei.nyaa.si/?page=rss&c=1_1&f=0' },
      requestTimeoutMs: 5_000,
    },
    env: {
      ONLYPORN_SUKEBEI_HENTAI_RESOLVE_CONCURRENCY: '3',
      ONLYPORN_SUKEBEI_HENTAI_STREAM_RESOLVE_BUDGET_MS: '2000',
    },
    checkDns: false,
    sukebeiHentaiStore: { enabled: false },
    sukebeiHentaiMetadataClients: {
      anilist: { configured: true },
      jikan: { configured: true },
    },
    fetchImpl: async value => {
      const url = new URL(String(value));
      const number = Number(url.pathname.match(/\/(\d+)\.torrent$/)?.[1]) - 9_000;
      const row = torrentRows.find(candidate => candidate.number === number);
      assert.ok(row);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 25));
      inFlight -= 1;
      return response(row.body, 'application/x-bittorrent');
    },
  });
  const streams = await adapter.resolve({
    sourceId: 'anilist:parallel:episode:2',
    item: {
      sukebeiHentai: {
        episode: 2,
        releases: torrentRows.map(row => row.release),
      },
    },
  });
  assert.equal(maxInFlight, 3);
  assert.equal(streams.length, 3);
  assert.equal(streams.every(stream => stream.fileIdx === 1), true);
  assert.equal(streams.every(stream => stream.trackers.includes('udp://tracker.example:80/announce')), true);
});

test('series records do not become catalog cards without a real matched torrent', () => {
  assert.equal(buildSeriesRecords(metadataItem(1), []), null);
});
