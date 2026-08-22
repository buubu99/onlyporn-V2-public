'use strict';

process.env.LOG_ENABLED = 'false';

const assert = require('node:assert/strict');
const test = require('node:test');

const createXvideos = require('./xvideos');
const { readContentFilterConfig } = require('./content-filter');

function playablePage({ title, keywords }) {
  return `
    <html>
      <head>
        <meta property="og:title" content="${title}">
        <meta name="description" content="${title}">
        <meta name="keywords" content="${keywords}">
        <meta property="og:image" content="https://thumb-cdn77.xvideos-cdn.com/fixture/xv_1_p.jpg">
      </head>
      <body>
        <script>html5player.setVideoHLS('https://hls-cdn77.xvideos-cdn.com/fixture/master.m3u8');</script>
      </body>
    </html>
  `;
}

test('XVideos removes blocked and unverifiable cards before Stremio catalog publication', async () => {
  const provider = createXvideos();
  provider.contentFilter = readContentFilterConfig({
    ONLYPORN_CONTENT_FILTER_ENABLED: 'true',
    ONLYPORN_FILTER_GAY: 'true',
    ONLYPORN_FILTER_INTERRACIAL: 'true',
    ONLYPORN_FILTER_UNKNOWN: 'false',
  });
  const safeId = 'https://www.xvideos.com/video.safe/safe';
  const blockedId = 'https://www.xvideos.com/video.blocked/blocked';
  const unavailableId = 'https://www.xvideos.com/video.unavailable/unavailable';
  provider.fetchHtml = async id => {
    if (id === safeId) return playablePage({ title: 'Safe title', keywords: 'Amateur, Japanese' });
    if (id === blockedId) return playablePage({ title: 'Blocked title', keywords: 'Interracial, Amateur' });
    throw new Error('fixture detail unavailable');
  };

  const response = await provider.postProcessCatalogMetas([
    { id: blockedId, name: 'Ambiguous catalog title' },
    { id: safeId, name: 'Safe catalog title' },
    { id: unavailableId, name: 'Broken catalog title' },
  ]);

  assert.deepEqual(response.map(item => item.id), [safeId]);
});
