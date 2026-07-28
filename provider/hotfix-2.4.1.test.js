const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const axios = require('axios');

const mediaRelay = require('../media-relay');
const createEporner = require('./eporner');
const createXvideos = require('./xvideos');

mediaRelay.setPublicBase('https://onlyporn.example');

function tokenFromRelayUrl(value) {
  const parts = new URL(value).pathname.split('/').filter(Boolean);
  assert.equal(parts[0], 'media');
  return parts[1];
}

test('media relay accepts only approved Eporner and XVideos media hosts', () => {
  assert.doesNotThrow(() =>
    mediaRelay._test.validateTargetUrl(
      'https://hls-cdn77.xvideos-cdn.com/path/master.m3u8',
      'xvideos'
    )
  );
  assert.doesNotThrow(() =>
    mediaRelay._test.validateTargetUrl(
      'https://vid-s1-c50-fr-cdn.eporner.com/path/video.mp4',
      'eporner'
    )
  );
  assert.throws(
    () => mediaRelay._test.validateTargetUrl('https://127.0.0.1/video.mp4', 'eporner'),
    /not approved/
  );
  assert.throws(
    () => mediaRelay._test.validateTargetUrl('https://example.com/video.mp4', 'xvideos'),
    /not approved/
  );
});

test('HLS relay rewrites playlists, media segments, and key URIs to absolute relay URLs', () => {
  mediaRelay._test.entries.clear();
  const entry = {
    provider: 'xvideos',
    headers: {
      Referer: 'https://www.xvideos.com/video.fixture/test',
      Origin: 'https://www.xvideos.com',
    },
  };
  const original = [
    '#EXTM3U',
    '#EXT-X-KEY:METHOD=AES-128,URI="keys/key.bin"',
    '#EXT-X-MAP:URI="init/init.mp4"',
    '#EXTINF:6.0,',
    'segments/part-0001.ts',
    '#EXT-X-STREAM-INF:BANDWIDTH=1000000',
    '../720/index.m3u8',
  ].join('\n');

  const rewritten = mediaRelay._test.rewritePlaylist(
    original,
    'https://hls-cdn77.xvideos-cdn.com/path/variant/index.m3u8',
    entry
  );

  const relayUrls = rewritten.match(/https:\/\/onlyporn\.example\/media\/[A-Za-z0-9_-]+\/[^"\s,]+/g) || [];
  assert.equal(relayUrls.length, 4);
  assert.doesNotMatch(rewritten, /segments\/part-0001\.ts/);
  assert.doesNotMatch(rewritten, /\.\.\/720\/index\.m3u8/);

  const targets = relayUrls.map(url => {
    const stored = mediaRelay._test.entries.get(tokenFromRelayUrl(url));
    assert.ok(stored);
    assert.equal(stored.provider, 'xvideos');
    assert.equal(stored.headers.Referer, entry.headers.Referer);
    return stored.url;
  });

  assert.deepEqual(targets, [
    'https://hls-cdn77.xvideos-cdn.com/path/variant/keys/key.bin',
    'https://hls-cdn77.xvideos-cdn.com/path/variant/init/init.mp4',
    'https://hls-cdn77.xvideos-cdn.com/path/variant/segments/part-0001.ts',
    'https://hls-cdn77.xvideos-cdn.com/path/720/index.m3u8',
  ]);
});

test('HLS relay converts partial text/plain upstream playlists into web-ready 200 responses', async () => {
  mediaRelay._test.entries.clear();
  const relayUrl = mediaRelay.register({
    url: 'https://hls-cdn77.xvideos-cdn.com/path/720/index.m3u8',
    headers: { Referer: 'https://www.xvideos.com/video.fixture/test' },
    provider: 'xvideos',
    kind: 'hls',
  });
  const token = tokenFromRelayUrl(relayUrl);
  const originalRequest = axios.request;
  let forwardedRange = null;
  axios.request = async options => {
    forwardedRange = options.headers.Range;
    return {
      status: 206,
      data: '#EXTM3U\n#EXTINF:6.0,\nsegments/part-0001.ts',
      headers: { 'content-type': 'text/plain' },
    };
  };

  const response = {
    headers: {},
    statusCode: 200,
    body: '',
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(value) { this.statusCode = value; return this; },
    type(value) { this.setHeader('content-type', value); return this; },
    send(value) { this.body = String(value); return this; },
    end(value = '') { this.body += String(value); },
  };

  try {
    await mediaRelay.handleRequest(
      { method: 'GET', params: { token }, headers: { range: 'bytes=0-' } },
      response
    );
  } finally {
    axios.request = originalRequest;
  }

  assert.equal(forwardedRange, undefined, 'playlist Range must not be forwarded upstream');
  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type'], /application\/vnd\.apple\.mpegurl/);
  assert.match(response.body, /https:\/\/onlyporn\.example\/media\//);
  assert.doesNotMatch(response.body, /segments\/part-0001\.ts/);
});

test('Eporner streams are relayed by OnlyPorn so signed media stays on the Render egress IP', async () => {
  mediaRelay._test.entries.clear();
  const provider = createEporner();
  provider.jar.getCookieString = async () => 'session=fixture-cookie';
  const page = 'https://www.eporner.com/video-fixture/test/';
  const response = await provider.selectSources(
    {
      mp4: {
        av1: {
          src: 'https://vid-cdn.eporner.com/videos/fixture-1080p-av1.mp4',
          labelShort: '1080p',
          codec: 'av1',
        },
        h264: {
          src: 'https://vid-cdn.eporner.com/videos/fixture-1080p-h264.mp4',
          labelShort: '1080p',
          codec: 'h264',
        },
      },
    },
    page
  );

  assert.equal(response.streams.length, 1);
  assert.match(response.streams[0].url, /^https:\/\/onlyporn\.example\/media\//);
  assert.equal(response.streams[0].behaviorHints.notWebReady, false);
  const stored = mediaRelay._test.entries.get(tokenFromRelayUrl(response.streams[0].url));
  assert.match(stored.url, /h264/);
  assert.equal(stored.provider, 'eporner');
  assert.equal(stored.headers.Referer, page);
  assert.equal(stored.headers.Cookie, 'session=fixture-cookie');
});

test('XVideos source routes HLS variants through the internal relay', () => {
  const source = fs.readFileSync(path.join(__dirname, 'xvideos.js'), 'utf8');
  const processStreams = source.slice(source.indexOf('async processStreams'));
  assert.match(processStreams, /mediaRelay\.register\(\{/);
  assert.match(processStreams, /kind:\s*'hls'/);
  assert.match(processStreams, /behaviorHints:\s*\{\s*notWebReady:\s*false\s*\}/);
  assert.doesNotMatch(processStreams, /proxyHeaders:\s*\{\s*request:\s*requestHeaders/);
});

test('server registers the media relay before the Stremio addon router', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server-sdk', 'index.js'), 'utf8');
  assert.match(source, /app\.all\('\/media\/:token\/:filename\?'/);
  assert.ok(source.indexOf("app.all('/media/:token/:filename?'") < source.indexOf('app.use(router)'));
});
