const { load } = require('cheerio');      
const logger = require('../logger');      
const { meta } = require('../model');      
const Provider = require('./provider');      
      
class PorntrexProvider extends Provider {      
      
  constructor() {      
    super('https://www.porntrex.com/', 'porntrex', 85);      
  }

GENRE_MAP = {
  'Most Popular': 'most-popular',
  'Top Rated': 'top-rated',
  '4K porn': '4k-porn',
  'Gaping': 'gaping',
  'Public': 'public',
  'Amateur': 'amateur',
  'Latina': 'latina',
  'Anal': 'anal',
  'Milf': 'milf',
  'Swallow': 'swallow',
  'Creampie': 'creampie',
  'Fantasy': 'fantasy',
  'Babe': 'babe',
  'Teen': 'teen',
  'Wife': 'wife',
  'POV': 'pov',
  'Shemale': 'shemale',
  'Blowjob': 'blowjob',
  'Compilation': 'compilation',
  'Deepthroat': 'deepthroat',
  'Massage': 'massage',
  'Japanese': 'japanese',
  'Asian': 'asian',
  'Cuckold': 'cuckold',
  'Hentai': 'hentai',
  'Celebrities': 'celebrities'
}; 

extractVideoId(url) {
  const match = url.match(/\/video\/(\d+)\//);
  return match ? parseInt(match[1], 10) : null;
}

buildPoster(videoId) {
  const bucket = Math.floor(videoId / 1000) * 1000;
  return `https://ptx.cdntrex.com/contents/videos_screenshots/${bucket}/${videoId}/preview.mp4.jpg`;
}     
      
async fetchHtml(url) {      
  return super.fetchHtml(url, {      
    headers: {      
      'User-Agent':      
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',      
      
      'Accept':      
        'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',      
      
      'Accept-Language': 'en-US,en;q=0.9',      
      
      'Referer': 'https://www.porntrex.com/',      
      
      // 🔥 THIS UNLOCKS CONTENT      
      'Cookie': 'kt_tcookie=1; confirmed=true'      
    }      
  });      
}      
      
async resolveStream(url) {
  try {
    let res = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Referer': 'https://www.porntrex.com/',
        'Cookie': 'kt_tcookie=1; confirmed=true'
      }
    });

    if (!res.url || res.status >= 400) {
      // fallback
      res = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Referer': 'https://www.porntrex.com/',
          'Cookie': 'kt_tcookie=1; confirmed=true'
        }
      });
    }

    return res.url;
  } catch (e) {
    logger.warn({ error: e.message }, 'Stream resolve failed');
    return null;
  }
}      
      
  static create() {      
    return new PorntrexProvider();      
  }      
      
  /* =========================      
     URL HANDLERS      
  ========================= */      
      
  getInitialUrl(catalogId) {      
    if (!catalogId) {      
      return `${this.baseUrl}latest-updates/`;      
    }      
      
    if (catalogId.includes('top-rated')) {      
      return `${this.baseUrl}top-rated/`;      
    }      
      
    if (catalogId.includes('most-popular')) {      
      return `${this.baseUrl}most-popular/`;      
    }      
      
    // fallback      
    return `${this.baseUrl}latest-updates/`;      
  }      
      
  handleSearch() {
  // 🚫 Completely ignore search → fallback to safe page
  return `${this.baseUrl}latest-updates/`;
}      
      
  handleGenre(args) {
  const input = (args.extra.genre || '').trim();

  const slug = this.GENRE_MAP[input];

  // 🚫 Block EVERYTHING not explicitly allowed
  if (!slug) {
  return `${this.baseUrl}latest-updates/`;
}

  // 🔥 special routes
  if (slug === 'top-rated') {
    return `${this.baseUrl}top-rated/`;
  }

  if (slug === 'most-popular') {
    return `${this.baseUrl}most-popular/`;
  }

  // ✅ normal categories
  return `${this.baseUrl}categories/${slug}/`;
}      
      
  handlePagination(url, { extra: { skip } }) {      
    const page = Math.floor(skip / this.perPage) + 1;      
      
    // page 1 = base URL      
    if (page <= 1) return url;      
      
    // ensure trailing slash      
    if (!url.endsWith('/')) url += '/';      
      
    return `${url}${page}/`;      
  }      
      
  /* =========================      
     CATALOG      
  ========================= */      
      
  getCatalogMetas(html) {      
    const $ = load(html);      
    const metas = [];      
    const seen = new Set();      
      
    $('div.video-item').each((_, el) => {      
      const $el = $(el);      
      const $a = $el.find('a').first();      
      
      const href = $a.attr('href');      
      if (!href) return;      
      
      const id = new URL(href, this.baseUrl).href;      
      if (seen.has(id)) return;      
      seen.add(id);      
      
      const $img = $a.find('img');      
      
      let poster;

// extract ID
const videoId = this.extractVideoId(id);

if (videoId) {
  poster = this.buildPoster(videoId);
}

if (!poster) {
  poster =
    $img.attr('data-src') ||
    $img.attr('data-srcset')?.split(',')[0]?.split(' ')[0] ||
    $img.attr('src');
}

// normalize
if (poster && poster.startsWith('//')) {
  poster = 'https:' + poster;
}      
      
      const title =      
        ($img.attr('alt') || 'Video')      
          .replace(/\s+/g, ' ')      
          .trim();      
      
      metas.push(
  new meta.MetaPreview(
    id,
    Provider.TYPE,
    title,
    poster,
    {
      posterShape: 'landscape' // 👈 THIS is the fix
    }
  )
);      
    });      
      
    return metas;      
  }      
      
  /* =========================      
     METADATA      
  ========================= */      
      
  async getMetadata(args) {      
  const html = await this.fetchHtml(args.id);      
  const parsed = await this.parseVideoPage({ id: args.id, html });      
  return parsed.metaResponse;      
}      
      
  /* =========================      
     PARSER      
  ========================= */      
      
  async parseVideoPage({ id, html }) {      
  const $ = load(html);      
      
  /* =========================      
     META (ROBUST)      
  ========================= */      
      
  const title =      
    $('meta[property="og:title"]').attr('content') ||      
    $('title').text().trim() ||      
    'Video';      
      
  const description =      
    $('meta[name="description"]').attr('content') ||      
    title;      
      
  // 🔥 Extract video ID from URL      
const videoId = this.extractVideoId(id);

let poster;

if (videoId) {
  poster = this.buildPoster(videoId);
  logger.debug(poster, 'High quality poster');
} else {      
  poster = $('meta[property="og:image"]').attr('content');      
      
  if (poster && poster.startsWith('//')) {      
    poster = 'https:' + poster;      
  }      
}      
      
  const metaResponse = new meta.MetaResponse(
  id,
  Provider.TYPE,
  title,
  {
    description,
    poster,
    background: poster,
    posterShape: 'landscape',
    genres: []
  }
);      
      
  /* =========================      
     STREAM EXTRACTION (PRIMARY)      
  ========================= */      
      
  const playerMatch = html.match(      
    /kt_player\s*\(\s*['"][^'"]+['"]\s*,\s*(\{[\s\S]*?\})\s*\)/      
  );      
      
  const streams = [];      
      
  if (playerMatch) {      
    const raw = playerMatch[1];      
      
    const streamRegex = /video_alt_url(\d*)\s*:\s*'([^']+)'/g;      
      
    const qualityMap = {      
      '': '480p',      
      '2': '720p',      
      '3': '1080p',      
      '4': '1440p',      
      '5': '2160p'      
    };      
      
    let match;      
      
    while ((match = streamRegex.exec(raw)) !== null) {      
      const key = match[1] || '';      
      let url = match[2];      
      
      if (url.startsWith('//')) {      
        url = 'https:' + url;      
      }      
      
      streams.push({      
  url,      
  quality: qualityMap[key] || '480p'      
});      
    }      
  }      
      
  /* =========================      
     FALLBACK (MP4 SCRAPE)      
  ========================= */      
      
  if (!streams.length) {      
    const matches =      
      html.match(/https?:\/\/[^"' ]+\.mp4[^"' ]*/g) || [];      
      
    const unique = [...new Set(matches)];      
      
    unique.forEach((url) => {      
  const qualityMatch = url.match(/(\d{3,4})p/);      
      
  let quality;      
      
  if (qualityMatch) {      
    quality = qualityMatch[1] + 'p';      
  } else if (url.includes('.mp4')) {      
    // 🔥 base file ALWAYS = 480p      
    quality = '480p';      
  } else {      
    quality = 'HD';      
  }      
      
  streams.push({      
    url,      
    quality      
  });      
});      
  }      
      
  /* =========================      
     FINAL CHECK      
  ========================= */      
      
  if (!streams.length) {      
    logger.warn('Porntrex: no streams found at all');      
    return { metaResponse };      
  }

// 🔥 Deduplicate streams
const seenUrls = new Set();
const uniqueStreams = streams.filter(s => {
  if (seenUrls.has(s.url)) return false;
  seenUrls.add(s.url);
  return true;
});      
      
  /* =========================      
     SORT STREAMS      
  ========================= */      
      
  uniqueStreams.sort((a, b) => {      
    const qa = Number(a.quality.replace('p', '')) || 0;
const qb = Number(b.quality.replace('p', '')) || 0;      
    return qb - qa;      
  });      
      
  /* =========================      
     RETURN STREAMS      
  ========================= */      
      
  const resolvedStreams = await Promise.all(
  uniqueStreams.map(async (s) => {
    const finalUrl = await this.resolveStream(s.url);

    if (!finalUrl) return null;

    logger.debug(finalUrl, 'Resolved stream');

    return {
      type: 'movie',
      url: finalUrl,
      name: s.quality,
      behaviorHints: {
        notWebReady: false
      }
    };
  })
);

return {
  metaResponse,
  streams: resolvedStreams.filter(Boolean)
};      
}      
}      
module.exports = PorntrexProvider.create;