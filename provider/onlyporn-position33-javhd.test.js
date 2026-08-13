'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const mediaRelay = require('../media-relay');
const createJavHdPorn = require('./javhdporn');

const ROOT = path.resolve(__dirname, '..');
mediaRelay.setPublicBase('https://onlyporn.example');

test('position 33 preserves c1 children and uses a decoder-safe JAV segment extension', () => {
  const source = fs.readFileSync(path.join(ROOT, 'media-relay.js'), 'utf8');
  assert.match(source, /const CHILD_TOKEN_VERSION = 'c1'/);
  assert.match(source, /return 'segment\.bin'/);
  assert.doesNotMatch(
    source,
    /COMPACT_CHILD_TOKEN_VERSION|createCompactChildToken|MAX_COMPACT_CHILDREN/
  );

  const javEntry = {
    provider: 'javhdporn',
    headers: { Referer: 'https://video.javhdporn.net/p/test' },
  };
  const javChild = mediaRelay._test.relayChild(
    javEntry,
    'https://akamai-cache-p01.vdcdn.xyz/hls/test/index.m3u8',
    'segment-1.webp',
    'segment'
  );
  assert.match(new URL(javChild).pathname, /\/segment\.ts$/);

  const regularEntry = {
    provider: 'pornhub',
    headers: { Referer: 'https://www.pornhub.com/view_video.php?viewkey=test' },
  };
  const regularChild = mediaRelay._test.relayChild(
    regularEntry,
    'https://cdn.phncdn.com/hls/test/index.m3u8',
    'segment-1.ts',
    'segment'
  );
  assert.match(new URL(regularChild).pathname, /\/segment\.ts$/);
});

test('JAVHDPorn accepts every verified additional playback host narrowly', () => {
  const accepted = [
    'https://edge-hls.saawsedge.com/tokenized/master.m3u8',
    'https://pianopic.com/hls/token/master.m3u8',
    'https://cdn.pianopic.com/hls/token/master.m3u8',
    'https://s2.maxstream.org/hls2/test/master.m3u8',
    'https://s4.maxstream.org/hls2/test/master.m3u8',
    'https://s8.maxstream.org/hls2/test/master.m3u8',
    'https://streamhls.click/hls/test/master.m3u8',
    'https://akamai-cache-p01.vdcdn.xyz/hls/test/master.m3u8',
    'https://tiktokcdn.com/hls/test/master.m3u8',
  ];

  for (const url of accepted) {
    assert.equal(mediaRelay._test.validateTargetUrl(url, 'javhdporn'), url);
    assert.throws(
      () => mediaRelay._test.validateTargetUrl(url, 'xvideos'),
      /not approved/
    );
  }

  assert.throws(
    () => mediaRelay._test.validateTargetUrl(
      'https://s1.maxstream.org/hls2/test/master.m3u8',
      'javhdporn'
    ),
    /not approved/
  );
  assert.throws(
    () => mediaRelay._test.validateTargetUrl(
      'https://evilmaxstream.org/hls/test/master.m3u8',
      'javhdporn'
    ),
    /not approved/
  );
});

test('vdcdn HLS roots are identified narrowly for immediate preservation', () => {
  assert.equal(
    createJavHdPorn._test.isExpiringVdcdnHls(
      'https://akamai-cache-p01.vdcdn.xyz/hls4/token/master.m3u8'
    ),
    true
  );
  assert.equal(
    createJavHdPorn._test.isExpiringVdcdnHls(
      'https://cloud-1.vdcdn.xyz/hls4/token/master.m3u8'
    ),
    true
  );
  assert.equal(
    createJavHdPorn._test.isExpiringVdcdnHls(
      'https://vdcdn.xyz.evil.example/hls4/token/master.m3u8'
    ),
    false
  );
  assert.equal(
    createJavHdPorn._test.isExpiringVdcdnHls(
      'https://akamai-cache-p01.vdcdn.xyz/hls4/token/video.mp4'
    ),
    false
  );
});

test('JAVHDPorn preserves an expiring direct candidate during discovery', async () => {
  const provider = createJavHdPorn();
  const upstream = 'https://akamai-cache-p01.vdcdn.xyz/hls4/fresh/master.m3u8';
  const preserved = 'https://onlyporn.example/media/preserved/index.m3u8';
  let calls = 0;
  provider.preserveDiscoveredMedia = async candidate => {
    calls += 1;
    return { ...candidate, relayUrl: preserved };
  };

  const candidates = await provider.discoverMedia(
    [{ value: upstream, context: '720p' }],
    'https://video.javhdporn.net/p/fixture'
  );

  assert.equal(calls, 1);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].url, upstream);
  assert.equal(candidates[0].relayUrl, preserved);
  const stream = await provider.streamFromMedia(candidates[0]);
  assert.equal(stream.url, preserved);
});

test('newly decoded media receives priority without deleting reserve fallbacks', () => {
  const queue = Array.from({ length: 14 }, (_, index) => ({
    url: `https://video1.javhdporn.net/p/reserve-${index}`,
    context: `reserve[${index}]`,
    referer: 'https://www.javhdporn.net/video/meyd-985/',
    depth: 0,
  }));

  const decoded = [
    {
      url: 'https://edge-hls.saawsedge.com/tokenized/no-extension?sig=test',
      context: 'encrypted JWPlayer extensionless source',
    },
    {
      url: 'https://pianopic.com/hls/test/master.m3u8',
      context: 'encrypted JWPlayer HLS',
    },
    {
      url: 'https://s4.maxstream.org/hls2/test/master.m3u8',
      context: 'encrypted JWPlayer HLS',
    },
  ];

  createJavHdPorn._test.prioritizePlayerCandidates(
    queue,
    new Set(),
    decoded,
    'https://video1.javhdporn.net/p/working-player',
    1
  );

  assert.deepEqual(
    queue.slice(0, decoded.length).map(item => item.url),
    decoded.map(item => item.url)
  );
  assert.equal(queue.length, 17);
  assert.equal(queue[3].url, 'https://video1.javhdporn.net/p/reserve-0');
});

test('the discovery loop retains the full 12-page fallback traversal', () => {
  const source = fs.readFileSync(path.join(ROOT, 'provider', 'javhdporn.js'), 'utf8');
  assert.match(source, /const MAX_PLAYER_PAGES = 12/);
  assert.match(source, /while \(queue\.length && visited\.size < MAX_PLAYER_PAGES\)/);
  assert.doesNotMatch(source, /media\.size === 0/);
  assert.match(source, /queue\.unshift\(\.\.\.pending\)/);
});

test('all approved pending-title source families survive stream registration', async () => {
  const provider = createJavHdPorn();
  provider.registerPlayableHls = async (candidate, headers) => mediaRelay.register({
    url: candidate.url,
    headers,
    provider: provider.name,
    kind: 'hls',
  });
  provider.fetchHtml = async () => '<html></html>';
  provider.playerBootstrap = () => ({
    videoId: '867640',
    mpu: 'fixture',
    version: '2',
  });
  provider.requestPlayerSources = async () => [];
  provider.discoverMedia = async () => [
    {
      url: 'https://pianopic.com/hls/test/master.m3u8',
      referer: 'https://video.javhdporn.net/p/pianopic',
      context: 'Pianopic',
      kind: 'hls',
    },
    {
      url: 'https://s2.maxstream.org/hls2/test/master.m3u8',
      referer: 'https://video.javhdporn.net/p/maxstream-s2',
      context: 'Maxstream s2',
      kind: 'hls',
    },
    {
      url: 'https://s4.maxstream.org/hls2/test/master.m3u8',
      referer: 'https://video.javhdporn.net/p/maxstream-s4',
      context: 'Maxstream s4',
      kind: 'hls',
    },
    {
      url: 'https://s8.maxstream.org/hls2/test/master.m3u8',
      referer: 'https://video.javhdporn.net/p/maxstream-s8',
      context: 'Maxstream s8',
      kind: 'hls',
    },
    {
      url: 'https://edge-hls.saawsedge.com/tokenized/master.m3u8',
      referer: 'https://video.javhdporn.net/p/saawsedge',
      context: 'Saawsedge',
      kind: 'hls',
    },
    {
      url: 'https://streamhls.click/hls/test/master.m3u8',
      referer: 'https://video1.javhdporn.net/p/streamhls',
      context: 'StreamHLS',
      kind: 'hls',
    },
  ];

  const response = await provider.processStreams({
    id: 'https://www.javhdporn.net/video/test/',
  });

  assert.equal(response.streams.length, 6);
  for (const stream of response.streams) {
    assert.match(stream.url, /^https:\/\/onlyporn\.example\/media\//);
    assert.equal(stream.behaviorHints.notWebReady, false);
  }
});

test('subtitle cards without an MPU recover through the canonical JAV player page', async () => {
  assert.equal(
    createJavHdPorn._test.subtitleCanonicalPlaybackUrl(
      'https://www.javhdporn.net/video/sone-670-sub/'
    ),
    'https://www.javhdporn.net/video/sone-670/'
  );
  assert.equal(
    createJavHdPorn._test.subtitleCanonicalPlaybackUrl(
      'https://www.javhdporn.net/v3/video/siro-4651-sub/?ignored=1'
    ),
    'https://www.javhdporn.net/v3/video/siro-4651/'
  );
  assert.equal(
    createJavHdPorn._test.subtitleCanonicalPlaybackUrl(
      'https://www.javhdporn.net/video/sone-670/'
    ),
    ''
  );

  const provider = createJavHdPorn();
  const subtitleUrl = 'https://www.javhdporn.net/video/sone-670-sub/';
  const canonicalUrl = 'https://www.javhdporn.net/video/sone-670/';
  const fetched = [];

  provider.fetchHtml = async url => {
    fetched.push(url);
    return url === subtitleUrl
      ? '<div id="video-player-area" data-video-id="887534"></div><div id="video-player" data-mpu="" data-ver="2"></div>'
      : '<div id="video-player-area" data-video-id="683026"></div><div id="video-player" data-mpu="canonical-payload" data-ver="2"></div>';
  };
  provider.requestPlayerSources = async (url, bootstrap) => {
    assert.equal(url, canonicalUrl);
    assert.deepEqual(bootstrap, {
      videoId: '683026',
      mpu: 'canonical-payload',
      version: '2',
    });
    return [];
  };
  provider.discoverMedia = async (_sources, url) => {
    assert.equal(url, canonicalUrl);
    return [];
  };

  assert.deepEqual(await provider.processStreams({ id: subtitleUrl }), { streams: [] });
  assert.deepEqual(fetched, [subtitleUrl, canonicalUrl]);
});

test('subtitle cards whose advertised page is gone recover metadata and playback canonically', async () => {
  const provider = createJavHdPorn();
  const subtitleUrl = 'https://www.javhdporn.net/video/start-269-sub/';
  const canonicalUrl = 'https://www.javhdporn.net/video/start-269/';
  const canonicalHtml = `
    <html>
      <head>
        <meta property="og:title" content="START-269" />
        <meta property="og:image" content="https://pics.pornfhd.com/start-269.jpg" />
      </head>
      <body>
        <div id="video-player-area" data-video-id="679447"></div>
        <div id="video-player" data-mpu="canonical-payload" data-ver="2"></div>
      </body>
    </html>`;
  const fetched = [];

  provider.fetchHtml = async url => {
    fetched.push(url);
    if (url === subtitleUrl) throw new Error('HTTP 404');
    assert.equal(url, canonicalUrl);
    return canonicalHtml;
  };
  provider.requestPlayerSources = async url => {
    assert.equal(url, canonicalUrl);
    return [];
  };
  provider.discoverMedia = async (_sources, url) => {
    assert.equal(url, canonicalUrl);
    return [];
  };

  const metadata = await provider.getMetadata({ id: subtitleUrl });
  assert.equal(metadata.name, 'START-269');
  assert.equal(metadata.id, canonicalUrl);
  assert.deepEqual(await provider.processStreams({ id: subtitleUrl }), { streams: [] });
  assert.deepEqual(fetched, [subtitleUrl, canonicalUrl, subtitleUrl, canonicalUrl]);
});

test('disguised JAV transport decoding from position 32 remains active', () => {
  const source = fs.readFileSync(path.join(ROOT, 'media-relay.js'), 'utf8');
  assert.match(source, /tiktokcdn\.com/);
  assert.match(source, /vdcdn\.xyz/);
  assert.match(source, /normalizeJavTransportSegment/);
  assert.match(source, /stripPngWrappedTsBuffer/);
  assert.match(source, /Content-Type', 'video\/mp2t'/);
});
