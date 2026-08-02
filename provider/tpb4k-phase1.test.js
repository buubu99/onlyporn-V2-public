'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const {
  catalogDefinitions,
  getCatalogDefinition,
  isTpb4kEnabled,
  tpb4kCatalogs,
} = require('../catalog/tpb4k');
const {
  candidateScore,
  classifyDirectUrl,
  dedupeCandidates,
  normalizeCandidate,
  normalizeInfoHash,
  parseMagnet,
  sortCandidates,
  toStremioStream,
} = require('./tpb4k/candidate');
const {
  publicConfigStatus,
  readTpb4kConfig,
  redactSecrets,
} = require('./tpb4k/config');
const { decodeTpb4kId, encodeTpb4kId } = require('./tpb4k/id-codec');
const { buildSceneIdentity } = require('./tpb4k/identity');
const {
  clearAdapters,
  registerAdapter,
} = require('./tpb4k/index');
const { Tpb4kProvider } = require('./tpb4k');

const HASH_4K = '0123456789abcdef0123456789abcdef01234567';
const HASH_1080 = '89abcdef0123456789abcdef0123456789abcdef';
const HASH_ALT = 'fedcba9876543210fedcba9876543210fedcba98';

function memoryAdapter() {
  return {
    id: 'pornrips',
    async catalog() {
      return [
        {
          sourceId: 'scene-001',
          title: 'Example Studio - Example Scene 2160p',
          poster: 'https://images.example/scene-001.jpg',
          studio: 'Example Studio',
          performers: ['Performer One'],
          releaseDate: '2026-07-01',
          resolution: '2160p',
        },
      ];
    },
    async meta({ sourceId }) {
      return {
        sourceId,
        title: 'Example Studio - Example Scene 2160p',
        poster: 'https://images.example/scene-001.jpg',
        description: 'Fixture metadata',
        studio: 'Example Studio',
        performers: ['Performer One'],
        releaseDate: '2026-07-01',
        resolution: '2160p',
      };
    },
    async resolve() {
      return [
        {
          title: 'Unresolved HTML result',
          detailUrl: 'https://1337x.example/torrent/123/fixture/',
          seeders: 999,
        },
        {
          title: 'Example Scene 2160p',
          infoHash: HASH_4K,
          cached: true,
          seeders: 23,
          size: '12.5 GiB',
          resolution: '2160p',
        },
        {
          title: 'Example Scene 2160p duplicate',
          magnet: `magnet:?xt=urn:btih:${HASH_4K}&dn=duplicate`,
          cached: true,
          seeders: 1,
          resolution: '2160p',
        },
        {
          title: 'Validated direct fallback 1080p',
          url: 'https://media.example/scene/master.m3u8',
          validated: true,
          resolution: '1080p',
        },
        {
          title: 'Uncached low-seed result',
          infoHash: HASH_1080,
          cached: false,
          seeders: 1,
          resolution: '1080p',
        },
      ];
    },
  };
}

test.afterEach(() => clearAdapters());

test('Phase 1 defines the exact 28 selected OnlyPorn board catalogs', () => {
  assert.equal(catalogDefinitions.length, 28);
  assert.equal(tpb4kCatalogs.length, 28);
  assert.equal(new Set(catalogDefinitions.map(item => item.id)).size, 28);
  assert.ok(getCatalogDefinition('tpb4k.pornrips.recent'));
  assert.ok(getCatalogDefinition('tpb4k.hentai.top'));
  assert.ok(getCatalogDefinition('tpb4k.stripchat.couples'));
  assert.ok(getCatalogDefinition('tpb4k.studio.vixen.top'));
  assert.ok(getCatalogDefinition('tpb4k.studio.sexart.top'));
  assert.equal(getCatalogDefinition('tpb4k.xxx.top'), null);
  assert.equal(catalogDefinitions.some(item => Object.hasOwn(item, 'targetResolution')), false);
  assert.equal(catalogDefinitions.some(item => /(?: 4K| 1080p) · Top/.test(item.name)), false);
});

test('OnlyPorn board catalogs stay disabled by default and expose 28 descriptors only behind the feature flag', () => {
  assert.equal(isTpb4kEnabled({}), false);
  assert.equal(isTpb4kEnabled({ TPB4K_ENABLED: 'true' }), true);
  assert.equal(tpb4kCatalogs.filter(item => item.id.startsWith('tpb4k.')).length, 28);
});

test('magnet and info-hash normalization accepts valid hashes and rejects HTML placeholders', () => {
  const parsed = parseMagnet(
    `magnet:?xt=urn:btih:${HASH_4K.toUpperCase()}&dn=Example%204K&tr=udp%3A%2F%2Ftracker.example%3A80%2Fannounce`
  );
  assert.equal(parsed.infoHash, HASH_4K);
  assert.equal(normalizeInfoHash(HASH_4K.toUpperCase()), HASH_4K);
  assert.equal(normalizeInfoHash('not-a-hash'), '');

  const placeholder = normalizeCandidate({
    title: '1337x unresolved result',
    url: 'https://1337x.example/torrent/123/fixture/',
  });
  assert.equal(placeholder.kind, 'invalid');
  assert.match(placeholder.reason, /detail pages/i);
  assert.equal(toStremioStream(placeholder), null);
});

test('direct media must be HTTPS and explicitly validated before it can play', () => {
  assert.equal(classifyDirectUrl('http://media.example/master.m3u8').kind, '');
  assert.equal(classifyDirectUrl('https://media.example/page.html').kind, '');
  assert.equal(classifyDirectUrl('https://media.example/master.m3u8').kind, 'direct-hls');

  const unvalidated = normalizeCandidate({ url: 'https://media.example/master.m3u8' });
  assert.equal(unvalidated.kind, 'invalid');

  const validated = normalizeCandidate({
    url: 'https://media.example/master.m3u8',
    validated: true,
    resolution: '1080p',
  });
  assert.equal(validated.kind, 'direct-hls');
  assert.equal(toStremioStream(validated).url, 'https://media.example/master.m3u8');
});

test('unified candidate ranking returns all resolutions and prefers ready 4K before ready lower resolutions', () => {
  const direct = normalizeCandidate({
    title: 'Direct 1080p',
    url: 'https://media.example/master.m3u8',
    validated: true,
    resolution: '1080p',
  });
  const cached4k = normalizeCandidate({
    title: 'Cached 4K',
    infoHash: HASH_4K,
    cached: true,
    resolution: '2160p',
    seeders: 10,
  });
  const duplicate = normalizeCandidate({
    title: 'Duplicate 4K',
    infoHash: HASH_4K,
    cached: true,
    resolution: '2160p',
    seeders: 1,
  });
  const uncached = normalizeCandidate({
    title: 'Uncached 4K',
    infoHash: HASH_1080,
    cached: false,
    resolution: '2160p',
    seeders: 100,
  });

  assert.ok(candidateScore(cached4k) > candidateScore(direct));
  assert.ok(candidateScore(direct) > candidateScore(uncached));
  const results = sortCandidates(dedupeCandidates([duplicate, uncached, direct, cached4k]));
  assert.equal(results.length, 3);
  assert.equal(results[0].infoHash, HASH_4K);
  assert.equal(results[0].seeders, 10);
  assert.equal(results[1].kind, 'direct-hls');
});

test('opaque TPB4K IDs carry source identity without credentials or raw playable URLs', () => {
  const id = encodeTpb4kId({
    source: 'pornrips',
    sourceId: 'scene-001',
    catalogId: 'tpb4k.pornrips.recent',
  });
  assert.match(id, /^onlyporn:tpb4k:/);
  assert.doesNotMatch(id, /https?:\/\//);
  assert.deepEqual(decodeTpb4kId(id), {
    version: 1,
    source: 'pornrips',
    sourceId: 'scene-001',
    catalogId: 'tpb4k.pornrips.recent',
  });
  assert.equal(decodeTpb4kId(`${id}broken`), null);
});

test('scene identity is stable across release-noise variations', () => {
  const left = buildSceneIdentity({
    studio: 'Example Studio',
    title: 'Example.Scene.2160p.WEB-DL.HEVC',
    performers: ['Performer One'],
    releaseDate: '2026-07-01',
  });
  const right = buildSceneIdentity({
    studio: 'example studio',
    title: 'Example Scene 4K',
    performers: ['performer one'],
    releaseDate: '2026/07/01',
  });
  assert.equal(left.digest, right.digest);
});

test('TPDB and StashDB keys are environment-only and public status never returns secrets', () => {
  const env = {
    TPB4K_ENABLED: 'true',
    TPDB_API_KEY: 'tpdb-secret-fixture',
    STASHDB_API_KEY: 'stash-secret-fixture',
    TPB4K_MIN_SEEDERS: '3',
  };
  const config = readTpb4kConfig(env);
  assert.equal(config.tpdb.apiKey, 'tpdb-secret-fixture');
  assert.equal(config.stashdb.apiKey, 'stash-secret-fixture');
  assert.deepEqual(publicConfigStatus(config), {
    enabled: true,
    catalogLimit: 40,
    minimumSeeders: 3,
    requestTimeoutMs: 15000,
    tpdbConfigured: true,
    stashdbConfigured: true,
    configuredDiscoverySources: ['hentai', 'pornrips', 'studio-metadata', 'sukebei', 'torrent-index', 'yesporn'],
    stripchatPhaseRequired: 7,
    renderPreview: false,
  });
  assert.equal(
    redactSecrets('a tpdb-secret-fixture b stash-secret-fixture c', env),
    'a [REDACTED] b [REDACTED] c'
  );
  assert.doesNotMatch(JSON.stringify(publicConfigStatus(config)), /secret-fixture/);
});

test('provider foundation normalizes catalog, meta, and stream results without leaking HTML pages', async () => {
  registerAdapter(memoryAdapter());
  const provider = new Tpb4kProvider({
    env: {
      TPB4K_ENABLED: 'true',
      TPB4K_MIN_SEEDERS: '3',
    },
  });

  const catalog = await provider.handleCatalog({
    type: 'movie',
    id: 'tpb4k.pornrips.recent',
    extra: {},
  });
  assert.equal(catalog.metas.length, 1);
  assert.match(catalog.metas[0].id, /^onlyporn:tpb4k:/);

  const meta = await provider.handleMeta({ type: 'movie', id: catalog.metas[0].id });
  assert.equal(meta.meta.name, 'Example Studio - Example Scene 2160p');
  assert.equal(meta.meta.extra.onlyporn.source, 'pornrips');

  const result = await provider.handleStream({ type: 'movie', id: catalog.metas[0].id });
  assert.equal(result.streams.length, 2);
  assert.equal(result.streams[0].infoHash, HASH_4K);
  assert.equal(result.streams[1].url, 'https://media.example/scene/master.m3u8');
  assert.equal(result.streams.some(stream => /1337x/.test(JSON.stringify(stream))), false);
  assert.equal(result.streams.some(stream => stream.infoHash === HASH_1080), false);
});

test('provider recovers metadata from the persisted catalog card when a transient adapter index forgets it', async () => {
  registerAdapter({
    id: 'pornrips',
    async catalog() {
      return [{
        sourceId: 'forgotten-after-catalog',
        title: 'Durable Catalog Metadata Fixture',
        poster: 'https://images.example/durable-catalog.jpg',
        description: 'Metadata retained with the catalog response',
        studio: 'Fixture Studio',
        infoHash: HASH_4K,
      }];
    },
    async meta() { return null; },
    async resolve() { return []; },
  });
  const provider = new Tpb4kProvider({
    installBuiltIns: false,
    env: {
      TPB4K_ENABLED: 'true',
      TPB4K_CATALOG_LIMIT: '1',
      ONLYPORN_DISABLE_PERSISTENT_CACHE: 'true',
    },
  });
  const catalog = await provider.handleCatalog({
    type: 'movie',
    id: 'tpb4k.pornrips.recent',
    extra: { skip: 0 },
  });
  const result = await provider.handleMeta({ type: 'movie', id: catalog.metas[0].id });

  assert.equal(result.meta.id, catalog.metas[0].id);
  assert.equal(result.meta.name, 'Durable Catalog Metadata Fixture');
  assert.equal(result.meta.poster, 'https://images.example/durable-catalog.jpg');
  assert.equal(result.meta.extra.onlyporn.metadataProvider, 'catalog-response');
  assert.equal(result.meta.extra.onlyporn.playbackCandidates, 1);
});

test('studio detail metadata preserves the exact real poster shown on its catalog card', async () => {
  const id = encodeTpb4kId({
    source: 'torrent-index',
    sourceId: 'torrent-first:onlyfans-poster-fixture',
    catalogId: 'tpb4k.studio.onlyfans.top',
    torrents: [{ infoHash: HASH_4K, filename: 'OnlyFans.Poster.Fixture.mp4' }],
  });
  registerAdapter({
    id: 'torrent-index',
    async catalog() { return []; },
    async meta({ sourceId }) {
      return {
        sourceId,
        title: 'OnlyFans Poster Fixture',
        studio: 'OnlyFans',
        poster: 'https://onlyporn.example/assets/tpb4k/studios/onlyfans.png',
      };
    },
    async resolve() { return []; },
  });
  const provider = new Tpb4kProvider({
    installBuiltIns: false,
    env: { TPB4K_ENABLED: 'true', ONLYPORN_DISABLE_PERSISTENT_CACHE: 'true' },
  });
  provider.catalogResponseCache.set('poster-fixture', {
    savedAt: Date.now(),
    value: {
      metas: [{
        id,
        type: 'movie',
        name: 'OnlyFans Poster Fixture',
        poster: 'https://images.example/onlyfans-real-scene.jpg',
      }],
    },
  });

  const result = await provider.handleMeta({ type: 'movie', id });

  assert.equal(result.meta.poster, 'https://images.example/onlyfans-real-scene.jpg');
  assert.equal(result.meta.background, 'https://images.example/onlyfans-real-scene.jpg');
});

test('Continue Watching recovers studio artwork when the saved torrent bundle is older than the catalog card', async () => {
  const catalogId = 'tpb4k.studio.onlyfans.top';
  const savedId = encodeTpb4kId({
    source: 'torrent-index', sourceId: 'torrent-first:onlyfans-old-identity', catalogId,
    torrents: [{ infoHash: HASH_4K, filename: 'OnlyFans.Old.Bundle.mp4' }],
  });
  const currentId = encodeTpb4kId({
    source: 'torrent-index', sourceId: 'torrent-first:onlyfans-current-identity', catalogId,
    torrents: [
      { infoHash: HASH_4K, filename: 'OnlyFans.Current.Bundle.mp4' },
      { infoHash: HASH_ALT, filename: 'OnlyFans.Current.Alternate.mp4' },
    ],
  });
  registerAdapter({
    id: 'torrent-index',
    async catalog() { return []; },
    async meta() {
      return {
        sourceId: 'torrent-first:onlyfans-old-identity',
        title: 'OnlyFans Continue Watching Fixture',
        studio: 'OnlyFans',
        poster: 'https://onlyporn.example/assets/tpb4k/studios/onlyfans.png',
      };
    },
    async resolve() { return []; },
  });
  const provider = new Tpb4kProvider({
    installBuiltIns: false,
    env: { TPB4K_ENABLED: 'true', ONLYPORN_DISABLE_PERSISTENT_CACHE: 'true' },
  });
  provider.catalogResponseCache.set('continue-watching-fixture', {
    savedAt: Date.now(),
    value: {
      metas: [{
        id: currentId,
        type: 'movie',
        name: 'OnlyFans Continue Watching Fixture',
        poster: 'https://images.example/onlyfans-continue-watching.jpg',
      }],
    },
  });

  const result = await provider.handleMeta({ type: 'movie', id: savedId });

  assert.equal(result.meta.id, savedId);
  assert.equal(result.meta.poster, 'https://images.example/onlyfans-continue-watching.jpg');
  assert.equal(result.meta.background, 'https://images.example/onlyfans-continue-watching.jpg');
});

test('ThePornDB recent resolves exact scene torrents instead of remaining metadata-only', async () => {
  registerAdapter({
    id: 'tpdb',
    async catalog() {
      return [{
        sourceId: 'tpdb:playable-scene',
        title: 'Playable TPDB Scene',
        poster: 'https://images.example/tpdb-playable.jpg',
        studio: 'Fixture Studio',
      }];
    },
    async meta({ sourceId }) {
      return {
        sourceId,
        title: 'Playable TPDB Scene',
        poster: 'https://images.example/tpdb-playable.jpg',
        studio: 'Fixture Studio',
      };
    },
    async resolve() { return []; },
  });
  registerAdapter({
    id: 'torrent-index',
    async catalog() { return []; },
    async meta() { return null; },
    async resolve({ item, catalog }) {
      assert.equal(item.title, 'Playable TPDB Scene');
      assert.equal(catalog.targetedPlaybackSearch, true);
      return [{
        source: 'knaben-targeted',
        title: 'Playable TPDB Scene 1080p H264',
        filename: 'Playable.TPDB.Scene.1080p.H264.mp4',
        infoHash: HASH_ALT,
        seeders: 12,
      }];
    },
  });
  const provider = new Tpb4kProvider({
    installBuiltIns: false,
    env: {
      TPB4K_ENABLED: 'true',
      TPB4K_CATALOG_LIMIT: '1',
      ONLYPORN_DISABLE_PERSISTENT_CACHE: 'true',
    },
  });
  const catalog = await provider.handleCatalog({
    type: 'movie', id: 'tpb4k.tpdb.recent', extra: { skip: 0 },
  });
  const result = await provider.handleStream({ type: 'movie', id: catalog.metas[0].id });

  assert.equal(result.streams.length, 1);
  assert.equal(result.streams[0].infoHash, HASH_ALT);
  assert.equal(result.streams[0].behaviorHints.filename, 'Playable.TPDB.Scene.1080p.H264.mp4');
});

test('PornRips preserves its authoritative torrent and adds index alternatives for failover', async () => {
  registerAdapter({
    id: 'pornrips',
    async catalog() {
      return [{ sourceId: 'pornrips:scene', title: 'PornRips Scene HEVC' }];
    },
    async meta({ sourceId }) {
      return { sourceId, title: 'PornRips Scene HEVC' };
    },
    async resolve() {
      return [{
        source: 'pornrips',
        title: 'PornRips Scene HEVC',
        filename: 'PornRips.Scene.HEVC.mkv',
        infoHash: HASH_4K,
        seeders: 0,
        provenance: ['pornrips-authoritative-torrent'],
      }];
    },
  });
  registerAdapter({
    id: 'torrent-index',
    async catalog() { return []; },
    async meta() { return null; },
    async resolve({ item, catalog }) {
      assert.equal(item.title, 'PornRips Scene HEVC');
      assert.equal(catalog.targetedPlaybackSearch, true);
      return [{
        source: 'knaben-targeted',
        title: 'PornRips Scene H264',
        filename: 'PornRips.Scene.H264.mp4',
        infoHash: HASH_1080,
        seeders: 8,
      }];
    },
  });
  const provider = new Tpb4kProvider({
    installBuiltIns: false,
    env: { TPB4K_ENABLED: 'true', TPB4K_CATALOG_LIMIT: '1' },
  });
  const catalog = await provider.handleCatalog({
    type: 'movie', id: 'tpb4k.pornrips.recent', extra: { skip: 0 },
  });
  const result = await provider.handleStream({ type: 'movie', id: catalog.metas[0].id });

  assert.deepEqual(new Set(result.streams.map(stream => stream.infoHash)), new Set([HASH_4K, HASH_1080]));
  assert.equal(result.streams.some(stream => /H264\.mp4$/.test(stream.behaviorHints.filename)), true);
});

test('provider supplies a branded HTTPS fallback when an upstream catalog omits artwork', async () => {
  registerAdapter({
    id: 'yesporn',
    async catalog() {
      return [{ sourceId: 'yesporn:no-poster', title: 'Posterless YesPorn fixture' }];
    },
    async meta({ sourceId }) {
      return { sourceId, title: 'Posterless YesPorn fixture' };
    },
    async resolve() { return []; },
  });
  const provider = new Tpb4kProvider({
    installBuiltIns: false,
    env: {
      TPB4K_ENABLED: 'true',
      TPB4K_CATALOG_LIMIT: '1',
      ONLYPORN_DISABLE_PERSISTENT_CACHE: 'true',
    },
  });
  const catalog = await provider.handleCatalog({
    type: 'movie',
    id: 'tpb4k.yesporn.recent',
    extra: {},
  });
  assert.equal(catalog.metas.length, 1);
  assert.equal(catalog.metas[0].posterShape, 'poster');
  assert.match(catalog.metas[0].poster, /assets\/tpb4k\/studios\/yesporn\.png$/);

  const meta = await provider.handleMeta({ type: 'movie', id: catalog.metas[0].id });
  assert.match(meta.meta.poster, /assets\/tpb4k\/studios\/yesporn\.png$/);
  assert.equal(meta.meta.background, meta.meta.poster);
});

test('Sukebei cards use the landscape presentation of the reference TPB4K addon', async () => {
  registerAdapter({
    id: 'sukebei',
    async catalog() {
      return [{
        sourceId: 'sukebei:poster',
        title: 'Recent Sukebei fixture',
        poster: 'https://images.example/sukebei.jpg',
      }];
    },
    async meta({ sourceId }) {
      return {
        sourceId,
        title: 'Recent Sukebei fixture',
        poster: 'https://images.example/sukebei.jpg',
      };
    },
    async resolve() { return []; },
  });
  const provider = new Tpb4kProvider({
    installBuiltIns: false,
    env: { TPB4K_ENABLED: 'true', TPB4K_CATALOG_LIMIT: '1' },
  });
  const catalog = await provider.handleCatalog({
    type: 'movie',
    id: 'tpb4k.sukebei.top',
    extra: {},
  });
  assert.equal(catalog.metas[0].posterShape, 'landscape');

  const meta = await provider.handleMeta({ type: 'movie', id: catalog.metas[0].id });
  assert.equal(meta.meta.posterShape, 'landscape');
});

test('Sukebei resolves an explicit main-file index instead of trusting debrid auto-selection', async () => {
  let resolveCalls = 0;
  registerAdapter({
    id: 'sukebei',
    async catalog() {
      return [{
        sourceId: 'sukebei:multi-file',
        title: 'Sukebei Multi-file Fixture',
        poster: 'https://images.example/sukebei-multi.jpg',
        infoHash: HASH_4K,
        seeders: 40,
      }];
    },
    async meta({ sourceId }) {
      return { sourceId, title: 'Sukebei Multi-file Fixture', poster: 'https://images.example/sukebei-multi.jpg' };
    },
    async resolve() {
      resolveCalls += 1;
      return [{ infoHash: HASH_4K, fileIdx: 2, filename: 'Sukebei.Main.Movie.mp4', seeders: 40 }];
    },
  });
  const provider = new Tpb4kProvider({
    installBuiltIns: false,
    env: { TPB4K_ENABLED: 'true', TPB4K_CATALOG_LIMIT: '1' },
  });
  const catalog = await provider.handleCatalog({ type: 'movie', id: 'tpb4k.sukebei.top', extra: {} });
  const result = await provider.handleStream({ type: 'movie', id: catalog.metas[0].id });

  assert.equal(resolveCalls, 1);
  assert.equal(result.streams.length, 1);
  assert.equal(result.streams[0].fileIdx, 2);
  assert.equal(result.streams[0].behaviorHints.filename, 'Sukebei.Main.Movie.mp4');
});

test('release wiring preserves v2.6.4 hardening and keeps TPB4K off production by default', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const relay = fs.readFileSync(path.join(ROOT, 'media-relay.js'), 'utf8');
  const catalogIndex = fs.readFileSync(path.join(ROOT, 'catalog/index.js'), 'utf8');

  assert.equal(pkg.version, '2.7.0-alpha.27');
  assert.equal(pkg.scripts['test:tpb4k-phase1'], 'node --test provider/tpb4k-phase1.test.js');
  assert.match(pkg.scripts['test:release'], /tpb4k-phase1\.test\.js/);
  assert.match(relay, /const SESSION_TTL_MS = 8 \* 60 \* 60 \* 1000/);
  assert.match(relay, /PLAYLIST_CHILD_ERROR_CODE = 'HLS_CHILD_REJECTED'/);
  assert.match(relay, /'vdcdn\.xyz'/);
  assert.match(catalogIndex, /isTpb4kEnabled\(\)/);

  assert.equal(isTpb4kEnabled({ TPB4K_ENABLED: '' }), false);
  assert.match(catalogIndex, /\.\.\.\(isTpb4kEnabled\(\) \? tpb4kCatalogs : \[\]\)/);
});
