'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const logger = require('../logger');
const { recordCatalogPrewarmResult } = require('./runtime-readiness');
const { sukebeiHentaiDbPath } = require('./sukebei-hentai-sqlite');

const DEFERRED_CATALOG_IDS = new Set([
  'tpb4k.stripchat.girls',
  'tpb4k.stripchat.couples',
]);

const DEFAULTS = Object.freeze({
  enabled: true,
  startDelayMs: 90_000,
  intervalMs: 23 * 60 * 60 * 1000,
  concurrency: 3,
  maxPasses: 6,
  retryDelayMs: 20_000,
  requestTimeoutMs: 45_000,
  expectedActiveCatalogs: 34,
  verificationPasses: 1,
});

const SUKEBEI_READY_CATALOG_ID = 'tpb4k.sukebei.top';
const SUKEBEI_HENTAI_READY_CATALOG_ID = 'tpb4k.sukebei.hentai';
const STARTUP_PREWARM_READY_FILE = 'startup-prewarm-ready.json';

function startupEnvTrue(value) {
  return /^(?:1|true|yes|on)$/i.test(String(value || '').trim());
}

function startupPrewarmReadyPath(env = process.env) {
  const runtimeDir = path.resolve(String(
    env.ONLYPORN_RUNTIME_DIR || '/tmp/onlyporn-runtime'
  ));
  return path.join(runtimeDir, STARTUP_PREWARM_READY_FILE);
}

function startupMetaTubePoster(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' &&
      /\/onlyporn\/poster\/metatube\//i.test(url.pathname);
  } catch {
    return false;
  }
}

function sukebeiHentaiSqliteSnapshot(env = process.env) {
  const enabled = !/^(?:0|false|off|no)$/i.test(String(
    env.ONLYPORN_SUKEBEI_HENTAI_SQLITE_ENABLED ?? 'true'
  ).trim()) && !startupEnvTrue(env.ONLYPORN_DISABLE_PERSISTENT_CACHE);
  let dbBytes = 0;
  let sqlite = false;
  try {
    const descriptor = fs.openSync(sukebeiHentaiDbPath(env), 'r');
    try {
      const header = Buffer.alloc(16);
      const bytes = fs.readSync(descriptor, header, 0, header.length, 0);
      sqlite = bytes === 16 && header.toString('binary') === 'SQLite format 3\u0000';
      dbBytes = Number(fs.fstatSync(descriptor).size || 0);
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {}
  return Object.freeze({ enabled, sqlite, dbBytes, ready: enabled && sqlite && dbBytes > 0 });
}

function latestPrewarmCatalogResult(passSummaries, catalogId) {
  const summaries = Array.isArray(passSummaries) ? passSummaries : [];
  for (let index = summaries.length - 1; index >= 0; index -= 1) {
    const results = Array.isArray(summaries[index]?.results)
      ? summaries[index].results
      : [];
    const match = results.find(item => item?.catalogId === catalogId);
    if (match) return match;
  }
  return null;
}

function writeStartupPrewarmReadyMarker(result, env = process.env) {
  if (
    result?.success !== true ||
    Number(result.activeCatalogs) !== 34 ||
    Number(result.healthyCatalogs) !== 34 ||
    !Array.isArray(result.missingCatalogs) ||
    result.missingCatalogs.length !== 0
  ) {
    return false;
  }

  const sukebei = latestPrewarmCatalogResult(
    result.passSummaries,
    SUKEBEI_READY_CATALOG_ID
  );

  const metas = Number(sukebei?.metas || 0);
  const metatubePosters = Number(sukebei?.metatubePosters || 0);
  const strictMetaTube =
    startupEnvTrue(env.TPB4K_METATUBE_ENABLED) &&
    startupEnvTrue(env.TPB4K_METATUBE_STRICT);
  const sukebeiHentai = latestPrewarmCatalogResult(
    result.passSummaries,
    SUKEBEI_HENTAI_READY_CATALOG_ID
  );
  const sukebeiHentaiMetas = Number(sukebeiHentai?.metas || 0);
  const sukebeiHentaiSqlite = sukebeiHentaiSqliteSnapshot(env);

  if (
    sukebei?.healthy !== true ||
    metas < 24 ||
    metas > 40 ||
    metatubePosters !== metas ||
    !strictMetaTube
  ) {
    throw new Error(
      `Render readiness refused: Sukebei is not strict-ready ` +
      `(healthy=${Boolean(sukebei?.healthy)} metas=${metas} ` +
      `metatubePosters=${metatubePosters} strict=${strictMetaTube})`
    );
  }
  if (sukebeiHentai?.healthy !== true || sukebeiHentaiMetas < 18 || sukebeiHentaiMetas > 40) {
    throw new Error(
      `Render readiness refused: Sukebei Hentai is not fully indexed ` +
      `(healthy=${Boolean(sukebeiHentai?.healthy)} metas=${sukebeiHentaiMetas})`
    );
  }
  if (!sukebeiHentaiSqlite.ready) {
    throw new Error(
      `Render readiness refused: Sukebei Hentai SQLite is incomplete ` +
      `(enabled=${sukebeiHentaiSqlite.enabled} sqlite=${sukebeiHentaiSqlite.sqlite} ` +
      `bytes=${sukebeiHentaiSqlite.dbBytes})`
    );
  }

  const markerPath = startupPrewarmReadyPath(env);
  const temporary = `${markerPath}.${process.pid}.tmp`;
  const marker = {
    ready: true,
    gate: 'catalog-prewarm-success',
    latchedAt: new Date().toISOString(),
    runId: String(result.runId || ''),
    activeCatalogs: 34,
    healthyCatalogs: 34,
    missingCatalogs: [],
    sukebei: {
      healthy: true,
      metas,
      metatubePosters,
      generatedPosters: 0,
      strictMetaTube: true,
    },
    sukebeiHentai: {
      healthy: true,
      metas: sukebeiHentaiMetas,
      sqliteComplete: true,
      dbBytes: sukebeiHentaiSqlite.dbBytes,
      category: '1_1',
    },
  };

  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(temporary, `${JSON.stringify(marker)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  fs.renameSync(temporary, markerPath);

  process.stdout.write(
    `OnlyPorn PREWARM READY: 34/34 + Sukebei ${metas} MetaTube cards + ` +
    `Sukebei Hentai ${sukebeiHentaiMetas} indexed series; ` +
    `marker=${markerPath}\n`
  );

  return true;
}

function toInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function toBoolean(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  return !/^(?:0|false|off|no)$/i.test(String(value));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeBaseUrl(value) {
  const input = String(value || '').trim();
  if (!input) throw new Error('Catalog prewarm base URL is required');
  return input.replace(/\/manifest\.json(?:\?.*)?$/i, '').replace(/\/+$/, '');
}

function makeRunId() {
  return `catalog-prewarm-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function activeCatalogsFromManifest(manifest) {
  const catalogs = Array.isArray(manifest?.catalogs) ? manifest.catalogs : [];
  return catalogs.filter(catalog =>
    catalog &&
    typeof catalog.id === 'string' &&
    typeof catalog.type === 'string' &&
    !DEFERRED_CATALOG_IDS.has(catalog.id) &&
    !(Array.isArray(catalog.extra) && catalog.extra.some(extra =>
      extra?.name === 'search' && extra?.isRequired === true
    ))
  );
}

function minimumHealthyMetas(catalogId) {
  if (catalogId === 'tpb4k.sukebei.top') return 24;
  if (catalogId === 'tpb4k.sukebei.hentai') return 18;
  if (catalogId === 'tpb4k.studio.playboyplus.top') return 30;
  return 1;
}
function catalogUrl(baseUrl, catalog, runId, pass) {
  const query = new URLSearchParams({
    skip: '0',
    catalogPrewarm: `${runId}-pass${pass}-${catalog.id}-${Date.now()}`,
  });
  return `${baseUrl}/catalog/${encodeURIComponent(catalog.type)}/${encodeURIComponent(catalog.id)}.json?${query}`;
}

async function fetchJson(fetchImpl, url, timeoutMs, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        accept: 'application/json',
        'cache-control': 'no-cache',
        pragma: 'no-cache',
        ...headers,
      },
    });
    const text = await response.text();
    let body = null;
    let parseError = '';
    try {
      body = JSON.parse(text);
    } catch (error) {
      parseError = error.message;
    }
    return {
      ok: response.ok,
      status: response.status,
      body,
      parseError,
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function mapLimited(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  );
  return results;
}

async function requestCatalog({
  baseUrl,
  catalog,
  runId,
  pass,
  fetchImpl,
  requestTimeoutMs,
}) {
  const startedAt = Date.now();
  try {
    const response = await fetchJson(
      fetchImpl,
      catalogUrl(baseUrl, catalog, runId, pass),
      requestTimeoutMs,
      {
        'x-onlyporn-request-id': `${runId}-${pass}-${catalog.id}`,
        'x-onlyporn-refresh-id': runId,
      }
    );
    const metaRows = Array.isArray(response.body?.metas) ? response.body.metas : [];
    const metas = metaRows.length;
    const metatubePosters = catalog.id === SUKEBEI_READY_CATALOG_ID
      ? metaRows.filter(meta => startupMetaTubePoster(meta?.poster)).length
      : 0;
    const minimumMetas = minimumHealthyMetas(catalog.id);
    return {
      catalogId: catalog.id,
      catalogType: catalog.type,
      healthy: response.ok && !response.parseError && metas >= minimumMetas,
      minimumMetas,
      httpStatus: response.status,
      metas,
      metatubePosters,
      elapsedMs: response.elapsedMs,
      error: response.parseError,
    };
  } catch (error) {
    return {
      catalogId: catalog.id,
      catalogType: catalog.type,
      healthy: false,
      httpStatus: 0,
      metas: 0,
      elapsedMs: Date.now() - startedAt,
      error: error?.message || String(error),
    };
  }
}

async function requestCatalogForPass(options = {}) {
  const first = await requestCatalog(options);
  if (
    first.healthy ||
    String(options.catalog?.id || '') !== SUKEBEI_READY_CATALOG_ID
  ) {
    return first;
  }

  const delayMs = Math.max(
    0,
    Math.min(Number(options.immediateRetryDelayMs || 0), 5_000)
  );
  if (delayMs > 0) await (options.sleepImpl || sleep)(delayMs);

  const retried = await requestCatalog({
    ...options,
    pass: `${options.pass}-sukebei-immediate`,
  });
  return {
    ...retried,
    immediateRetry: {
      attempted: true,
      firstHttpStatus: first.httpStatus,
      firstMetas: first.metas,
      firstError: first.error || '',
    },
  };
}

async function loadManifest({ baseUrl, fetchImpl, requestTimeoutMs, runId }) {
  const response = await fetchJson(
    fetchImpl,
    `${baseUrl}/manifest.json?catalogPrewarm=${encodeURIComponent(runId)}`,
    requestTimeoutMs,
    {
      'x-onlyporn-request-id': `${runId}-manifest`,
      'x-onlyporn-refresh-id': runId,
    }
  );

  if (!response.ok || response.parseError || !response.body) {
    throw new Error(
      `Catalog prewarm manifest failed: HTTP ${response.status}; ${response.parseError || 'no JSON body'}`
    );
  }
  return response.body;
}

async function runCatalogPrewarm(options = {}) {
  const log = options.logger || logger;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('Global fetch is unavailable');

  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const runId = options.runId || makeRunId();
  const concurrency = toInteger(options.concurrency, DEFAULTS.concurrency, 1, 10);
  const maxPasses = toInteger(options.maxPasses, DEFAULTS.maxPasses, 1, 20);
  const retryDelayMs = toInteger(options.retryDelayMs, DEFAULTS.retryDelayMs, 0, 300_000);
  const requestTimeoutMs = toInteger(
    options.requestTimeoutMs,
    DEFAULTS.requestTimeoutMs,
    1_000,
    900_000
  );
  const expectedActiveCatalogs = toInteger(
    options.expectedActiveCatalogs,
    DEFAULTS.expectedActiveCatalogs,
    1,
    1_000
  );
  const verificationPasses = toInteger(
    options.verificationPasses,
    DEFAULTS.verificationPasses,
    0,
    3
  );
  const sleepImpl = options.sleepImpl || sleep;

  const manifest = options.manifest || await loadManifest({
    baseUrl,
    fetchImpl,
    requestTimeoutMs,
    runId,
  });
  const activeCatalogs = activeCatalogsFromManifest(manifest);

  if (activeCatalogs.length !== expectedActiveCatalogs) {
    throw new Error(
      `Catalog prewarm expected ${expectedActiveCatalogs} active catalogs, manifest has ${activeCatalogs.length}`
    );
  }

  const byId = new Map(activeCatalogs.map(catalog => [catalog.id, catalog]));
  const healthy = new Set();
  let pending = [...activeCatalogs];
  let totalRequests = 0;
  const passSummaries = [];

  log.info(
    {
      event: 'DEPLOY_PREWARM_START',
      runId,
      baseUrl,
      activeCatalogs: activeCatalogs.length,
      deferredCatalogs: DEFERRED_CATALOG_IDS.size,
      concurrency,
      maxPasses,
    },
    'OnlyPorn catalog prewarm started'
  );

  for (let pass = 1; pass <= maxPasses; pass += 1) {
    const targets = pending.length ? pending : [...activeCatalogs];
    const results = await mapLimited(targets, concurrency, catalog =>
      requestCatalogForPass({
        baseUrl,
        catalog,
        runId,
        pass,
        fetchImpl,
        requestTimeoutMs,
        sleepImpl,
        immediateRetryDelayMs: Math.min(retryDelayMs, 1_000),
      })
    );
    totalRequests += results.length;

    for (const result of results) {
      if (result.healthy) healthy.add(result.catalogId);
      else healthy.delete(result.catalogId);
    }

    pending = activeCatalogs.filter(catalog => !healthy.has(catalog.id));
    const summary = {
      pass,
      requested: targets.length,
      healthy: healthy.size,
      required: activeCatalogs.length,
      missing: pending.map(catalog => catalog.id),
      results,
    };
    passSummaries.push(summary);

    log.info(
      {
        runId,
        pass,
        requested: targets.length,
        healthy: healthy.size,
        required: activeCatalogs.length,
        missing: summary.missing,
      },
      'OnlyPorn catalog prewarm pass completed'
    );

    if (pending.length === 0) {
      let verificationSucceeded = true;

      for (let verification = 1; verification <= verificationPasses; verification += 1) {
        if (retryDelayMs > 0) await sleepImpl(retryDelayMs);

        const verificationResults = await mapLimited(activeCatalogs, concurrency, catalog =>
          requestCatalogForPass({
            baseUrl,
            catalog,
            runId,
            pass: `${pass}-verify${verification}`,
            fetchImpl,
            requestTimeoutMs,
            sleepImpl,
            immediateRetryDelayMs: Math.min(retryDelayMs, 1_000),
          })
        );
        totalRequests += verificationResults.length;
        const failed = verificationResults.filter(result => !result.healthy);

        passSummaries.push({
          pass: `${pass}-verify${verification}`,
          requested: activeCatalogs.length,
          healthy: activeCatalogs.length - failed.length,
          required: activeCatalogs.length,
          missing: failed.map(result => result.catalogId),
          results: verificationResults,
        });

        if (failed.length) {
          verificationSucceeded = false;
          pending = failed.map(result => byId.get(result.catalogId)).filter(Boolean);
          for (const result of failed) healthy.delete(result.catalogId);
          break;
        }
      }

      if (verificationSucceeded) {
        const finishedAt = new Date().toISOString();
        const result = {
          success: true,
          runId,
          manifestVersion: manifest.version || '',
          activeCatalogs: activeCatalogs.length,
          healthyCatalogs: activeCatalogs.length,
          missingCatalogs: [],
          totalRequests,
          passSummaries,
          finishedAt,
        };
        writeStartupPrewarmReadyMarker(result);

        log.info(
          {
            event: 'DEPLOY_PREWARM_COMPLETE',
            success: true,
            runId,
            manifestVersion: result.manifestVersion,
            activeCatalogs: result.activeCatalogs,
            healthyCatalogs: result.healthyCatalogs,
            totalRequests: result.totalRequests,
            finishedAt,
          },
          'OnlyPorn catalog prewarm completed'
        );
        return result;
      }
    }

    if (pass < maxPasses && retryDelayMs > 0) {
      await sleepImpl(retryDelayMs);
    }
  }

  const result = {
    success: false,
    runId,
    manifestVersion: manifest.version || '',
    activeCatalogs: activeCatalogs.length,
    healthyCatalogs: healthy.size,
    missingCatalogs: pending.map(catalog => catalog.id),
    totalRequests,
    passSummaries,
    finishedAt: new Date().toISOString(),
  };
  log.warn(
    {
      event: 'DEPLOY_PREWARM_INCOMPLETE',
      success: false,
      runId,
      manifestVersion: result.manifestVersion,
      activeCatalogs: result.activeCatalogs,
      healthyCatalogs: result.healthyCatalogs,
      missingCatalogs: result.missingCatalogs,
      totalRequests: result.totalRequests,
      finishedAt: result.finishedAt,
    },
    'OnlyPorn catalog prewarm finished incomplete'
  );
  return result;
}

function readSchedulerConfig(env = process.env) {
  return Object.freeze({
    enabled: toBoolean(env.ONLYPORN_PREWARM_ENABLED, DEFAULTS.enabled),
    startDelayMs: toInteger(
      env.ONLYPORN_PREWARM_START_DELAY_MS,
      DEFAULTS.startDelayMs,
      0,
      60 * 60 * 1000
    ),
    intervalMs: toInteger(
      env.ONLYPORN_PREWARM_INTERVAL_MS,
      DEFAULTS.intervalMs,
      15 * 60 * 1000,
      7 * 24 * 60 * 60 * 1000
    ),
    concurrency: toInteger(
      env.ONLYPORN_PREWARM_CONCURRENCY,
      DEFAULTS.concurrency,
      1,
      10
    ),
    maxPasses: toInteger(
      env.ONLYPORN_PREWARM_MAX_PASSES,
      DEFAULTS.maxPasses,
      1,
      20
    ),
    retryDelayMs: toInteger(
      env.ONLYPORN_PREWARM_RETRY_DELAY_MS,
      DEFAULTS.retryDelayMs,
      0,
      300_000
    ),
    requestTimeoutMs: toInteger(
      env.ONLYPORN_PREWARM_REQUEST_TIMEOUT_MS,
      DEFAULTS.requestTimeoutMs,
      1_000,
      900_000
    ),
    // A Render environment value survives deployments. Never let a stale
    // value from the previous release weaken the catalog contract compiled
    // into this release; an environment value may only tighten the minimum.
    expectedActiveCatalogs: Math.max(
      DEFAULTS.expectedActiveCatalogs,
      toInteger(
        env.ONLYPORN_PREWARM_EXPECTED_ACTIVE,
        DEFAULTS.expectedActiveCatalogs,
        1,
        1_000
      )
    ),
    verificationPasses: toInteger(
      env.ONLYPORN_PREWARM_VERIFICATION_PASSES,
      DEFAULTS.verificationPasses,
      0,
      3
    ),
  });
}

function startCatalogPrewarmScheduler(options = {}) {
  const log = options.logger || logger;
  const config = { ...readSchedulerConfig(options.env), ...(options.config || {}) };
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const setTimeoutImpl = options.setTimeoutImpl || setTimeout;
  const clearTimeoutImpl = options.clearTimeoutImpl || clearTimeout;
  let timer = null;
  let running = null;
  let stopped = false;

  function schedule(delayMs, reason) {
    if (stopped || !config.enabled) return;
    clearTimeoutImpl(timer);
    timer = setTimeoutImpl(() => {
      timer = null;
      void execute(reason);
    }, delayMs);
    timer.unref?.();
  }

  async function execute(reason = 'scheduled') {
    if (stopped || !config.enabled) return null;
    if (reason === 'manual' && timer) {
      clearTimeoutImpl(timer);
      timer = null;
    }
    if (running) {
      log.info({ reason }, 'OnlyPorn catalog prewarm skipped because a run is already active');
      return running;
    }

    running = runCatalogPrewarm({
      baseUrl,
      logger: log,
      fetchImpl: options.fetchImpl,
      sleepImpl: options.sleepImpl,
      concurrency: config.concurrency,
      maxPasses: config.maxPasses,
      retryDelayMs: config.retryDelayMs,
      requestTimeoutMs: config.requestTimeoutMs,
      expectedActiveCatalogs: config.expectedActiveCatalogs,
      verificationPasses: config.verificationPasses,
    })
      .then(result => {
        recordCatalogPrewarmResult(result);
        return result;
      })
      .catch(error => {
        log.error(
          { reason, error: error?.message || String(error) },
          'OnlyPorn catalog prewarm run failed'
        );
        const result = {
          success: false,
          error: error?.message || String(error),
          activeCatalogs: 0,
          healthyCatalogs: 0,
          missingCatalogs: [],
          finishedAt: new Date().toISOString(),
        };
        recordCatalogPrewarmResult(result);
        return result;
      })
      .finally(() => {
        running = null;
      });

    return running;
  }

  function start() {
    if (!config.enabled) {
      log.info('OnlyPorn catalog prewarm scheduler is disabled');
      return;
    }
    log.info(
      {
        baseUrl,
        startDelayMs: config.startDelayMs,
        startupOnly: true,
        concurrency: config.concurrency,
        maxPasses: config.maxPasses,
      },
      'OnlyPorn startup-only catalog prewarm scheduled'
    );
    schedule(config.startDelayMs, 'startup');
  }

  function stop() {
    stopped = true;
    clearTimeoutImpl(timer);
    timer = null;
    log.info('OnlyPorn catalog prewarm scheduler stopped');
  }

  start();

  return Object.freeze({
    stop,
    runNow: () => execute('manual'),
    get running() {
      return Boolean(running);
    },
    config: Object.freeze({ ...config }),
  });
}

module.exports = {
  DEFAULTS,
  DEFERRED_CATALOG_IDS,
  activeCatalogsFromManifest,
  minimumHealthyMetas,
  normalizeBaseUrl,
  readSchedulerConfig,
  requestCatalog,
  requestCatalogForPass,
  runCatalogPrewarm,
  startCatalogPrewarmScheduler,
  sukebeiHentaiSqliteSnapshot,
};
