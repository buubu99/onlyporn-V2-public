'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  resolveYesporn,
  yespornStreamPairs,
} = require('./tpb4k/native-discovery');
const {
  normalizeCandidate,
  toStremioStream,
} = require('./tpb4k/candidate');
const { getCatalogDefinition } = require('../catalog/tpb4k');

function mockHeaders(values = {}) {
  const normalized = Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key.toLowerCase(),
      String(value),
    ])
  );
  return {
    get(name) {
      return normalized[String(name).toLowerCase()] || null;
    },
  };
}

function mockHtmlResponse(body) {
  return {
    status: 200,
    headers: mockHeaders({
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    }),
    async text() {
      return body;
    },
  };
}

test('YesPorn extracts every KVS function/0 quality and preserves tokens', () => {
  const html = `
    <script>
      video_url: 'function/0/https:\\/\\/cdn.example\\/get_file\\/1080?token=one&amp;x=1',
      video_url_text: '1080p',
      video_alt_url: 'function/0/https:\\/\\/cdn.example\\/get_file\\/720?token=two',
      video_alt_url_text: '720p',
      video_alt_url2: 'function/0/https:\\/\\/cdn.example\\/get_file\\/480?token=three',
      video_alt_url2_text: '480p'
    </script>
  `;

  const values = yespornStreamPairs(
    html,
    'https://yesporn.vip/video/123/example/'
  );

  assert.equal(values.length, 3);
  assert.deepEqual(values.map(value => value.label), [
    '1080p',
    '720p',
    '480p',
  ]);
  assert.equal(
    values[0].url,
    'https://cdn.example/get_file/1080?token=one&x=1'
  );
  assert.equal(
    values.every(value => !value.url.includes('function/0/')),
    true
  );
});

test('YesPorn accepts extensionless get_file URLs from JSON-style player data', () => {
  const html = `
    <script type="application/json">
      {
        "video_url": "https:\\/\\/media.example\\/get_file\\/abc123?token=fresh",
        "video_url_text": "HD"
      }
    </script>
  `;

  const values = yespornStreamPairs(
    html,
    'https://yesporn.vip/video/321/json-player/'
  );

  assert.equal(values.length, 1);
  assert.equal(
    values[0].url,
    'https://media.example/get_file/abc123?token=fresh'
  );
  assert.equal(values[0].mediaKind, 'mp4');
});

test('YesPorn resolver follows one safe iframe player level', async () => {
  const detailPath = '/video/456/iframe-player/';
  const sourceId =
    `yesporn:${Buffer.from(detailPath, 'utf8').toString('base64url')}`;
  const requests = [];

  const candidates = await resolveYesporn({
    sourceId,
    item: { title: 'Iframe Player' },
    options: {
      checkDns: false,
      config: {
        requestTimeoutMs: 2_000,
        discoveryMaxResponseBytes: 1_000_000,
      },
      async fetchImpl(url) {
        requests.push(String(url));
        if (String(url).includes('/video/456/')) {
          return mockHtmlResponse(`
            <iframe src="https://player.example/embed/456"></iframe>
          `);
        }
        return mockHtmlResponse(`
          <video>
            <source src="https://cdn.example/get_file/iframe456?token=fresh" type="video/mp4">
          </video>
        `);
      },
    },
  });

  assert.deepEqual(requests, [
    'https://yesporn.vip/video/456/iframe-player/',
    'https://player.example/embed/456',
  ]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].mediaKind, 'mp4');
  assert.equal(
    candidates[0].url,
    'https://cdn.example/get_file/iframe456?token=fresh'
  );
  assert.equal(
    candidates[0].requestHeaders.Referer,
    'https://player.example/embed/456'
  );
});

test('YesPorn direct streams carry proxy headers and are notWebReady', () => {
  const candidate = normalizeCandidate({
    source: 'yesporn',
    sourceId: 'yesporn:test',
    title: 'Example',
    mediaKind: 'mp4',
    url: 'https://cdn.example/get_file/1080?token=fresh',
    validated: true,
    requestHeaders: {
      'User-Agent': 'Mozilla/5.0 Test',
      Referer: 'https://yesporn.vip/video/123/example/',
      Origin: 'https://yesporn.vip',
      Cookie: 'must-not-survive',
      Authorization: 'must-not-survive',
    },
  });

  const stream = toStremioStream(candidate);

  assert.equal(stream.url, candidate.url);
  assert.equal(stream.behaviorHints.notWebReady, true);
  assert.deepEqual(stream.behaviorHints.proxyHeaders, {
    request: {
      'User-Agent': 'Mozilla/5.0 Test',
      Referer: 'https://yesporn.vip/video/123/example/',
      Origin: 'https://yesporn.vip',
    },
  });
});

test('the YesPorn catalog remains the website/native route', () => {
  const definition = getCatalogDefinition('tpb4k.yesporn.recent');
  assert.equal(definition.source, 'yesporn');
  assert.equal(definition.mode, 'recent');
  assert.equal(Object.hasOwn(definition, 'lookupSource'), false);
});
