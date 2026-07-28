'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { captureJwPlayerSources } = require('./javhdporn-jw-config');

const ROOT = path.resolve(__dirname, '..');


function versionAtLeast(actual, minimum) {
  const current = actual.split('.').map(Number);
  const required = minimum.split('.').map(Number);

  if (
    current.length !== 3 ||
    required.length !== 3 ||
    current.some(value => !Number.isInteger(value)) ||
    required.some(value => !Number.isInteger(value))
  ) {
    return false;
  }

  for (let index = 0; index < 3; index += 1) {
    if (current[index] > required[index]) return true;
    if (current[index] < required[index]) return false;
  }

  return true;
}

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test('JWPlayer child protocol is isolated from live script console output', async () => {
  const html = '<!doctype html><html><body><div id="jwplayer" data-config="encrypted"></div></body></html>';
  const script = `
    console.log(JSON.stringify({ ok: false, source: 'noise-before' }));
    jwplayer('jwplayer').setup({
      sources: [{ file: 'https://streamhls.click/hls/token/master.m3u8', type: 'hls' }],
      image: 'https://example.test/poster.jpg'
    });
    Promise.resolve().then(() => console.log(JSON.stringify({ ok: false, source: 'noise-after' })));
  `;

  const captured = await captureJwPlayerSources({
    html,
    script,
    playerUrl: 'https://video1.javhdporn.net/p/test',
  });

  assert.equal(captured.ok, true);
  assert.deepEqual(captured.sources, [
    {
      url: 'https://streamhls.click/hls/token/master.m3u8',
      type: 'hls',
      label: '',
    },
  ]);
});

test('JWPlayer capture emits a marked result and exits immediately', () => {
  const captureSource = read('scripts/javhdporn_jw_capture.js');
  const bridgeSource = read('provider/javhdporn-jw-config.js');

  assert.match(captureSource, /__ONLYPORN_JW_RESULT__:/);
  assert.match(captureSource, /process\.stdout\.write\(line, \(\) => process\.exit\(status\)\)/);
  assert.match(captureSource, /const sandboxConsole = quietConsole\(\)/);
  assert.match(bridgeSource, /startsWith\(RESULT_PREFIX\)/);
  assert.doesNotMatch(bridgeSource, /\.at\(-1\)/);
});

test('OnlyPorn hotfix release reports version 2.5.4', () => {
  const pkg = require('../package.json');
  assert.ok(
    versionAtLeast(pkg.version, '2.5.4'),
    `Expected version 2.5.4 or newer, detected ${pkg.version}`,
  );
  assert.match(pkg.scripts['test:release'], /hotfix-2\.5\.4\.test\.js/);
});
