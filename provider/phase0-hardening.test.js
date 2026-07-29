'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const axios = require('axios');

const mediaRelay = require('../media-relay');

mediaRelay.setPublicBase('https://onlyporn.example');

function tokenFromRelayUrl(value) {
  const parts = new URL(value).pathname.split('/').filter(Boolean);
  assert.equal(parts[0], 'media');
  return parts[1];
}

test('Phase 0 relay sessions default to eight hours for long playback', () => {
  assert.equal(mediaRelay._test.SESSION_TTL_MS, 8 * 60 * 60 * 1000);
  assert.equal(mediaRelay._test.MAX_SESSIONS, 8000);

  mediaRelay._test.entries.clear();
  const relayUrl = mediaRelay.register({
    url: 'https://hv-h.phncdn.com/hls/fixture/master.m3u8?h=root&e=9999999999&f=1',
    headers: {
      Referer: 'https://www.pornhub.com/view_video.php?viewkey=phase0fixture',
      Origin: 'https://www.pornhub.com',
    },
    provider: 'pornhub',
    kind: 'hls',
  });

  const token = tokenFromRelayUrl(relayUrl);
  const stored = mediaRelay._test.entries.store.get(token);
  assert.ok(stored);
  assert.ok(
    stored.expiresAt - Date.now() > 7 * 60 * 60 * 1000,
    'new playback session should retain more than seven hours of remaining life'
  );
});

test('a multi-hour VOD playlist creates one session instead of thousands of segment entries', () => {
  mediaRelay._test.entries.clear();
  const masterUrl =
    'https://hv-h.phncdn.com/hls/fixture/1080/master.m3u8?h=root&e=9999999999&f=1';
  const relayUrl = mediaRelay.register({
    url: masterUrl,
    headers: {
      Referer: 'https://www.pornhub.com/view_video.php?viewkey=phase0fixture',
      Origin: 'https://www.pornhub.com',
    },
    provider: 'pornhub',
    kind: 'hls',
  });
  const entry = mediaRelay._test.resolveRelayEntry(tokenFromRelayUrl(relayUrl));

  const lines = ['#EXTM3U', '#EXT-X-TARGETDURATION:6', '#EXT-X-PLAYLIST-TYPE:VOD'];
  for (let index = 1; index <= 2000; index += 1) {
    lines.push('#EXTINF:5.120,');
    lines.push(`seg-${index}-v1-a1.ts?h=signed&e=9999999999&f=1`);
  }
  lines.push('#EXT-X-ENDLIST');

  const rewritten = mediaRelay._test.rewritePlaylist(lines.join('\n'), masterUrl, entry);
  const relayLines = rewritten
    .split(/\r?\n/)
    .filter(line => line.startsWith('https://onlyporn.example/media/'));

  assert.equal(relayLines.length, 2000);
  assert.equal(
    mediaRelay._test.entries.size,
    1,
    'segment URLs must not consume one in-memory cache entry each'
  );

  const first = mediaRelay._test.resolveRelayEntry(tokenFromRelayUrl(relayLines[0]));
  const last = mediaRelay._test.resolveRelayEntry(tokenFromRelayUrl(relayLines.at(-1)));
  assert.equal(first.kind, 'segment');
  assert.match(first.url, /seg-1-v1-a1\.ts/);
  assert.equal(last.kind, 'segment');
  assert.match(last.url, /seg-2000-v1-a1\.ts/);
  assert.equal(first.sessionToken, entry.sessionToken);
  assert.equal(last.sessionToken, entry.sessionToken);
});

test('nested HLS playlists reuse the original playback session', () => {
  mediaRelay._test.entries.clear();
  const masterUrl =
    'https://hv-h.phncdn.com/hls/fixture/master.m3u8?h=root&e=9999999999&f=1';
  const relayUrl = mediaRelay.register({
    url: masterUrl,
    headers: { Referer: 'https://www.pornhub.com/view_video.php?viewkey=phase0fixture' },
    provider: 'pornhub',
    kind: 'hls',
  });
  const masterEntry = mediaRelay._test.resolveRelayEntry(tokenFromRelayUrl(relayUrl));

  const rewrittenMaster = mediaRelay._test.rewritePlaylist(
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4000000\n1080/index.m3u8?h=child&e=9999999999&f=1',
    masterUrl,
    masterEntry
  );
  const variantUrl = rewrittenMaster.split(/\r?\n/).at(-1);
  const variantEntry = mediaRelay._test.resolveRelayEntry(tokenFromRelayUrl(variantUrl));

  const rewrittenVariant = mediaRelay._test.rewritePlaylist(
    '#EXTM3U\n#EXTINF:5.120,\nseg-1.ts?h=segment&e=9999999999&f=1',
    variantEntry.url,
    variantEntry
  );
  const segmentUrl = rewrittenVariant.split(/\r?\n/).at(-1);
  const segmentEntry = mediaRelay._test.resolveRelayEntry(tokenFromRelayUrl(segmentUrl));

  assert.equal(variantEntry.kind, 'hls');
  assert.equal(segmentEntry.kind, 'segment');
  assert.equal(variantEntry.sessionToken, masterEntry.sessionToken);
  assert.equal(segmentEntry.sessionToken, masterEntry.sessionToken);
  assert.equal(mediaRelay._test.entries.size, 1);
});


test('HTTP relay resolves a signed child playlist token without a child cache entry', async () => {
  mediaRelay._test.entries.clear();
  const masterUrl =
    'https://hv-h.phncdn.com/hls/fixture/master.m3u8?h=root&e=9999999999&f=1';
  const relayUrl = mediaRelay.register({
    url: masterUrl,
    headers: { Referer: 'https://www.pornhub.com/view_video.php?viewkey=phase0fixture' },
    provider: 'pornhub',
    kind: 'hls',
  });
  const masterEntry = mediaRelay._test.resolveRelayEntry(tokenFromRelayUrl(relayUrl));
  const childRelayUrl = mediaRelay._test
    .rewritePlaylist(
      '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4000000\n1080/index.m3u8?h=child&e=9999999999&f=1',
      masterUrl,
      masterEntry
    )
    .split(/\r?\n/)
    .at(-1);
  const childToken = tokenFromRelayUrl(childRelayUrl);

  assert.equal(mediaRelay._test.entries.size, 1);
  assert.equal(mediaRelay._test.entries.get(childToken), undefined);

  const originalRequest = axios.request;
  axios.request = async options => {
    assert.match(options.url, /1080\/index\.m3u8/);
    return {
      status: 200,
      data: '#EXTM3U\n#EXTINF:5.120,\nseg-1.ts?h=segment&e=9999999999&f=1',
      headers: { 'content-type': 'application/vnd.apple.mpegurl' },
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
      { method: 'GET', params: { token: childToken }, headers: {} },
      response
    );
  } finally {
    axios.request = originalRequest;
  }

  assert.equal(response.statusCode, 200);
  assert.match(response.body, /https:\/\/onlyporn\.example\/media\/c1\./);
  assert.equal(mediaRelay._test.entries.size, 1);
});

test('tampered stateless child tokens are rejected', () => {
  mediaRelay._test.entries.clear();
  const relayUrl = mediaRelay.register({
    url: 'https://hv-h.phncdn.com/hls/fixture/master.m3u8?h=root&e=9999999999&f=1',
    provider: 'pornhub',
    kind: 'hls',
  });
  const entry = mediaRelay._test.resolveRelayEntry(tokenFromRelayUrl(relayUrl));
  const rewritten = mediaRelay._test.rewritePlaylist(
    '#EXTM3U\n#EXTINF:5.120,\nseg-1.ts?h=segment&e=9999999999&f=1',
    entry.url,
    entry
  );
  const childToken = tokenFromRelayUrl(rewritten.split(/\r?\n/).at(-1));
  const replacement = childToken.endsWith('A') ? 'B' : 'A';
  const tampered = `${childToken.slice(0, -1)}${replacement}`;

  assert.ok(mediaRelay._test.resolveRelayEntry(childToken));
  assert.equal(mediaRelay._test.resolveRelayEntry(tampered), undefined);
});

test('Phase 0 release version and test wiring are deterministic', () => {
  const pkg = require('../package.json');
  assert.equal(pkg.version, '2.6.1');
  assert.match(pkg.scripts['test:release'], /phase0-hardening\.test\.js/);
  assert.equal(pkg.scripts['test:phase0'], 'node --test provider/phase0-hardening.test.js');
});
