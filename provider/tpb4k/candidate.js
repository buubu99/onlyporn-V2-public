'use strict';

const crypto = require('node:crypto');
const mediaRelay = require('../../media-relay');

const RESOLUTION_HEIGHTS = Object.freeze({
  '8k': 4320,
  '4320p': 4320,
  '4k': 2160,
  '2160p': 2160,
  '1440p': 1440,
  '2k': 1440,
  '1080p': 1080,
  '720p': 720,
  '576p': 576,
  '480p': 480,
  '360p': 360,
  '240p': 240,
  '144p': 144,
});

const DEFAULT_TRACKERS = Object.freeze([
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://tracker.moeking.me:6969/announce',
]);

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const INDEXER_RELIABILITY = Object.freeze({
  pornrips: 100,
  sukebei: 96,
  '1337x': 92,
  hiddenbay: 88,
  piratebay: 88,
  tpb: 88,
  knaben: 84,
  unknown: 50,
});

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function decodeBase32(value) {
  const text = String(value || '').toUpperCase().replace(/=+$/g, '');
  let bits = '';
  for (const character of text) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0) return null;
    bits += index.toString(2).padStart(5, '0');
  }

  const bytes = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  }
  return Buffer.from(bytes);
}

function normalizeInfoHash(value) {
  const text = String(value || '').trim();
  if (/^[a-f0-9]{40}$/i.test(text)) return text.toLowerCase();
  if (/^[a-z2-7]{32}$/i.test(text)) {
    const decoded = decodeBase32(text);
    if (decoded && decoded.length === 20) return decoded.toString('hex');
  }
  return '';
}

function parseMagnet(value) {
  const text = String(value || '').trim();
  if (!/^magnet:\?/i.test(text)) return null;

  try {
    const url = new URL(text);
    const exactTopics = url.searchParams.getAll('xt');
    const rawHash = exactTopics
      .map(topic => topic.match(/^urn:btih:([a-z0-9]+)$/i)?.[1] || '')
      .find(Boolean);
    const infoHash = normalizeInfoHash(rawHash);
    if (!infoHash) return null;

    const trackers = url.searchParams
      .getAll('tr')
      .map(normalizeTracker)
      .filter(Boolean);

    return {
      infoHash,
      displayName: cleanText(url.searchParams.get('dn')),
      trackers: [...new Set(trackers)],
    };
  } catch {
    return null;
  }
}

function normalizeTracker(value) {
  const text = String(value || '').trim();
  if (!text) return '';

  try {
    const url = new URL(text);
    if (!['udp:', 'https:', 'http:'].includes(url.protocol)) return '';
    if (!url.hostname) return '';
    return url.toString();
  } catch {
    return '';
  }
}

function normalizeHttpsUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    return url.toString();
  } catch {
    return '';
  }
}

function classifyDirectUrl(value, mediaKind = '') {
  const url = normalizeHttpsUrl(value);
  if (!url) return { url: '', kind: '' };

  const parsed = new URL(url);
  const pathname = parsed.pathname.toLowerCase();
  const hint = cleanText(mediaKind).toLowerCase();

  if (
    /\.m3u8\/?$/.test(pathname) ||
    ['hls', 'direct-hls'].includes(hint)
  ) {
    return { url, kind: 'direct-hls' };
  }

  if (
    /\.(?:mp4|m4v|webm|mkv)\/?$/.test(pathname) ||
    ['mp4', 'file', 'direct-file'].includes(hint)
  ) {
    return { url, kind: 'direct-file' };
  }

  return { url, kind: '' };
}

function safeHeaderValue(value, maximum = 2_048) {
  return String(value || '')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, maximum);
}

function normalizeRelayHeaders(value = {}) {
  const input =
    value && typeof value === 'object'
      ? value
      : {};

  const output = {};

  for (
    const [canonical, aliases] of [
      ['User-Agent', ['User-Agent', 'user-agent']],
      ['Referer', ['Referer', 'referer']],
      ['Origin', ['Origin', 'origin']],
      ['Cookie', ['Cookie', 'cookie']],
      ['Accept', ['Accept', 'accept']],
      ['Accept-Language', ['Accept-Language', 'accept-language']],
    ]
  ) {
    const raw = aliases
      .map(alias => input[alias])
      .find(item => item != null);

    const sanitized = safeHeaderValue(raw);
    if (sanitized) output[canonical] = sanitized;
  }

  return Object.freeze(output);
}

function resolutionHeight(...values) {
  for (const value of values) {
    const text = cleanText(value).toLowerCase();
    if (!text) continue;

    for (const [label, height] of Object.entries(RESOLUTION_HEIGHTS)) {
      if (new RegExp(`(?:^|[^0-9a-z])${label.replace('p', 'p?')}(?:[^0-9a-z]|$)`, 'i').test(text)) {
        return height;
      }
    }

    const numeric = text.match(/(?:^|[^0-9])(4320|2160|1440|1080|720|576|480|360|240|144)p?(?:[^0-9]|$)/)?.[1];
    if (numeric) return Number(numeric);
  }
  return 0;
}

function normalizeResolution(...values) {
  const height = resolutionHeight(...values);
  return height ? `${height}p` : 'Unknown';
}

function indexerReliability(value) {
  const key = cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (!key) return INDEXER_RELIABILITY.unknown;
  if (key.includes('pornrips')) return INDEXER_RELIABILITY.pornrips;
  if (key.includes('sukebei')) return INDEXER_RELIABILITY.sukebei;
  if (key.includes('1337')) return INDEXER_RELIABILITY['1337x'];
  if (key.includes('hiddenbay')) return INDEXER_RELIABILITY.hiddenbay;
  if (key.includes('piratebay')) return INDEXER_RELIABILITY.piratebay;
  if (key === 'tpb') return INDEXER_RELIABILITY.tpb;
  if (key.includes('knaben')) return INDEXER_RELIABILITY.knaben;
  return INDEXER_RELIABILITY.unknown;
}
function normalizeSeeders(value) {
  const number = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function normalizeSize(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  const text = cleanText(value).toLowerCase();
  if (!text) return 0;
  const match = text.match(/([0-9]+(?:\.[0-9]+)?)\s*(b|kb|kib|mb|mib|gb|gib|tb|tib)\b/i);
  if (!match) return 0;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const powers = {
    b: 0,
    kb: 1,
    kib: 1,
    mb: 2,
    mib: 2,
    gb: 3,
    gib: 3,
    tb: 4,
    tib: 4,
  };
  return Math.round(amount * 1024 ** powers[unit]);
}

function cacheState(value) {
  if (value === true || /^(?:cached|ready|instant)$/i.test(String(value || ''))) return 'cached';
  if (value === false || /^(?:uncached|download)$/i.test(String(value || ''))) return 'uncached';
  return 'unknown';
}

function candidateFingerprint(candidate) {
  if (candidate.infoHash) return `torrent:${candidate.infoHash}:${candidate.fileIdx ?? ''}`;
  if (candidate.url) return `url:${candidate.url}`;
  return `invalid:${crypto.createHash('sha256').update(JSON.stringify(candidate)).digest('hex')}`;
}

function normalizeCandidate(input = {}) {
  const magnet = parseMagnet(input.magnet || input.magnetUrl || input.uri);
  const infoHash = normalizeInfoHash(input.infoHash || input.hash || magnet?.infoHash);
  const direct = classifyDirectUrl(
    input.url ||
    input.streamUrl ||
    input.mediaUrl,
    input.mediaKind ||
    input.directKind
  );
  const debridUrl = normalizeHttpsUrl(input.debridUrl || input.unrestrictedUrl);
  const state = cacheState(input.cached ?? input.cacheStatus);
  const validated = input.validated === true;
  const title = cleanText(input.title || magnet?.displayName || input.name);
  const filename = cleanText(input.filename || magnet?.displayName || title);
  const resolution = normalizeResolution(input.resolution, input.quality, title, direct.url, debridUrl);
  const trackers = [...new Set([
    ...(Array.isArray(input.trackers) ? input.trackers : []),
    ...(magnet?.trackers || []),
  ].map(normalizeTracker).filter(Boolean))];

  let kind = 'invalid';
  let playableUrl = '';
  let reason = '';

  if (debridUrl && state === 'cached' && validated) {
    kind = 'cached-debrid';
    playableUrl = debridUrl;
  } else if (direct.kind && validated) {
    kind = direct.kind;
    playableUrl = direct.url;
  } else if (infoHash && state === 'cached') {
    kind = 'cached-torrent';
  } else if (infoHash && state === 'uncached') {
    kind = 'uncached-torrent';
  } else if (infoHash) {
    kind = 'p2p';
  } else if (direct.kind && !validated) {
    reason = 'Direct media candidate was not validated';
  } else if (normalizeHttpsUrl(input.detailUrl || input.url)) {
    reason = 'HTML/detail pages are discovery records, not playable streams';
  } else {
    reason = 'Candidate has no validated media URL or valid BitTorrent info hash';
  }

  const candidate = {
    kind,
    source: cleanText(input.source || input.indexer || 'unknown').toLowerCase(),
    sourceId: cleanText(input.sourceId || input.id),
    title,
    filename,
    studio: cleanText(input.studio),
    performers: Array.isArray(input.performers)
      ? input.performers.map(cleanText).filter(Boolean)
      : [],
    releaseDate: cleanText(input.releaseDate || input.date),
    resolution,
    resolutionHeight: resolutionHeight(resolution),
    quality: cleanText(input.quality),
    seeders: normalizeSeeders(input.seeders),
    size: normalizeSize(input.sizeBytes ?? input.size),
    infoHash,
    fileIdx: Number.isInteger(input.fileIdx) && input.fileIdx >= 0 ? input.fileIdx : null,
    trackers,
    requestHeaders:
      normalizeRelayHeaders(
        input.requestHeaders
      ),
    relayProvider:
      cleanText(input.relayProvider)
        .toLowerCase(),
    url: playableUrl,
    detailUrl: normalizeHttpsUrl(input.detailUrl || (direct.kind ? '' : input.url)),
    cached: state,
    validated,
    reason,
    provenance: Array.isArray(input.provenance)
      ? [...new Set(input.provenance.map(cleanText).filter(Boolean))]
      : [],
  };

  candidate.fingerprint = candidateFingerprint(candidate);
  return Object.freeze(candidate);
}

function candidateScore(candidate) {
  const readinessTier = {
    'cached-debrid': 3,
    'direct-hls': 3,
    'direct-file': 3,
    'cached-torrent': 3,
    p2p: 2,
    'uncached-torrent': 1,
    invalid: 0,
  }[candidate.kind] ?? 0;

  const kindPreference = {
    'cached-debrid': 4,
    'direct-hls': 3,
    'direct-file': 2,
    'cached-torrent': 1,
    p2p: 1,
    'uncached-torrent': 1,
    invalid: 0,
  }[candidate.kind] ?? 0;

  return (
    readinessTier * 10_000_000_000_000 +
    candidate.resolutionHeight * 1_000_000_000 +
    kindPreference * 100_000_000 +
    Math.min(candidate.seeders, 99_999) * 1_000 +
    indexerReliability(candidate.source) * 10 +
    Math.min(Math.floor(candidate.size / (1024 * 1024)), 9)
  );
}

function sortCandidates(candidates) {
  return [...candidates].sort((left, right) => {
    const scoreDifference = candidateScore(right) - candidateScore(left);
    if (scoreDifference) return scoreDifference;
    return left.fingerprint.localeCompare(right.fingerprint);
  });
}

function dedupeCandidates(candidates) {
  const best = new Map();
  for (const candidate of sortCandidates(candidates)) {
    if (candidate.kind === 'invalid') continue;
    const previous = best.get(candidate.fingerprint);
    if (!previous) {
      best.set(candidate.fingerprint, candidate);
      continue;
    }
    best.set(candidate.fingerprint, Object.freeze({
      ...previous,
      title: previous.title || candidate.title,
      filename: previous.filename || candidate.filename,
      seeders: Math.max(previous.seeders, candidate.seeders),
      size: Math.max(previous.size, candidate.size),
      trackers: Object.freeze([...new Set([...previous.trackers, ...candidate.trackers])]),
      provenance: Object.freeze([...new Set([
        ...previous.provenance,
        ...candidate.provenance,
        previous.source,
        candidate.source,
      ].filter(Boolean))]),
    }));
  }
  return [...best.values()];
}

function streamSources(candidate) {
  const trackers = candidate.trackers.length ? candidate.trackers : DEFAULT_TRACKERS;
  return trackers.map(tracker => `tracker:${tracker}`);
}

function formatSize(bytes) {
  if (!bytes) return '';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let amount = bytes;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

function toStremioStream(candidate) {
  if (!candidate || candidate.kind === 'invalid') return null;

  const filename = candidate.filename || candidate.title || candidate.sourceId || 'OnlyPorn result';
  const labels = [candidate.resolution];
  if (candidate.cached === 'cached') labels.push('Cached');
  if (candidate.cached === 'uncached') labels.push('Uncached');
  if (candidate.seeders) labels.push(`${candidate.seeders} seeders`);
  if (candidate.size) labels.push(formatSize(candidate.size));

  const stream = {
    name: `OnlyPorn · ${labels.filter(Boolean).join(' · ')}`,
    title: filename,
    description: [
      filename,
      candidate.seeders ? `👤 ${candidate.seeders}` : '',
      candidate.size ? `💾 ${formatSize(candidate.size)}` : '',
      candidate.source ? `🔎 ${candidate.source}` : '',
    ].filter(Boolean).join('\n'),
    behaviorHints: {
      bingeGroup: `onlyporn-torrent-${candidate.infoHash || candidate.source}`,
      filename,
      ...(candidate.size ? { videoSize: candidate.size } : {}),
    },
  };

  if (candidate.url) {
    if (candidate.relayProvider) {
      try {
        stream.url = mediaRelay.register({
          url: candidate.url,
          headers: candidate.requestHeaders,
          provider: candidate.relayProvider,
          kind:
            candidate.kind === 'direct-hls'
              ? 'hls'
              : 'mp4',
          ttlMs: 30 * 60 * 1000,
        });
      } catch {
        return null;
      }

      stream.behaviorHints.notWebReady =
        candidate.kind === 'direct-hls';

      return stream;
    }

    stream.url = candidate.url;
    stream.behaviorHints.notWebReady =
      candidate.kind === 'direct-hls';

    return stream;
  }

  if (candidate.infoHash) {
    stream.infoHash = candidate.infoHash;
    if (candidate.fileIdx !== null) stream.fileIdx = candidate.fileIdx;
    stream.sources = streamSources(candidate);
    stream.behaviorHints.notWebReady = false;
    return stream;
  }

  return null;
}

module.exports = {
  DEFAULT_TRACKERS,
  cacheState,
  candidateScore,
  classifyDirectUrl,
  dedupeCandidates,
  indexerReliability,
  normalizeCandidate,
  normalizeInfoHash,
  normalizeResolution,
  parseMagnet,
  resolutionHeight,
  sortCandidates,
  toStremioStream,
};
