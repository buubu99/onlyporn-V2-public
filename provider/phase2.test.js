const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildEpornerGenreUrl,
  parseGenreSelection,
  toSearchSlug,
} = require('./eporner-routing');
const {
  parseAssignedObjectStringValues,
} = require('./js-literal');
const {
  isPreviewMediaCandidate,
  normalizeAbsoluteUrl,
  selectDirectMp4Candidates,
} = require('./media-utils');
const {
  resolveTemplateFrame,
  stableFrame,
} = require('./poster-utils');
const {
  collectStructuredMediaUrls,
  parseStructuredDataBlocks,
} = require('./structured-data');

test('Eporner genre selections map to functional sorted routes', () => {
  assert.deepEqual(parseGenreSelection('4k Porn (Weekly Top)'), {
    genre: '4k Porn',
    sort: 'Weekly Top',
  });
  assert.equal(toSearchSlug('HD 1080p'), 'hd-1080p');
  assert.equal(
    buildEpornerGenreUrl('https://www.eporner.com', '4k Porn (Weekly Top)'),
    'https://www.eporner.com/search/4k-porn/SORT-top-weekly/'
  );
  assert.equal(
    buildEpornerGenreUrl('https://www.eporner.com/', 'Asian Porn (Most Recent)'),
    'https://www.eporner.com/search/asian-porn/'
  );
});

test('SpankBang stream_data parser handles JavaScript strings without eval or global quote replacement', () => {
  const source = String.raw`
    window.stream_data = {
      '720p': ['https://cdn.example/videos/720p.mp4?token=it\'s-safe'],
      "1080p": ["https://cdn.example/videos/1080p.mp4"],
      preview: ['https://thumb-cdn.example/previews/720p.t.mp4']
    };
  `;

  const parsed = parseAssignedObjectStringValues(source, 'stream_data');
  assert.equal(parsed['720p'][0], "https://cdn.example/videos/720p.mp4?token=it\'s-safe".replace("\\'", "'"));
  assert.equal(parsed['1080p'][0], 'https://cdn.example/videos/1080p.mp4');
  assert.equal(parsed.preview[0], 'https://thumb-cdn.example/previews/720p.t.mp4');
});

test('shared preview detection rejects thumbnail MP4s even when they contain a resolution', () => {
  assert.equal(
    isPreviewMediaCandidate('https://thumb-v4.example/previews/720p.t.mp4', '720p'),
    true
  );
  assert.equal(
    isPreviewMediaCandidate('https://cdn.example/videos/720p.mp4', '720p'),
    false
  );
});

test('direct MP4 selection resolves relative URLs, filters previews, and keeps the preferred candidate', () => {
  const selected = selectDirectMp4Candidates(
    [
      {
        url: '/videos/720p.mp4',
        label: 'High 720p',
        priority: 0,
      },
      {
        url: 'https://thumb.example/previews/1080p.t.mp4',
        label: '1080p preview',
        priority: 1,
      },
      {
        url: 'https://cdn.example/videos/720p.mp4?alternate=1',
        label: '720p alternate',
        priority: 10,
      },
      {
        url: 'https://cdn.example/master.m3u8',
        label: 'HLS',
      },
    ],
    {
      baseUrl: 'https://www.xnxx.com/video-test',
      allowKnownVideoPath: true,
    }
  );

  assert.equal(selected.length, 1);
  assert.equal(selected[0].url, 'https://www.xnxx.com/videos/720p.mp4');
  assert.equal(selected[0].resolution, '720p');
});

test('absolute URL normalization correctly handles protocol-relative and root-relative paths', () => {
  assert.equal(
    normalizeAbsoluteUrl('//cdn.example/video.mp4', 'https://www.xnxx.com/watch'),
    'https://cdn.example/video.mp4'
  );
  assert.equal(
    normalizeAbsoluteUrl('/videos/video.mp4', 'https://www.xnxx.com/watch'),
    'https://www.xnxx.com/videos/video.mp4'
  );
});

test('JSON-LD media fallback supports arrays and @graph objects', () => {
  const parsed = parseStructuredDataBlocks([
    JSON.stringify({
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'VideoObject', contentUrl: 'https://cdn.example/videos/1080p.mp4' },
        { '@type': 'VideoObject', embedUrl: 'https://cdn.example/master.m3u8' },
      ],
    }),
    'not valid json',
  ]);
  const media = collectStructuredMediaUrls(parsed);

  assert.ok(media.some(item => item.url.endsWith('/1080p.mp4')));
  assert.ok(media.some(item => item.url.endsWith('/master.m3u8')));
});

test('XNXX poster frame replacement is deterministic', () => {
  const seed = 'https://www.xnxx.com/video-abc';
  assert.equal(stableFrame(seed), stableFrame(seed));
  assert.equal(
    resolveTemplateFrame('https://cdn.example/THUMBNUM.jpg', seed),
    resolveTemplateFrame('https://cdn.example/THUMBNUM.jpg', seed)
  );
  assert.match(resolveTemplateFrame('https://cdn.example/THUMBNUM.jpg', seed), /\/\d+\.jpg$/);
});

test('Phase 2 provider integrations remain wired into the live code paths', () => {
  const providerDir = __dirname;
  const eporner = fs.readFileSync(path.join(providerDir, 'eporner.js'), 'utf8');
  const spankbang = fs.readFileSync(path.join(providerDir, 'spankbang.js'), 'utf8');
  const xhamster = fs.readFileSync(path.join(providerDir, 'xhamster.js'), 'utf8');
  const xvideos = fs.readFileSync(path.join(providerDir, 'xvideos.js'), 'utf8');
  const xnxx = fs.readFileSync(path.join(providerDir, 'xnxx.js'), 'utf8');

  assert.match(eporner, /buildEpornerGenreUrl/);
  assert.match(spankbang, /parseAssignedObjectStringValues/);
  assert.doesNotMatch(spankbang, /currentUrl}::\$\{link}::\$\{index}/);
  assert.match(spankbang, /markFourKUrl\(videoPageUrl\)/);

  assert.match(xhamster, /async handleCatalog\(args\)/);
  assert.match(xhamster, /await this\.fetchCatalog\(baseUrl, extra\.genre \|\| '', skip\)/);
  assert.match(xhamster, /super\.fetchHtml\(url, \{ cache: false \}\)/);
  assert.match(xhamster, /isBlockedXhamsterHtml/);

  for (const source of [xvideos, xnxx]) {
    assert.match(source, /directMp4Streams/);
    assert.match(source, /if \(parsed\?\.directMp4Streams\?\.length\)/);
    assert.match(source, /collectStructuredMediaUrls/);
  }
  assert.match(xnxx, /resolveTemplateFrame/);
});
