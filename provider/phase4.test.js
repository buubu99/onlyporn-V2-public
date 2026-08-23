const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Provider = require('./provider');
const mediaRelay = require('../media-relay');
const createEporner = require('./eporner');
const createPorntrex = require('./porntrex');
const createXvideos = require('./xvideos');

const ROOT = path.resolve(__dirname, '..');
mediaRelay.setPublicBase('https://onlyporn.example');

test('XVideos builds canonical candidates from THUMBNUM catalog templates', () => {
  const malformed =
    '/video.opbbvmfd842/51058054/THUMBNUM/the_most_unforgettable_surprise_of_my_life_lana_myers';
  const expected = 'https://www.xvideos.com/video.opbbvmfd842/51058054';

  assert.equal(
    createXvideos._test.normalizeXvideosPageUrl(malformed, 'https://www.xvideos.com'),
    expected
  );

  const candidates = createXvideos._test.xvideosPageCandidates(
    malformed,
    'https://www.xvideos.com'
  );
  assert.equal(candidates[0], expected);
  assert.ok(candidates.length >= 3);
  assert.doesNotMatch(candidates[0], /THUMBNUM/i);
  assert.ok(
    candidates.includes(
      'https://www.xvideos.com/video.opbbvmfd842/the_most_unforgettable_surprise_of_my_life_lana_myers'
    )
  );
});

test('XVideos preserves template context and retries canonical candidates on 404', async () => {
  const provider = createXvideos();
  const malformed =
    'https://www.xvideos.com/video.retryfixture/51058054/THUMBNUM/fixture_title';
  const catalog = provider.getCatalogMetas(
    `<div class="thumb-block"><a href="${malformed}" title="Fixture">` +
      '<img src="https://thumb-cdn77.xvideos-cdn.com/x.jpg" alt="Fixture"></a></div>'
  );
  assert.equal(catalog.length, 1);
  assert.match(catalog[0].id, /THUMBNUM/);

  const attempted = [];
  const originalFetchHtml = Provider.prototype.fetchHtml;
  Provider.prototype.fetchHtml = async url => {
    attempted.push(url);
    if (url !== 'https://www.xvideos.com/video.retryfixture/fixture_title') {
      const error = new Error('HTTP 404');
      error.response = { status: 404 };
      throw error;
    }
    return '<html><script>html5player.setVideoUrlHigh(\'https://video-cdn77.xvideos-cdn.com/videos/fixture-1080p.mp4\');</script></html>';
  };

  try {
    const html = await provider.fetchHtml(malformed);
    assert.match(html, /setVideoUrlHigh/);
    assert.equal(attempted.length, 3);
    assert.ok(attempted.every(url => !/THUMBNUM/i.test(url)));
    assert.equal(
      attempted[2],
      'https://www.xvideos.com/video.retryfixture/fixture_title'
    );
  } finally {
    Provider.prototype.fetchHtml = originalFetchHtml;
  }
});

test('XVideos direct MP4 streams force protected playback headers', () => {
  const provider = createXvideos();
  const parsed = provider.parseVideoPage({
    id: 'https://www.xvideos.com/video.test123/fixture',
    html: `<!doctype html><html><head>
      <meta property="og:title" content="Fixture">
      <meta property="og:image" content="https://thumb-cdn77.xvideos-cdn.com/x.jpg">
      </head><body><script>
      html5player.setVideoUrlHigh('https://video-cdn77.xvideos-cdn.com/videos/fixture-1080p.mp4');
      </script></body></html>`,
  });

  assert.equal(parsed.directMp4Streams.length, 1);
  const hints = parsed.directMp4Streams[0].behaviorHints;
  assert.equal(hints.notWebReady, false);
  assert.match(parsed.directMp4Streams[0].url, /^https:\/\/onlyporn\.example\/media\//);
});

test('XVideos accepts current signed mp4_sd paths and prefers direct MP4 over HLS', () => {
  const provider = createXvideos();
  const page = 'https://www.xvideos.com/video.currentfixture/current_fixture';
  const signedMp4 =
    'https://mp4-cdn77.xvideos-cdn.com/05248c16-0ce8-482f-84a0-48afbec20b21/6/mp4_sd.mp4?secure=fixture';
  const parsed = provider.parseVideoPage({
    id: page,
    html: `<!doctype html><html><head>
      <meta property="og:title" content="Current XVideos Fixture">
      <meta property="og:image" content="https://thumb-cdn77.xvideos-cdn.com/x.jpg">
      </head><body><script>
      html5player.setVideoUrlLow('${signedMp4}');
      html5player.setVideoUrlHigh('${signedMp4}');
      html5player.setVideoHLS('https://hls-cdn77.xvideos-cdn.com/current/hls.m3u8');
      </script></body></html>`,
  });

  assert.equal(parsed.directMp4Streams.length, 1);
  assert.match(parsed.directMp4Streams[0].url, /^https:\/\/onlyporn\.example\/media\//);
  assert.equal(parsed.directMp4Streams[0].behaviorHints.notWebReady, false);
  assert.equal(parsed.videoPageUrl, 'https://hls-cdn77.xvideos-cdn.com/current/hls.m3u8');
});

test('XVideos fetches HLS playlists with protected page headers', async () => {
  const provider = createXvideos();
  const page = 'https://www.xvideos.com/video.hlsfixture/fixture';
  provider.fetchHtml = async () => `<!doctype html><html><head>
    <meta property="og:title" content="HLS Fixture">
    <meta property="og:image" content="https://thumb-cdn77.xvideos-cdn.com/x.jpg">
    </head><body><script>
    html5player.setVideoHLS('https://hls-cdn77.xvideos-cdn.com/xvideos/master.m3u8');
    </script></body></html>`;
  provider.fetchMediaText = async (url, options) => {
    assert.equal(url, 'https://hls-cdn77.xvideos-cdn.com/xvideos/master.m3u8');
    assert.equal(options.headers.Referer, page);
    assert.equal(options.headers.Origin, 'https://www.xvideos.com');
    return '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720\n720/index.m3u8';
  };
  provider.parseM3u8 = () => [
    { type: Provider.TYPE, url: '720/index.m3u8', name: '720p', resolution: '720p' },
  ];

  const response = await provider.processStreams({ id: page });
  assert.equal(response.streams.length, 1);
  assert.match(response.streams[0].url, /^https:\/\/onlyporn\.example\/media\//);
  assert.equal(response.streams[0].behaviorHints.notWebReady, false);
});

test('Eporner prefers H264 and forces Referer-aware proxy playback', async () => {
  const provider = createEporner();
  const page = 'https://www.eporner.com/video-test/fixture/';
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
  const hints = response.streams[0].behaviorHints;
  assert.equal(hints.notWebReady, false);
});

test('Eporner fetches HLS playlists with Referer-aware headers', async () => {
  const provider = createEporner();
  const page = 'https://www.eporner.com/video-hls/fixture/';
  provider.fetchMediaText = async (url, options) => {
    assert.equal(url, 'https://vid-cdn.eporner.com/eporner/master.m3u8');
    assert.equal(options.headers.Referer, page);
    assert.equal(options.headers.Origin, 'https://www.eporner.com');
    return '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720\n720/index.m3u8';
  };
  provider.parseM3u8 = () => [
    { type: Provider.TYPE, url: '720/index.m3u8', name: '720p', resolution: '720p' },
  ];

  const response = await provider.selectSources(
    { hls: { auto: { src: 'https://vid-cdn.eporner.com/eporner/master.m3u8' } } },
    page
  );
  assert.match(response.streams[0].url, /^https:\/\/onlyporn\.example\/media\//);
  assert.equal(response.streams[0].behaviorHints.notWebReady, false);
});

test('Porntrex parses modern flashvars variables with quoted source keys', async () => {
  const provider = createPorntrex();
  provider.resolveStream = async url => url;

  const html = `<!doctype html><html><head>
    <meta property="og:title" content="Modern Porntrex Fixture">
    <meta property="og:image" content="https://cdn.example/poster.jpg">
    </head><body><script>
    var flashvars = {
      "video_url": "https://cdn.example/contents/videos/480p.mp4",
      "video_url_text": "480p",
      "video_alt_url2": "https://cdn.example/contents/videos/720p.mp4",
      "video_alt_url2_text": "720p",
      "video_alt_url3": "https://cdn.example/contents/videos/1080p.mp4",
      "video_alt_url3_text": "1080p"
    };
    kt_player('kt_player', flashvars);
    </script></body></html>`;

  assert.equal(
    createPorntrex._test.decodeMediaValue('https://cdn.example/contents/videos/720p.mp4/'),
    'https://cdn.example/contents/videos/720p.mp4'
  );

  const candidates = createPorntrex._test.collectPorntrexSources(
    html,
    'https://www.porntrex.com/videos/3281172/fixture/'
  );
  assert.deepEqual(
    candidates.slice(0, 3).map(candidate => candidate.quality),
    ['1080p', '720p', '480p']
  );

  const parsed = await provider.parseVideoPage({
    id: 'https://www.porntrex.com/videos/3281172/fixture/',
    html,
  });
  assert.deepEqual(parsed.streams.map(stream => stream.name), ['1080p', '720p', '480p']);
  assert.ok(parsed.streams.every(stream => stream.behaviorHints.notWebReady === true));
});

test('SpankBang production package pins Safari curl_cffi transport', () => {
  const requirements = fs.readFileSync(path.join(ROOT, 'requirements.txt'), 'utf8');
  const packageInfo = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const providerSource = fs.readFileSync(path.join(ROOT, 'provider', 'spankbang.js'), 'utf8');
  const installerSource = fs.readFileSync(
    path.join(ROOT, 'scripts', 'install-python-deps.js'),
    'utf8'
  );
  const helperSource = fs.readFileSync(
    path.join(ROOT, 'scripts', 'safari_fetch_helper.py'),
    'utf8'
  );

  assert.match(requirements, /^curl_cffi==0\.15\.0\s*$/m);
  assert.match(packageInfo.scripts.postinstall, /install:python/);
  assert.match(packageInfo.scripts['install:python'], /install-python-deps\.js/);
  assert.match(installerSource, /'-m', 'venv'/);
  assert.match(providerSource, /safariImpersonation\.fetchText/);
  assert.match(helperSource, /requests\.Session\(impersonate=.*safari/);
  assert.match(helperSource, /ensure_bootstrap\(timeout_seconds\)/);
  assert.match(helperSource, /ALLOWED_HOSTS\s*=\s*\{[^}]*spankbang\.com/);
});
