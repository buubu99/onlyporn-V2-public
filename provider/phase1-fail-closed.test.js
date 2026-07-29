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

function responseCapture() {
  return {
    headers: {},
    statusCode: 200,
    body: '',
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(value) { this.statusCode = value; return this; },
    type(value) { this.setHeader('content-type', value); return this; },
    send(value) { this.body = String(value); return this; },
    end(value = '') { this.body += String(value); },
  };
}

test('Hardening Phase 1 rewrites an approved HLS child through the protected relay', () => {
  mediaRelay._test.entries.clear();
  const parentUrl = 'https://hv-h.phncdn.com/hls/fixture/master.m3u8?h=root';
  const relayUrl = mediaRelay.register({
    url: parentUrl,
    headers: {
      Referer: 'https://www.pornhub.com/view_video.php?viewkey=phase1fixture',
      Origin: 'https://www.pornhub.com',
    },
    provider: 'pornhub',
    kind: 'hls',
  });
  const entry = mediaRelay._test.resolveRelayEntry(tokenFromRelayUrl(relayUrl));
  const rewritten = mediaRelay._test.rewritePlaylist(
    '#EXTM3U\n#EXTINF:6.0,\nsegments/part-0001.ts?h=signed',
    parentUrl,
    entry
  );

  assert.match(rewritten, /^#EXTM3U\n#EXTINF:6\.0,\nhttps:\/\/onlyporn\.example\/media\/c1\./);
  assert.doesNotMatch(rewritten, /hv-h\.phncdn\.com\/hls\/fixture\/segments/);
  assert.equal(mediaRelay._test.entries.size, 1, 'Phase 0 one-session behavior must remain active');
});

test('an unapproved bare HLS child fails closed instead of returning its raw URL', () => {
  mediaRelay._test.entries.clear();
  const entry = {
    provider: 'pornhub',
    headers: { Referer: 'https://www.pornhub.com/view_video.php?viewkey=phase1fixture' },
  };
  const hostile = 'https://attacker.example/segment.ts?secret=must-not-leak';

  assert.throws(
    () => mediaRelay._test.rewritePlaylist(
      `#EXTM3U\n#EXTINF:6.0,\n${hostile}`,
      'https://hv-h.phncdn.com/hls/fixture/index.m3u8',
      entry
    ),
    error => {
      assert.equal(error.code, mediaRelay._test.PLAYLIST_CHILD_ERROR_CODE);
      assert.equal(error.name, 'PlaylistChildRelayError');
      return true;
    }
  );
});

test('an unapproved URI attribute fails closed instead of being copied upstream', () => {
  const entry = {
    provider: 'xvideos',
    headers: { Referer: 'https://www.xvideos.com/video.fixture/test' },
  };

  assert.throws(
    () => mediaRelay._test.rewritePlaylist(
      '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://keys.attacker.example/key.bin"\n#EXTINF:6.0,\npart.ts',
      'https://hls-cdn77.xvideos-cdn.com/path/index.m3u8',
      entry
    ),
    error => error?.code === mediaRelay._test.PLAYLIST_CHILD_ERROR_CODE
  );
});

test('unsupported non-HTTPS child URLs fail closed', () => {
  const entry = { provider: 'javhdporn', headers: {} };
  assert.throws(
    () => mediaRelay._test.rewritePlaylist(
      '#EXTM3U\n#EXTINF:4.0,\nhttp://akamai-cache-p01.vdcdn.xyz/hls/seg0.webp',
      'https://akamai-cache-p01.vdcdn.xyz/hls/index.m3u8',
      entry
    ),
    error => error?.code === mediaRelay._test.PLAYLIST_CHILD_ERROR_CODE
  );
});

test('HTTP relay returns controlled 502 and never exposes the rejected child URL', async () => {
  mediaRelay._test.entries.clear();
  const relayUrl = mediaRelay.register({
    url: 'https://hv-h.phncdn.com/hls/fixture/master.m3u8?h=root',
    headers: { Referer: 'https://www.pornhub.com/view_video.php?viewkey=phase1fixture' },
    provider: 'pornhub',
    kind: 'hls',
  });
  const token = tokenFromRelayUrl(relayUrl);
  const hostile = 'https://attacker.example/segment.ts?secret=must-not-leak';
  const originalRequest = axios.request;
  axios.request = async () => ({
    status: 200,
    data: `#EXTM3U\n#EXTINF:6.0,\n${hostile}`,
    headers: { 'content-type': 'application/vnd.apple.mpegurl' },
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

  assert.equal(response.statusCode, 502);
  assert.equal(
    response.headers['x-onlyporn-relay-error'],
    mediaRelay._test.PLAYLIST_CHILD_ERROR_CODE
  );
  assert.equal(response.body, 'HLS playlist could not be relayed safely');
  assert.doesNotMatch(response.body, /attacker\.example|must-not-leak/);
});

test('JAVHDPorn custom token lines remain untouched under fail-closed rewriting', () => {
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
  const rewritten = mediaRelay._test.rewritePlaylist(
    [
      '#EXTM3U',
      '#EXT-X-TOKEN=fixture-token-must-remain',
      '#EXTINF:4.0,',
      'seg0.webp',
    ].join('\n'),
    'https://akamai-cache-p01.vdcdn.xyz/hls4/a/b/360p/index.m3u8',
    entry
  );

  assert.match(rewritten, /#EXT-X-TOKEN=fixture-token-must-remain/);
  assert.match(rewritten, /https:\/\/onlyporn\.example\/media\/c1\./);
  assert.doesNotMatch(rewritten, /\nseg0\.webp(?:\n|$)/);
});

test('Hardening Phase 1 release wiring is deterministic and preserves prior repairs', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const relay = fs.readFileSync(path.join(ROOT, 'media-relay.js'), 'utf8');

  assert.equal(pkg.version, '2.7.0-alpha.1');
  assert.equal(pkg.scripts['test:hardening1'], 'node --test provider/phase1-fail-closed.test.js');
  assert.match(pkg.scripts['test:release'], /phase1-fail-closed\.test\.js/);
  assert.match(pkg.scripts['test:release'], /phase0-hardening\.test\.js/);
  assert.match(pkg.scripts['test:release'], /hotfix-2\.6\.2\.test\.js/);
  assert.match(relay, /PLAYLIST_CHILD_ERROR_CODE = 'HLS_CHILD_REJECTED'/);
  assert.doesNotMatch(relay, /catch\s*\{\s*return resolved;\s*\}/);
  assert.match(relay, /const SESSION_TTL_MS = 8 \* 60 \* 60 \* 1000/);
  assert.match(relay, /'vdcdn\.xyz'/);
});
