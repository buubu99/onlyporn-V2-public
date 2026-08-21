'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createMetaTubeClient, isExactMetaTubeCode } = require('./tpb4k/metatube-client');
const { isConfirmedMissing } = require('../scripts/warm-rd-metatube-posters');
const { MAX_CONCURRENT_IMAGES, MAX_IMAGE_BYTES, decodeToken, readBoundedBody } = require('./tpb4k/metatube-image-proxy');
const { minimumHealthyMetas } = require('./catalog-prewarm');
const { choosePoster, chooseBackground, normalizeScene } = require('./tpb4k/metadata-normalize');
const readiness = require('./runtime-readiness');

function validPng() {
  const buffer = Buffer.alloc(9_000);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(buffer, 0);
  buffer.writeUInt32BE(800, 16);
  buffer.writeUInt32BE(1200, 20);
  return buffer;
}

function withSQLiteFixture(callback) {
  const directory = fs.mkdtempSync(path.join('/tmp', 'onlyporn-v6-'));
  const database = path.join(directory, 'metatube.db');
  const bytes = Buffer.alloc(4_096);
  Buffer.from('SQLite format 3\0', 'binary').copy(bytes, 0);
  fs.writeFileSync(database, bytes);
  const saved = Object.fromEntries([
    'METATUBE_DB', 'DSN', 'DB_AUTO_MIGRATE', 'DB_MAX_OPEN_CONNS',
    'DB_MAX_IDLE_CONNS', 'DB_PREPARED_STMT', 'ONLYPORN_PERSISTENT_CACHE_DIR',
    'ONLYPORN_CACHE_DIR', 'TPB4K_METATUBE_PROXY_SECRET', 'ONLYPORN_RD_CATALOG_REQUIRED',
    'ONLYPORN_RD_CATALOG_DB',
  ].map(key => [key, process.env[key]]));
  const cacheDirectory = path.join(directory, 'cache');
  fs.mkdirSync(cacheDirectory, { recursive: true });
  fs.writeFileSync(path.join(cacheDirectory, 'sukebei-artwork-v3.json'), '{"version":3,"records":[]}\n');
  fs.writeFileSync(path.join(cacheDirectory, 'catalog-responses-v1.json'), '{"version":1,"records":[]}\n');
  Object.assign(process.env, {
    METATUBE_DB: database,
    DSN: database,
    DB_AUTO_MIGRATE: 'true',
    DB_MAX_OPEN_CONNS: '1',
    DB_MAX_IDLE_CONNS: '1',
    DB_PREPARED_STMT: 'false',
    ONLYPORN_PERSISTENT_CACHE_DIR: cacheDirectory,
    ONLYPORN_CACHE_DIR: cacheDirectory,
    TPB4K_METATUBE_PROXY_SECRET: 'onlyporn-v6-test-secret-at-least-32-characters',
  });
  try { return callback({ directory, database }); }
  finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('MetaTube exact matching accepts canonical and FC2 variants only', () => {
  assert.equal(isExactMetaTubeCode('MIDA-762', { number: 'MIDA-762' }), true);
  assert.equal(isExactMetaTubeCode('MIDA-762', { number: 'MIDA-761' }), false);
  assert.equal(isExactMetaTubeCode('FC2-PPV-4949783', { number: 'FC2-4949783' }), true);
});

test('MetaTube warming records confirmed HTTP 404 as missing but retries operational failures', async () => {
  const client = createMetaTubeClient({
    env: {
      TPB4K_METATUBE_ENABLED: 'true',
      TPB4K_METATUBE_URL: 'http://127.0.0.1:18080',
      TPB4K_METATUBE_PUBLIC_URL: 'https://onlyporn.example',
      TPB4K_METATUBE_PROXY_SECRET: 'onlyporn-v6-test-secret-at-least-32-characters',
    },
    fetchImpl: async () => new Response('', { status: 404 }),
  });
  const missingError = await client.searchExact('MIDA-762', 5_000).catch(error => error);
  assert.equal(missingError.status, 404);
  assert.equal(isConfirmedMissing(missingError), true);
  assert.equal(isConfirmedMissing(new Error('MetaTube search returned HTTP 404')), true);
  assert.equal(isConfirmedMissing(new Error('MetaTube search returned HTTP 503')), false);
  assert.equal(isConfirmedMissing(new Error('fetch failed')), false);
});

test('MetaTube scalar proxy poster survives metadata normalization', () => {
  const poster = 'https://onlyporn.example/onlyporn/poster/metatube/SmF2QnVz/TUlEQS03MjM/signature1234567890123456789012345678901234567890';

  // Regression for V5: primitive strings inherit String.prototype.small(), so
  // image?.small must never be inspected before establishing that image is an object.
  assert.equal(typeof poster.small, 'function');
  assert.equal(choosePoster([poster]), poster);
  assert.equal(chooseBackground([poster]), poster);

  const normalized = normalizeScene('metatube', {
    id: 'JavBus:MIDA-723',
    title: 'MIDA-723 fixture',
    code: 'MIDA-723',
    poster,
    background: poster,
    performers: ['Fixture'],
    tags: [],
    url: 'https://www.javbus.com/ja/MIDA-723',
  });

  assert.ok(normalized);
  assert.equal(normalized.poster, poster);
  assert.equal(normalized.background, poster);
  assert.equal(normalized.sceneCode, 'MIDA-723');
});

test('MetaTube poster proxy bounds image RAM and concurrency', async () => {
  assert.equal(MAX_IMAGE_BYTES, 2_000_000);
  assert.equal(MAX_CONCURRENT_IMAGES, 2);
  const bytes = await readBoundedBody(new Response(Buffer.alloc(1024), {
    headers: { 'content-type': 'image/jpeg' },
  }));
  assert.equal(bytes.length, 1024);
  await assert.rejects(
    readBoundedBody(new Response(Buffer.alloc(2049)), 2048),
    /byte limit/
  );
});

test('MetaTube returns an exact verified OnlyPorn poster proxy', async () => {
  const client = createMetaTubeClient({
    env: {
      TPB4K_METATUBE_ENABLED: 'true',
      TPB4K_METATUBE_URL: 'http://127.0.0.1:18080',
      TPB4K_METATUBE_PUBLIC_URL: 'https://onlyporn.example',
      TPB4K_METATUBE_PROXY_SECRET: 'onlyporn-v6-test-secret-at-least-32-characters',
    },
    fetchImpl: async url => {
      if (String(url).includes('/v1/movies/search')) {
        return new Response(JSON.stringify({ data: [{
          id: 'mida-762', provider: 'JavBus', number: 'MIDA-762', title: 'Exact fixture',
        }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(validPng(), { status: 200, headers: { 'content-type': 'image/png' } });
    },
  });
  assert.equal(client.configured, true);
  const rows = await client.queryScenes({ query: 'MIDA-762', timeoutMs: 5_000 });
  assert.equal(rows.length, 1);
  const parts = new URL(rows[0].poster).pathname.split('/');
  assert.equal(decodeToken(parts.at(-3)), 'JavBus');
  assert.equal(decodeToken(parts.at(-2)), 'mida-762');
  assert.match(parts.at(-1), /^[A-Za-z0-9_-]{40,}$/);
});

test('catalogue health requires Sukebei minimum 24, not exact 40', () => {
  assert.equal(minimumHealthyMetas('eporner'), 1);
  assert.equal(minimumHealthyMetas('tpb4k.studio.playboyplus.top'), 30);
  assert.equal(minimumHealthyMetas('tpb4k.sukebei.top'), 24);
  assert.equal(minimumHealthyMetas('tpb4k.sukebei.hentai'), 18);

  const prewarmSource = fs.readFileSync(require.resolve('./catalog-prewarm'), 'utf8');
  assert.equal((prewarmSource.match(/900_000/g) || []).length, 2);
});

test('readiness accepts 24 through 40 matching MetaTube posters only', () => withSQLiteFixture(() => {
  readiness.recordCatalogPrewarmResult({ success: true, activeCatalogs: 34, healthyCatalogs: 34 });

  readiness.recordSukebeiResult({ ready: true, cards: 23, metatubePosters: 23, generatedPosters: 0 });
  assert.equal(readiness.snapshot().ready, false);

  readiness.recordSukebeiResult({ ready: true, cards: 24, metatubePosters: 24, generatedPosters: 0 });
  assert.equal(readiness.snapshot().ready, true);

  readiness.recordSukebeiResult({ ready: true, cards: 31, metatubePosters: 31, generatedPosters: 0 });
  assert.equal(readiness.snapshot().ready, true);

  readiness.recordSukebeiResult({ ready: true, cards: 40, metatubePosters: 40, generatedPosters: 0 });
  assert.equal(readiness.snapshot().ready, true);

  readiness.recordSukebeiResult({ ready: true, cards: 41, metatubePosters: 41, generatedPosters: 0 });
  assert.equal(readiness.snapshot().ready, false);

  readiness.recordSukebeiResult({ ready: true, cards: 30, metatubePosters: 29, generatedPosters: 0 });
  assert.equal(readiness.snapshot().ready, false);
}));

test('readiness proves file-backed migrated SQLite with one connection', () => withSQLiteFixture(({ database }) => {
  const storage = readiness.storageSnapshot();
  assert.equal(storage.dbPath, database);
  assert.equal(storage.ephemeralPaths, true);
  assert.equal(storage.fileBacked, true);
  assert.equal(storage.autoMigrate, true);
  assert.equal(storage.maxOpenConnections, 1);
  assert.equal(storage.maxIdleConnections, 1);
  assert.equal(storage.preparedStatements, false);
  assert.equal(storage.proxySecretConfigured, true);
  assert.equal(storage.dbExists, true);
  assert.equal(storage.sqlite, true);
  assert.equal(storage.artworkCacheExists, true);
  assert.equal(storage.catalogCacheExists, true);
}));

test('required RD catalog must be a persistent SQLite file before readiness opens', () => withSQLiteFixture(({ directory }) => {
  process.env.ONLYPORN_RD_CATALOG_REQUIRED = 'true';
  process.env.ONLYPORN_RD_CATALOG_DB = path.join(directory, 'rd-catalog.sqlite');
  readiness.recordCatalogPrewarmResult({ success: true, activeCatalogs: 34, healthyCatalogs: 34 });
  readiness.recordSukebeiResult({ ready: true, cards: 24, metatubePosters: 24, generatedPosters: 0 });
  assert.equal(readiness.snapshot().ready, false);
  const bytes = Buffer.alloc(4_096);
  Buffer.from('SQLite format 3\0', 'binary').copy(bytes, 0);
  fs.writeFileSync(process.env.ONLYPORN_RD_CATALOG_DB, bytes);
  const state = readiness.snapshot();
  assert.equal(state.ready, true);
  assert.equal(state.storage.rdCatalogRequired, true);
  assert.equal(state.storage.rdCatalogSqlite, true);
}));

test('public readiness gate exposes and enforces required RD SQLite state', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../scripts/public-gate-proxy.js'), 'utf8');
  assert.match(source, /ONLYPORN_RD_CATALOG_REQUIRED/);
  assert.match(source, /ONLYPORN_RD_CATALOG_DB/);
  assert.match(source, /SQLite format 3\\u0000/);
  assert.match(source, /storage: rdCatalogState\(\)/);
  assert.match(source, /return \{ \.\.\.marker, storage \}/);
});

test('strict Sukebei source publishes 24–40 MetaTube cards and no generated fallback', () => {
  const source = fs.readFileSync(require.resolve('./tpb4k/sukebei-metadata'), 'utf8');
  assert.match(source, /const strictMinimum = searchMode \? 0 : \(safeSkip === 0 \? Math\.min\(24, safeLimit\) : 0\)/);
  assert.match(source, /allowed\.length < strictMinimum/);
  assert.match(source, /\(searchMode \|\| !metatubeStrict\)/);
  assert.match(source, /ONLYPORN_SEARCH_SUKEBEI_METADATA_TIMEOUT_MS/);
  assert.match(source, /metatubePosters === cards/);
  assert.match(source, /recordSukebeiResult/);
});

test('startup forces database, logs, cache and temp work onto ephemeral file storage', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../scripts/start-onlyporn-with-metatube.sh'), 'utf8');
  assert.match(source, /DB_AUTO_MIGRATE=true/);
  assert.match(source, /DB_MAX_OPEN_CONNS=1/);
  assert.match(source, /DB_MAX_IDLE_CONNS=1/);
  assert.match(source, /DB_PREPARED_STMT=false/);
  assert.match(source, /ONLYPORN_PERSISTENT_CACHE_DIR/);
  assert.match(source, /ONLYPORN_CACHE_DIR/);
  assert.match(source, /TPB4K_METATUBE_PROXY_SECRET/);
  assert.match(source, /Refusing RAM-backed MetaTube SQLite storage/);
  assert.match(source, /-dsn "\$METATUBE_DB"/);
  assert.doesNotMatch(source, /file::memory/);
  const proxySource = fs.readFileSync(require.resolve('./tpb4k/metatube-image-proxy'), 'utf8');
  assert.match(proxySource, /MAX_CONCURRENT_IMAGES = 2/);
  assert.match(proxySource, /MAX_IMAGE_BYTES = 2_000_000/);
  assert.doesNotMatch(proxySource, /await response\.arrayBuffer\(\)/);
});
