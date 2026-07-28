const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const axios = require('axios');

const mediaRelay = require('../media-relay');
const createXnxx = require('./xnxx');

mediaRelay.setPublicBase('https://onlyporn.example');

function tokenFromRelayUrl(value) {
  const parts = new URL(value).pathname.split('/').filter(Boolean);
  assert.equal(parts[0], 'media');
  return parts[1];
}

test('XNXX canonical candidates repair THUMBNUM routes with frame zero first', () => {
  const raw =
    'https://www.xnxx.com/video-1i5j872c/51067600/THUMBNUM/girlsrimming_-_rebecca_s_naughty_surprise';
  const candidates = createXnxx._test.xnxxPageCandidates(raw);
  assert.ok(candidates.length >= 3);
  assert.equal(
    candidates[0],
    'https://www.xnxx.com/video-1i5j872c/51067600/0/girlsrimming_-_rebecca_s_naughty_surprise'
  );
  assert.ok(candidates.every(url => !/THUMBNUM/i.test(url)));
});

test('XNXX catalog source accepts absolute same-origin links and preserves repair context', () => {
  const source = fs.readFileSync(path.join(__dirname, 'xnxx.js'), 'utf8');
  const catalogSource = source.slice(
    source.indexOf('getCatalogMetas(html)'),
    source.indexOf('async getMetadata')
  );
  assert.match(catalogSource, /new URL\(href, this\.baseUrl\)/);
  assert.match(catalogSource, /this\.allowedPageHosts\.has/);
  assert.match(catalogSource, /normalizeXnxxPageUrl\(rawId/);
  assert.match(catalogSource, /THUMBNUM/);
});

test('XNXX retries repaired candidates rather than requesting the literal template', async () => {
  const provider = createXnxx();
  const raw =
    'https://www.xnxx.com/video-1i5j872c/51067600/THUMBNUM/fixture_title';
  const attempted = [];
  const original = Object.getPrototypeOf(Object.getPrototypeOf(provider)).fetchHtml;
  let calls = 0;
  Object.getPrototypeOf(Object.getPrototypeOf(provider)).fetchHtml = async function(url) {
    attempted.push(url);
    calls += 1;
    if (calls === 1) {
      const error = new Error('HTTP 404');
      error.response = { status: 404 };
      throw error;
    }
    return '<html><script>html5player.setVideoHLS("https://hls-cdn77.xnxx-cdn.com/path/master.m3u8")</script></html>';
  };

  try {
    const html = await provider.fetchHtml(raw);
    assert.match(html, /setVideoHLS/);
    assert.equal(attempted.length, 2);
    assert.ok(attempted.every(url => !/THUMBNUM/i.test(url)));
  } finally {
    Object.getPrototypeOf(Object.getPrototypeOf(provider)).fetchHtml = original;
  }
});

test('media relay allows XNXX page, playlist, and segment hosts', () => {
  assert.doesNotThrow(() =>
    mediaRelay._test.validateTargetUrl(
      'https://hls-cdn77.xnxx-cdn.com/path/master.m3u8',
      'xnxx'
    )
  );
  assert.doesNotThrow(() =>
    mediaRelay._test.validateTargetUrl(
      'https://www.xnxx.com/video-fixture/test',
      'xnxx'
    )
  );
  assert.throws(
    () => mediaRelay._test.validateTargetUrl('https://example.com/video.mp4', 'xnxx'),
    /not approved/
  );
});

test('XNXX source routes direct MP4 and HLS variants through the OnlyPorn relay', () => {
  const source = fs.readFileSync(path.join(__dirname, 'xnxx.js'), 'utf8');
  const parseVideoPage = source.slice(source.indexOf('parseVideoPage'), source.indexOf('async processStreams'));
  const processStreams = source.slice(source.indexOf('async processStreams'));
  assert.match(parseVideoPage, /provider:\s*this\.name/);
  assert.match(parseVideoPage, /kind:\s*'mp4'/);
  assert.match(processStreams, /mediaRelay\.register\(\{/);
  assert.match(processStreams, /kind:\s*'hls'/);
  assert.match(processStreams, /behaviorHints:\s*\{\s*notWebReady:\s*false\s*\}/);
});

test('XNXX HLS relay converts partial text/plain playlists into web-ready responses', async () => {
  mediaRelay._test.entries.clear();
  const relayUrl = mediaRelay.register({
    url: 'https://hls-cdn77.xnxx-cdn.com/path/480/index.m3u8',
    headers: { Referer: 'https://www.xnxx.com/video-fixture/test' },
    provider: 'xnxx',
    kind: 'hls',
  });
  const token = tokenFromRelayUrl(relayUrl);
  const originalRequest = axios.request;
  axios.request = async () => ({
    status: 206,
    data: '#EXTM3U\n#EXTINF:6.0,\nsegments/part-0001.ts',
    headers: { 'content-type': 'text/plain' },
  });

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

  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type'], /application\/vnd\.apple\.mpegurl/);
  assert.match(response.body, /https:\/\/onlyporn\.example\/media\//);
  assert.doesNotMatch(response.body, /segments\/part-0001\.ts/);
});
