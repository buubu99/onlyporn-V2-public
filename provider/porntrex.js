const { load } = require('cheerio');
const logger = require('../logger');
const { meta } = require('../model');
const Provider = require('./provider');
const { decodeJsStringLiteral, parseAssignedObjectStringValues } = require('./js-literal');
const {
  cleanMediaUrl,
  extractResolution,
  isHls,
  isLikelyFullVideoMp4,
  isPlayableMediaUrl,
  isPreviewMediaUrl,
  normalizeAbsoluteUrl,
} = require('./media-utils');
const { collectStructuredMediaUrls, parseStructuredDataBlocks } = require('./structured-data');
const { sanitizeUrlForLogs } = require('./url-security');

const PLAYBACK_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36';

const GENRE_MAP = {
  'Most Popular': 'most-popular',
  'Top Rated': 'top-rated',
  '4K porn': '4k-porn',
  Gaping: 'gaping',
  Public: 'public',
  Amateur: 'amateur',
  Latina: 'latina',
  Anal: 'anal',
  Milf: 'milf',
  Swallow: 'swallow',
  Creampie: 'creampie',
  Fantasy: 'fantasy',
  Babe: 'babe',
  Teen: 'teen',
  Wife: 'wife',
  POV: 'pov',
  Shemale: 'shemale',
  Blowjob: 'blowjob',
  Compilation: 'compilation',
  Deepthroat: 'deepthroat',
  Massage: 'massage',
  Japanese: 'japanese',
  Asian: 'asian',
  Cuckold: 'cuckold',
  Hentai: 'hentai',
  Celebrities: 'celebrities',
};

const QUALITY_BY_SUFFIX = {
  '': '480p',
  2: '720p',
  3: '1080p',
  4: '1440p',
  5: '2160p',
};

function decodeMediaValue(value) {
  let output = cleanMediaUrl(value);
  if (!output) return '';

  if (/^https?%3a%2f%2f/i.test(output)) {
    try {
      output = decodeURIComponent(output);
    } catch {
      // Keep the original value when percent decoding is malformed.
    }
  }

  const embeddedUrl = output.match(/https?:\/\/.+$/i)?.[0];
  if (embeddedUrl && !/^https?:\/\//i.test(output)) output = embeddedUrl;
  output = output.replace(/(\.(?:mp4|m3u8))\/(?=[?#]|$)/i, '$1');
  return cleanMediaUrl(output);
}

function qualityForSource(key, label, url) {
  const detected = extractResolution(label, key, url);
  if (detected) return detected;
  const suffix = String(key || '').match(/video_alt_url(\d*)/i)?.[1];
  if (suffix !== undefined) return QUALITY_BY_SUFFIX[suffix] || '480p';
  if (/video_url/i.test(key)) return extractResolution(label, url) || '480p';
  return isHls(url) ? 'HLS' : '480p';
}

function extractLiteralAssignments(source) {
  const values = new Map();
  const regex = /["']?(video(?:_alt)?_url\d*(?:_text)?)["']?\s*[:=]\s*(["'])((?:\\.|(?!\2)[\s\S])*?)\2/gi;
  let match;

  while ((match = regex.exec(source)) !== null) {
    const literal = `${match[2]}${match[3]}${match[2]}`;
    const decoded = decodeJsStringLiteral(literal);
    if (decoded) values.set(match[1].toLowerCase(), decoded);
  }

  return values;
}

function collectPorntrexSources(html, baseUrl) {
  const $ = load(html);
  const candidates = [];
  const seen = new Set();
  const add = (rawUrl, key = '', label = '', priority = 100) => {
    const decoded = decodeMediaValue(rawUrl);
    const url = normalizeAbsoluteUrl(decoded, baseUrl);
    if (!url || seen.has(url) || !isPlayableMediaUrl(url) || isPreviewMediaUrl(url)) return;
    seen.add(url);
    candidates.push({
      url,
      key,
      label,
      quality: qualityForSource(key, label, url),
      priority,
    });
  };

  const scripts = $('script')
    .toArray()
    .map(element => $(element).html() || '')
    .join('\n');
  const literals = extractLiteralAssignments(scripts);

  for (const [key, value] of literals.entries()) {
    if (key.endsWith('_text')) continue;
    add(value, key, literals.get(`${key}_text`) || '', 0);
  }

  for (const variableName of ['flashvars', 'player_data', 'playerConfig', 'video_data']) {
    const parsed = parseAssignedObjectStringValues(scripts, variableName);
    for (const [key, values] of Object.entries(parsed)) {
      if (!/^video(?:_alt)?_url\d*$/i.test(key)) continue;
      const labelKey = `${key}_text`;
      const label = parsed[labelKey]?.[0] || literals.get(labelKey.toLowerCase()) || '';
      for (const value of values) add(value, key, label, 10);
    }
  }

  $('video[src], source[src]').each((_, element) => {
    add($(element).attr('src'), 'html_source', $(element).attr('label') || $(element).attr('res'), 20);
  });

  for (const property of ['og:video', 'og:video:url', 'og:video:secure_url']) {
    add($(`meta[property="${property}"]`).attr('content'), property, '', 30);
  }

  const structured = parseStructuredDataBlocks(
    $('script[type="application/ld+json"]')
      .toArray()
      .map(element => $(element).text())
  );
  for (const item of collectStructuredMediaUrls(structured)) {
    add(item.url, 'json_ld', item.context, 40);
  }

  const broadMatches = scripts.match(/(?:https?:)?\\?\/\\?\/[^\s"'<>]+?\.(?:mp4|m3u8)(?:\?[^\s"'<>]*)?/gi) || [];
  for (const value of broadMatches) add(value, 'page_fallback', '', 90);

  return candidates.sort((left, right) => {
    const qualityDelta =
      (Number.parseInt(right.quality, 10) || 0) - (Number.parseInt(left.quality, 10) || 0);
    return qualityDelta || left.priority - right.priority;
  });
}

class PorntrexProvider extends Provider {
  constructor() {
    super('https://www.porntrex.com/', 'porntrex', 85);
  }

  static create() {
    return new PorntrexProvider();
  }

  extractVideoId(url) {
    const match = String(url || '').match(/\/videos?\/(\d+)\//i);
    return match ? Number.parseInt(match[1], 10) : null;
  }

  buildPoster(videoId) {
    const bucket = Math.floor(videoId / 1000) * 1000;
    return `https://ptx.cdntrex.com/contents/videos_screenshots/${bucket}/${videoId}/preview.mp4.jpg`;
  }

  async fetchHtml(url) {
    return super.fetchHtml(url, {
      headers: {
        'User-Agent': PLAYBACK_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: 'https://www.porntrex.com/',
        Cookie: 'kt_tcookie=1; confirmed=true',
      },
    });
  }

  playbackHints(videoPageUrl) {
    return {
      notWebReady: true,
      proxyHeaders: {
        request: {
          Referer: videoPageUrl || 'https://www.porntrex.com/',
          Origin: 'https://www.porntrex.com',
          Cookie: 'kt_tcookie=1; confirmed=true',
          'User-Agent': PLAYBACK_USER_AGENT,
        },
      },
    };
  }

  async resolveStream(url, videoPageUrl) {
    try {
      return await this.resolveMediaUrl(url, {
        headers: this.playbackHints(videoPageUrl).proxyHeaders.request,
      });
    } catch (error) {
      // Many signed KVS media URLs reject HEAD while playing correctly with GET.
      logger.debug(
        { provider: this.name, url: sanitizeUrlForLogs(url), error: error.message },
        'Porntrex HEAD resolution skipped'
      );
      return url;
    }
  }

  getInitialUrl(catalogId) {
    if (catalogId?.includes('top-rated')) return `${this.baseUrl}top-rated/`;
    if (catalogId?.includes('most-popular')) return `${this.baseUrl}most-popular/`;
    return `${this.baseUrl}latest-updates/`;
  }

  handleSearch({ extra: { search } }) {
    const keyword = String(search || '').trim();
    if (!keyword) return `${this.baseUrl}latest-updates/`;
    return `${this.baseUrl}search/${encodeURIComponent(keyword)}/`;
  }

  handleGenre(args) {
    const input = String(args.extra?.genre || '').trim();
    const slug = GENRE_MAP[input];
    if (!slug) return `${this.baseUrl}latest-updates/`;
    if (slug === 'top-rated' || slug === 'most-popular') return `${this.baseUrl}${slug}/`;
    return `${this.baseUrl}categories/${slug}/`;
  }

  handlePagination(url, { extra: { skip } }) {
    const page = Math.floor(Number(skip || 0) / this.limit) + 1;
    if (page <= 1) return url;
    const base = url.endsWith('/') ? url : `${url}/`;
    return `${base}${page}/`;
  }

  getCatalogMetas(html) {
    const $ = load(html);
    const metas = [];
    const seen = new Set();

    $('div.video-item').each((_, element) => {
      const anchor = $(element).find('a').first();
      const href = anchor.attr('href');
      if (!href) return;

      const id = new URL(href, this.baseUrl).toString();
      if (seen.has(id)) return;
      seen.add(id);

      const image = anchor.find('img').first();
      const videoId = this.extractVideoId(id);
      let poster = videoId ? this.buildPoster(videoId) : null;
      if (!poster) {
        poster =
          image.attr('data-src') ||
          image.attr('data-srcset')?.split(',')[0]?.trim().split(' ')[0] ||
          image.attr('src');
      }
      poster = normalizeAbsoluteUrl(poster, this.baseUrl);

      const title = (image.attr('alt') || 'Video').replace(/\s+/g, ' ').trim();
      metas.push(
        new meta.MetaPreview(id, Provider.TYPE, title, poster, {
          posterShape: 'landscape',
        })
      );
    });

    return metas;
  }

  async getMetadata(args) {
    const html = await this.fetchHtml(args.id);
    const parsed = await this.parseVideoPage({ id: args.id, html });
    return parsed.metaResponse;
  }

  async processStreams({ id }) {
    const html = await this.fetchHtml(id);
    const parsed = await this.parseVideoPage({ id, html });
    return { streams: Array.isArray(parsed?.streams) ? parsed.streams : [] };
  }

  async parseVideoPage({ id, html }) {
    const $ = load(html);
    const title =
      $('meta[property="og:title"]').attr('content') || $('title').text().trim() || 'Video';
    const description = $('meta[name="description"]').attr('content') || title;
    const videoId = this.extractVideoId(id);
    let poster = videoId
      ? this.buildPoster(videoId)
      : normalizeAbsoluteUrl($('meta[property="og:image"]').attr('content'), this.baseUrl);

    if (!poster) poster = normalizeAbsoluteUrl($('meta[property="og:image"]').attr('content'), this.baseUrl);

    const metaResponse = new meta.MetaResponse(id, Provider.TYPE, title, {
      description,
      poster,
      background: poster,
      posterShape: 'landscape',
      genres: [],
    });

    const candidates = collectPorntrexSources(html, id);
    const byQuality = new Map();

    for (const candidate of candidates) {
      if (isPreviewMediaUrl(candidate.url)) continue;
      if (
        !isHls(candidate.url) &&
        !isLikelyFullVideoMp4(candidate.url, {
          allowKnownVideoPath: true,
          context: `${candidate.key} ${candidate.label} ${candidate.quality}`,
        })
      ) {
        continue;
      }

      const key = candidate.quality || candidate.url;
      if (!byQuality.has(key)) byQuality.set(key, candidate);
    }

    const selected = [...byQuality.values()].sort(
      (left, right) =>
        (Number.parseInt(right.quality, 10) || 0) -
        (Number.parseInt(left.quality, 10) || 0)
    );

    if (!selected.length) {
      logger.warn(
        { provider: this.name, candidateCount: candidates.length },
        'Porntrex: no playable streams found'
      );
      return { metaResponse, streams: [] };
    }

    const streams = [];
    for (const candidate of selected) {
      const finalUrl = await this.resolveStream(candidate.url, id);
      if (!finalUrl) continue;
      streams.push({
        type: Provider.TYPE,
        url: finalUrl,
        name: candidate.quality || (isHls(finalUrl) ? 'HLS' : 'MP4'),
        behaviorHints: this.playbackHints(id),
      });
    }

    return { metaResponse, streams };
  }
}

const create = PorntrexProvider.create;
create._test = {
  collectPorntrexSources,
  decodeMediaValue,
  extractLiteralAssignments,
  qualityForSource,
};
module.exports = create;
