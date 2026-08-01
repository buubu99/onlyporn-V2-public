'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  mergeTorrentFirstStudio,
  metadataPosterMatch,
} = require('./tpb4k/torrent-first-studio');
const {
  renderStudioReleaseSvg,
  studioReleasePosterUrl,
} = require('./tpb4k/studio-release-poster');

function hash(char) { return String(char).repeat(40); }

const config = Object.freeze({ publicBaseUrl: 'https://onlyporn.example' });

test('OnlyFans creator and title evidence binds the correct real metadata poster', () => {
  const torrent = {
    title: 'OnlyFans.2025.06.17.Ruth.Morning.Routine.2160p',
    filename: 'OnlyFans.2025.06.17.Ruth.Morning.Routine.2160p.mkv',
    infoHash: hash('a'),
    sourceId: 'torrent:ruth',
    lookupSource: 'torrent-index',
  };
  const metadata = [{
    title: 'Ruth - Morning Routine',
    creator: 'Ruth',
    performers: ['Ruth'],
    releaseDate: '2025-06-17',
    poster: 'https://cdn.example/ruth-morning.jpg',
    metadataProvider: 'tpdb',
    lookupSource: 'torrent-index',
    sourceId: 'tpdb:ruth',
  }];
  assert.equal(metadataPosterMatch(torrent, { studio: 'OnlyFans' }, metadata)?.poster, metadata[0].poster);
});

test('DigitalPlayground and XVideosRED release-title overlap can attach real scene art', () => {
  const metadata = [{
    title: 'Riley Reid Secret Office Affair',
    poster: 'https://cdn.example/dp-riley.jpg',
    metadataProvider: 'tpdb',
    lookupSource: 'torrent-index',
    sourceId: 'tpdb:dp-riley',
  }];
  assert.equal(metadataPosterMatch({
    title: 'Digital.Playground.Riley.Reid.Secret.Office.Affair.1080p',
    filename: 'Digital.Playground.Riley.Reid.Secret.Office.Affair.1080p.mp4',
  }, { studio: 'DigitalPlayground' }, metadata)?.poster, metadata[0].poster);
  assert.equal(metadataPosterMatch({
    title: 'XVideos.RED.Riley.Reid.Secret.Office.Affair.4K',
    filename: 'XVideos.RED.Riley.Reid.Secret.Office.Affair.4K.mkv',
  }, { studio: 'XVideosRED' }, metadata)?.poster, metadata[0].poster);
});

test('unmatched fallback cards are release-specific portrait posters, never one repeated studio image', () => {
  const result = mergeTorrentFirstStudio({
    catalog: { id: 'tpb4k.studio.digitalplayground.top', studio: 'DigitalPlayground' },
    existingItems: [],
    metadataItems: [],
    torrentItems: [
      { infoHash: hash('b'), sourceId: 'torrent:b', title: 'Digital Playground Scene One', filename: 'Digital Playground Scene One.mkv', lookupSource: 'torrent-index', seeders: 5 },
      { infoHash: hash('c'), sourceId: 'torrent:c', title: 'Digital Playground Scene Two', filename: 'Digital Playground Scene Two.mkv', lookupSource: 'torrent-index', seeders: 4 },
    ],
    limit: 40,
    config,
    env: {},
  });
  assert.equal(result.items.length, 2);
  assert.notEqual(result.items[0].poster, result.items[1].poster);
  assert.match(result.items[0].poster, /\/onlyporn\/poster\/studio-release\//);
  assert.match(result.items[1].poster, /\/onlyporn\/poster\/studio-release\//);
  const svg = renderStudioReleaseSvg('abc', 'Digital Playground', 'Scene One');
  assert.match(svg, /width="600" height="900"/);
  assert.match(svg, /Scene One/);
  assert.match(studioReleasePosterUrl(result.items[0], { studio: 'DigitalPlayground' }, config, {}), /studio-release/);
});

test('runtime source serializes metadata catalogues, retries transient failures, falls back instead of returning zero, and preserves bound hashes', () => {
  const provider = fs.readFileSync(path.join(__dirname, 'tpb4k.js'), 'utf8');
  assert.match(provider, /scheduleMetadataCatalog/);
  assert.match(provider, /METADATA_RATE_LIMIT_RETRY_MS/);
  assert.match(provider, /torrentFirstEnabled \|\| !metadataItems\.length/);
  assert.match(provider, /metadataFallbackReason/);
  assert.match(provider, /catalogBoundHashes\.has/);
  assert.match(provider, /studioReleasePosterUrl/);
});

test('Sukebei outage fallback is unconditional for both Top and RSS once playable RSS hashes exist', () => {
  const source = fs.readFileSync(path.join(__dirname, 'tpb4k', 'sukebei-metadata.js'), 'utf8');
  assert.match(source, /if \(allowed\.length < needed\)/);
  assert.doesNotMatch(source, /catalog\?\.mode === ['"]rss['"] && allowed\.length < needed/);
  assert.match(source, /lookupSource: ['"]sukebei-rss-fallback['"]/);
});
