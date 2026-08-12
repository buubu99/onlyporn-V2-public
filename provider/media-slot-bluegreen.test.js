const test = require('node:test');
const assert = require('node:assert/strict');

const mediaRelay = require('../media-relay');

test.afterEach(() => {
  delete process.env.ONLYPORN_MEDIA_GENERATION;
  delete process.env.ONLYPORN_MEDIA_SLOT;
});

test('default media URL remains legacy /media/<token> for backward compatibility', () => {
  process.env.ADDON_BASE_URL = 'https://onlyporn.example';
  delete process.env.ONLYPORN_MEDIA_SLOT;

  const url = mediaRelay.register({
    url: 'https://cdn.phncdn.com/master.m3u8',
    headers: { Referer: 'https://www.pornhub.com/view_video.php?viewkey=fixture' },
    provider: 'pornhub',
    kind: 'hls',
  });

  const path = new URL(url).pathname;
  assert.match(path, /^\/media\/[^/]+\/index\.m3u8$/);
  assert.doesNotMatch(path, /^\/media\/(?:blue|green)\//);
});

test('green media URL includes /media/green and child tokens keep same slot prefix', () => {
  process.env.ADDON_BASE_URL = 'https://onlyporn.example';
  process.env.ONLYPORN_MEDIA_SLOT = 'green';

  const url = mediaRelay.register({
    url: 'https://cdn.phncdn.com/master.m3u8',
    headers: { Referer: 'https://www.pornhub.com/view_video.php?viewkey=fixture' },
    provider: 'pornhub',
    kind: 'hls',
  });

  const path = new URL(url).pathname;
  assert.match(path, /^\/media\/green\/[^/]+\/index\.m3u8$/);

  const token = path.split('/')[3];
  const entry = mediaRelay._test.entries.get(token);
  assert.ok(entry);
  assert.equal(entry.provider, 'pornhub');
  assert.equal(
    entry.headers.Referer,
    'https://www.pornhub.com/view_video.php?viewkey=fixture'
  );

  const child = mediaRelay._test.relayChild(
    entry,
    'https://cdn.phncdn.com/master.m3u8',
    'segment01.ts',
    'segment'
  );
  assert.match(new URL(child).pathname, /^\/media\/green\/c1\.[^/]+\/segment\.bin$/);
});

test('immutable generation media URL and every HLS child keep the same commit prefix', () => {
  process.env.ADDON_BASE_URL = 'https://onlyporn.example';
  process.env.ONLYPORN_MEDIA_GENERATION = '905c6397';
  process.env.ONLYPORN_MEDIA_SLOT = 'blue';

  const url = mediaRelay.register({
    url: 'https://cdn.phncdn.com/master.m3u8',
    headers: { Referer: 'https://www.pornhub.com/view_video.php?viewkey=fixture' },
    provider: 'pornhub',
    kind: 'hls',
  });

  const path = new URL(url).pathname;
  assert.match(path, /^\/media\/g-905c6397\/[^/]+\/index\.m3u8$/);

  const token = path.split('/')[3];
  const entry = mediaRelay._test.entries.get(token);
  assert.ok(entry);

  const playlist = mediaRelay._test.rewritePlaylist([
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=1280000',
    'child.m3u8',
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
    '#EXTINF:6,',
    'segment01.ts',
  ].join('\n'), 'https://cdn.phncdn.com/master.m3u8', entry);

  const rewrittenUrls = playlist.match(/https:\/\/[^\s"]+/g) || [];
  assert.equal(rewrittenUrls.length, 3);
  assert.ok(rewrittenUrls.every(value => new URL(value).pathname.startsWith('/media/g-905c6397/')));
});

test('blue slot is accepted and invalid slots fail closed', () => {
  assert.equal(mediaRelay._test.mediaPathPrefix({ ONLYPORN_MEDIA_SLOT: 'blue' }), '/media/blue');
  assert.equal(mediaRelay._test.mediaPathPrefix({ ONLYPORN_MEDIA_SLOT: 'green' }), '/media/green');
  assert.equal(mediaRelay._test.mediaPathPrefix({}), '/media');
  assert.throws(
    () => mediaRelay._test.mediaPathPrefix({ ONLYPORN_MEDIA_SLOT: '../bad' }),
    /must be blue or green/
  );
});

test('generation identifiers normalize safely and malformed values fail closed', () => {
  assert.equal(
    mediaRelay._test.mediaPathPrefix({ ONLYPORN_MEDIA_GENERATION: 'A721AA38' }),
    '/media/g-a721aa38'
  );
  assert.equal(
    mediaRelay._test.mediaPathPrefix({ ONLYPORN_MEDIA_GENERATION: 'g-ab22163c' }),
    '/media/g-ab22163c'
  );
  for (const value of ['short', '../ab22163c', 'g-ab22163c/next', 'blue']) {
    assert.throws(
      () => mediaRelay._test.mediaPathPrefix({ ONLYPORN_MEDIA_GENERATION: value }),
      /must be a 7-40 character hexadecimal commit identifier/
    );
  }
});
