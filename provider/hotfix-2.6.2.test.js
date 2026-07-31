'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const axios = require('axios');

const mediaRelay = require('../media-relay');

const ROOT = path.resolve(__dirname, '..');
mediaRelay.setPublicBase('https://onlyporn.example');

function tokenFromRelayUrl(value) {
  const parts = new URL(value).pathname.split('/').filter(Boolean);
  assert.equal(parts[0], 'media');
  return parts[1];
}

function transportStream(packetCount = 4) {
  const transport = Buffer.alloc(188 * packetCount, 0xff);
  for (let offset = 0; offset < transport.length; offset += 188) {
    transport[offset] = 0x47;
  }
  return transport;
}

function pngWrappedTransportStream70(packetCount = 4) {
  const signature = Buffer.from('89504e470d0a1a0a', 'hex');
  const ihdr = Buffer.concat([
    Buffer.from([0, 0, 0, 13]),
    Buffer.from('IHDR'),
    Buffer.alloc(13),
    Buffer.alloc(4),
  ]);
  const filler = Buffer.concat([
    Buffer.from([0, 0, 0, 13]),
    Buffer.from('tEXt'),
    Buffer.alloc(13),
    Buffer.alloc(4),
  ]);
  const iend = Buffer.concat([
    Buffer.alloc(4),
    Buffer.from('IEND'),
    Buffer.alloc(4),
  ]);
  const transport = transportStream(packetCount);
  const wrapped = Buffer.concat([signature, ihdr, filler, iend, transport]);
  assert.equal(wrapped.length - transport.length, 70);
  return { transport, wrapped };
}

function responseCapture() {
  return {
    headers: {},
    statusCode: 200,
    body: Buffer.alloc(0),
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(value) { this.statusCode = value; return this; },
    type(value) { this.setHeader('content-type', value); return this; },
    send(value) { this.body = Buffer.from(String(value)); return this; },
    end(value = '') { this.body = Buffer.isBuffer(value) ? value : Buffer.from(String(value)); },
  };
}

test('JAVHDPorn accepts vdcdn only inside its own protected media profile', () => {
  for (const url of [
    'https://vdcdn.xyz/hls4/token/master.m3u8',
    'https://akamai-cache-p01.vdcdn.xyz/hls4/token/master.m3u8',
  ]) {
    assert.doesNotThrow(() => mediaRelay._test.validateTargetUrl(url, 'javhdporn'));
  }

  for (const url of [
    'https://evilvdcdn.xyz/hls/master.m3u8',
    'https://vdcdn.xyz.evil.example/hls/master.m3u8',
    'https://random.xyz/hls/master.m3u8',
  ]) {
    assert.throws(
      () => mediaRelay._test.validateTargetUrl(url, 'javhdporn'),
      /not approved/
    );
  }

  assert.throws(
    () => mediaRelay._test.validateTargetUrl(
      'https://akamai-cache-p01.vdcdn.xyz/hls4/token/master.m3u8',
      'xvideos'
    ),
    /not approved/
  );
});

test('vdcdn master rewriting preserves custom token lines and relays image-named segments', () => {
  mediaRelay._test.entries.clear();
  const entry = {
    provider: 'javhdporn',
    headers: {
      Cookie: 'fixture=1',
      Origin: 'https://video.javhdporn.net',
      Referer: 'https://video.javhdporn.net/p/fixture?t=token',
      'User-Agent': 'fixture-agent',
    },
  };
  const playlist = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TOKEN=fixture-token-must-remain',
    '#EXTINF:4.000000,',
    'seg0.webp',
    '#EXT-X-ENDLIST',
  ].join('\n');
  const base = 'https://akamai-cache-p01.vdcdn.xyz/hls4/a/b/360p/index.m3u8';
  const rewritten = mediaRelay._test.rewritePlaylist(playlist, base, entry);

  assert.match(rewritten, /#EXT-X-TOKEN=fixture-token-must-remain/);
  const relayUrl = rewritten.split('\n').find(line => line.startsWith('https://onlyporn.example/media/'));
  assert.ok(relayUrl);
  const stored = mediaRelay._test.resolveRelayEntry(tokenFromRelayUrl(relayUrl));
  assert.equal(stored.provider, 'javhdporn');
  assert.equal(stored.kind, 'segment');
  assert.equal(stored.url, 'https://akamai-cache-p01.vdcdn.xyz/hls4/a/b/360p/seg0.webp');
  assert.equal(stored.headers.Cookie, 'fixture=1');
  assert.equal(stored.headers.Origin, 'https://video.javhdporn.net');
  assert.match(stored.headers.Referer, /video\.javhdporn\.net\/p\/fixture/);
  assert.equal(mediaRelay._test.entries.size, 1, 'segment child token must reuse one session');
});

test('raw MPEG-TS disguised as image/webp remains byte-identical', () => {
  const transport = transportStream();
  const normalized = mediaRelay._test.normalizeJavTransportSegment(transport);
  assert.ok(normalized);
  assert.equal(normalized.wrapperBytes, 0);
  assert.equal(normalized.payload, transport);
  assert.deepEqual(normalized.payload, transport);
});

test('the existing 70-byte PNG wrapper is still removed exactly', () => {
  const { transport, wrapped } = pngWrappedTransportStream70();
  const normalized = mediaRelay._test.normalizeJavTransportSegment(wrapped);
  assert.ok(normalized);
  assert.equal(normalized.wrapperBytes, 70);
  assert.deepEqual(normalized.payload, transport);
});

test('vdcdn image/webp handler returns video/mp2t without altering raw TS', async () => {
  mediaRelay._test.entries.clear();
  const relayUrl = mediaRelay.register({
    url: 'https://akamai-cache-p01.vdcdn.xyz/hls4/a/b/360p/seg0.webp',
    headers: {
      Cookie: 'fixture=1',
      Origin: 'https://video.javhdporn.net',
      Referer: 'https://video.javhdporn.net/p/fixture?t=token',
      'User-Agent': 'fixture-agent',
    },
    provider: 'javhdporn',
    kind: 'segment',
  });
  const token = tokenFromRelayUrl(relayUrl);
  const transport = transportStream();
  const originalRequest = axios.request;
  axios.request = async options => {
    assert.equal(options.responseType, 'arraybuffer');
    assert.equal(options.headers.Cookie, 'fixture=1');
    assert.equal(options.headers.Origin, 'https://video.javhdporn.net');
    assert.match(options.headers.Referer, /video\.javhdporn\.net\/p\/fixture/);
    return {
      status: 200,
      data: transport,
      headers: {
        'content-type': 'image/webp',
        'content-length': String(transport.length),
      },
    };
  };

  const response = responseCapture();
  try {
    await mediaRelay.handleRequest(
      { method: 'GET', params: { token }, headers: {} },
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

test('TikTok PNG-wrapped segment behavior remains intact', async () => {
  mediaRelay._test.entries.clear();
  const relayUrl = mediaRelay.register({
    url: 'https://p16-ad-site-sign-sg.tiktokcdn.com/path/segment.image',
    headers: { Referer: 'https://streamhls.click/hls/token/360p/index.m3u8' },
    provider: 'javhdporn',
    kind: 'segment',
  });
  const token = tokenFromRelayUrl(relayUrl);
  const { transport, wrapped } = pngWrappedTransportStream70();
  const originalRequest = axios.request;
  axios.request = async () => ({
    status: 200,
    data: wrapped,
    headers: { 'content-type': 'image/png' },
  });

  const response = responseCapture();
  try {
    await mediaRelay.handleRequest(
      { method: 'GET', params: { token }, headers: {} },
      response
    );
  } finally {
    axios.request = originalRequest;
  }

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-type'], 'video/mp2t');
  assert.deepEqual(response.body, transport);
});

test('OnlyPorn 2.6.2 wires the isolated vdcdn hotfix into release validation', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const relay = fs.readFileSync(path.join(ROOT, 'media-relay.js'), 'utf8');
  assert.equal(pkg.version, '2.7.0-alpha.21');
  assert.match(pkg.scripts['test:hotfix262'], /hotfix-2\.6\.2\.test\.js/);
  assert.match(pkg.scripts['test:release'], /hotfix-2\.6\.2\.test\.js/);
  assert.match(relay, /'vdcdn\.xyz'/);
  assert.match(relay, /JAVHDPorn image-labelled MPEG-TS segment normalized/);
  assert.equal(relay.includes('const SESSION_TTL_MS = 8 * 60 * 60 * 1000;'), true);
  assert.match(pkg.scripts['test:release'], /phase0-hardening\.test\.js/);
});
