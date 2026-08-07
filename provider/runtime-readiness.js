'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SUKEBEI_MIN_CARDS = 24;
const SUKEBEI_MAX_CARDS = 40;

const STARTUP_READY_MARKER = 'startup-ready.json';
let startupReadyLatched = false;

function startupReadyMarkerPath(env = process.env) {
  const runtimeDir = path.resolve(String(
    env.ONLYPORN_RUNTIME_DIR || '/tmp/onlyporn-runtime'
  ));
  return path.join(runtimeDir, STARTUP_READY_MARKER);
}

function latchStartupReadyMarkerIfNeeded() {
  if (startupReadyLatched) return false;

  const state = snapshot();
  if (!state.ready) return false;

  const markerPath = startupReadyMarkerPath();
  const temporary = `${markerPath}.${process.pid}.tmp`;
  const payload = Object.freeze({
    ready: true,
    latchedAt: new Date().toISOString(),
    catalog: Object.freeze({
      success: state.catalog.success,
      activeCatalogs: state.catalog.activeCatalogs,
      healthyCatalogs: state.catalog.healthyCatalogs,
      missingCatalogs: state.catalog.missingCatalogs,
      finishedAt: state.catalog.finishedAt,
    }),
    sukebei: Object.freeze({
      ready: state.sukebei.ready,
      cards: state.sukebei.cards,
      metatubePosters: state.sukebei.metatubePosters,
      generatedPosters: state.sukebei.generatedPosters,
      updatedAt: state.sukebei.updatedAt,
    }),
  });

  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(temporary, `${JSON.stringify(payload)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  fs.renameSync(temporary, markerPath);
  startupReadyLatched = true;

  process.stdout.write(
    `OnlyPorn startup readiness latched: 33/33 + strict Sukebei; marker=${markerPath}\n`
  );
  return true;
}

function truthy(value) {
  return /^(?:1|true|yes|on)$/i.test(String(value || '').trim());
}

let catalogState = Object.freeze({
  success: false,
  activeCatalogs: 0,
  healthyCatalogs: 0,
  missingCatalogs: [],
  finishedAt: '',
});
let sukebeiState = Object.freeze({
  ready: false,
  cards: 0,
  metatubePosters: 0,
  generatedPosters: 0,
  updatedAt: '',
});

function recordCatalogPrewarmResult(result = {}) {
  catalogState = Object.freeze({
    success: Boolean(result.success),
    activeCatalogs: Number(result.activeCatalogs || 0),
    healthyCatalogs: Number(result.healthyCatalogs || 0),
    missingCatalogs: Object.freeze([...(result.missingCatalogs || [])]),
    finishedAt: String(result.finishedAt || new Date().toISOString()),
  });
  latchStartupReadyMarkerIfNeeded();
}

function recordSukebeiResult(result = {}) {
  sukebeiState = Object.freeze({
    ready: Boolean(result.ready),
    cards: Number(result.cards || 0),
    metatubePosters: Number(result.metatubePosters || 0),
    generatedPosters: Number(result.generatedPosters || 0),
    updatedAt: new Date().toISOString(),
  });
  latchStartupReadyMarkerIfNeeded();
}

function sqliteHeader(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return false;
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(16);
    const bytes = fs.readSync(descriptor, buffer, 0, 16, 0);
    return bytes === 16 && buffer.toString('binary') === 'SQLite format 3\u0000';
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
  }
}

function storageSnapshot(env = process.env) {
  const dbPath = path.resolve(String(
    env.METATUBE_DB || env.DSN || '/tmp/onlyporn-runtime/metatube/metatube.db'
  ));
  const cacheDir = path.resolve(String(
    env.ONLYPORN_PERSISTENT_CACHE_DIR || '/tmp/onlyporn-runtime/cache'
  ));
  const artworkCachePath = path.join(cacheDir, 'sukebei-artwork-v3.json');
  const catalogCachePath = path.join(cacheDir, 'catalog-responses-v1.json');
  const dbExists = fs.existsSync(dbPath);
  const artworkCacheExists = fs.existsSync(artworkCachePath);
  const catalogCacheExists = fs.existsSync(catalogCachePath);
  let dbBytes = 0;
  let artworkCacheBytes = 0;
  let catalogCacheBytes = 0;
  let freeBytes = -1;
  try { dbBytes = dbExists ? fs.statSync(dbPath).size : 0; } catch {}
  try { artworkCacheBytes = artworkCacheExists ? fs.statSync(artworkCachePath).size : 0; } catch {}
  try { catalogCacheBytes = catalogCacheExists ? fs.statSync(catalogCachePath).size : 0; } catch {}
  try {
    if (typeof fs.statfsSync === 'function') {
      const stats = fs.statfsSync(path.dirname(dbPath));
      freeBytes = Number(stats.bavail) * Number(stats.bsize);
    }
  } catch {}
  return Object.freeze({
    dbPath,
    cacheDir,
    artworkCachePath,
    catalogCachePath,
    ephemeralPaths: dbPath.startsWith('/tmp/') && cacheDir.startsWith('/tmp/'),
    fileBacked: !/(?:^|[/:])memory(?:$|[?/:])/i.test(dbPath),
    autoMigrate: truthy(env.DB_AUTO_MIGRATE),
    maxOpenConnections: Number(env.DB_MAX_OPEN_CONNS || 0),
    maxIdleConnections: Number(env.DB_MAX_IDLE_CONNS || 0),
    preparedStatements: truthy(env.DB_PREPARED_STMT),
    proxySecretConfigured: String(env.TPB4K_METATUBE_PROXY_SECRET || '').length >= 32,
    dbExists,
    sqlite: sqliteHeader(dbPath),
    dbBytes,
    artworkCacheExists,
    artworkCacheBytes,
    catalogCacheExists,
    catalogCacheBytes,
    freeBytes,
  });
}

function snapshot() {
  const storage = storageSnapshot();
  const cardsInRange = sukebeiState.cards >= SUKEBEI_MIN_CARDS &&
    sukebeiState.cards <= SUKEBEI_MAX_CARDS;
  const ready = Boolean(
    catalogState.success &&
    catalogState.activeCatalogs === 33 &&
    catalogState.healthyCatalogs === 33 &&
    sukebeiState.ready &&
    cardsInRange &&
    sukebeiState.metatubePosters === sukebeiState.cards &&
    sukebeiState.generatedPosters === 0
  );
  const publicStorage = Object.freeze({
    ephemeralPaths: storage.ephemeralPaths,
    fileBacked: storage.fileBacked,
    autoMigrate: storage.autoMigrate,
    maxOpenConnections: storage.maxOpenConnections,
    maxIdleConnections: storage.maxIdleConnections,
    preparedStatements: storage.preparedStatements,
    proxySecretConfigured: storage.proxySecretConfigured,
    dbExists: storage.dbExists,
    sqlite: storage.sqlite,
    dbBytes: storage.dbBytes,
    artworkCacheExists: storage.artworkCacheExists,
    artworkCacheBytes: storage.artworkCacheBytes,
    catalogCacheExists: storage.catalogCacheExists,
    catalogCacheBytes: storage.catalogCacheBytes,
  });
  return Object.freeze({
    ready,
    limits: Object.freeze({ sukebeiMinCards: SUKEBEI_MIN_CARDS, sukebeiMaxCards: SUKEBEI_MAX_CARDS }),
    catalog: catalogState,
    sukebei: sukebeiState,
    storage: publicStorage,
  });
}

function installRuntimeReadinessRoute(app) {
  app.get('/onlyporn/ready', (_req, res) => {
    const state = snapshot();
    res.status(state.ready ? 200 : 503).json(state);
  });
}

module.exports = {
  SUKEBEI_MAX_CARDS,
  SUKEBEI_MIN_CARDS,
  installRuntimeReadinessRoute,
  recordCatalogPrewarmResult,
  recordSukebeiResult,
  snapshot,
  startupReadyMarkerPath,
  storageSnapshot,
};
