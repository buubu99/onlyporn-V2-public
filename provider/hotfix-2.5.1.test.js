const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const createJavHdPorn = require('./javhdporn');
const safariImpersonation = require('./javhdporn-safari-impersonation');

const ROOT = path.resolve(__dirname, '..');

test('JAV HD Porn uses the protected Safari profile for page HTML', async () => {
  const provider = createJavHdPorn();
  let captured;
  provider.fetchSafariResponse = async (url, options) => {
    captured = { url, options };
    return { data: '<html><title>Fixture</title></html>', status: 200, headers: {} };
  };

  const html = await provider.fetchHtml(
    'https://www.javhdporn.net/v3/category/censored/',
    { cache: false }
  );

  assert.match(html, /Fixture/);
  assert.equal(captured.url, 'https://www.javhdporn.net/v3/category/censored/');
});

test('JAV HD Porn player API stays on the same Safari session', async () => {
  const providerSource = fs.readFileSync(
    path.join(ROOT, 'provider', 'javhdporn.js'),
    'utf8'
  );

  assert.match(providerSource, /fetchSafariJson\(`\$\{this\.baseUrl\}\/api\/play\//);
  assert.match(providerSource, /javhdporn-safari-impersonation/);
  assert.match(providerSource, /method:\s*'POST'/);
  assert.match(providerSource, /X-Requested-With/);
});

test('JAV HD Porn uses a dedicated Safari helper process', () => {
  const helper = fs.readFileSync(
    path.join(ROOT, 'scripts', 'javhdporn_safari_fetch_helper.py'),
    'utf8'
  );
  const client = fs.readFileSync(
    path.join(ROOT, 'provider', 'javhdporn-safari-impersonation.js'),
    'utf8'
  );

  assert.match(helper, /JAV HD Porn/);
  assert.match(helper, /video\\d\*\\.javhdporn/);
  assert.doesNotMatch(helper, /spankbang/i);
  assert.match(helper, /method not in \{"GET", "POST", "HEAD"\}/);
  assert.match(client, /javhdporn_safari_fetch_helper\.py/);
});

test('JAV HD Porn playback headers forward Safari-session cookies', async () => {
  const provider = createJavHdPorn();
  const original = safariImpersonation.getCookieHeader;
  safariImpersonation.getCookieHeader = () => {
    return 'session=fixture; age=1';
  };

  try {
    const headers = await provider.playbackHeaders(
      'https://www.javhdporn.net/video/fixture/',
      'https://video.javhdporn.net/media/master.m3u8'
    );
    assert.equal(headers.Cookie, 'session=fixture; age=1');
    assert.equal(headers.Referer, 'https://www.javhdporn.net/video/fixture/');
  } finally {
    safariImpersonation.getCookieHeader = original;
  }
});

test('OnlyPorn retains the 2.5.1 Safari transport regression coverage', () => {
  const packageInfo = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')
  );
  const [major, minor, patch] = packageInfo.version.split('.').map(Number);
  assert.ok(
    major > 2 ||
      (major === 2 && (minor > 5 || (minor === 5 && patch >= 1)))
  );
  assert.equal(packageInfo.scripts['test:release'], 'npm test');
});
