'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const mediaRelay = require('../media-relay');
const {
  resolveYesporn,
  yespornFlashvarStreams,
  yespornKvsDecryptUrl,
} = require('./tpb4k/native-discovery');
const {
  normalizeCandidate,
  toStremioStream,
} = require('./tpb4k/candidate');
const { getCatalogDefinition } = require('../catalog/tpb4k');

function mockHeaders(values = {}, setCookies = []) {
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
    getSetCookie() {
      return [...setCookies];
    },
  };
}

function mockHtmlResponse(body, setCookies = []) {
  return {
    status: 200,
    headers: mockHeaders(
      {
        'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(body),
      },
      setCookies
    ),
    async text() {
      return body;
    },
  };
}

test('YesPorn KVS decrypts the proven hashes exactly', () => {
  const licenseCode = '$494000116297929';

  assert.equal(
    yespornKvsDecryptUrl(
      'function/0/https://yesporn.vip/get_file/4/2935ef688611f1e65dad0e6515737b19a898519079/55000/55800/55800.mp4/',
      licenseCode
    ),
    'https://yesporn.vip/get_file/4/69013f11195367675be65d18e8aef5d2a898519079/55000/55800/55800.mp4/'
  );

  assert.equal(
    yespornKvsDecryptUrl(
      'function/0/https://yesporn.vip/get_file/4/b721c3be4127696def59b4bd712f017a453f6f2069/55000/55800/55800_720p.mp4/',
      licenseCode
    ),
    'https://yesporn.vip/get_file/4/b7b7f3727a12b012d16de994ce5461fb453f6f2069/55000/55800/55800_720p.mp4/'
  );

  assert.equal(
    yespornKvsDecryptUrl(
      'function/0/https://yesporn.vip/get_file/4/bfe26f607512fadb0ddabed1662fa0c42ffbd96159/55000/55800/55800_1080p.mp4/?br=1999',
      licenseCode
    ),
    'https://yesporn.vip/get_file/4/dfb6ffc1242e6a5210db0aa760def6db2ffbd96159/55000/55800/55800_1080p.mp4/?br=1999'
  );
});

test('YesPorn parses only authoritative flashvars media fields', () => {
  const html = `
    <script>
      var flashvars = {
        license_code: '$494000116297929',
        event_reporting2: 'https://yesporn.vip/get_file/1/not-video/report.mp4/',
        video_url: 'function/0/https://yesporn.vip/get_file/4/2935ef688611f1e65dad0e6515737b19a898519079/55000/55800/55800.mp4/',
        video_url_text: '480p',
        video_alt_url: 'function/0/https://yesporn.vip/get_file/4/b721c3be4127696def59b4bd712f017a453f6f2069/55000/55800/55800_720p.mp4/',
        video_alt_url_text: '720p',
        video_alt_url_hd: '1',
        video_alt_url2: 'function/0/https://yesporn.vip/get_file/4/bfe26f607512fadb0ddabed1662fa0c42ffbd96159/55000/55800/55800_1080p.mp4/?br=1999',
        video_alt_url2_text: '1080p',
        video_alt_url2_hd: '1',
        preview_url: 'https://yesnn.b-cdn.net/preview.jpg',
        timeline_screens_url: 'https://yesnn.b-cdn.net/{time}.jpg',
        adv_pre_vast: 'https://ads.example/vast'
      };
    </script>
    <a href="https://yesporn.vip/get_file/0/screenshot/screenshots/1.jpg/">screen</a>
    <img src="https://yesnn.b-cdn.net/poster.jpg">
  `;

  const streams = yespornFlashvarStreams(
    html,
    'https://yesporn.vip/video/55800/in-laws-episode-1-5jzkfg/'
  );

  assert.equal(streams.length, 3);
  assert.deepEqual(
    streams.map(stream => stream.label),
    ['1080p', '720p', '480p']
  );
  assert.equal(
    streams.every(stream =>
      stream.url.startsWith('https://yesporn.vip/get_file/4/')
      && /\.mp4\/?(?:\?|$)/i.test(stream.url)
    ),
    true
  );
  assert.deepEqual(
    streams.map(stream => stream.url),
    [
      'https://yesporn.vip/get_file/4/dfb6ffc1242e6a5210db0aa760def6db2ffbd96159/55000/55800/55800_1080p.mp4/?br=1999',
      'https://yesporn.vip/get_file/4/b7b7f3727a12b012d16de994ce5461fb453f6f2069/55000/55800/55800_720p.mp4/',
      'https://yesporn.vip/get_file/4/69013f11195367675be65d18e8aef5d2a898519079/55000/55800/55800.mp4/',
    ]
  );
  assert.equal(
    streams.some(stream =>
      /preview|screenshot|event_reporting|ads/i.test(stream.url)
    ),
    false
  );
  assert.equal(
    streams.some(stream =>
      /2935ef6886|b721c3be41|bfe26f6075/i.test(stream.url)
    ),
    false
  );
});

test('YesPorn resolver refetches exact detail page and keeps its session cookie', async () => {
  const path = '/video/55800/in-laws-episode-1-5jzkfg/';
  const sourceId =
    `yesporn:${Buffer.from(path, 'utf8').toString('base64url')}`;
  const requests = [];

  const candidates = await resolveYesporn({
    sourceId,
    item: { title: 'In-Laws Episode 1' },
    options: {
      checkDns: false,
      config: {
        requestTimeoutMs: 2_000,
        discoveryMaxResponseBytes: 1_000_000,
      },
      async fetchImpl(url, init) {
        requests.push({
          url: String(url),
          headers: init?.headers || {},
        });

        return mockHtmlResponse(
          `
            <script>
              var flashvars = {
                license_code: '$494000116297929',
                video_url: 'function/0/https://yesporn.vip/get_file/4/2935ef688611f1e65dad0e6515737b19a898519079/55000/55800/55800.mp4/',
                video_url_text: '480p',
                video_alt_url2: 'function/0/https://yesporn.vip/get_file/4/bfe26f607512fadb0ddabed1662fa0c42ffbd96159/55000/55800/55800_1080p.mp4/?br=1999',
                video_alt_url2_text: '1080p'
              };
            </script>
          `,
          [
            'kt_session=abc123; Path=/; Secure; HttpOnly',
            'consent=yes; Path=/; Secure',
          ]
        );
      },
    },
  });

  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    'https://yesporn.vip/video/55800/in-laws-episode-1-5jzkfg/'
  );
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].relayProvider, 'yesporn');
  assert.equal(candidates[0].mediaKind, 'mp4');
  assert.equal(
    candidates[0].requestHeaders.Referer,
    'https://yesporn.vip/video/55800/in-laws-episode-1-5jzkfg/'
  );
  assert.equal(
    candidates[0].requestHeaders.Cookie,
    'kt_session=abc123; consent=yes'
  );
  assert.equal(
    candidates[0].url,
    'https://yesporn.vip/get_file/4/dfb6ffc1242e6a5210db0aa760def6db2ffbd96159/55000/55800/55800_1080p.mp4/?br=1999'
  );
});

test('YesPorn candidates become OnlyPorn media-relay URLs', () => {
  mediaRelay.setPublicBase('http://127.0.0.1:49631');

  const candidate = normalizeCandidate({
    source: 'yesporn',
    sourceId: 'yesporn:test',
    title: 'Example',
    filename: 'Example.mp4',
    resolution: '1080p',
    quality: '1080p',
    mediaKind: 'mp4',
    url: 'https://yesporn.vip/get_file/4/dfb6ffc1242e6a5210db0aa760def6db2ffbd96159/55000/55800/55800_1080p.mp4/',
    validated: true,
    relayProvider: 'yesporn',
    requestHeaders: {
      'User-Agent': 'Mozilla/5.0 Test',
      Referer: 'https://yesporn.vip/video/1/example/',
      Origin: 'https://yesporn.vip',
      Cookie: 'kt_session=abc123',
    },
  });

  const stream = toStremioStream(candidate);

  assert.match(
    stream.url,
    /^http:\/\/127\.0\.0\.1:49631\/media\/[^/]+\/video\.mp4$/
  );
  assert.equal(stream.url.includes('yesporn.vip'), false);
  assert.equal(stream.behaviorHints.notWebReady, false);

  const token = new URL(stream.url).pathname.split('/')[2];
  const entry = mediaRelay._test.resolveRelayEntry(token);

  assert.equal(entry.provider, 'yesporn');
  assert.equal(
    entry.url,
    'https://yesporn.vip/get_file/4/dfb6ffc1242e6a5210db0aa760def6db2ffbd96159/55000/55800/55800_1080p.mp4/'
  );
  assert.equal(entry.headers.Cookie, 'kt_session=abc123');
  assert.equal(entry.headers.Referer, 'https://yesporn.vip/video/1/example/');
});

test('media relay permits YesPorn media hosts narrowly', () => {
  assert.equal(
    mediaRelay._test.hostnameAllowed('yesporn.vip', 'yesporn'),
    true
  );
  assert.equal(
    mediaRelay._test.hostnameAllowed('sub.yesporn.vip', 'yesporn'),
    true
  );
  assert.equal(
    mediaRelay._test.hostnameAllowed('yesnn.b-cdn.net', 'yesporn'),
    false
  );
  assert.equal(
    mediaRelay._test.hostnameAllowed('example.com', 'yesporn'),
    false
  );
});

test('YesPorn relay source uses fetch-session transport rather than axios', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(
    require.resolve('../media-relay'),
    'utf8'
  );

  assert.match(
    source,
    /async function yespornFetchRequest\(/
  );
  assert.match(
    source,
    /response = await fetch\(currentUrl,/
  );
  assert.match(
    source,
    /entry\.provider === 'yesporn'[\s\S]{0,200}pipeYespornResponse/
  );
});

test('the YesPorn catalog remains website-native and XVideosRED is unchanged', () => {
  const yesporn = getCatalogDefinition('tpb4k.yesporn.recent');
  const xvideosred = getCatalogDefinition('tpb4k.studio.xvideosred.top');

  assert.equal(yesporn.source, 'yesporn');
  assert.equal(yesporn.mode, 'recent');

  assert.equal(xvideosred.source, 'studio-metadata');
  assert.equal(xvideosred.lookupSource, 'torrent-index');
  assert.equal(xvideosred.studio, 'XVideosRED');
});
