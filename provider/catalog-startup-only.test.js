'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  DEFAULTS,
  readSchedulerConfig,
  startCatalogPrewarmScheduler,
} = require('./catalog-prewarm');
const {
  DEFAULT_TTL_MS,
  createCatalogResponseStore,
} = require('./tpb4k/catalog-response-store');

const DAY_MS = 24 * 60 * 60 * 1000;

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(body); },
  };
}

function fakeTimers() {
  const scheduled = [];
  const cleared = [];
  return {
    scheduled,
    cleared,
    setTimeoutImpl(callback, delayMs) {
      const timer = {
        callback,
        delayMs,
        cancelled: false,
        unref() {},
      };
      scheduled.push(timer);
      return timer;
    },
    clearTimeoutImpl(timer) {
      if (!timer || timer.cancelled) return;
      timer.cancelled = true;
      cleared.push(timer);
    },
    fire(timer) {
      if (!timer || timer.cancelled) return false;
      timer.cancelled = true;
      timer.callback();
      return true;
    },
  };
}

async function waitUntil(predicate, message) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail(message);
}

function healthyHarness({ holdManifest = false, manifestFailure = false } = {}) {
  const catalogs = Array.from({ length: 35 }, (_, index) => ({
    id: `catalog-${index + 1}`,
    type: 'movie',
  }));
  let manifestCalls = 0;
  let catalogCalls = 0;
  let releaseManifest;
  const manifestGate = holdManifest
    ? new Promise(resolve => { releaseManifest = resolve; })
    : null;

  const fetchImpl = async url => {
    if (String(url).includes('/manifest.json')) {
      manifestCalls += 1;
      if (manifestGate) await manifestGate;
      if (manifestFailure) return jsonResponse({ error: 'failed' }, 503);
      return jsonResponse({ version: 'test', catalogs });
    }
    catalogCalls += 1;
    return jsonResponse({ metas: [{ id: 'healthy' }] });
  };

  return {
    fetchImpl,
    releaseManifest: () => releaseManifest?.(),
    get manifestCalls() { return manifestCalls; },
    get catalogCalls() { return catalogCalls; },
  };
}

function createScheduler(timers, harness) {
  return startCatalogPrewarmScheduler({
    baseUrl: 'https://example.invalid',
    fetchImpl: harness.fetchImpl,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    sleepImpl: async () => {},
    config: {
      enabled: true,
      startDelayMs: 90_000,
      intervalMs: 23 * 60 * 60 * 1000,
      concurrency: 3,
      maxPasses: 6,
      retryDelayMs: 0,
      requestTimeoutMs: 1_000,
      expectedActiveCatalogs: 35,
      verificationPasses: 1,
    },
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  });
}

test('interval configuration remains compatible but runtime has no interval reschedule', () => {
  assert.equal(DEFAULTS.intervalMs, 23 * 60 * 60 * 1000);
  assert.equal(DEFAULTS.expectedActiveCatalogs, 34);
  assert.equal(readSchedulerConfig({}).intervalMs, 23 * 60 * 60 * 1000);
  assert.equal(readSchedulerConfig({}).expectedActiveCatalogs, 34);
  assert.equal(readSchedulerConfig({ ONLYPORN_PREWARM_INTERVAL_MS: '7200000' }).intervalMs, 7_200_000);

  const source = fs.readFileSync(path.join(__dirname, 'catalog-prewarm.js'), 'utf8');
  assert.match(source, /schedule\(config\.startDelayMs, 'startup'\)/);
  assert.doesNotMatch(source, /schedule\(config\.intervalMs, 'interval'\)/);
  assert.match(source, /startupOnly:\s*true/);
});

test('stale deployment environment cannot lower the compiled catalog contract', () => {
  assert.equal(
    readSchedulerConfig({ ONLYPORN_PREWARM_EXPECTED_ACTIVE: '33' }).expectedActiveCatalogs,
    34
  );
  assert.equal(
    readSchedulerConfig({ ONLYPORN_PREWARM_EXPECTED_ACTIVE: '35' }).expectedActiveCatalogs,
    35
  );
});

test('successful startup runs once and never schedules a recurring timer', async () => {
  const timers = fakeTimers();
  const harness = healthyHarness();
  const scheduler = createScheduler(timers, harness);

  assert.equal(timers.scheduled.length, 1);
  assert.equal(timers.scheduled[0].delayMs, 90_000);
  assert.equal(timers.fire(timers.scheduled[0]), true);

  await waitUntil(
    () => harness.manifestCalls === 1 && !scheduler.running,
    'startup run did not finish'
  );
  assert.equal(harness.catalogCalls, 70);
  assert.equal(timers.scheduled.length, 1);
  scheduler.stop();
});

test('failed startup also stops without an interval retry', async () => {
  const timers = fakeTimers();
  const harness = healthyHarness({ manifestFailure: true });
  const scheduler = createScheduler(timers, harness);

  assert.equal(timers.fire(timers.scheduled[0]), true);
  await waitUntil(
    () => harness.manifestCalls === 1 && !scheduler.running,
    'failed startup run did not finish'
  );
  assert.equal(timers.scheduled.length, 1);
  scheduler.stop();
});

test('manual run cancels pending startup and the cancelled callback cannot start a second run', async () => {
  const timers = fakeTimers();
  const harness = healthyHarness();
  const scheduler = createScheduler(timers, harness);
  const startupTimer = timers.scheduled[0];

  const result = await scheduler.runNow();
  assert.equal(result.success, true);
  assert.equal(result.healthyCatalogs, 35);
  assert.equal(result.totalRequests, 70);
  assert.equal(startupTimer.cancelled, true);
  assert.equal(timers.fire(startupTimer), false);
  assert.equal(harness.manifestCalls, 1);
  assert.equal(timers.scheduled.length, 1);
  scheduler.stop();
});

test('duplicate manual calls share one active catalog run', async () => {
  const timers = fakeTimers();
  const harness = healthyHarness({ holdManifest: true });
  const scheduler = createScheduler(timers, harness);

  const first = scheduler.runNow();
  const second = scheduler.runNow();
  await waitUntil(() => harness.manifestCalls === 1, 'manual run did not reach manifest');
  assert.equal(scheduler.running, true);

  harness.releaseManifest();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.success, true);
  assert.equal(secondResult.success, true);
  assert.equal(harness.manifestCalls, 1);
  assert.equal(harness.catalogCalls, 70);
  assert.equal(timers.scheduled.length, 1);
  scheduler.stop();
});

test('stop cancels pending startup and prevents execution', async () => {
  const timers = fakeTimers();
  const harness = healthyHarness();
  const scheduler = createScheduler(timers, harness);
  const startupTimer = timers.scheduled[0];

  scheduler.stop();
  assert.equal(startupTimer.cancelled, true);
  assert.equal(timers.fire(startupTimer), false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.manifestCalls, 0);
});

test('persistent last-known-good remains through 30 days and expires after the boundary', () => {
  assert.equal(DEFAULT_TTL_MS, 30 * DAY_MS);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyporn-lkg-'));
  const filePath = path.join(directory, 'catalog-responses-v1.json');
  let current = 1_000_000;
  const key = 'r7:movie:tpb4k.studio.digitalplayground.top:0';

  try {
    const writer = createCatalogResponseStore({
      filePath,
      now: () => current,
      ttlMs: DEFAULT_TTL_MS,
    });
    assert.equal(writer.set(key, { metas: [{ id: 'saved-card' }] }), true);

    current += 30 * DAY_MS;
    const boundaryReader = createCatalogResponseStore({
      filePath,
      now: () => current,
      ttlMs: DEFAULT_TTL_MS,
    });
    assert.equal(boundaryReader.get(key)?.value?.metas?.length, 1);

    current += 1;
    const expiredReader = createCatalogResponseStore({
      filePath,
      now: () => current,
      ttlMs: DEFAULT_TTL_MS,
    });
    assert.equal(expiredReader.get(key), null);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('fresh TTL stays 15 minutes and in-memory stale TTL is 30 days', () => {
  const source = fs.readFileSync(path.join(__dirname, 'tpb4k.js'), 'utf8');
  assert.match(source, /CATALOG_CACHE_TTL_MS = 15 \* 60 \* 1000/);
  assert.match(source, /CATALOG_STALE_TTL_MS = 30 \* 24 \* 60 \* 60 \* 1000/);
});
