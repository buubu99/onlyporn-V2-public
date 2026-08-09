
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

function source(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('deployment readiness contract is 33 active and 33 healthy', () => {
  const prewarm = source('provider/catalog-prewarm.js');
  const runtime = source('provider/runtime-readiness.js');
  const gate = source('scripts/public-gate-proxy.js');

  assert.match(prewarm, /expectedActiveCatalogs:\s*33/);
  assert.match(prewarm, /Number\(result\.activeCatalogs\)\s*!==\s*33/);
  assert.match(prewarm, /Number\(result\.healthyCatalogs\)\s*!==\s*33/);
  assert.match(prewarm, /activeCatalogs:\s*33/);
  assert.match(prewarm, /healthyCatalogs:\s*33/);

  assert.match(runtime, /catalogState\.activeCatalogs\s*===\s*33/);
  assert.match(runtime, /catalogState\.healthyCatalogs\s*===\s*33/);

  assert.match(gate, /activeCatalogs[^\n]*33/);
  assert.match(gate, /healthyCatalogs[^\n]*33/);
  assert.match(gate, /33\/33 prewarm/);
});

test('media relay hardening and bandwidth observability are present', () => {
  const relay = source('media-relay.js');

  assert.match(relay, /Method Not Allowed/);
  assert.match(relay, /GET, HEAD, OPTIONS/);
  assert.match(relay, /event:\s*'media_relay_usage'/);
  assert.match(relay, /bytesSent/);
  assert.match(relay, /requestRange/);
  assert.match(relay, /responseContentRange/);
  assert.match(relay, /completed/);
  assert.match(relay, /relaySessionFingerprint/);
});

test('deployment environment example documents required MetaTube variables', () => {
  const env = source('.env.example');

  assert.match(env, /^TPB4K_METATUBE_ENABLED=/m);
  assert.match(env, /^TPB4K_METATUBE_STRICT=/m);
  assert.match(env, /^TPB4K_METATUBE_PROXY_SECRET=/m);
  assert.match(env, /^ONLYPORN_MEDIA_USAGE_LOGGING=true$/m);
});
