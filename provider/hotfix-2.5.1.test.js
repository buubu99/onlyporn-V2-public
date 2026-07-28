const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const createJavHdPorn = require('./javhdporn');
const safariImpersonation = require('./safari-impersonation');

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
  assert.match(providerSource, /profile:\s*'javhdporn'/);
  assert.match(providerSource, /method:\s*'POST'/);
  assert.match(providerSource, /X-Requested-With/);
});

test('Safari helper keeps isolated SpankBang and JAV HD Porn sessions', () => {
  const helper = fs.readFileSync(
    path.join(ROOT, 'scripts', 'safari_fetch_helper.py'),
    'utf8'
  );

  assert.match(helper, /"spankbang"/);
  assert.match(helper, /"javhdporn"/);
  assert.match(helper, /"video\.javhdporn\.net"/);
  assert.match(helper, /sessions:\s*dict\[str, requests\.Session\]/);
  assert.match(helper, /method not in \{"GET", "POST", "HEAD"\}/);
  assert.match(helper, /session\.request\(/);
});

test('JAV HD Porn playback headers forward Safari-session cookies', async () => {
  const provider = createJavHdPorn();
  const original = safariImpersonation.getCookieHeader;
  safariImpersonation.getCookieHeader = profile => {
    assert.equal(profile, 'javhdporn');
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

test('OnlyPorn hotfix release reports version 2.5.1', () => {
  const packageInfo = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')
  );
  assert.equal(packageInfo.version, '2.5.1');
  assert.match(packageInfo.scripts['test:release'], /hotfix-2\.5\.1\.test\.js/);
});
