'use strict';

const { cleanText, stripMarkup, titleSimilarity } = require('./sukebei-hentai-title');

const ANILIST_ENDPOINT = 'https://graphql.anilist.co/';
const JIKAN_ENDPOINT = 'https://api.jikan.moe/v4/';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const MEDIA_FIELDS = `
  id idMal
  title { romaji english native }
  synonyms
  coverImage { extraLarge large }
  bannerImage
  description(asHtml: false)
  format episodes averageScore popularity status
  startDate { year month day }
  genres
  tags { name rank isAdult }
  studios(isMain: true) { nodes { name } }
`;

const ADULT_CATALOG_QUERY = `query OnlyPornSukebeiHentai {
  latest: Page(page: 1, perPage: 50) {
    media(type: ANIME, isAdult: true, status_in: [RELEASING, FINISHED], sort: [START_DATE_DESC]) { ${MEDIA_FIELDS} }
  }
  trending: Page(page: 1, perPage: 40) {
    media(type: ANIME, isAdult: true, sort: [TRENDING_DESC, POPULARITY_DESC]) { ${MEDIA_FIELDS} }
  }
  top: Page(page: 1, perPage: 40) {
    media(type: ANIME, isAdult: true, sort: [SCORE_DESC, POPULARITY_DESC]) { ${MEDIA_FIELDS} }
  }
}`;

const ADULT_SEARCH_QUERY = `query OnlyPornSukebeiHentaiSearch($search: String!) {
  Page(page: 1, perPage: 12) {
    media(type: ANIME, isAdult: true, search: $search, sort: [SEARCH_MATCH, POPULARITY_DESC]) { ${MEDIA_FIELDS} }
  }
}`;

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function responseContentType(response) {
  return String(response?.headers?.get?.('content-type') || '').split(';')[0].trim().toLowerCase();
}

async function boundedJsonRequest(url, options = {}) {
  const target = new URL(String(url));
  if (target.protocol !== 'https:' || target.username || target.password) throw new Error('Hentai metadata endpoint must be credential-free HTTPS');
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('Global fetch is unavailable');
  const timeoutMs = Math.min(Math.max(Number(options.timeoutMs || 8_000), 1_000), 20_000);
  const retries = Math.min(Math.max(Number(options.retries ?? 1), 0), 2);
  const maximum = Math.min(Math.max(Number(options.maxResponseBytes || MAX_RESPONSE_BYTES), 16_384), 4 * 1024 * 1024);

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(target.toString(), {
        method: options.method || 'GET',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'OnlyPorn-Sukebei-Hentai/1.0',
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          ...(options.headers || {}),
        },
        ...(options.body ? { body: options.body } : {}),
      });
      const status = Number(response?.status || 0);
      if ((status === 429 || status >= 500) && attempt < retries) {
        try { await response.body?.cancel?.(); } catch {}
        await sleep(Math.min(750 * (2 ** attempt), 2_500));
        continue;
      }
      if (status < 200 || status >= 300) throw new Error(`Hentai metadata returned HTTP ${status}`);
      const contentType = responseContentType(response);
      if (contentType && contentType !== 'application/json') throw new Error('Hentai metadata returned a non-JSON response');
      const contentLength = Number(response.headers?.get?.('content-length') || 0);
      if (contentLength > maximum) throw new Error('Hentai metadata response exceeded the byte limit');
      const body = await response.text();
      if (Buffer.byteLength(body, 'utf8') > maximum) throw new Error('Hentai metadata response exceeded the byte limit');
      return JSON.parse(body);
    } catch (error) {
      if (attempt >= retries) throw error;
      await sleep(Math.min(500 * (2 ** attempt), 2_000));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('Hentai metadata request failed');
}

function isoDate(value = {}) {
  const year = Number(value.year || 0);
  if (year < 1900 || year > 2200) return '';
  const month = Math.min(Math.max(Number(value.month || 1), 1), 12);
  const day = Math.min(Math.max(Number(value.day || 1), 1), 31);
  return new Date(Date.UTC(year, month - 1, day)).toISOString();
}

function validImage(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : '';
  } catch {
    return '';
  }
}

function uniqueStrings(values, limit = 80) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(value => cleanText(value?.name || value, 160))
    .filter(Boolean))].slice(0, limit);
}

function normalizeAniListMedia(raw = {}, ranks = {}) {
  const id = Number(raw.id || 0);
  const title = cleanText(raw.title?.romaji || raw.title?.english || raw.title?.native, 300);
  const poster = validImage(raw.coverImage?.extraLarge || raw.coverImage?.large);
  if (!id || !title || !poster) return null;
  const tags = uniqueStrings((raw.tags || []).filter(tag => Number(tag?.rank || 0) >= 35).map(tag => tag?.name), 30);
  const genres = uniqueStrings(raw.genres, 20);
  const studios = uniqueStrings(raw.studios?.nodes, 10);
  return Object.freeze({
    sourceId: `anilist:${id}`,
    provider: 'anilist',
    externalId: String(id),
    idMal: Number(raw.idMal || 0) || null,
    title,
    englishTitle: cleanText(raw.title?.english, 300),
    nativeTitle: cleanText(raw.title?.native, 300),
    synonyms: Object.freeze(uniqueStrings(raw.synonyms, 30)),
    poster,
    background: validImage(raw.bannerImage) || poster,
    description: stripMarkup(raw.description || 'No description available.'),
    format: cleanText(raw.format, 40),
    episodes: Math.min(Math.max(Number(raw.episodes || 0), 0), 2_000),
    averageScore: Math.min(Math.max(Number(raw.averageScore || 0), 0), 100),
    popularity: Math.max(Number(raw.popularity || 0), 0),
    status: cleanText(raw.status, 40),
    releaseDate: isoDate(raw.startDate),
    genres: Object.freeze(genres),
    tags: Object.freeze(tags),
    studios: Object.freeze(studios),
    adult: true,
    ranks: Object.freeze({
      latest: Number(ranks.latest || 0),
      trending: Number(ranks.trending || 0),
      top: Number(ranks.top || 0),
    }),
  });
}

function mergeAniListCatalog(payload = {}) {
  const data = payload?.data || {};
  const merged = new Map();
  for (const mode of ['latest', 'trending', 'top']) {
    const rows = Array.isArray(data?.[mode]?.media) ? data[mode].media : [];
    rows.forEach((row, index) => {
      const id = Number(row?.id || 0);
      if (!id) return;
      const previous = merged.get(id) || { raw: row, ranks: {} };
      previous.ranks[mode] = index + 1;
      merged.set(id, previous);
    });
  }
  return [...merged.values()].map(value => normalizeAniListMedia(value.raw, value.ranks)).filter(Boolean);
}

function createAniListClient(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = Math.min(Math.max(Number(options.timeoutMs || 9_000), 1_000), 20_000);
  return Object.freeze({
    id: 'anilist',
    configured: true,
    async catalog() {
      const payload = await boundedJsonRequest(ANILIST_ENDPOINT, {
        fetchImpl,
        timeoutMs,
        method: 'POST',
        body: JSON.stringify({ query: ADULT_CATALOG_QUERY }),
      });
      if (Array.isArray(payload?.errors) && payload.errors.length) throw new Error('AniList adult catalog query failed');
      return mergeAniListCatalog(payload);
    },
    async search(query) {
      const search = cleanText(query, 160);
      if (search.length < 2) return [];
      const payload = await boundedJsonRequest(ANILIST_ENDPOINT, {
        fetchImpl,
        timeoutMs,
        method: 'POST',
        body: JSON.stringify({ query: ADULT_SEARCH_QUERY, variables: { search } }),
      });
      const rows = Array.isArray(payload?.data?.Page?.media) ? payload.data.Page.media : [];
      return rows.map(row => normalizeAniListMedia(row)).filter(Boolean);
    },
  });
}

function jikanIsAdult(raw = {}) {
  const genres = [...(raw.genres || []), ...(raw.explicit_genres || []), ...(raw.themes || [])]
    .map(item => cleanText(item?.name || item).toLocaleLowerCase('en-US'));
  return genres.includes('hentai') || /^rx\b/i.test(String(raw.rating || ''));
}

function normalizeJikanMedia(raw = {}, query = '') {
  const id = Number(raw.mal_id || 0);
  const title = cleanText(raw.title || raw.title_english || raw.title_japanese, 300);
  const poster = validImage(raw.images?.webp?.large_image_url || raw.images?.jpg?.large_image_url || raw.images?.jpg?.image_url);
  if (!id || !title || !poster || !jikanIsAdult(raw)) return null;
  const aliases = uniqueStrings([
    raw.title,
    raw.title_english,
    raw.title_japanese,
    ...(raw.title_synonyms || []),
    ...((raw.titles || []).map(item => item?.title)),
  ], 40);
  const score = Math.max(...aliases.map(alias => titleSimilarity(query || title, alias)), 0);
  return Object.freeze({
    sourceId: `mal:${id}`,
    provider: 'jikan',
    externalId: String(id),
    idMal: id,
    title,
    englishTitle: cleanText(raw.title_english, 300),
    nativeTitle: cleanText(raw.title_japanese, 300),
    synonyms: Object.freeze(aliases.filter(alias => alias !== title)),
    poster,
    background: validImage(raw.trailer?.images?.maximum_image_url) || poster,
    description: stripMarkup(raw.synopsis || raw.background || 'No description available.'),
    format: cleanText(raw.type, 40),
    episodes: Math.min(Math.max(Number(raw.episodes || 0), 0), 2_000),
    averageScore: Math.min(Math.max(Math.round(Number(raw.score || 0) * 10), 0), 100),
    popularity: Math.max(Number(raw.members || 0), 0),
    status: cleanText(raw.status, 40),
    releaseDate: String(raw.aired?.from || ''),
    genres: Object.freeze(uniqueStrings([...(raw.genres || []), ...(raw.explicit_genres || []), ...(raw.themes || [])], 30)),
    tags: Object.freeze([]),
    studios: Object.freeze(uniqueStrings(raw.studios, 10)),
    adult: true,
    matchScore: score,
    ranks: Object.freeze({ latest: 0, trending: 0, top: 0 }),
  });
}

function createJikanClient(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = Math.min(Math.max(Number(options.timeoutMs || 8_000), 1_000), 20_000);
  return Object.freeze({
    id: 'jikan',
    configured: true,
    async search(query) {
      const search = cleanText(query, 160);
      if (search.length < 2) return [];
      const url = new URL('anime', JIKAN_ENDPOINT);
      url.searchParams.set('q', search);
      url.searchParams.set('sfw', 'false');
      url.searchParams.set('limit', '5');
      const payload = await boundedJsonRequest(url, { fetchImpl, timeoutMs, retries: 1 });
      return (Array.isArray(payload?.data) ? payload.data : [])
        .map(row => normalizeJikanMedia(row, search))
        .filter(Boolean)
        .sort((left, right) => right.matchScore - left.matchScore);
    },
  });
}

module.exports = {
  ADULT_CATALOG_QUERY,
  ADULT_SEARCH_QUERY,
  ANILIST_ENDPOINT,
  JIKAN_ENDPOINT,
  boundedJsonRequest,
  createAniListClient,
  createJikanClient,
  jikanIsAdult,
  mergeAniListCatalog,
  normalizeAniListMedia,
  normalizeJikanMedia,
};
