const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { captureJwPlayerSources } = require('./javhdporn-jw-config');

const ROOT = path.resolve(__dirname, '..');

test('SpankBang restores the exact isolated v2.4.2 Safari transport shape', () => {
  const helper = fs.readFileSync(path.join(ROOT, 'scripts', 'safari_fetch_helper.py'), 'utf8');
  const client = fs.readFileSync(path.join(ROOT, 'provider', 'safari-impersonation.js'), 'utf8');
  const provider = fs.readFileSync(path.join(ROOT, 'provider', 'spankbang.js'), 'utf8');

  assert.match(helper, /Persistent curl_cffi Safari transport for SpankBang page requests/);
  assert.match(helper, /session = requests\.Session\(impersonate=os\.getenv\("SPANKBANG_IMPERSONATE", "safari"\)\)/);
  assert.match(helper, /ensure_bootstrap\(timeout_seconds\)/);
  assert.match(helper, /response = session\.get\(HOME_URL/);
  assert.match(helper, /headers\["Referer"\] = HOME_URL/);
  assert.doesNotMatch(helper, /PROFILES|javhdporn/i);
  assert.match(client, /scripts', 'safari_fetch_helper\.py/);
  assert.doesNotMatch(client, /profile/);
  assert.match(provider, /require\('\.\/safari-impersonation'\)/);
});

test('JAVHDPorn has a separate process, helper, and cookie store', () => {
  const helper = fs.readFileSync(
    path.join(ROOT, 'scripts', 'javhdporn_safari_fetch_helper.py'),
    'utf8'
  );
  const client = fs.readFileSync(
    path.join(ROOT, 'provider', 'javhdporn-safari-impersonation.js'),
    'utf8'
  );
  const provider = fs.readFileSync(path.join(ROOT, 'provider', 'javhdporn.js'), 'utf8');

  assert.match(helper, /JAVHDPORN_IMPERSONATE/);
  assert.match(helper, /ALLOWED_HOST_PATTERN = re\.compile\(r"\^video\\d\*\\\.javhdporn\\\.net\$"\)/);
  assert.doesNotMatch(helper, /spankbang/i);
  assert.match(client, /javhdporn_safari_fetch_helper\.py/);
  assert.match(client, /this\.cookieHeader = ''/);
  assert.match(provider, /require\('\.\/javhdporn-safari-impersonation'\)/);
  assert.doesNotMatch(provider, /profile:\s*'javhdporn'/);
});

test('live-compatible JWPlayer sandbox keeps native browser APIs instead of incompatible stubs', () => {
  const capture = fs.readFileSync(
    path.join(ROOT, 'scripts', 'javhdporn_jw_capture.js'),
    'utf8'
  );

  assert.match(capture, /window\.fetch = global\.fetch/);
  assert.doesNotMatch(capture, /DisabledXMLHttpRequest/);
  assert.doesNotMatch(capture, /DisabledWebSocket/);
  assert.doesNotMatch(capture, /DisabledEventSource/);
  assert.doesNotMatch(capture, /context\.process = undefined/);
  assert.doesNotMatch(capture, /context\.require = undefined/);
  assert.match(capture, /setup\(config\) \{\s*capturedConfig = config/);
});

test('live-compatible JWPlayer sandbox captures setup after browser feature checks', async () => {
  const config = {
    sources: [
      {
        file: 'https://streamhls.click/hls/live-compatible/master.m3u8',
        type: 'hls',
        label: 'auto',
      },
    ],
  };
  const encoded = Buffer.from(JSON.stringify(config), 'utf8').toString('base64');
  const html = `<div id="jwplayer" data-config="${encoded}"></div>`;
  const script = `
    if (typeof fetch !== 'function') throw new TypeError('fetch is not callable');
    if (typeof XMLHttpRequest !== 'function') throw new TypeError('XMLHttpRequest missing');
    const read = () => document.querySelector('#jwplayer').getAttribute('data-config');
    Promise.resolve().then(() => jwplayer('jwplayer').setup(JSON.parse(atob(read()))));
  `;

  const captured = await captureJwPlayerSources({
    html,
    script,
    playerUrl: 'https://video1.javhdporn.net/p/live-compatible',
  });

  assert.deepEqual(captured.sources, [
    {
      url: 'https://streamhls.click/hls/live-compatible/master.m3u8',
      type: 'hls',
      label: 'auto',
    },
  ]);
});

test('OnlyPorn hotfix release reports version 2.5.3', () => {
  const packageInfo = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(packageInfo.version, '2.5.3');
  assert.match(packageInfo.scripts['test:release'], /hotfix-2\.5\.3\.test\.js/);
  assert.equal(packageInfo.dependencies.jsdom, '22.1.0');
  assert.equal(packageInfo.dependencies.jquery, '3.7.1');
});
