'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { clearAdapters, registerAdapter } = require('./tpb4k/index');
const { decodeTpb4kId } = require('./tpb4k/id-codec');
const {
  createPlaybackBindingStore,
} = require('./tpb4k/playback-binding-store');
const { createTorrentIndexAdapter } = require('./tpb4k/torrent-index');
const { readTpb4kConfig } = require('./tpb4k/config');
const { Tpb4kProvider } = require('./tpb4k');

const HASH = '1234567890abcdef1234567890abcdef12345678';

function responseJson(value) {
  const text = JSON.stringify(value);
  return {
    status: 200,
    headers: {
      get(name) {
        const key = String(name).toLowerCase();
        if (key === 'content-type') return 'application/json';
        if (key === 'content-length') return String(Buffer.byteLength(text));
        return '';
      },
    },
    async text() {
      return text;
    },
  };
}

test.afterEach(() => clearAdapters());

test('XVideosRED keeps its full metadata row and persists click-time recovery', async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'onlyporn-playback-bindings-')
  );
  const filePath = path.join(directory, 'bindings.json');
  const scenes = [1, 2, 3].map(index => ({
    source: 'studio-metadata',
    sourceId: `tpdb:xvr-${index}`,
    title: `XVideos RED Scene ${index}`,
    studio: 'XVideosRED',
    poster: `https://images.example/xvr-${index}.jpg`,
    background: `https://images.example/xvr-${index}.jpg`,
    releaseDate: `2026-07-${20 + index}`,
  }));

  let clickRecovery = false;
  let clickCalls = 0;

  registerAdapter({
    id: 'studio-metadata',
    configured: true,
    async catalog() {
      return scenes;
    },
    async meta({ sourceId }) {
      return scenes.find(item => item.sourceId === sourceId) || null;
    },
    async resolve() {
      return [];
    },
  });

  registerAdapter({
    id: 'torrent-index',
    configured: true,
    async catalog() {
      return [];
    },
    async catalogTorrents() {
      return [];
    },
    async meta() {
      return null;
    },
    async resolve({ catalog, item }) {
      if (!clickRecovery) return [];
      clickCalls += 1;
      assert.equal(catalog.targetedPlaybackSearch, true);
      assert.equal(catalog.fastPlaybackSearch, true);
      return [{
        source: 'knaben',
        sourceId: `knaben:${item.sourceId}`,
        infoHash: HASH,
        title: item.title,
        filename: `${item.title}.mp4`,
        seeders: 12,
      }];
    },
  });

  try {
    const store = createPlaybackBindingStore({
      enabled: true,
      filePath,
    });
    const provider = new Tpb4kProvider({
      env: {
        TPB4K_ENABLED: 'true',
        TPB4K_CATALOG_LIMIT: '3',
        TPB4K_MINIMUM_SEEDERS: '3',
        ONLYPORN_DISABLE_PERSISTENT_CACHE: 'true',
      },
      installBuiltIns: false,
      playbackBindingStore: store,
    });

    const catalog = await provider.handleCatalog({
      type: 'movie',
      id: 'tpb4k.studio.xvideosred.top',
      extra: {},
    });
    assert.equal(catalog.metas.length, 3);

    const unbound = catalog.metas.find(meta => {
      const decoded = decodeTpb4kId(meta.id);
      return !decoded?.torrents?.length;
    });
    assert.ok(unbound);

    clickRecovery = true;
    const first = await provider.handleStream({
      type: 'movie',
      id: unbound.id,
    });
    assert.equal(first.streams.length, 1);
    assert.equal(first.streams[0].infoHash, HASH);
    assert.equal(clickCalls, 1);
    assert.equal(store.size(), 1);

    clickRecovery = false;
    const reloadedStore = createPlaybackBindingStore({
      enabled: true,
      filePath,
    });
    const secondProvider = new Tpb4kProvider({
      env: {
        TPB4K_ENABLED: 'true',
        TPB4K_MINIMUM_SEEDERS: '3',
        ONLYPORN_DISABLE_PERSISTENT_CACHE: 'true',
      },
      installBuiltIns: false,
      playbackBindingStore: reloadedStore,
    });

    const second = await secondProvider.handleStream({
      type: 'movie',
      id: unbound.id,
    });
    assert.equal(second.streams.length, 1);
    assert.equal(second.streams[0].infoHash, HASH);
    assert.equal(clickCalls, 1, 'persisted binding must avoid another resolver call');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('ThePornDB fast recovery uses the title and accepts Knaben direct infoHash', async () => {
  const requests = [];
  const adapter = createTorrentIndexAdapter({
    config: readTpb4kConfig({
      TPB4K_ENABLED: 'true',
      TPB4K_MINIMUM_SEEDERS: '3',
      TPB4K_REQUEST_TIMEOUT_MS: '15000',
      TPB4K_KNABEN_ENABLED: 'true',
    }),
    checkDns: false,
    minRequestIntervalMs: 0,
    maxRetries: 0,
    fetchImpl: async (url, options = {}) => {
      requests.push({ url: String(url), options });
      const body = JSON.parse(options.body);
      return responseJson({
        hits: [{
          title: 'A Very Specific TPDB Title 1080p',
          hash: HASH,
          seeders: 21,
          peers: 2,
          bytes: 1234567890,
          date: '2026-07-20',
        }],
      });
    },
  });

  const queries = adapter.debugSceneQueries(
    {
      sourceId: 'tpdb:recent-one',
      title: 'A Very Specific TPDB Title',
      studio: '',
    },
    {
      id: 'tpb4k.tpdb.recent',
      targetedPlaybackSearch: true,
    }
  );
  assert.equal(
    queries.some(query => /very specific tpdb title/i.test(query)),
    true
  );

  const candidates = await adapter.resolve({
    sourceId: 'tpdb:recent-one',
    catalogId: 'tpb4k.tpdb.recent',
    catalog: {
      id: 'tpb4k.tpdb.recent',
      targetedPlaybackSearch: true,
      fastPlaybackSearch: true,
    },
    item: {
      sourceId: 'tpdb:recent-one',
      title: 'A Very Specific TPDB Title',
      studio: '',
    },
  });

  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /api\.knaben\.org\/v1/);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].infoHash, HASH);
  assert.equal(candidates[0].seeders, 21);
});

test('XVideosRED fast queries preserve approved readable aliases', () => {
  const adapter = createTorrentIndexAdapter({
    config: readTpb4kConfig({
      TPB4K_ENABLED: 'true',
      TPB4K_KNABEN_ENABLED: 'false',
    }),
    checkDns: false,
  });

  const queries = adapter.debugSceneQueries(
    {
      sourceId: 'tpdb:xvr-alias',
      title: 'Alias Recovery Scene',
      studio: 'XVideosRED',
    },
    {
      id: 'tpb4k.studio.xvideosred.top',
      studio: 'XVideosRED',
      targetedPlaybackSearch: true,
    }
  );

  assert.equal(
    queries.some(query => /xvideos\s+red/i.test(query)),
    true
  );
});
