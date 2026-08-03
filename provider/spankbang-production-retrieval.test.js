'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const createSpankbang = require('./spankbang');
const safariImpersonation = require('./safari-impersonation');

const ONE_CARD_HTML = `
<html><body>
  <a class="thumb" href="/abc123/video/example-title/">
    <img alt="Example title" src="https://static.example/poster.jpg">
  </a>
</body></html>`;

test('SpankBang sends the complete proven Safari navigation headers', async () => {
  const provider = createSpankbang();
  const originalFetchText = safariImpersonation.fetchText;
  let captured = null;

  safariImpersonation.fetchText = async (url, options) => {
    captured = { url, options };
    return {
      data: ONE_CARD_HTML,
      status: 200,
      headers: {},
      finalUrl: url,
    };
  };

  try {
    await provider.fetchHtml('https://spankbang.com/new_videos/');
  } finally {
    safariImpersonation.fetchText = originalFetchText;
  }

  assert.ok(captured);
  assert.equal(captured.options.attempts, 2);
  assert.equal(captured.options.headers.Referer, 'https://spankbang.com/');
  assert.equal(captured.options.headers['Accept-Language'], 'en-US,en;q=0.9');
  assert.equal(captured.options.headers['Cache-Control'], 'no-cache');
  assert.match(captured.options.headers.Cookie, /age_verified=1/);
  assert.equal(captured.options.headers['Upgrade-Insecure-Requests'], '1');
});

test('default SpankBang catalog falls back only after a fresh empty Trending result', async () => {
  const provider = createSpankbang();
  const requested = [];

  provider.fetchHtml = async url => {
    requested.push(url);
    if (url.includes('/new_videos/')) return ONE_CARD_HTML;
    return '<html><body></body></html>';
  };

  const result = await provider.handleCatalog({
    type: 'movie',
    id: 'spankbang',
    extra: { skip: 0, catalogPrewarm: 'test' },
  });

  assert.equal(result.metas.length, 1);
  assert.equal(requested.length, 2);
  assert.match(requested[0], /\/trending_videos\//);
  assert.match(requested[1], /\/new_videos\//);
});

test('explicit SpankBang genres are authoritative and do not trigger root fallbacks', async () => {
  const provider = createSpankbang();
  const requested = [];
  provider.fetchHtml = async url => {
    requested.push(url);
    return '<html><body></body></html>';
  };

  const result = await provider.handleCatalog({
    type: 'movie',
    id: 'spankbang',
    extra: { genre: 'Popular', skip: 0 },
  });

  assert.equal(result.metas.length, 0);
  assert.equal(requested.length, 1);
  assert.match(requested[0], /\/most_popular\//);
});
