const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const axios = require('axios');

const mediaRelay = require('../media-relay');
const createJavHdPorn = require('./javhdporn');
const {
  captureJwPlayerSources,
  getPlayerConfigMetadata,
  isJavPlayerHost,
} = require('./javhdporn-jw-config');

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
mediaRelay.setPublicBase('https://onlyporn.example');

function tokenFromRelayUrl(value) {
  const parts = new URL(value).pathname.split('/').filter(Boolean);
  assert.equal(parts[0], 'media');
  return parts[1];
}

function pngWrappedTransportStream(packetCount = 3) {
  const signature = Buffer.from('89504e470d0a1a0a', 'hex');
  const ihdr = Buffer.concat([
    Buffer.from([0, 0, 0, 13]),
    Buffer.from('IHDR'),
    Buffer.alloc(13),
    Buffer.alloc(4),
  ]);
  const iend = Buffer.concat([
    Buffer.alloc(4),
    Buffer.from('IEND'),
    Buffer.alloc(4),
  ]);
  const transport = Buffer.alloc(188 * packetCount, 0xff);
  for (let offset = 0; offset < transport.length; offset += 188) {
    transport[offset] = 0x47;
  }
  return {
    transport,
    wrapped: Buffer.concat([signature, ihdr, iend, transport]),
  };
}

test('SpankBang and JAVHDPorn use completely separate Safari helpers', () => {
  const spankHelper = fs.readFileSync(
    path.join(ROOT, 'scripts', 'safari_fetch_helper.py'),
    'utf8'
  );
  const javHelper = fs.readFileSync(
    path.join(ROOT, 'scripts', 'javhdporn_safari_fetch_helper.py'),
    'utf8'
  );

  assert.match(spankHelper, /Persistent curl_cffi Safari transport for SpankBang/);
  assert.match(spankHelper, /ensure_bootstrap\(timeout_seconds\)/);
  assert.doesNotMatch(spankHelper, /javhdporn/i);
  assert.match(javHelper, /Persistent curl_cffi Safari transport dedicated to JAV HD Porn/);
  assert.match(javHelper, /video\\d\*\\.javhdporn/);
  assert.doesNotMatch(javHelper, /spankbang/i);
});

test('JAVHDPorn accepts numbered player hosts but rejects lookalike domains', () => {
  assert.equal(isJavPlayerHost('video.javhdporn.net'), true);
  assert.equal(isJavPlayerHost('video1.javhdporn.net'), true);
  assert.equal(isJavPlayerHost('video25.javhdporn.net'), true);
  assert.equal(isJavPlayerHost('video1.javhdporn.net.example.com'), false);
  assert.equal(isJavPlayerHost('cdn.javhdporn.net'), false);
});

test('JAVHDPorn locates encrypted config and player main.js on dynamic hosts', () => {
  const metadata = getPlayerConfigMetadata(
    '<div id="jwplayer" data-config="encrypted"></div><script src="/main.js?ver=0.16.2"></script>',
    'https://video1.javhdporn.net/p/fixture'
  );
  assert.equal(metadata.encryptedConfig, 'encrypted');
  assert.equal(
    metadata.mainScriptUrl,
    'https://video1.javhdporn.net/main.js?ver=0.16.2'
  );
});

test('isolated JWPlayer decoder captures only playable HLS and MP4 sources', async () => {
  const config = {
    advertising: {
      schedule: {
        pre: { tag: 'https://ads.example/preroll' },
      },
    },
    sources: [
      { file: 'https://streamhls.click/hls/token/master.m3u8', type: 'hls', label: 'auto' },
      { file: 'https://cdn.example/video.mp4', type: 'mp4', label: '1080p' },
    ],
    image: 'https://images.example/poster.jpg',
    tracks: [{ file: 'https://images.example/slides.jpg' }],
  };
  const encoded = Buffer.from(JSON.stringify(config), 'utf8').toString('base64');
  const html = `<div id="jwplayer" data-config="${encoded}"></div>`;
  const script = `document.addEventListener('DOMContentLoaded',()=>{const raw=document.querySelector('#jwplayer').getAttribute('data-config');jwplayer('jwplayer').setup(JSON.parse(atob(raw)));});`;

  const captured = await captureJwPlayerSources({
    html,
    script,
    playerUrl: 'https://video1.javhdporn.net/p/fixture',
  });

  assert.deepEqual(captured.sources, [
    {
      url: 'https://streamhls.click/hls/token/master.m3u8',
      type: 'hls',
      label: 'auto',
    },
    {
      url: 'https://cdn.example/video.mp4',
      type: 'mp4',
      label: '1080p',
    },
  ]);
});

test('JAVHDPorn provider decodes a numbered player page into a fresh HLS candidate', async () => {
  const provider = createJavHdPorn();
  const config = {
    sources: [
      { file: 'https://streamhls.click/hls/fresh/master.m3u8', type: 'hls', label: 'auto' },
    ],
  };
  const encoded = Buffer.from(JSON.stringify(config), 'utf8').toString('base64');
  const html = `<div id="jwplayer" data-config="${encoded}"></div><script src="/main.js?ver=fixture"></script>`;
  const script = `const raw=document.querySelector('#jwplayer').getAttribute('data-config');jwplayer('jwplayer').setup(JSON.parse(atob(raw)));`;
  provider.fetchSafariResponse = async url => ({
    data: url.includes('/main.js') ? script : html,
    status: 200,
    headers: {},
    finalUrl: url,
  });

  const candidates = await provider.encryptedJwPlayerCandidates(
    html,
    'https://video1.javhdporn.net/p/fixture'
  );
  assert.deepEqual(candidates, [
    {
      url: 'https://streamhls.click/hls/fresh/master.m3u8',
      context: 'auto',
    },
  ]);
  assert.equal(provider.allowedPageHosts.has('video1.javhdporn.net'), true);
});

test('JAVHDPorn relay allows streamhls and TikTok CDN only within its provider profile', () => {
  assert.doesNotThrow(() =>
    mediaRelay._test.validateTargetUrl(
      'https://streamhls.click/hls/token/master.m3u8',
      'javhdporn'
    )
  );
  assert.doesNotThrow(() =>
    mediaRelay._test.validateTargetUrl(
      'https://p16-ad-site-sign-sg.tiktokcdn.com/path/segment.image',
      'javhdporn'
    )
  );
  assert.throws(
    () => mediaRelay._test.validateTargetUrl(
      'https://p16-ad-site-sign-sg.tiktokcdn.com/path/segment.image',
      'xvideos'
    ),
    /not approved/
  );
});

test('JAVHDPorn HLS rewrite marks image-named EXTINF objects as media segments', () => {
  mediaRelay._test.entries.clear();
  const entry = {
    provider: 'javhdporn',
    headers: { Referer: 'https://video1.javhdporn.net/p/fixture' },
  };
  const rewritten = mediaRelay._test.rewritePlaylist(
    '#EXTM3U\n#EXTINF:10.010,\nhttps://p16-ad-site-sign-sg.tiktokcdn.com/path/segment.image',
    'https://streamhls.click/hls/token/1080/index.m3u8',
    entry
  );
  const relayUrl = rewritten.split('\n').at(-1);
  const stored = mediaRelay._test.entries.get(tokenFromRelayUrl(relayUrl));
  assert.equal(stored.provider, 'javhdporn');
  assert.equal(stored.kind, 'segment');
  assert.match(stored.url, /tiktokcdn\.com/);
});

test('JAVHDPorn relay removes the PNG wrapper and exposes aligned MPEG-TS packets', () => {
  const { transport, wrapped } = pngWrappedTransportStream();
  const payload = mediaRelay._test.stripPngWrappedTsBuffer(wrapped);
  assert.ok(payload);
  assert.deepEqual(payload, transport);
  assert.equal(payload[0], 0x47);
  assert.equal(payload[188], 0x47);
  assert.equal(payload[376], 0x47);
});

test('JAVHDPorn wrapped segment handler returns video/mp2t instead of image/png', async () => {
  mediaRelay._test.entries.clear();
  const relayUrl = mediaRelay.register({
    url: 'https://p16-ad-site-sign-sg.tiktokcdn.com/path/segment.image',
    headers: { Referer: 'https://streamhls.click/hls/token/1080/index.m3u8' },
    provider: 'javhdporn',
    kind: 'segment',
  });
  const token = tokenFromRelayUrl(relayUrl);
  const { transport, wrapped } = pngWrappedTransportStream();
  const originalRequest = axios.request;
  axios.request = async options => {
    assert.equal(options.responseType, 'arraybuffer');
    assert.equal(options.headers.Range, undefined);
    return {
      status: 200,
      data: wrapped,
      headers: {
        'content-type': 'image/png',
        'content-length': String(wrapped.length),
      },
    };
  };

  const response = {
    headers: {},
    statusCode: 200,
    body: Buffer.alloc(0),
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(value) { this.statusCode = value; return this; },
    type(value) { this.setHeader('content-type', value); return this; },
    send(value) { this.body = Buffer.from(String(value)); return this; },
    end(value = '') { this.body = Buffer.isBuffer(value) ? value : Buffer.from(String(value)); },
  };

  try {
    await mediaRelay.handleRequest(
      { method: 'GET', params: { token }, headers: { range: 'bytes=0-' } },
      response
    );
  } finally {
    axios.request = originalRequest;
  }

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-type'], 'video/mp2t');
  assert.equal(response.headers['content-length'], transport.length);
  assert.deepEqual(response.body, transport);
});

test('OnlyPorn retains the v2.5.2 relay behavior in v2.5.3', () => {
  const packageInfo = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')
  );
  assert.ok(
    versionAtLeast(packageInfo.version, '2.5.4'),
    `Expected version 2.5.4 or newer, detected ${packageInfo.version}`,
  );
  assert.equal(packageInfo.dependencies.jsdom, '22.1.0');
  assert.equal(packageInfo.dependencies.jquery, '3.7.1');
  assert.match(packageInfo.scripts['test:release'], /hotfix-2\.5\.2\.test\.js/);
});
