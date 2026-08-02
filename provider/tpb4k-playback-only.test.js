'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { encodeTpb4kId } = require('./tpb4k/id-codec');
const { clearAdapters, registerAdapter } = require('./tpb4k/index');
const { createTorrentIndexAdapter } = require('./tpb4k/torrent-index');
const { Tpb4kProvider } = require('./tpb4k');

const HASH_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function jsonResponse(payload) {
  const text = JSON.stringify(payload);
  return {
    status: 200,
    headers: {
      get(name) {
        const key = String(name || '').toLowerCase();
        if (key === 'content-type') return 'application/json';
        if (key === 'content-length') return String(Buffer.byteLength(text));
        return '';
      },
    },
    async text() { return text; },
  };
}

function createAdapter(fetchImpl) {
  return createTorrentIndexAdapter({
    fetchImpl,
    checkDns: false,
    minRequestIntervalMs: 0,
    maxRetries: 0,
    config: {
      requestTimeoutMs: 15_000,
      minimumSeeders: 3,
      discoveryMaxResponseBytes: 2_000_000,
      discoveryCacheTtlMs: 60_000,
      discoveryNegativeTtlMs: 1_000,
      discoveryCacheMaxEntries: 50,
      torrentIndex: {
        knabenEnabled: true,
        mirrors: ['https://thehiddenbay.com'],
        x1337Mirrors: ['https://1337x.to'],
        resolutionCategory: 501,
        sort: 7,
        detailConcurrency: 3,
      },
    },
  });
}

test('targeted query order is title-first for ThePornDB and readable-alias plus title-only for XVideosRED', () => {
  const adapter = createAdapter(async () => jsonResponse({ hits: [] }));

  const tpdbQueries = adapter.debugSceneQueries({
    title: 'Playable Scene Title',
    studio: 'Fixture Studio',
    releaseDate: '2026-07-20',
  }, {
    id: 'tpb4k.tpdb.recent',
    targetedPlaybackSearch: true,
    fastPlaybackSearch: true,
  });
  assert.equal(tpdbQueries[0], 'Playable Scene Title');

  const xvrQueries = adapter.debugSceneQueries({
    title: 'Morning Routine',
    studio: 'XVideosRED',
  }, {
    id: 'tpb4k.studio.xvideosred.top',
    studio: 'XVideosRED',
    targetedPlaybackSearch: true,
    fastPlaybackSearch: true,
  });
  assert.equal(xvrQueries[0], 'XVideos RED Morning Routine');
  assert.equal(xvrQueries[1], 'Morning Routine');
});

test('fast XVideosRED retrieval accepts direct Knaben info hashes without a magnet or detail page', async () => {
  const requests = [];
  const adapter = createAdapter(async (url, options = {}) => {
    requests.push({ url: String(url), body: JSON.parse(String(options.body || '{}')) });
    assert.equal(String(url), 'https://api.knaben.org/v1');
    return jsonResponse({
      hits: [{
        hash: HASH_A,
        title: 'XVideos RED Morning Routine 2160p WEB-DL',
        seeders: 42,
        peers: 2,
        bytes: 4_000_000_000,
        date: '2026-07-20',
      }],
    });
  });

  const candidates = await adapter.resolve({
    sourceId: 'tpdb:xvr-morning-routine',
    catalogId: 'tpb4k.studio.xvideosred.top',
    catalog: {
      id: 'tpb4k.studio.xvideosred.top',
      studio: 'XVideosRED',
      targetedPlaybackSearch: true,
      fastPlaybackSearch: true,
    },
    item: {
      title: 'Morning Routine',
      studio: 'XVideosRED',
    },
  });

  assert.equal(requests.length, 2, 'the readable studio-title and title-only Knaben searches run concurrently');
  assert.deepEqual(requests.map(item => item.body.query), [
    'XVideos RED Morning Routine',
    'Morning Routine',
  ]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].infoHash, HASH_A);
  assert.equal(candidates[0].magnet || '', '');
});


test('fast playback search does not discard a valid Knaben response that arrives after the old 2.5-second cutoff', async () => {
  const adapter = createAdapter(async () => {
    await new Promise(resolve => setTimeout(resolve, 2_700));
    return jsonResponse({
      hits: [{
        hash: HASH_A,
        title: 'XVideos RED Delayed Scene 2160p WEB-DL',
        seeders: 31,
        peers: 1,
        bytes: 3_000_000_000,
      }],
    });
  });

  const startedAt = Date.now();
  const candidates = await adapter.resolve({
    sourceId: 'tpdb:xvr-delayed-scene',
    catalogId: 'tpb4k.studio.xvideosred.top',
    catalog: {
      id: 'tpb4k.studio.xvideosred.top',
      studio: 'XVideosRED',
      targetedPlaybackSearch: true,
      fastPlaybackSearch: true,
    },
    item: {
      title: 'Delayed Scene',
      studio: 'XVideosRED',
    },
  });

  assert.ok(Date.now() - startedAt >= 2_500);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].infoHash, HASH_A);
});

for (const fixture of [
  {
    label: 'ThePornDB Recent',
    catalogId: 'tpb4k.tpdb.recent',
    source: 'tpdb',
    sourceId: 'tpdb:forgotten-scene',
    title: 'Forgotten TPDB Scene',
    studio: 'Fixture Studio',
    hash: HASH_A,
  },
  {
    label: 'XVideosRED',
    catalogId: 'tpb4k.studio.xvideosred.top',
    source: 'studio-metadata',
    sourceId: 'tpdb:forgotten-xvr-scene',
    title: 'Forgotten XVideos RED Scene',
    studio: 'XVideosRED',
    hash: HASH_B,
  },
]) {
  test(`${fixture.label} stream retrieval recovers the title from the existing catalog card and caches the resolved hash`, async () => {
    clearAdapters();
    registerAdapter({
      id: fixture.source,
      configured: true,
      async catalog() { return []; },
      async meta() { return null; },
      async resolve() { return []; },
    });

    let resolveCalls = 0;
    registerAdapter({
      id: 'torrent-index',
      configured: true,
      async catalog() { return []; },
      async meta() { return null; },
      async resolve({ item, catalog }) {
        resolveCalls += 1;
        assert.equal(item.title, fixture.title);
        assert.equal(item.studio, fixture.studio);
        assert.equal(catalog.targetedPlaybackSearch, true);
        assert.equal(catalog.fastPlaybackSearch, true);
        return [{
          source: 'knaben-targeted',
          sourceId: `knaben:${fixture.sourceId}`,
          title: fixture.title,
          filename: `${fixture.title}.mp4`,
          infoHash: fixture.hash,
          seeders: 20,
        }];
      },
    });

    const id = encodeTpb4kId({
      source: fixture.source,
      sourceId: fixture.sourceId,
      catalogId: fixture.catalogId,
      torrents: [],
    });
    const preview = {
      id,
      type: 'movie',
      name: fixture.title,
      genres: [fixture.studio],
      tags: [],
      poster: 'https://images.example/scene.jpg',
    };
    const catalogResponseStore = {
      findMeta(requestId) { return requestId === id ? preview : null; },
      findMetaByIdentity() { return null; },
    };
    const provider = new Tpb4kProvider({
      installBuiltIns: false,
      catalogResponseStore,
      env: {
        TPB4K_ENABLED: 'true',
        TPB4K_MINIMUM_SEEDERS: '3',
        ONLYPORN_DISABLE_PERSISTENT_CACHE: 'true',
      },
    });

    const first = await provider.handleStream({ type: 'movie', id });
    const second = await provider.handleStream({ type: 'movie', id });

    assert.equal(first.streams.length, 1);
    assert.equal(first.streams[0].infoHash, fixture.hash);
    assert.equal(second.streams.length, 1);
    assert.equal(second.streams[0].infoHash, fixture.hash);
    assert.equal(resolveCalls, 1, 'the second click reuses the bounded in-memory playback result');
  });
}
