'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const logger = require('../logger');

const root = path.resolve(__dirname, '..');

function source(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('client classification distinguishes Google Android Streamer from Mac Web Stremio', () => {
  const { classifyClient } = logger._traceTest;
  assert.deepEqual(
    classifyClient('Dalvik/2.1.0 (Linux; U; Android 14; Google TV Streamer Build/UTT3)'),
    {
      platform: 'android-tv',
      uaFamily: 'dalvik',
      uaHash: classifyClient('Dalvik/2.1.0 (Linux; U; Android 14; Google TV Streamer Build/UTT3)').uaHash,
    }
  );
  assert.equal(
    classifyClient('Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome/140.0 Safari/537.36').platform,
    'mac-web'
  );
  assert.equal(classifyClient('node-fetch').platform, 'server');
});

test('route metadata retains addon diagnostics but never records relay tokens', () => {
  const { routeMetadata } = logger._traceTest;
  const catalog = routeMetadata({
    path: '/catalog/movie/tpb4k.sukebei.top/search=uncensored&skip=40.json',
  });
  assert.equal(catalog.resource, 'catalog');
  assert.equal(catalog.targetId, 'tpb4k.sukebei.top');
  assert.equal(catalog.search, 'uncensored');
  assert.equal(catalog.skip, '40');

  const media = routeMetadata({
    path: '/media/g-deadbee/super-secret-token/segment.ts',
  });
  assert.equal(media.resource, 'media');
  assert.equal(media.targetId, 'protected-relay');
  assert.doesNotMatch(JSON.stringify(media), /super-secret-token/);
});

test('long encoded content identifiers are compact and remain correlatable', () => {
  const longId = `onlyporn:${'x'.repeat(1000)}`;
  const compact = logger._traceTest.compactIdentifier(longId);
  assert.equal(compact.length, longId.length);
  assert.equal(compact.truncated, true);
  assert.match(compact.value, /sha256:[a-f0-9]{16}/);
  assert.equal(compact.hash.length, 16);
});

test('request context survives asynchronous provider work', async () => {
  const result = await logger.runWithTraceContext(
    { rid: 'op-test', platform: 'android-tv' },
    async () => {
      await Promise.resolve();
      return logger.currentTraceContext();
    }
  );
  assert.equal(result.rid, 'op-test');
  assert.equal(result.platform, 'android-tv');
});

test('observability contract includes request, result, relay and deployment markers', () => {
  const addon = source('addon.js');
  const serverSdk = source('server-sdk/index.js');
  const relay = source('media-relay.js');
  const server = source('server.js');
  const readiness = source('provider/runtime-readiness.js');

  for (const marker of ['ONLYV2_TIMING', 'ONLYV2_STATS', 'ONLYV2_COUNTS']) {
    assert.match(addon, new RegExp(marker));
  }
  assert.match(serverSdk, /REQ_IN/);
  assert.match(serverSdk, /REQ_OUT/);
  assert.match(relay, /originRid/);
  assert.match(relay, /RELAY_SESSION/);
  assert.match(relay, /JAVHD_SEGMENT_REJECTED/);
  assert.match(server, /DEPLOY_CONTAINER_START/);
  assert.match(server, /DEPLOY_CUTOVER_START/);
  assert.match(server, /DEPLOY_LIVE/);
  assert.match(server, /DEPLOY_ROLLBACK/);
  assert.match(readiness, /DEPLOY_READY/);
});

test('sensitive headers and source URLs are reduced without losing host diagnostics', () => {
  const { safeHeaders, safeUrlLogValue } = logger._traceTest;
  assert.deepEqual(
    safeHeaders({ Cookie: 'secret', Authorization: 'Bearer secret', Range: 'bytes=1-2' }),
    { Cookie: '[Redacted]', Authorization: '[Redacted]', Range: 'bytes=1-2' }
  );
  assert.deepEqual(safeUrlLogValue('tpdb:scene-1'), 'tpdb:scene-1');
  const safeUrl = safeUrlLogValue('https://cdn.example/private/token/video.m3u8?sig=secret');
  assert.equal(safeUrl.hostname, 'cdn.example');
  assert.equal(safeUrl.extension, '.m3u8');
  assert.equal(safeUrl.hasQuery, true);
  assert.doesNotMatch(JSON.stringify(safeUrl), /private|token|secret/);
});
